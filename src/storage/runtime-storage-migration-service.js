import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { SqliteRuntimeStorage } from './backends/sqlite-runtime-storage.js';
import { buildStableProviderId, splitProviderConfig, sqlValue } from './provider-storage-mapper.js';
import { getRuntimeStorageDefaults } from './runtime-storage-factory.js';
import { wrapRuntimeStorageError } from './runtime-storage-error.js';
import {
    buildRuntimeStorageCrashRecoveryDiagnostics,
    buildRuntimeStorageFeatureFlagFallback,
    recordRuntimeStorageExportStatus,
    recordRuntimeStorageValidationStatus
} from './runtime-storage-registry.js';
import { PROVIDER_MAPPINGS, isValidOAuthCredentials } from '../utils/provider-utils.js';

const DEFAULT_PROVIDER_POOLS_PATH = path.join(process.cwd(), 'configs', 'provider_pools.json');
const DEFAULT_USAGE_CACHE_PATH = path.join(process.cwd(), 'configs', 'usage-cache.json');
const DEFAULT_TOKEN_STORE_PATH = path.join(process.cwd(), 'configs', 'token-store.json');
const DEFAULT_API_POTLUCK_DATA_PATH = path.join(process.cwd(), 'configs', 'api-potluck-data.json');
const DEFAULT_API_POTLUCK_KEYS_PATH = path.join(process.cwd(), 'configs', 'api-potluck-keys.json');
const DEFAULT_ARTIFACT_ROOT = path.join(process.cwd(), 'configs', 'runtime', 'migrations');
const PROVIDER_CREDENTIAL_PATH_SUFFIXES = ['_FILE_PATH', '_CREDS_FILE_PATH', '_TOKEN_FILE_PATH'];

function nowIso() {
    return new Date().toISOString();
}

function sortObject(value) {
    if (Array.isArray(value)) {
        return value.map((item) => sortObject(item));
    }

    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.keys(value)
            .sort()
            .reduce((result, key) => {
                result[key] = sortObject(value[key]);
                return result;
            }, {});
    }

    return value;
}

function stableStringify(value) {
    return JSON.stringify(sortObject(value));
}

function hashValue(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function createStableId(prefix, parts = []) {
    return `${prefix}_${hashValue(parts.join('::')).slice(0, 24)}`;
}

function parseJsonSafe(value, fallback = null) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function normalizeTimestamp(value, fallback = null) {
    if (!value) {
        return fallback;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return fallback;
    }

    return parsed.toISOString();
}

function normalizeRelativePath(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().replace(/\\/g, '/');
    return normalized || null;
}

function resolvePathMaybeAbsolute(filePath) {
    if (!filePath) {
        return null;
    }

    return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function toSqlBoolean(value) {
    return value ? 1 : 0;
}

function normalizeUsageInstance(instance, fallbackTimestamp = null) {
    if (!instance || typeof instance !== 'object') {
        return null;
    }

    return {
        ...instance,
        lastRefreshedAt: normalizeTimestamp(
            instance.lastRefreshedAt || instance.timestamp || instance.cachedAt,
            fallbackTimestamp
        )
    };
}

function normalizeProviderUsage(providerType, usageData = {}, fallbackTimestamp = null) {
    const providerTimestamp = normalizeTimestamp(
        usageData.timestamp || usageData.refreshedAt || usageData.cachedAt,
        fallbackTimestamp || nowIso()
    );
    const instances = Array.isArray(usageData.instances)
        ? usageData.instances
            .map((instance) => normalizeUsageInstance(instance, providerTimestamp))
            .filter(Boolean)
        : [];
    const successCount = Number.isFinite(usageData.successCount)
        ? usageData.successCount
        : instances.filter((instance) => instance.success === true).length;
    const errorCount = Number.isFinite(usageData.errorCount)
        ? usageData.errorCount
        : instances.filter((instance) => instance.success !== true).length;
    const totalCount = Number.isFinite(usageData.totalCount)
        ? usageData.totalCount
        : instances.length;
    const processedCount = Number.isFinite(usageData.processedCount)
        ? usageData.processedCount
        : instances.length;

    return {
        ...usageData,
        providerType: usageData.providerType || providerType,
        timestamp: providerTimestamp,
        instances,
        totalCount,
        successCount,
        errorCount,
        processedCount
    };
}

function normalizeUsageCache(cache) {
    if (!cache || typeof cache !== 'object') {
        return {
            timestamp: nowIso(),
            providers: {}
        };
    }

    const cacheTimestamp = normalizeTimestamp(cache.timestamp, nowIso());
    const normalizedCache = {
        ...cache,
        timestamp: cacheTimestamp,
        providers: {}
    };

    for (const [providerType, providerUsage] of Object.entries(cache.providers || {})) {
        normalizedCache.providers[providerType] = normalizeProviderUsage(providerType, providerUsage, cacheTimestamp);
    }

    return normalizedCache;
}

function normalizeApiPotluckData(rawData) {
    const normalized = rawData && typeof rawData === 'object'
        ? rawData
        : { config: {}, users: {} };

    return {
        config: { ...(normalized.config || {}) },
        users: Object.entries(normalized.users || {}).reduce((result, [userIdentifier, userData]) => {
            const safeUserData = userData && typeof userData === 'object' ? userData : {};
            result[userIdentifier] = {
                credentials: Array.isArray(safeUserData.credentials)
                    ? safeUserData.credentials
                        .filter((credential) => credential && typeof credential === 'object')
                        .map((credential) => ({
                            ...credential,
                            path: normalizeRelativePath(credential.path),
                            addedAt: normalizeTimestamp(credential.addedAt, null)
                        }))
                    : [],
                credentialBonuses: Array.isArray(safeUserData.credentialBonuses)
                    ? safeUserData.credentialBonuses.map((bonus) => ({
                        ...bonus,
                        grantedAt: normalizeTimestamp(bonus.grantedAt, null)
                    }))
                    : [],
                createdAt: normalizeTimestamp(safeUserData.createdAt, null)
            };
            return result;
        }, {})
    };
}

function normalizeApiPotluckKeys(rawData) {
    const normalized = rawData && typeof rawData === 'object'
        ? rawData
        : { keys: {} };

    return {
        keys: Object.entries(normalized.keys || {}).reduce((result, [keyId, keyData]) => {
            const safeKeyData = keyData && typeof keyData === 'object' ? keyData : {};
            result[keyId] = {
                ...safeKeyData,
                id: safeKeyData.id || keyId,
                createdAt: normalizeTimestamp(safeKeyData.createdAt, null),
                lastUsedAt: normalizeTimestamp(safeKeyData.lastUsedAt, null)
            };
            return result;
        }, {})
    };
}

function normalizeTokenStore(rawData) {
    const normalized = rawData && typeof rawData === 'object'
        ? rawData
        : { tokens: {} };

    return {
        tokens: Object.entries(normalized.tokens || {}).reduce((result, [token, tokenInfo]) => {
            result[token] = tokenInfo && typeof tokenInfo === 'object'
                ? { ...tokenInfo }
                : {};
            return result;
        }, {})
    };
}

function buildAdminSessionId(token) {
    return `admin_sess_${hashValue(token).slice(0, 24)}`;
}

function normalizeTokenStoreTime(value, fallback = null) {
    const normalized = normalizeTimestamp(value, null);
    if (normalized) {
        return normalized;
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
        return normalizeTimestamp(new Date(numericValue).toISOString(), fallback);
    }

    return fallback;
}

function buildAdminSessionComparableMeta(tokenInfo = {}, fallbacks = {}) {
    const safeTokenInfo = tokenInfo && typeof tokenInfo === 'object'
        ? { ...tokenInfo }
        : {};

    return sortObject({
        ...safeTokenInfo,
        username: safeTokenInfo.username || fallbacks.subject || 'admin',
        sourceIp: safeTokenInfo.sourceIp || fallbacks.sourceIp || null,
        userAgent: safeTokenInfo.userAgent || fallbacks.userAgent || null
    });
}

function buildAdminSessionImportRecord(token, tokenInfo = {}, timestamp = nowIso()) {
    const safeTokenInfo = tokenInfo && typeof tokenInfo === 'object'
        ? { ...tokenInfo }
        : {};
    const subject = safeTokenInfo.username || 'admin';
    const createdAt = normalizeTokenStoreTime(safeTokenInfo.loginTime, timestamp) || timestamp;
    const expiresAt = normalizeTokenStoreTime(safeTokenInfo.expiryTime, timestamp) || timestamp;

    return {
        id: buildAdminSessionId(token),
        tokenHash: hashValue(token),
        subject,
        createdAt,
        expiresAt,
        sourceIp: safeTokenInfo.sourceIp || null,
        userAgent: safeTokenInfo.userAgent || null,
        metaJson: safeTokenInfo
    };
}

function buildComparableAdminSessionFromToken(token, tokenInfo = {}) {
    const safeTokenInfo = tokenInfo && typeof tokenInfo === 'object'
        ? { ...tokenInfo }
        : {};
    const subject = safeTokenInfo.username || 'admin';
    const sourceIp = safeTokenInfo.sourceIp || null;
    const userAgent = safeTokenInfo.userAgent || null;

    return {
        tokenHash: hashValue(token),
        subject,
        createdAt: normalizeTokenStoreTime(safeTokenInfo.loginTime, null),
        expiresAt: normalizeTokenStoreTime(safeTokenInfo.expiryTime, null),
        sourceIp,
        userAgent,
        metaHash: hashValue(stableStringify(buildAdminSessionComparableMeta(safeTokenInfo, {
            subject,
            sourceIp,
            userAgent
        })))
    };
}

function buildComparableAdminSessionFromRow(row = {}) {
    const metaJson = parseJsonSafe(row.meta_json, {}) || {};
    const subject = metaJson.username || row.subject || 'admin';
    const sourceIp = metaJson.sourceIp || row.source_ip || null;
    const userAgent = metaJson.userAgent || row.user_agent || null;

    return {
        tokenHash: row.token_hash,
        subject,
        createdAt: normalizeTokenStoreTime(metaJson.loginTime, null) || normalizeTimestamp(row.created_at, null),
        expiresAt: normalizeTokenStoreTime(metaJson.expiryTime, null) || normalizeTimestamp(row.expires_at, null),
        sourceIp,
        userAgent,
        metaHash: hashValue(stableStringify(buildAdminSessionComparableMeta(metaJson, {
            subject,
            sourceIp,
            userAgent
        })))
    };
}

async function ensureDirectory(dirPath) {
    await pfs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile(filePath, fallback) {
    if (!filePath) {
        return fallback;
    }

    try {
        const raw = await pfs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`[RuntimeStorageMigration] Failed to read JSON file ${filePath}: ${error.message}`);
        }
        return fallback;
    }
}

async function writeJsonFile(filePath, data) {
    await ensureDirectory(path.dirname(filePath));
    await pfs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function copyFileIfExists(sourcePath, targetPath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        return false;
    }

    await ensureDirectory(path.dirname(targetPath));
    await pfs.copyFile(sourcePath, targetPath);
    return true;
}

function getSqliteSidecarPaths(dbPath) {
    return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

async function backupSqliteFiles(dbPath, backupDirPath) {
    const copiedFiles = [];
    await ensureDirectory(backupDirPath);

    for (const candidatePath of getSqliteSidecarPaths(dbPath)) {
        if (!fs.existsSync(candidatePath)) {
            continue;
        }

        const targetPath = path.join(backupDirPath, path.basename(candidatePath));
        await pfs.copyFile(candidatePath, targetPath);
        copiedFiles.push(targetPath);
    }

    return copiedFiles;
}

async function restoreSqliteFiles(backupDirPath, dbPath) {
    const restoredFiles = [];

    for (const candidatePath of getSqliteSidecarPaths(dbPath)) {
        if (fs.existsSync(candidatePath)) {
            await pfs.unlink(candidatePath);
        }
    }

    for (const candidatePath of getSqliteSidecarPaths(dbPath)) {
        const backupPath = path.join(backupDirPath, path.basename(candidatePath));
        if (!fs.existsSync(backupPath)) {
            continue;
        }

        await ensureDirectory(path.dirname(candidatePath));
        await pfs.copyFile(backupPath, candidatePath);
        restoredFiles.push(candidatePath);
    }

    return restoredFiles;
}

function resolveRuntimeStoragePaths(config = {}, options = {}) {
    const defaults = getRuntimeStorageDefaults();
    const providerPoolsFilePath = resolvePathMaybeAbsolute(
        options.providerPoolsFilePath || config.PROVIDER_POOLS_FILE_PATH || DEFAULT_PROVIDER_POOLS_PATH
    );
    const legacyBaseDir = path.dirname(providerPoolsFilePath || DEFAULT_PROVIDER_POOLS_PATH);
    const dbPath = resolvePathMaybeAbsolute(
        options.dbPath || config.RUNTIME_STORAGE_DB_PATH || defaults.RUNTIME_STORAGE_DB_PATH
    );
    const usageCacheFilePath = resolvePathMaybeAbsolute(
        options.usageCacheFilePath || config.USAGE_CACHE_FILE_PATH || DEFAULT_USAGE_CACHE_PATH
    );
    const tokenStoreFilePath = resolvePathMaybeAbsolute(
        options.tokenStoreFilePath || config.TOKEN_STORE_FILE_PATH || path.join(legacyBaseDir, 'token-store.json') || DEFAULT_TOKEN_STORE_PATH
    );
    const apiPotluckDataFilePath = resolvePathMaybeAbsolute(
        options.apiPotluckDataFilePath
        || options.potluckUserDataFilePath
        || config.API_POTLUCK_DATA_FILE_PATH
        || config.POTLUCK_USER_DATA_FILE_PATH
        || DEFAULT_API_POTLUCK_DATA_PATH
    );
    const apiPotluckKeysFilePath = resolvePathMaybeAbsolute(
        options.apiPotluckKeysFilePath
        || options.potluckKeysFilePath
        || config.API_POTLUCK_KEYS_FILE_PATH
        || config.POTLUCK_KEYS_FILE_PATH
        || DEFAULT_API_POTLUCK_KEYS_PATH
    );
    const artifactRoot = resolvePathMaybeAbsolute(
        options.artifactRoot || config.RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT
    );

    return {
        providerPoolsFilePath,
        legacyBaseDir,
        dbPath,
        usageCacheFilePath,
        tokenStoreFilePath,
        apiPotluckDataFilePath,
        apiPotluckKeysFilePath,
        artifactRoot,
        sqliteBinary: config.RUNTIME_STORAGE_SQLITE_BINARY || defaults.RUNTIME_STORAGE_SQLITE_BINARY,
        dbBusyTimeoutMs: config.RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS ?? defaults.RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS,
        persistSelectionState: config.PERSIST_SELECTION_STATE === true
    };
}

async function createSqliteStorage(config = {}, options = {}) {
    const resolvedPaths = resolveRuntimeStoragePaths(config, options);
    const storage = new SqliteRuntimeStorage({
        ...config,
        RUNTIME_STORAGE_DB_PATH: resolvedPaths.dbPath,
        PROVIDER_POOLS_FILE_PATH: resolvedPaths.providerPoolsFilePath,
        USAGE_CACHE_FILE_PATH: resolvedPaths.usageCacheFilePath,
        TOKEN_STORE_FILE_PATH: resolvedPaths.tokenStoreFilePath,
        POTLUCK_USER_DATA_FILE_PATH: resolvedPaths.apiPotluckDataFilePath,
        POTLUCK_KEYS_FILE_PATH: resolvedPaths.apiPotluckKeysFilePath,
        API_POTLUCK_DATA_FILE_PATH: resolvedPaths.apiPotluckDataFilePath,
        API_POTLUCK_KEYS_FILE_PATH: resolvedPaths.apiPotluckKeysFilePath,
        RUNTIME_STORAGE_SQLITE_BINARY: resolvedPaths.sqliteBinary,
        RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS: resolvedPaths.dbBusyTimeoutMs
    });
    await storage.initialize();
    return {
        storage,
        resolvedPaths
    };
}

async function loadLegacySourceBundle(config = {}, options = {}) {
    const resolvedPaths = resolveRuntimeStoragePaths(config, options);
    const providerPools = await readJsonFile(resolvedPaths.providerPoolsFilePath, {});
    const usageCache = normalizeUsageCache(await readJsonFile(resolvedPaths.usageCacheFilePath, null));
    const tokenStore = normalizeTokenStore(await readJsonFile(resolvedPaths.tokenStoreFilePath, null));
    const apiPotluckData = normalizeApiPotluckData(await readJsonFile(resolvedPaths.apiPotluckDataFilePath, null));
    const apiPotluckKeys = normalizeApiPotluckKeys(await readJsonFile(resolvedPaths.apiPotluckKeysFilePath, null));

    return {
        resolvedPaths,
        providerPools,
        usageCache,
        tokenStore,
        apiPotluckData,
        apiPotluckKeys
    };
}

function buildRunId() {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `migration_${timestamp}_${randomUUID().slice(0, 8)}`;
}

function buildArtifactPaths(artifactRoot, runId) {
    const runRoot = path.join(artifactRoot, runId);
    return {
        runRoot,
        manifestPath: path.join(runRoot, 'manifest.json'),
        sourceDir: path.join(runRoot, 'source'),
        beforeDir: path.join(runRoot, 'before'),
        exportDir: path.join(runRoot, 'export'),
        reportsDir: path.join(runRoot, 'reports'),
        inventoryReportPath: path.join(runRoot, 'reports', 'inventory-report.json'),
        inventoryMarkdownPath: path.join(runRoot, 'reports', 'inventory-report.md'),
        anomalyReportPath: path.join(runRoot, 'reports', 'anomaly-report.json'),
        anomalyMarkdownPath: path.join(runRoot, 'reports', 'anomaly-report.md'),
        acceptanceSummaryPath: path.join(runRoot, 'reports', 'acceptance-summary.json'),
        acceptanceMarkdownPath: path.join(runRoot, 'reports', 'acceptance-summary.md')
    };
}

async function readJsonArtifactIfExists(filePath, fallback = null) {
    if (!filePath || !fs.existsSync(filePath)) {
        return fallback;
    }

    try {
        const raw = await pfs.readFile(filePath, 'utf8');
        return parseJsonSafe(raw, fallback);
    } catch {
        return fallback;
    }
}

async function loadMigrationArtifacts(resolvedPaths, runId) {
    if (!runId) {
        return {
            artifactPaths: null,
            manifest: null,
            inventoryReport: null,
            anomalyReport: null
        };
    }

    const artifactPaths = buildArtifactPaths(resolvedPaths.artifactRoot, runId);
    return {
        artifactPaths,
        manifest: await readJsonArtifactIfExists(artifactPaths.manifestPath, null),
        inventoryReport: await readJsonArtifactIfExists(artifactPaths.inventoryReportPath, null),
        anomalyReport: await readJsonArtifactIfExists(artifactPaths.anomalyReportPath, null)
    };
}

function normalizeProjectRelativePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        return null;
    }

    const absolutePath = resolvePathMaybeAbsolute(filePath.trim());
    if (!absolutePath) {
        return null;
    }

    return path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');
}

function countJsonEntries(value) {
    if (Array.isArray(value)) {
        return value.length;
    }

    if (value && typeof value === 'object') {
        return Object.keys(value).length;
    }

    return value === undefined || value === null ? 0 : 1;
}

function buildProviderPoolsCountSummary(providerPools = {}) {
    const providerTypeCount = Object.keys(providerPools || {}).length;
    const providerCount = Object.values(providerPools || {}).reduce((count, providers) => {
        return count + (Array.isArray(providers) ? providers.length : 0);
    }, 0);

    return {
        recordCount: providerCount,
        entryCount: providerTypeCount,
        providerTypeCount,
        providerCount
    };
}

function buildUsageCacheCountSummary(usageCache = {}) {
    const providerEntries = Object.entries(usageCache.providers || {});
    const instanceCount = providerEntries.reduce((count, [, providerUsage]) => {
        return count + (Array.isArray(providerUsage?.instances) ? providerUsage.instances.length : 0);
    }, 0);

    return {
        recordCount: providerEntries.length,
        entryCount: instanceCount,
        providerCount: providerEntries.length,
        instanceCount
    };
}

function buildTokenStoreCountSummary(tokenStore = {}) {
    const sessionCount = Object.keys(tokenStore.tokens || {}).length;
    return {
        recordCount: sessionCount,
        entryCount: sessionCount,
        sessionCount
    };
}

function buildApiPotluckDataCountSummary(apiPotluckData = {}) {
    const users = Object.values(apiPotluckData.users || {});
    const credentialCount = users.reduce((count, userData) => {
        return count + (Array.isArray(userData?.credentials) ? userData.credentials.length : 0);
    }, 0);
    const bonusCount = users.reduce((count, userData) => {
        return count + (Array.isArray(userData?.credentialBonuses) ? userData.credentialBonuses.length : 0);
    }, 0);
    const configCount = Object.keys(apiPotluckData.config || {}).length;

    return {
        recordCount: users.length,
        entryCount: credentialCount + bonusCount + configCount,
        userCount: users.length,
        credentialCount,
        bonusCount,
        configCount
    };
}

function buildApiPotluckKeysCountSummary(apiPotluckKeys = {}) {
    const keyCount = Object.keys(apiPotluckKeys.keys || {}).length;
    return {
        recordCount: keyCount,
        entryCount: keyCount,
        keyCount
    };
}

function buildCredentialFileCountSummary(parsedValue) {
    return {
        recordCount: parsedValue ? 1 : 0,
        entryCount: countJsonEntries(parsedValue)
    };
}

async function scanJsonFileForInventory(filePath) {
    const absolutePath = resolvePathMaybeAbsolute(filePath);
    const relativePath = absolutePath
        ? path.relative(process.cwd(), absolutePath).replace(/\\/g, '/')
        : null;

    if (!absolutePath) {
        return {
            absolutePath: null,
            relativePath: filePath || null,
            fileName: filePath ? path.basename(filePath) : null,
            fileSize: null,
            mtime: null,
            checksum: null,
            parseStatus: 'missing',
            parsedValue: null,
            errorMessage: 'file path is empty'
        };
    }

    try {
        const [stats, content] = await Promise.all([
            pfs.stat(absolutePath),
            pfs.readFile(absolutePath)
        ]);
        const rawContent = content.toString('utf8');

        try {
            return {
                absolutePath,
                relativePath,
                fileName: path.basename(absolutePath),
                fileSize: stats.size,
                mtime: stats.mtime.toISOString(),
                checksum: hashValue(content),
                parseStatus: 'parsed',
                parsedValue: JSON.parse(rawContent),
                errorMessage: null
            };
        } catch (error) {
            return {
                absolutePath,
                relativePath,
                fileName: path.basename(absolutePath),
                fileSize: stats.size,
                mtime: stats.mtime.toISOString(),
                checksum: hashValue(content),
                parseStatus: 'parse_failed',
                parsedValue: null,
                errorMessage: error.message
            };
        }
    } catch (error) {
        return {
            absolutePath,
            relativePath,
            fileName: path.basename(absolutePath),
            fileSize: null,
            mtime: null,
            checksum: null,
            parseStatus: error.code === 'ENOENT' ? 'missing' : 'read_failed',
            parsedValue: null,
            errorMessage: error.message
        };
    }
}

function buildCredentialReferenceIndex(providerPools = {}, apiPotluckData = {}) {
    const references = new Map();

    const appendReference = (filePath, providerType, referenceType, referenceId) => {
        const normalizedPath = normalizeProjectRelativePath(filePath);
        if (!normalizedPath) {
            return;
        }

        if (!references.has(normalizedPath)) {
            references.set(normalizedPath, {
                providerTypes: new Set(),
                references: []
            });
        }

        const entry = references.get(normalizedPath);
        if (providerType) {
            entry.providerTypes.add(providerType);
        }
        entry.references.push({
            referenceType,
            referenceId
        });
    };

    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        if (!Array.isArray(providers)) {
            continue;
        }

        for (const providerConfig of providers) {
            for (const [fieldName, fieldValue] of Object.entries(providerConfig || {})) {
                if (!PROVIDER_CREDENTIAL_PATH_SUFFIXES.some((suffix) => fieldName.endsWith(suffix))) {
                    continue;
                }

                appendReference(fieldValue, providerType, 'provider_pool', providerConfig.uuid || providerConfig.customName || fieldName);
            }
        }
    }

    for (const [userId, userData] of Object.entries(apiPotluckData.users || {})) {
        for (const credential of Array.isArray(userData?.credentials) ? userData.credentials : []) {
            appendReference(
                credential?.path,
                credential?.provider || null,
                'potluck_user',
                `${userId}:${credential?.id || credential?.path || 'credential'}`
            );
        }
    }

    return references;
}

async function collectCredentialInventoryCandidates(dirPath, providerType, result = [], depth = 0) {
    try {
        const entries = await pfs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile()) {
                if (path.extname(entry.name).toLowerCase() !== '.json') {
                    continue;
                }

                result.push({
                    providerType,
                    filePath: fullPath,
                    discoveredFrom: 'credential_directory'
                });
                continue;
            }

            if (!entry.isDirectory() || depth >= 2) {
                continue;
            }

            await collectCredentialInventoryCandidates(fullPath, providerType, result, depth + 1);
        }
    } catch (error) {
        logger.warn(`[RuntimeStorageMigration] Failed to scan credential directory ${dirPath}: ${error.message}`);
    }

    return result;
}

function createInventoryItem({ itemType, category, scanResult, countSummary, providerType = null, discoveredFrom = null, references = [] }) {
    return {
        id: createStableId('inventory', [itemType, scanResult.absolutePath || scanResult.relativePath || scanResult.fileName || 'unknown']),
        itemType,
        category,
        path: scanResult.relativePath,
        absolutePath: scanResult.absolutePath,
        fileName: scanResult.fileName,
        fileSize: scanResult.fileSize,
        mtime: scanResult.mtime,
        checksum: scanResult.checksum,
        recordCount: countSummary.recordCount,
        entryCount: countSummary.entryCount,
        countSummary,
        parseStatus: scanResult.parseStatus,
        providerType,
        discoveredFrom,
        references,
        anomalyCodes: [],
        anomalyReasons: []
    };
}

function pushInventoryAnomaly(item, code, reason) {
    if (!item || !code) {
        return;
    }

    if (!item.anomalyCodes.includes(code)) {
        item.anomalyCodes.push(code);
    }
    if (reason && !item.anomalyReasons.includes(reason)) {
        item.anomalyReasons.push(reason);
    }
}

function buildAnomalyRecord(code, reason, extra = {}) {
    return {
        id: createStableId('anomaly', [code, extra.path || JSON.stringify(extra.paths || []), extra.providerType || '', extra.checksum || '']),
        code,
        reason,
        ...extra
    };
}

function buildInventorySummary(items = [], anomalyItems = []) {
    return {
        totalItems: items.length,
        domainFileCount: items.filter((item) => item.category === 'domain').length,
        credentialFileCount: items.filter((item) => item.category === 'credential').length,
        parsedCount: items.filter((item) => item.parseStatus === 'parsed').length,
        parseFailedCount: items.filter((item) => item.parseStatus === 'parse_failed').length,
        anomalyItemCount: items.filter((item) => item.anomalyCodes.length > 0).length,
        anomalyCount: anomalyItems.length
    };
}

function buildAnomalySummary(anomalyItems = []) {
    const codeCounts = anomalyItems.reduce((result, item) => {
        result[item.code] = (result[item.code] || 0) + 1;
        return result;
    }, {});

    return {
        totalAnomalies: anomalyItems.length,
        codeCounts
    };
}

function buildInventoryMarkdown(report) {
    const lines = [
        '# Runtime Storage Inventory Report',
        '',
        `- Generated At: ${report.generatedAt}`,
        `- Total Items: ${report.summary.totalItems}`,
        `- Domain Files: ${report.summary.domainFileCount}`,
        `- Credential Files: ${report.summary.credentialFileCount}`,
        `- Parsed: ${report.summary.parsedCount}`,
        `- Parse Failed: ${report.summary.parseFailedCount}`,
        `- Items With Anomalies: ${report.summary.anomalyItemCount}`,
        ''
    ];

    for (const item of report.items) {
        lines.push(`## ${item.itemType}`);
        lines.push('');
        lines.push(`- Path: ${item.path || item.absolutePath || 'n/a'}`);
        lines.push(`- Parse Status: ${item.parseStatus}`);
        lines.push(`- Record Count: ${item.recordCount}`);
        lines.push(`- Entry Count: ${item.entryCount}`);
        lines.push(`- Provider Type: ${item.providerType || 'n/a'}`);
        if (item.anomalyCodes.length > 0) {
            lines.push(`- Anomalies: ${item.anomalyCodes.join(', ')}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function buildAnomalyMarkdown(report) {
    const lines = [
        '# Runtime Storage Anomaly Report',
        '',
        `- Generated At: ${report.generatedAt}`,
        `- Total Anomalies: ${report.summary.totalAnomalies}`,
        ''
    ];

    for (const anomaly of report.items) {
        lines.push(`- ${anomaly.code}: ${anomaly.reason}`);
        if (anomaly.path) {
            lines.push(`  - Path: ${anomaly.path}`);
        }
        if (Array.isArray(anomaly.paths) && anomaly.paths.length > 0) {
            lines.push(`  - Paths: ${anomaly.paths.join(', ')}`);
        }
    }

    return lines.join('\n');
}

function buildPreflightMigrationItems(inventoryReport, anomalyReport) {
    const inventoryItems = inventoryReport.items.map((item) => ({
        id: item.id,
        itemType: item.itemType,
        sourceRef: item.path || item.absolutePath || item.fileName || item.id,
        targetRef: 'preflight_inventory',
        status: item.anomalyCodes.length > 0 ? 'scanned_with_anomaly' : 'scanned',
        errorMessage: item.anomalyReasons[0] || null,
        detailJson: {
            path: item.path,
            absolutePath: item.absolutePath,
            fileName: item.fileName,
            fileSize: item.fileSize,
            mtime: item.mtime,
            checksum: item.checksum,
            recordCount: item.recordCount,
            entryCount: item.entryCount,
            parseStatus: item.parseStatus,
            providerType: item.providerType,
            discoveredFrom: item.discoveredFrom,
            references: item.references,
            anomalyCodes: item.anomalyCodes,
            anomalyReasons: item.anomalyReasons
        }
    }));
    const anomalyItems = anomalyReport.items.map((item) => ({
        id: item.id,
        itemType: 'preflight_anomaly',
        sourceRef: item.path || item.paths?.[0] || item.id,
        targetRef: 'anomaly_report',
        status: 'detected',
        errorMessage: item.reason,
        detailJson: item
    }));

    return [...inventoryItems, ...anomalyItems];
}

async function buildPreflightReports(sourceBundle, resolvedPaths, artifactPaths) {
    const inventoryItems = [];
    const anomalyItems = [];
    const referencedCredentials = buildCredentialReferenceIndex(sourceBundle.providerPools, sourceBundle.apiPotluckData);

    const domainDefinitions = [
        {
            itemType: 'provider_pools_file',
            filePath: resolvedPaths.providerPoolsFilePath,
            countSummary: buildProviderPoolsCountSummary(sourceBundle.providerPools)
        },
        {
            itemType: 'usage_cache_file',
            filePath: resolvedPaths.usageCacheFilePath,
            countSummary: buildUsageCacheCountSummary(sourceBundle.usageCache)
        },
        {
            itemType: 'token_store_file',
            filePath: resolvedPaths.tokenStoreFilePath,
            countSummary: buildTokenStoreCountSummary(sourceBundle.tokenStore)
        },
        {
            itemType: 'api_potluck_data_file',
            filePath: resolvedPaths.apiPotluckDataFilePath,
            countSummary: buildApiPotluckDataCountSummary(sourceBundle.apiPotluckData)
        },
        {
            itemType: 'api_potluck_keys_file',
            filePath: resolvedPaths.apiPotluckKeysFilePath,
            countSummary: buildApiPotluckKeysCountSummary(sourceBundle.apiPotluckKeys)
        }
    ];

    for (const definition of domainDefinitions) {
        const scanResult = await scanJsonFileForInventory(definition.filePath);
        const inventoryItem = createInventoryItem({
            itemType: definition.itemType,
            category: 'domain',
            scanResult,
            countSummary: definition.countSummary
        });

        if (scanResult.parseStatus === 'parse_failed' || scanResult.parseStatus === 'read_failed') {
            pushInventoryAnomaly(inventoryItem, 'parse_failed_domain_file', scanResult.errorMessage || 'Failed to parse runtime source file');
            anomalyItems.push(buildAnomalyRecord('parse_failed_domain_file', scanResult.errorMessage || 'Failed to parse runtime source file', {
                path: inventoryItem.path,
                itemType: inventoryItem.itemType
            }));
        }

        inventoryItems.push(inventoryItem);
    }

    const credentialCandidates = [];
    for (const mapping of PROVIDER_MAPPINGS) {
        const directoryPath = path.join(resolvedPaths.legacyBaseDir, mapping.dirName);
        if (!fs.existsSync(directoryPath)) {
            continue;
        }

        await collectCredentialInventoryCandidates(directoryPath, mapping.providerType, credentialCandidates);
    }

    const credentialItemsByPath = new Map();
    const addCredentialInventoryItem = async (candidate, discoveredFrom) => {
        const normalizedPath = normalizeProjectRelativePath(candidate.filePath);
        if (!normalizedPath || credentialItemsByPath.has(normalizedPath)) {
            return;
        }

        const scanResult = await scanJsonFileForInventory(candidate.filePath);
        const referenceInfo = referencedCredentials.get(normalizedPath);
        const inventoryItem = createInventoryItem({
            itemType: 'credential_file',
            category: 'credential',
            scanResult,
            countSummary: buildCredentialFileCountSummary(scanResult.parsedValue),
            providerType: candidate.providerType || (referenceInfo ? Array.from(referenceInfo.providerTypes)[0] : null),
            discoveredFrom,
            references: referenceInfo?.references || []
        });

        if (scanResult.parseStatus === 'parse_failed' || scanResult.parseStatus === 'read_failed') {
            pushInventoryAnomaly(inventoryItem, 'parse_failed_credential_file', scanResult.errorMessage || 'Failed to parse credential file');
            anomalyItems.push(buildAnomalyRecord('parse_failed_credential_file', scanResult.errorMessage || 'Failed to parse credential file', {
                path: inventoryItem.path,
                providerType: inventoryItem.providerType
            }));
        } else if (scanResult.parseStatus === 'parsed') {
            const validCredential = await isValidOAuthCredentials(scanResult.absolutePath);
            if (!validCredential) {
                pushInventoryAnomaly(inventoryItem, 'invalid_credential_file', 'Credential file does not match expected OAuth/token payload');
                anomalyItems.push(buildAnomalyRecord('invalid_credential_file', 'Credential file does not match expected OAuth/token payload', {
                    path: inventoryItem.path,
                    providerType: inventoryItem.providerType
                }));
            }
        }

        if (!referenceInfo && discoveredFrom === 'credential_directory') {
            pushInventoryAnomaly(inventoryItem, 'orphan_credential_file', 'Credential file is not referenced by provider pools or potluck data');
            anomalyItems.push(buildAnomalyRecord('orphan_credential_file', 'Credential file is not referenced by provider pools or potluck data', {
                path: inventoryItem.path,
                providerType: inventoryItem.providerType
            }));
        }

        if (referenceInfo && scanResult.parseStatus === 'missing') {
            pushInventoryAnomaly(inventoryItem, 'missing_referenced_credential_file', 'Referenced credential file is missing');
            anomalyItems.push(buildAnomalyRecord('missing_referenced_credential_file', 'Referenced credential file is missing', {
                path: inventoryItem.path,
                providerType: inventoryItem.providerType,
                references: referenceInfo.references
            }));
        }

        credentialItemsByPath.set(normalizedPath, inventoryItem);
        inventoryItems.push(inventoryItem);
    };

    for (const candidate of credentialCandidates) {
        await addCredentialInventoryItem(candidate, 'credential_directory');
    }

    for (const [referencedPath, referenceInfo] of referencedCredentials.entries()) {
        if (credentialItemsByPath.has(referencedPath)) {
            continue;
        }

        await addCredentialInventoryItem({
            providerType: Array.from(referenceInfo.providerTypes)[0] || null,
            filePath: referencedPath
        }, 'referenced_path');
    }

    const duplicateGroups = new Map();
    for (const item of inventoryItems) {
        if (item.category !== 'credential' || !item.checksum || item.parseStatus !== 'parsed') {
            continue;
        }

        const duplicateKey = `${item.providerType || 'unknown'}::${item.checksum}`;
        if (!duplicateGroups.has(duplicateKey)) {
            duplicateGroups.set(duplicateKey, []);
        }
        duplicateGroups.get(duplicateKey).push(item);
    }

    for (const duplicateItems of duplicateGroups.values()) {
        if (duplicateItems.length <= 1) {
            continue;
        }

        const duplicatePaths = duplicateItems.map((item) => item.path || item.absolutePath).filter(Boolean);
        for (const item of duplicateItems) {
            pushInventoryAnomaly(item, 'duplicate_credential_file', `Duplicate credential checksum matched: ${duplicatePaths.join(', ')}`);
        }
        anomalyItems.push(buildAnomalyRecord('duplicate_credential_file', 'Multiple credential files share the same checksum within one provider type', {
            paths: duplicatePaths,
            providerType: duplicateItems[0].providerType,
            checksum: duplicateItems[0].checksum
        }));
    }

    const providerPoolsDir = path.dirname(resolvedPaths.providerPoolsFilePath);
    const providerPoolsBaseName = path.basename(resolvedPaths.providerPoolsFilePath);
    try {
        const providerPoolsDirEntries = await pfs.readdir(providerPoolsDir, { withFileTypes: true });
        for (const entry of providerPoolsDirEntries) {
            if (!entry.isFile() || !entry.name.startsWith(`${providerPoolsBaseName}.`) || !entry.name.endsWith('.tmp')) {
                continue;
            }

            const tmpScanResult = await scanJsonFileForInventory(path.join(providerPoolsDir, entry.name));
            anomalyItems.push(buildAnomalyRecord('provider_pools_tmp_file', 'Legacy provider_pools temporary file residue detected', {
                path: tmpScanResult.relativePath,
                checksum: tmpScanResult.checksum,
                fileSize: tmpScanResult.fileSize,
                mtime: tmpScanResult.mtime
            }));
        }
    } catch (error) {
        logger.warn(`[RuntimeStorageMigration] Failed to inspect provider pools temp files: ${error.message}`);
    }

    const inventoryReport = {
        generatedAt: nowIso(),
        summary: buildInventorySummary(inventoryItems, anomalyItems),
        items: inventoryItems.map((item) => ({
            ...item,
            references: item.references,
            anomalyCodes: item.anomalyCodes,
            anomalyReasons: item.anomalyReasons
        }))
    };
    const anomalyReport = {
        generatedAt: nowIso(),
        summary: buildAnomalySummary(anomalyItems),
        items: anomalyItems
    };

    await writeJsonFile(artifactPaths.inventoryReportPath, inventoryReport);
    await ensureDirectory(path.dirname(artifactPaths.inventoryMarkdownPath));
    await pfs.writeFile(artifactPaths.inventoryMarkdownPath, `${buildInventoryMarkdown(inventoryReport)}\n`, 'utf8');
    await writeJsonFile(artifactPaths.anomalyReportPath, anomalyReport);
    await pfs.writeFile(artifactPaths.anomalyMarkdownPath, `${buildAnomalyMarkdown(anomalyReport)}\n`, 'utf8');

    return {
        inventoryReport,
        anomalyReport,
        migrationItems: buildPreflightMigrationItems(inventoryReport, anomalyReport)
    };
}

function buildProviderRegistryComparable(providerPools = {}) {
    const entries = [];

    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        if (!Array.isArray(providers)) {
            continue;
        }

        for (const providerConfig of providers) {
            const normalized = splitProviderConfig(providerType, providerConfig);
            entries.push({
                providerId: normalized.registration.providerId,
                providerType: normalized.registration.providerType,
                uuid: normalized.registration.routingUuid,
                displayName: normalized.registration.displayName,
                checkModel: normalized.registration.checkModel,
                projectId: normalized.registration.projectId,
                baseUrl: normalized.registration.baseUrl,
                configHash: hashValue(normalized.registration.configJson),
                secretKinds: normalized.inlineSecrets.map((secret) => secret.secretKind).sort()
            });
        }
    }

    return entries.sort((left, right) => {
        return `${left.providerType}:${left.uuid}`.localeCompare(`${right.providerType}:${right.uuid}`);
    });
}

function buildProviderRuntimeComparable(providerPools = {}, persistSelectionState = false) {
    const entries = [];

    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        if (!Array.isArray(providers)) {
            continue;
        }

        for (const providerConfig of providers) {
            const normalized = splitProviderConfig(providerType, providerConfig);
            const runtimeState = {
                providerId: normalized.runtimeState.providerId,
                providerType,
                uuid: normalized.registration.routingUuid,
                isHealthy: normalized.runtimeState.isHealthy,
                isDisabled: normalized.runtimeState.isDisabled,
                usageCount: normalized.runtimeState.usageCount,
                errorCount: normalized.runtimeState.errorCount,
                lastUsed: normalized.runtimeState.lastUsed,
                lastHealthCheckTime: normalized.runtimeState.lastHealthCheckTime,
                lastHealthCheckModel: normalized.runtimeState.lastHealthCheckModel,
                lastErrorTime: normalized.runtimeState.lastErrorTime,
                lastErrorMessage: normalized.runtimeState.lastErrorMessage,
                scheduledRecoveryTime: normalized.runtimeState.scheduledRecoveryTime,
                refreshCount: normalized.runtimeState.refreshCount
            };

            if (persistSelectionState) {
                runtimeState.lastSelectionSeq = normalized.runtimeState.lastSelectionSeq;
            }

            entries.push(runtimeState);
        }
    }

    return entries.sort((left, right) => {
        return `${left.providerType}:${left.uuid}`.localeCompare(`${right.providerType}:${right.uuid}`);
    });
}

async function buildFileReferenceMetadata(relativePath) {
    const absolutePath = resolvePathMaybeAbsolute(relativePath);
    if (!absolutePath || !fs.existsSync(absolutePath)) {
        return {
            fileName: relativePath ? path.basename(relativePath) : null,
            fileSize: null,
            checksum: null,
            mtime: null
        };
    }

    const [stats, content] = await Promise.all([
        pfs.stat(absolutePath),
        pfs.readFile(absolutePath)
    ]);

    return {
        fileName: path.basename(relativePath),
        fileSize: stats.size,
        checksum: hashValue(content),
        mtime: stats.mtime.toISOString()
    };
}

function buildCredentialAssetComparableKey(providerType, relativePath) {
    return `${providerType}::${normalizeRelativePath(relativePath)}`;
}

function buildCredentialBindingKey(bindingType, bindingTargetId, assetKey) {
    return `${bindingType}::${bindingTargetId}::${assetKey}`;
}

async function collectExpectedCredentialState(providerPools = {}, apiPotluckData = {}) {
    const assets = new Map();
    const bindings = new Map();
    const potluckUserCredentialLinks = new Map();
    const potluckUserIds = new Map();

    const ensureAssetRecord = async (providerType, relativePath, sourceKind, metadata = {}) => {
        const normalizedPath = normalizeRelativePath(relativePath);
        if (!providerType || !normalizedPath) {
            return null;
        }

        const assetKey = buildCredentialAssetComparableKey(providerType, normalizedPath);
        if (assets.has(assetKey)) {
            return assets.get(assetKey);
        }

        const fileMetadata = await buildFileReferenceMetadata(normalizedPath);
        const assetRecord = {
            id: createStableId('cred', [providerType, normalizedPath]),
            providerType,
            identityKey: metadata.identityKey || normalizedPath,
            dedupeKey: assetKey,
            sourceKind,
            sourcePath: normalizedPath,
            sourceChecksum: fileMetadata.checksum,
            storageMode: 'file_reference',
            isActive: true,
            fileIndex: {
                id: createStableId('cfi', [providerType, normalizedPath]),
                filePath: normalizedPath,
                fileName: fileMetadata.fileName,
                fileSize: fileMetadata.fileSize,
                checksum: fileMetadata.checksum,
                mtime: fileMetadata.mtime,
                isPrimary: true
            }
        };

        assets.set(assetKey, assetRecord);
        return assetRecord;
    };

    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        if (!Array.isArray(providers)) {
            continue;
        }

        for (const providerConfig of providers) {
            const providerId = buildStableProviderId(providerType, providerConfig);
            for (const [fieldName, fieldValue] of Object.entries(providerConfig || {})) {
                if (!PROVIDER_CREDENTIAL_PATH_SUFFIXES.some((suffix) => fieldName.endsWith(suffix))) {
                    continue;
                }

                const assetRecord = await ensureAssetRecord(
                    providerType,
                    fieldValue,
                    'provider_pools_json',
                    { identityKey: `${providerId}:${fieldName}` }
                );
                if (!assetRecord) {
                    continue;
                }

                const bindingKey = buildCredentialBindingKey('provider_registration', providerId, assetRecord.dedupeKey);
                bindings.set(bindingKey, {
                    id: createStableId('bind', ['provider_registration', providerId, assetRecord.id]),
                    bindingType: 'provider_registration',
                    bindingTargetId: providerId,
                    bindingStatus: 'active',
                    credentialAssetId: assetRecord.id,
                    assetKey: assetRecord.dedupeKey
                });
            }
        }
    }

    for (const [userIdentifier, userData] of Object.entries(apiPotluckData.users || {})) {
        const potluckUserId = createStableId('potluck_user', [userIdentifier]);
        potluckUserIds.set(userIdentifier, potluckUserId);

        for (const credential of userData.credentials || []) {
            const providerType = credential.provider || 'unknown';
            const assetRecord = await ensureAssetRecord(
                providerType,
                credential.path,
                'api_potluck_data',
                { identityKey: credential.id || credential.path || `${userIdentifier}:${providerType}` }
            );
            if (!assetRecord) {
                continue;
            }

            const bindingKey = buildCredentialBindingKey('potluck_user', potluckUserId, assetRecord.dedupeKey);
            bindings.set(bindingKey, {
                id: createStableId('bind', ['potluck_user', potluckUserId, assetRecord.id]),
                bindingType: 'potluck_user',
                bindingTargetId: potluckUserId,
                bindingStatus: 'linked',
                credentialAssetId: assetRecord.id,
                assetKey: assetRecord.dedupeKey
            });

            const linkKey = `${potluckUserId}::${assetRecord.id}`;
            potluckUserCredentialLinks.set(linkKey, {
                id: createStableId('puc', [potluckUserId, assetRecord.id]),
                userId: potluckUserId,
                credentialAssetId: assetRecord.id,
                providerType,
                bindingStatus: 'linked',
                linkedAt: normalizeTimestamp(credential.addedAt, null),
                metaJson: JSON.stringify(sortObject({
                    legacyCredentialId: credential.id || null,
                    authMethod: credential.authMethod || null
                }))
            });
        }
    }

    return {
        assets: Array.from(assets.values()).sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey)),
        bindings: Array.from(bindings.values()).sort((left, right) => {
            return `${left.bindingType}:${left.bindingTargetId}:${left.assetKey}`
                .localeCompare(`${right.bindingType}:${right.bindingTargetId}:${right.assetKey}`);
        }),
        potluckUserCredentialLinks: Array.from(potluckUserCredentialLinks.values()).sort((left, right) => {
            return `${left.userId}:${left.credentialAssetId}`.localeCompare(`${right.userId}:${right.credentialAssetId}`);
        }),
        potluckUserIds
    };
}

async function recordMigrationRunStart(client, runId, summary = {}) {
    const timestamp = nowIso();
    await client.exec(`
INSERT INTO storage_migration_runs (
    id,
    migration_type,
    source_version,
    status,
    summary_json,
    started_at,
    finished_at
) VALUES (
    ${sqlValue(runId)},
    'legacy_file_to_sqlite_runtime_storage',
    'v1',
    'running',
    ${sqlValue(JSON.stringify(sortObject(summary)))},
    ${sqlValue(timestamp)},
    NULL
) ON CONFLICT(id) DO UPDATE SET
    migration_type = excluded.migration_type,
    source_version = excluded.source_version,
    status = excluded.status,
    summary_json = excluded.summary_json,
    started_at = COALESCE(storage_migration_runs.started_at, excluded.started_at),
    finished_at = NULL;
    `);
}

async function updateMigrationRun(client, runId, status, summary = {}) {
    const timestamp = nowIso();
    await client.exec(`
UPDATE storage_migration_runs
SET status = ${sqlValue(status)},
    summary_json = ${sqlValue(JSON.stringify(sortObject(summary)))},
    finished_at = ${sqlValue(timestamp)}
WHERE id = ${sqlValue(runId)};
    `);
}

async function insertMigrationItems(client, runId, items = []) {
    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    const statements = ['BEGIN IMMEDIATE;'];
    for (const item of items) {
        statements.push(`
INSERT INTO storage_migration_items (
    id,
    run_id,
    item_type,
    source_ref,
    target_ref,
    status,
    error_message,
    detail_json,
    created_at
) VALUES (
    ${sqlValue(item.id || createStableId('migitem', [runId, item.itemType, item.sourceRef, item.targetRef || '']))},
    ${sqlValue(runId)},
    ${sqlValue(item.itemType)},
    ${sqlValue(item.sourceRef || null)},
    ${sqlValue(item.targetRef || null)},
    ${sqlValue(item.status || 'completed')},
    ${sqlValue(item.errorMessage || null)},
    ${sqlValue(JSON.stringify(sortObject(item.detailJson || {})))},
    ${sqlValue(item.createdAt || nowIso())}
) ON CONFLICT(id) DO UPDATE SET
    run_id = excluded.run_id,
    item_type = excluded.item_type,
    source_ref = excluded.source_ref,
    target_ref = excluded.target_ref,
    status = excluded.status,
    error_message = excluded.error_message,
    detail_json = excluded.detail_json,
    created_at = excluded.created_at;
        `);
    }
    statements.push('COMMIT;');
    await client.exec(statements.join('\n'));
}

async function queryProviderRows(client) {
    return await client.query(`
SELECT
    r.provider_id,
    r.provider_type,
    r.routing_uuid,
    r.display_name,
    r.check_model,
    r.project_id,
    r.base_url,
    r.config_json,
    s.is_healthy,
    s.is_disabled,
    s.usage_count,
    s.error_count,
    s.last_used_at,
    s.last_health_check_at,
    s.last_health_check_model,
    s.last_error_time,
    s.last_error_message,
    s.scheduled_recovery_at,
    s.refresh_count,
    s.last_selection_seq
FROM provider_registrations r
LEFT JOIN provider_runtime_state s
    ON s.provider_id = r.provider_id
ORDER BY r.provider_type ASC, r.routing_uuid ASC;
    `);
}

async function querySecretRows(client) {
    return await client.query(`
SELECT provider_id, secret_kind, secret_payload, protection_mode
FROM provider_inline_secrets
ORDER BY provider_id ASC, secret_kind ASC;
    `);
}

async function clearCredentialDomain(client) {
    await client.exec(`
BEGIN IMMEDIATE;
DELETE FROM potluck_user_credentials;
DELETE FROM credential_bindings;
DELETE FROM credential_file_index;
DELETE FROM credential_secret_blobs;
DELETE FROM credential_assets;
COMMIT;
    `);
}

async function clearUsageDomain(client) {
    await client.exec(`
BEGIN IMMEDIATE;
DELETE FROM usage_refresh_tasks;
DELETE FROM usage_snapshots;
DELETE FROM runtime_settings
WHERE scope = 'usage_cache' AND key = 'timestamp';
COMMIT;
    `);
}

async function clearSessionDomain(client) {
    await client.exec(`
BEGIN IMMEDIATE;
DELETE FROM admin_sessions;
COMMIT;
    `);
}

async function clearPotluckDomain(client) {
    await client.exec(`
BEGIN IMMEDIATE;
DELETE FROM potluck_key_usage_daily;
DELETE FROM potluck_api_keys;
DELETE FROM potluck_user_credentials;
DELETE FROM potluck_users;
DELETE FROM potluck_config;
DELETE FROM runtime_settings
WHERE scope = 'potluck_api_key_legacy'
   OR scope = 'migration_manifest'
   OR (scope = 'compat_export' AND key IN (
        'api-potluck-data',
        'api-potluck-keys'
   ));
COMMIT;
    `);
}

async function importCredentialState(client, credentialState, timestamp) {
    const statements = ['BEGIN IMMEDIATE;'];

    for (const asset of credentialState.assets) {
        statements.push(`
INSERT INTO credential_assets (
    id,
    provider_type,
    identity_key,
    dedupe_key,
    email,
    account_id,
    external_user_id,
    source_kind,
    source_path,
    source_checksum,
    storage_mode,
    is_active,
    last_imported_at,
    last_refreshed_at,
    created_at,
    updated_at
) VALUES (
    ${sqlValue(asset.id)},
    ${sqlValue(asset.providerType)},
    ${sqlValue(asset.identityKey)},
    ${sqlValue(asset.dedupeKey)},
    NULL,
    NULL,
    NULL,
    ${sqlValue(asset.sourceKind)},
    ${sqlValue(asset.sourcePath)},
    ${sqlValue(asset.sourceChecksum)},
    ${sqlValue(asset.storageMode)},
    ${sqlValue(asset.isActive)},
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)}
);
        `);

        statements.push(`
INSERT INTO credential_file_index (
    id,
    credential_asset_id,
    file_path,
    file_name,
    file_size,
    checksum,
    mtime,
    is_primary,
    created_at,
    updated_at
) VALUES (
    ${sqlValue(asset.fileIndex.id)},
    ${sqlValue(asset.id)},
    ${sqlValue(asset.fileIndex.filePath)},
    ${sqlValue(asset.fileIndex.fileName)},
    ${sqlValue(asset.fileIndex.fileSize)},
    ${sqlValue(asset.fileIndex.checksum)},
    ${sqlValue(asset.fileIndex.mtime)},
    ${sqlValue(asset.fileIndex.isPrimary)},
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)}
);
        `);
    }

    for (const binding of credentialState.bindings) {
        statements.push(`
INSERT INTO credential_bindings (
    id,
    credential_asset_id,
    binding_type,
    binding_target_id,
    binding_status,
    created_at,
    updated_at
) VALUES (
    ${sqlValue(binding.id)},
    ${sqlValue(binding.credentialAssetId)},
    ${sqlValue(binding.bindingType)},
    ${sqlValue(binding.bindingTargetId)},
    ${sqlValue(binding.bindingStatus)},
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)}
);
        `);
    }

    statements.push('COMMIT;');
    await client.exec(statements.join('\n'));
}

function createSqliteRuntimeStorageView(client) {
    const storage = new SqliteRuntimeStorage({
        RUNTIME_STORAGE_DB_PATH: client?.dbPath || 'configs/runtime/runtime-storage.sqlite'
    });
    storage.client = client;
    storage.initialized = true;
    return storage;
}

async function importUsageCache(client, usageCache, timestamp) {
    const storage = createSqliteRuntimeStorageView(client);
    await storage.replaceUsageCacheSnapshot(normalizeUsageCache(usageCache));
}

async function importTokenStore(client, tokenStore, timestamp) {
    const statements = ['BEGIN IMMEDIATE;'];

    for (const [token, tokenInfo] of Object.entries(tokenStore.tokens || {})) {
        const sessionRecord = buildAdminSessionImportRecord(token, tokenInfo, timestamp);
        statements.push(`
INSERT INTO admin_sessions (
    id,
    token_hash,
    subject,
    expires_at,
    created_at,
    last_seen_at,
    source_ip,
    user_agent,
    meta_json
) VALUES (
    ${sqlValue(sessionRecord.id)},
    ${sqlValue(sessionRecord.tokenHash)},
    ${sqlValue(sessionRecord.subject)},
    ${sqlValue(sessionRecord.expiresAt)},
    ${sqlValue(sessionRecord.createdAt)},
    ${sqlValue(timestamp)},
    ${sqlValue(sessionRecord.sourceIp)},
    ${sqlValue(sessionRecord.userAgent)},
    ${sqlValue(JSON.stringify(sessionRecord.metaJson || {}))}
)
ON CONFLICT(id) DO UPDATE SET
    token_hash = excluded.token_hash,
    subject = excluded.subject,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at,
    last_seen_at = excluded.last_seen_at,
    source_ip = excluded.source_ip,
    user_agent = excluded.user_agent,
    meta_json = excluded.meta_json;
        `);
    }

    statements.push('COMMIT;');
    await client.exec(statements.join('\n'));
}

function buildPotluckUserRow(userIdentifier, userData, timestamp) {
    const userId = createStableId('potluck_user', [userIdentifier]);
    return {
        id: userId,
        userIdentifier,
        displayName: null,
        status: 'active',
        dailyLimit: null,
        bonusRemaining: null,
        bonusExpiresAt: null,
        metaJson: JSON.stringify(sortObject({
            credentials: userData.credentials || [],
            credentialBonuses: userData.credentialBonuses || [],
            sourceCreatedAt: userData.createdAt || null
        })),
        createdAt: userData.createdAt || timestamp,
        updatedAt: timestamp
    };
}

async function importPotluckData(client, apiPotluckData, credentialState, timestamp) {
    const statements = ['BEGIN IMMEDIATE;'];

    for (const [configKey, configValue] of Object.entries(apiPotluckData.config || {})) {
        statements.push(`
INSERT INTO potluck_config (key, value_json, updated_at)
VALUES (
    ${sqlValue(configKey)},
    ${sqlValue(JSON.stringify(configValue))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
        `);
    }

    for (const [userIdentifier, userData] of Object.entries(apiPotluckData.users || {})) {
        const userRow = buildPotluckUserRow(userIdentifier, userData, timestamp);
        statements.push(`
INSERT INTO potluck_users (
    id,
    user_identifier,
    display_name,
    status,
    daily_limit,
    bonus_remaining,
    bonus_expires_at,
    meta_json,
    created_at,
    updated_at
) VALUES (
    ${sqlValue(userRow.id)},
    ${sqlValue(userRow.userIdentifier)},
    ${sqlValue(userRow.displayName)},
    ${sqlValue(userRow.status)},
    ${sqlValue(userRow.dailyLimit)},
    ${sqlValue(userRow.bonusRemaining)},
    ${sqlValue(userRow.bonusExpiresAt)},
    ${sqlValue(userRow.metaJson)},
    ${sqlValue(userRow.createdAt)},
    ${sqlValue(userRow.updatedAt)}
);
        `);
    }

    for (const link of credentialState.potluckUserCredentialLinks) {
        statements.push(`
INSERT INTO potluck_user_credentials (
    id,
    user_id,
    credential_asset_id,
    provider_type,
    binding_status,
    linked_at,
    meta_json
) VALUES (
    ${sqlValue(link.id)},
    ${sqlValue(link.userId)},
    ${sqlValue(link.credentialAssetId)},
    ${sqlValue(link.providerType)},
    ${sqlValue(link.bindingStatus)},
    ${sqlValue(link.linkedAt)},
    ${sqlValue(link.metaJson)}
);
        `);
    }

    statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'compat_export',
    'api-potluck-data',
    ${sqlValue(JSON.stringify(sortObject(apiPotluckData)))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
    `);
    statements.push('COMMIT;');

    await client.exec(statements.join('\n'));
}

async function importPotluckKeys(client, apiPotluckKeys, timestamp) {
    const statements = ['BEGIN IMMEDIATE;'];

    for (const [keyId, keyData] of Object.entries(apiPotluckKeys.keys || {})) {
        const ownerUserId = keyData.ownerUserId
            ? createStableId('potluck_user', [keyData.ownerUserId])
            : null;
        statements.push(`
INSERT INTO potluck_api_keys (
    id,
    key_id,
    key_hash,
    name,
    enabled,
    daily_limit,
    used_today,
    bonus_remaining,
    last_reset_at,
    owner_user_id,
    created_at,
    updated_at
) VALUES (
    ${sqlValue(createStableId('potkey', [keyId]))},
    ${sqlValue(keyData.id || keyId)},
    ${sqlValue(hashValue(keyData.id || keyId))},
    ${sqlValue(keyData.name || null)},
    ${sqlValue(toSqlBoolean(keyData.enabled !== false))},
    ${sqlValue(keyData.dailyLimit ?? null)},
    ${sqlValue(keyData.todayUsage ?? 0)},
    ${sqlValue(keyData.bonusRemaining ?? 0)},
    ${sqlValue(keyData.lastResetDate || null)},
    ${sqlValue(ownerUserId)},
    ${sqlValue(keyData.createdAt || timestamp)},
    ${sqlValue(timestamp)}
);
        `);
        statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'potluck_api_key_legacy',
    ${sqlValue(keyData.id || keyId)},
    ${sqlValue(JSON.stringify(sortObject(keyData)))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
        `);
    }

    statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'compat_export',
    'api-potluck-keys',
    ${sqlValue(JSON.stringify(sortObject(apiPotluckKeys)))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
    `);
    statements.push('COMMIT;');

    await client.exec(statements.join('\n'));
}

async function queryCredentialState(client) {
    const assetRows = await client.query(`
SELECT id, provider_type, identity_key, dedupe_key, source_kind, source_path, source_checksum, storage_mode, is_active
FROM credential_assets
ORDER BY dedupe_key ASC;
    `);
    const bindingRows = await client.query(`
SELECT id, credential_asset_id, binding_type, binding_target_id, binding_status
FROM credential_bindings
ORDER BY binding_type ASC, binding_target_id ASC, credential_asset_id ASC;
    `);
    const fileIndexRows = await client.query(`
SELECT id, credential_asset_id, file_path, file_name, file_size, checksum, mtime, is_primary
FROM credential_file_index
ORDER BY credential_asset_id ASC, file_path ASC;
    `);
    const potluckUserCredentialRows = await client.query(`
SELECT id, user_id, credential_asset_id, provider_type, binding_status, linked_at, meta_json
FROM potluck_user_credentials
ORDER BY user_id ASC, credential_asset_id ASC;
    `);

    const fileIndexByAssetId = new Map();
    for (const fileIndexRow of fileIndexRows) {
        if (!fileIndexByAssetId.has(fileIndexRow.credential_asset_id)) {
            fileIndexByAssetId.set(fileIndexRow.credential_asset_id, []);
        }
        fileIndexByAssetId.get(fileIndexRow.credential_asset_id).push(fileIndexRow);
    }

    const assetRowsWithIndex = assetRows.map((assetRow) => ({
        id: assetRow.id,
        providerType: assetRow.provider_type,
        identityKey: assetRow.identity_key,
        dedupeKey: assetRow.dedupe_key,
        sourceKind: assetRow.source_kind,
        sourcePath: assetRow.source_path,
        sourceChecksum: assetRow.source_checksum,
        storageMode: assetRow.storage_mode,
        isActive: Boolean(assetRow.is_active),
        fileIndex: (fileIndexByAssetId.get(assetRow.id) || [])[0]
            ? {
                id: fileIndexByAssetId.get(assetRow.id)[0].id,
                filePath: fileIndexByAssetId.get(assetRow.id)[0].file_path,
                fileName: fileIndexByAssetId.get(assetRow.id)[0].file_name,
                fileSize: fileIndexByAssetId.get(assetRow.id)[0].file_size,
                checksum: fileIndexByAssetId.get(assetRow.id)[0].checksum,
                mtime: fileIndexByAssetId.get(assetRow.id)[0].mtime,
                isPrimary: Boolean(fileIndexByAssetId.get(assetRow.id)[0].is_primary)
            }
            : null
    }));

    const bindings = bindingRows.map((bindingRow) => {
        const asset = assetRowsWithIndex.find((assetRow) => assetRow.id === bindingRow.credential_asset_id);
        return {
            id: bindingRow.id,
            credentialAssetId: bindingRow.credential_asset_id,
            bindingType: bindingRow.binding_type,
            bindingTargetId: bindingRow.binding_target_id,
            bindingStatus: bindingRow.binding_status,
            assetKey: asset?.dedupeKey || null
        };
    });

    return {
        assets: assetRowsWithIndex,
        bindings,
        potluckUserCredentialLinks: potluckUserCredentialRows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            credentialAssetId: row.credential_asset_id,
            providerType: row.provider_type,
            bindingStatus: row.binding_status,
            linkedAt: row.linked_at,
            metaJson: row.meta_json
        }))
    };
}

async function exportUsageCacheFromDb(client) {
    const storage = createSqliteRuntimeStorageView(client);
    const usageCache = await storage.loadUsageCacheSnapshot();
    return normalizeUsageCache(usageCache);
}

function buildAdminSessionsSummary(sessions = []) {
    return {
        sessionCount: sessions.length
    };
}

function buildExpectedAdminSessionState(tokenStore = {}) {
    return Object.entries(tokenStore.tokens || {})
        .map(([token, tokenInfo]) => buildComparableAdminSessionFromToken(token, tokenInfo))
        .sort((left, right) => left.tokenHash.localeCompare(right.tokenHash));
}

async function queryAdminSessionState(client) {
    const rows = await client.query(`
SELECT token_hash, subject, expires_at, created_at, source_ip, user_agent, meta_json
FROM admin_sessions
ORDER BY created_at ASC, id ASC;
    `);

    const sessions = rows
        .map((row) => buildComparableAdminSessionFromRow(row))
        .sort((left, right) => left.tokenHash.localeCompare(right.tokenHash));

    return {
        sessions,
        summary: buildAdminSessionsSummary(sessions)
    };
}

async function exportApiPotluckDataFromDb(client) {
    const compatRow = await client.query(`
SELECT value_json
FROM runtime_settings
WHERE scope = 'compat_export' AND key = 'api-potluck-data'
LIMIT 1;
    `);

    if (compatRow[0]?.value_json) {
        return normalizeApiPotluckData(parseJsonSafe(compatRow[0].value_json, null));
    }

    const configRows = await client.query(`SELECT key, value_json FROM potluck_config ORDER BY key ASC;`);
    const userRows = await client.query(`SELECT id, user_identifier, meta_json, created_at FROM potluck_users ORDER BY user_identifier ASC;`);
    const userCredentialRows = await client.query(`SELECT user_id, credential_asset_id, provider_type, linked_at, meta_json FROM potluck_user_credentials ORDER BY user_id ASC, credential_asset_id ASC;`);
    const assetRows = await client.query(`SELECT id, source_path FROM credential_assets ORDER BY id ASC;`);

    const assetPathById = new Map(assetRows.map((row) => [row.id, row.source_path]));
    const credentialsByUserId = new Map();
    for (const row of userCredentialRows) {
        if (!credentialsByUserId.has(row.user_id)) {
            credentialsByUserId.set(row.user_id, []);
        }

        const meta = parseJsonSafe(row.meta_json, {});
        credentialsByUserId.get(row.user_id).push({
            id: meta.legacyCredentialId || row.credential_asset_id,
            path: assetPathById.get(row.credential_asset_id) || null,
            provider: row.provider_type,
            authMethod: meta.authMethod || null,
            addedAt: row.linked_at || null
        });
    }

    const config = {};
    for (const row of configRows) {
        config[row.key] = parseJsonSafe(row.value_json, row.value_json);
    }

    const users = {};
    for (const row of userRows) {
        const meta = parseJsonSafe(row.meta_json, {});
        users[row.user_identifier] = {
            credentials: credentialsByUserId.get(row.id) || meta.credentials || [],
            credentialBonuses: meta.credentialBonuses || [],
            createdAt: meta.sourceCreatedAt || row.created_at || null
        };
    }

    return normalizeApiPotluckData({ config, users });
}

async function exportApiPotluckKeysFromDb(client) {
    const compatRow = await client.query(`
SELECT value_json
FROM runtime_settings
WHERE scope = 'compat_export' AND key = 'api-potluck-keys'
LIMIT 1;
    `);

    if (compatRow[0]?.value_json) {
        return normalizeApiPotluckKeys(parseJsonSafe(compatRow[0].value_json, null));
    }

    const keyRows = await client.query(`
SELECT key_id, name, enabled, daily_limit, used_today, bonus_remaining, last_reset_at, created_at
FROM potluck_api_keys
ORDER BY key_id ASC;
    `);
    const legacyMetaRows = await client.query(`
SELECT key, value_json
FROM runtime_settings
WHERE scope = 'potluck_api_key_legacy'
ORDER BY key ASC;
    `);

    const legacyMetaByKeyId = new Map(legacyMetaRows.map((row) => [row.key, parseJsonSafe(row.value_json, {})]));
    const keys = {};

    for (const row of keyRows) {
        const legacyMeta = legacyMetaByKeyId.get(row.key_id) || {};
        keys[row.key_id] = {
            ...legacyMeta,
            id: row.key_id,
            name: row.name,
            createdAt: legacyMeta.createdAt || row.created_at || null,
            dailyLimit: row.daily_limit,
            todayUsage: row.used_today,
            totalUsage: legacyMeta.totalUsage ?? row.used_today,
            lastResetDate: legacyMeta.lastResetDate || row.last_reset_at || null,
            lastUsedAt: legacyMeta.lastUsedAt || null,
            enabled: Boolean(row.enabled),
            bonusRemaining: row.bonus_remaining
        };
    }

    return normalizeApiPotluckKeys({ keys });
}

export async function exportLegacyRuntimeStorage(config = {}, options = {}) {
    const requestedDomains = options.domains || ['provider-pools'];
    const outputDir = options.outputDir ? resolvePathMaybeAbsolute(options.outputDir) : null;

    try {
        const { storage, resolvedPaths } = await createSqliteStorage(config, options);
        const providerPools = await storage.exportProviderPoolsSnapshot();
        const usageCache = await exportUsageCacheFromDb(storage.client);
        const adminSessionState = await queryAdminSessionState(storage.client);
        const apiPotluckData = await exportApiPotluckDataFromDb(storage.client);
        const apiPotluckKeys = await exportApiPotluckKeysFromDb(storage.client);

        const bundle = {
            providerPools,
            usageCache,
            sessionSummary: adminSessionState.summary,
            apiPotluckData,
            apiPotluckKeys,
            resolvedPaths
        };

        const domains = new Set(requestedDomains);
        if (outputDir) {
            await ensureDirectory(outputDir);
            if (domains.has('provider-pools')) {
                await writeJsonFile(path.join(outputDir, 'provider_pools.json'), providerPools);
            }
            if (domains.has('usage-cache')) {
                await writeJsonFile(path.join(outputDir, 'usage-cache.json'), usageCache);
            }
            if (domains.has('api-potluck-data')) {
                await writeJsonFile(path.join(outputDir, 'api-potluck-data.json'), apiPotluckData);
            }
            if (domains.has('api-potluck-keys')) {
                await writeJsonFile(path.join(outputDir, 'api-potluck-keys.json'), apiPotluckKeys);
            }
        }

        if (options.outputFile && domains.size === 1) {
            const singleDomain = Array.from(domains)[0];
            const payloadByDomain = {
                'provider-pools': providerPools,
                'usage-cache': usageCache,
                'api-potluck-data': apiPotluckData,
                'api-potluck-keys': apiPotluckKeys
            };
            await writeJsonFile(resolvePathMaybeAbsolute(options.outputFile), payloadByDomain[singleDomain]);
        }

        recordRuntimeStorageExportStatus({
            status: 'success',
            domains: Array.from(domains),
            exportedSummary: buildSummaryCounts(bundle),
            outputDir
        }, {
            operation: 'exportLegacyRuntimeStorage',
            outputDir
        });

        return bundle;
    } catch (error) {
        recordRuntimeStorageExportStatus({
            status: 'failed',
            domains: Array.isArray(requestedDomains) ? requestedDomains : ['provider-pools'],
            exportedSummary: null,
            outputDir
        }, {
            operation: 'exportLegacyRuntimeStorage',
            outputDir
        });
        throw error;
    }
}

function compareMappedCollections(expectedItems, actualItems, keyBuilder, mismatchBuilder) {
    const expectedMap = new Map(expectedItems.map((item) => [keyBuilder(item), item]));
    const actualMap = new Map(actualItems.map((item) => [keyBuilder(item), item]));
    const missingInDatabase = [];
    const unexpectedInDatabase = [];
    const mismatched = [];

    for (const [key, expectedItem] of expectedMap.entries()) {
        if (!actualMap.has(key)) {
            missingInDatabase.push(key);
            continue;
        }

        const actualItem = actualMap.get(key);
        const mismatch = mismatchBuilder(expectedItem, actualItem);
        if (mismatch) {
            mismatched.push({ key, ...mismatch });
        }
    }

    for (const key of actualMap.keys()) {
        if (!expectedMap.has(key)) {
            unexpectedInDatabase.push(key);
        }
    }

    return {
        missingInDatabase,
        unexpectedInDatabase,
        mismatched
    };
}

function deriveStatusFromCollectionDiff(diff) {
    return diff.missingInDatabase.length === 0
        && diff.unexpectedInDatabase.length === 0
        && diff.mismatched.length === 0
        ? 'pass'
        : 'fail';
}

async function buildActualProviderRegistryComparable(client) {
    const providerRows = await queryProviderRows(client);
    const secretRows = await querySecretRows(client);
    const secretKindsByProviderId = new Map();
    for (const secretRow of secretRows) {
        if (!secretKindsByProviderId.has(secretRow.provider_id)) {
            secretKindsByProviderId.set(secretRow.provider_id, []);
        }
        secretKindsByProviderId.get(secretRow.provider_id).push(secretRow.secret_kind);
    }

    return providerRows.map((row) => ({
        providerId: row.provider_id,
        providerType: row.provider_type,
        uuid: row.routing_uuid,
        displayName: row.display_name,
        checkModel: row.check_model,
        projectId: row.project_id,
        baseUrl: row.base_url,
        configHash: hashValue(row.config_json || '{}'),
        secretKinds: (secretKindsByProviderId.get(row.provider_id) || []).slice().sort()
    }));
}

async function buildActualProviderRuntimeComparable(client, persistSelectionState = false) {
    const providerRows = await queryProviderRows(client);
    return providerRows.map((row) => {
        const runtimeState = {
            providerId: row.provider_id,
            providerType: row.provider_type,
            uuid: row.routing_uuid,
            isHealthy: Boolean(row.is_healthy),
            isDisabled: Boolean(row.is_disabled),
            usageCount: Number(row.usage_count || 0),
            errorCount: Number(row.error_count || 0),
            lastUsed: row.last_used_at || null,
            lastHealthCheckTime: row.last_health_check_at || null,
            lastHealthCheckModel: row.last_health_check_model || null,
            lastErrorTime: row.last_error_time || null,
            lastErrorMessage: row.last_error_message || null,
            scheduledRecoveryTime: row.scheduled_recovery_at || null,
            refreshCount: Number(row.refresh_count || 0)
        };

        if (persistSelectionState) {
            runtimeState.lastSelectionSeq = row.last_selection_seq === null || row.last_selection_seq === undefined
                ? null
                : Number(row.last_selection_seq);
        }

        return runtimeState;
    });
}

function compareJsonDomain(sourceValue, actualValue) {
    const expected = sortObject(sourceValue);
    const actual = sortObject(actualValue);
    const expectedSerialized = JSON.stringify(expected);
    const actualSerialized = JSON.stringify(actual);

    return {
        status: expectedSerialized === actualSerialized ? 'pass' : 'fail',
        expectedHash: hashValue(expectedSerialized),
        actualHash: hashValue(actualSerialized),
        expectedCount: Array.isArray(expected)
            ? expected.length
            : Object.keys(expected || {}).length,
        actualCount: Array.isArray(actual)
            ? actual.length
            : Object.keys(actual || {}).length
    };
}

function buildSummaryCounts(bundle) {
    return {
        providerTypeCount: Object.keys(bundle.providerPools || {}).length,
        providerCount: Object.values(bundle.providerPools || {}).reduce((count, providers) => {
            return count + (Array.isArray(providers) ? providers.length : 0);
        }, 0),
        usageProviderCount: Object.keys(bundle.usageCache?.providers || {}).length,
        sessionCount: Number(bundle.sessionSummary?.sessionCount || Object.keys(bundle.tokenStore?.tokens || {}).length || 0),
        potluckUserCount: Object.keys(bundle.apiPotluckData?.users || {}).length,
        potluckKeyCount: Object.keys(bundle.apiPotluckKeys?.keys || {}).length
    };
}

function buildMismatchFieldSummary(mismatched = []) {
    const fieldCounts = {};
    for (const item of mismatched) {
        for (const fieldName of item?.mismatchedFields || []) {
            fieldCounts[fieldName] = (fieldCounts[fieldName] || 0) + 1;
        }
    }

    return {
        mismatchCount: mismatched.length,
        fieldCounts
    };
}

function buildCollectionDomainReport(expectedItems, actualItems, diff) {
    return {
        status: deriveStatusFromCollectionDiff(diff),
        expectedCount: expectedItems.length,
        actualCount: actualItems.length,
        expectedHash: hashValue(stableStringify(expectedItems)),
        actualHash: hashValue(stableStringify(actualItems)),
        missingInDatabase: diff.missingInDatabase,
        unexpectedInDatabase: diff.unexpectedInDatabase,
        mismatched: diff.mismatched,
        diffSummary: buildMismatchFieldSummary(diff.mismatched)
    };
}

function buildProviderAcceptanceSummary(providerPools = {}, providerRegistry = [], providerRuntime = [], compatSnapshot = {}) {
    const providerTypeCounts = Object.entries(providerPools || {}).reduce((result, [providerType, providers]) => {
        result[providerType] = Array.isArray(providers) ? providers.length : 0;
        return result;
    }, {});
    const providerCount = Object.values(providerTypeCounts).reduce((sum, count) => sum + count, 0);
    const credentialPathCount = Object.values(compatSnapshot || {}).reduce((count, providers) => {
        if (!Array.isArray(providers)) {
            return count;
        }

        return count + providers.filter((provider) => {
            return Object.keys(provider || {}).some((fieldName) => {
                return PROVIDER_CREDENTIAL_PATH_SUFFIXES.some((suffix) => fieldName.endsWith(suffix));
            });
        }).length;
    }, 0);

    return {
        providerTypeCount: Object.keys(providerTypeCounts).length,
        providerCount,
        providerTypeCounts,
        uuidCoverageCount: providerRegistry.filter((item) => item.uuid).length,
        healthyCount: providerRuntime.filter((item) => item.isHealthy === true).length,
        unhealthyCount: providerRuntime.filter((item) => item.isHealthy !== true).length,
        disabledCount: providerRuntime.filter((item) => item.isDisabled === true).length,
        totalUsageCount: providerRuntime.reduce((sum, item) => sum + Number(item.usageCount || 0), 0),
        totalErrorCount: providerRuntime.reduce((sum, item) => sum + Number(item.errorCount || 0), 0),
        providerWithCredentialPathCount: credentialPathCount,
        compatSnapshotHash: hashValue(stableStringify(compatSnapshot || {}))
    };
}

function buildUsageAcceptanceSummary(usageCache = {}) {
    const providers = Object.values(usageCache.providers || {});
    const timestamps = providers
        .map((item) => item?.timestamp || null)
        .filter(Boolean)
        .sort();

    return {
        providerCount: providers.length,
        instanceCount: providers.reduce((sum, item) => sum + (Array.isArray(item?.instances) ? item.instances.length : 0), 0),
        totalCount: providers.reduce((sum, item) => sum + Number(item?.totalCount || 0), 0),
        successCount: providers.reduce((sum, item) => sum + Number(item?.successCount || 0), 0),
        errorCount: providers.reduce((sum, item) => sum + Number(item?.errorCount || 0), 0),
        latestTimestamp: timestamps.length > 0 ? timestamps[timestamps.length - 1] : usageCache.timestamp || null
    };
}

function buildSessionAcceptanceSummary(sessionState = {}) {
    const sessions = Array.isArray(sessionState)
        ? sessionState
        : Array.isArray(sessionState.sessions)
            ? sessionState.sessions
            : [];
    const createdAtValues = sessions.map((item) => item.createdAt).filter(Boolean).sort();
    const expiresAtValues = sessions.map((item) => item.expiresAt).filter(Boolean).sort();

    return {
        sessionCount: sessions.length,
        uniqueTokenHashCount: new Set(sessions.map((item) => item.tokenHash)).size,
        latestCreatedAt: createdAtValues.length > 0 ? createdAtValues[createdAtValues.length - 1] : null,
        latestExpiresAt: expiresAtValues.length > 0 ? expiresAtValues[expiresAtValues.length - 1] : null
    };
}

function buildPotluckDataAcceptanceSummary(apiPotluckData = {}) {
    const users = Object.values(apiPotluckData.users || {});
    const createdAtValues = users.map((item) => item?.createdAt).filter(Boolean).sort();

    return {
        userCount: users.length,
        credentialCount: users.reduce((sum, item) => sum + (Array.isArray(item?.credentials) ? item.credentials.length : 0), 0),
        bonusCount: users.reduce((sum, item) => sum + (Array.isArray(item?.credentialBonuses) ? item.credentialBonuses.length : 0), 0),
        configCount: Object.keys(apiPotluckData.config || {}).length,
        latestCreatedAt: createdAtValues.length > 0 ? createdAtValues[createdAtValues.length - 1] : null
    };
}

function buildPotluckKeysAcceptanceSummary(apiPotluckKeys = {}) {
    const keys = Object.values(apiPotluckKeys.keys || {});
    const createdAtValues = keys.map((item) => item?.createdAt).filter(Boolean).sort();
    const lastUsedValues = keys.map((item) => item?.lastUsedAt).filter(Boolean).sort();

    return {
        keyCount: keys.length,
        enabledCount: keys.filter((item) => item?.enabled !== false).length,
        disabledCount: keys.filter((item) => item?.enabled === false).length,
        zeroQuotaCount: keys.filter((item) => Number(item?.dailyLimit) === 0).length,
        negativeQuotaCount: keys.filter((item) => Number(item?.dailyLimit) < 0).length,
        latestCreatedAt: createdAtValues.length > 0 ? createdAtValues[createdAtValues.length - 1] : null,
        latestLastUsedAt: lastUsedValues.length > 0 ? lastUsedValues[lastUsedValues.length - 1] : null
    };
}

function buildCredentialAcceptanceSummary(credentialState = {}, inventoryReport = null, anomalyReport = null) {
    const assets = Array.isArray(credentialState.assets) ? credentialState.assets : [];
    const bindings = Array.isArray(credentialState.bindings) ? credentialState.bindings : [];
    const credentialItems = Array.isArray(inventoryReport?.items)
        ? inventoryReport.items.filter((item) => item.category === 'credential')
        : [];
    const duplicateGroups = new Map();

    for (const item of credentialItems) {
        if (!item?.providerType || !item?.checksum || item.parseStatus !== 'parsed') {
            continue;
        }

        const duplicateKey = `${item.providerType}::${item.checksum}`;
        if (!duplicateGroups.has(duplicateKey)) {
            duplicateGroups.set(duplicateKey, []);
        }
        duplicateGroups.get(duplicateKey).push(item.path || item.absolutePath || item.fileName || item.id);
    }

    const matchedDuplicateGroups = Array.from(duplicateGroups.values()).filter((group) => group.length > 1);

    return {
        assetCount: assets.length,
        bindingCount: bindings.length,
        providerTypeCount: new Set(assets.map((item) => item.providerType).filter(Boolean)).size,
        potluckLinkCount: Array.isArray(credentialState.potluckUserCredentialLinks) ? credentialState.potluckUserCredentialLinks.length : 0,
        dedupeGroupCount: matchedDuplicateGroups.length,
        dedupeHitCount: matchedDuplicateGroups.reduce((sum, group) => sum + (group.length - 1), 0),
        anomalyCount: Number(anomalyReport?.summary?.totalAnomalies || 0),
        anomalyCodeCounts: anomalyReport?.summary?.codeCounts || {}
    };
}

async function buildCurrentDomainInventorySnapshot(resolvedPaths, sourceBundle) {
    const domainDefinitions = [
        {
            itemType: 'provider_pools_file',
            filePath: resolvedPaths.providerPoolsFilePath,
            countSummary: buildProviderPoolsCountSummary(sourceBundle.providerPools)
        },
        {
            itemType: 'usage_cache_file',
            filePath: resolvedPaths.usageCacheFilePath,
            countSummary: buildUsageCacheCountSummary(sourceBundle.usageCache)
        },
        {
            itemType: 'token_store_file',
            filePath: resolvedPaths.tokenStoreFilePath,
            countSummary: buildTokenStoreCountSummary(sourceBundle.tokenStore)
        },
        {
            itemType: 'api_potluck_data_file',
            filePath: resolvedPaths.apiPotluckDataFilePath,
            countSummary: buildApiPotluckDataCountSummary(sourceBundle.apiPotluckData)
        },
        {
            itemType: 'api_potluck_keys_file',
            filePath: resolvedPaths.apiPotluckKeysFilePath,
            countSummary: buildApiPotluckKeysCountSummary(sourceBundle.apiPotluckKeys)
        }
    ];

    const items = [];
    for (const definition of domainDefinitions) {
        const scanResult = await scanJsonFileForInventory(definition.filePath);
        items.push(createInventoryItem({
            itemType: definition.itemType,
            category: 'domain',
            scanResult,
            countSummary: definition.countSummary
        }));
    }

    return items;
}

function compareInventorySnapshots(expectedItems = [], actualItems = []) {
    const normalizeItems = (items) => items.map((item) => ({
        itemType: item.itemType,
        path: item.path,
        checksum: item.checksum,
        recordCount: item.recordCount,
        entryCount: item.entryCount,
        parseStatus: item.parseStatus
    }));
    const expectedMap = new Map(normalizeItems(expectedItems).map((item) => [item.itemType, item]));
    const actualMap = new Map(normalizeItems(actualItems).map((item) => [item.itemType, item]));
    const missing = [];
    const unexpected = [];
    const mismatched = [];

    for (const [itemType, expectedItem] of expectedMap.entries()) {
        if (!actualMap.has(itemType)) {
            missing.push(itemType);
            continue;
        }

        const actualItem = actualMap.get(itemType);
        const mismatchedFields = ['checksum', 'recordCount', 'entryCount', 'parseStatus'].filter((fieldName) => {
            return stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName]);
        });
        if (mismatchedFields.length > 0) {
            mismatched.push({ itemType, path: expectedItem.path, mismatchedFields });
        }
    }

    for (const itemType of actualMap.keys()) {
        if (!expectedMap.has(itemType)) {
            unexpected.push(itemType);
        }
    }

    return {
        status: missing.length === 0 && unexpected.length === 0 && mismatched.length === 0 ? 'pass' : 'fail',
        expectedHash: hashValue(stableStringify(normalizeItems(expectedItems))),
        actualHash: hashValue(stableStringify(normalizeItems(actualItems))),
        missing,
        unexpected,
        mismatched,
        diffSummary: buildMismatchFieldSummary(mismatched.map((item) => ({ mismatchedFields: item.mismatchedFields })))
    };
}

function normalizeCutoverPolicy(options = {}) {
    const blockedAnomalyCodes = Array.isArray(options.blockedAnomalyCodes)
        ? options.blockedAnomalyCodes.map((item) => String(item).trim()).filter(Boolean)
        : [];
    const rawMaxAnomalyCount = options.maxAnomalyCount;
    const hasMaxAnomalyCount = rawMaxAnomalyCount !== undefined && rawMaxAnomalyCount !== null && rawMaxAnomalyCount !== '';
    const parsedMaxAnomalyCount = hasMaxAnomalyCount ? Number(rawMaxAnomalyCount) : NaN;

    return {
        blockedAnomalyCodes,
        maxAnomalyCount: Number.isFinite(parsedMaxAnomalyCount) ? parsedMaxAnomalyCount : null
    };
}

function buildAnomalyPolicyStatus(anomalyReport = null, cutoverPolicy = {}) {
    const codeCounts = anomalyReport?.summary?.codeCounts || {};
    const totalAnomalies = Number(anomalyReport?.summary?.totalAnomalies || 0);
    const blockedCodeHits = (cutoverPolicy.blockedAnomalyCodes || []).filter((code) => Number(codeCounts[code] || 0) > 0);
    const exceedsMaxCount = cutoverPolicy.maxAnomalyCount !== null && totalAnomalies > cutoverPolicy.maxAnomalyCount;

    return {
        status: blockedCodeHits.length > 0 || exceedsMaxCount ? 'fail' : 'pass',
        totalAnomalies,
        maxAnomalyCount: cutoverPolicy.maxAnomalyCount,
        blockedAnomalyCodes: cutoverPolicy.blockedAnomalyCodes || [],
        blockedCodeHits,
        exceedsMaxCount,
        codeCounts
    };
}

function buildCountGateStatus(domains = {}) {
    const failingChecks = [];
    for (const [domainName, domainReport] of Object.entries(domains || {})) {
        if (domainReport.expectedCount !== undefined && domainReport.actualCount !== undefined && domainReport.expectedCount !== domainReport.actualCount) {
            failingChecks.push(domainName);
        }

        for (const [subdomainName, subdomainReport] of Object.entries(domainReport.subdomains || {})) {
            if (subdomainReport.expectedCount !== undefined && subdomainReport.actualCount !== undefined
                && subdomainReport.expectedCount !== subdomainReport.actualCount) {
                failingChecks.push(`${domainName}.${subdomainName}`);
            }
        }
    }

    return {
        status: failingChecks.length === 0 ? 'pass' : 'fail',
        failingChecks
    };
}

function buildChecksumGateStatus(domains = {}, sourceSnapshotCheck = null) {
    const failingChecks = [];
    for (const [domainName, domainReport] of Object.entries(domains || {})) {
        if (domainReport.expectedHash && domainReport.actualHash && domainReport.expectedHash !== domainReport.actualHash) {
            failingChecks.push(domainName);
        }

        for (const [subdomainName, subdomainReport] of Object.entries(domainReport.subdomains || {})) {
            if (subdomainReport.expectedHash && subdomainReport.actualHash
                && subdomainReport.expectedHash !== subdomainReport.actualHash) {
                failingChecks.push(`${domainName}.${subdomainName}`);
            }
        }
    }

    if (sourceSnapshotCheck?.status === 'fail') {
        failingChecks.push('sourceSnapshot');
    }

    return {
        status: failingChecks.length === 0 ? 'pass' : 'fail',
        failingChecks,
        sourceSnapshot: sourceSnapshotCheck
    };
}

function buildCutoverGateReport(domains = {}, overallStatus = 'unknown', sourceSnapshotCheck = null, anomalyPolicy = null) {
    const countGate = buildCountGateStatus(domains);
    const checksumGate = buildChecksumGateStatus(domains, sourceSnapshotCheck);
    const compatDiffGate = {
        status: overallStatus === 'pass' ? 'pass' : 'fail',
        failingChecks: overallStatus === 'pass' ? [] : ['compatibility']
    };
    const anomalyGate = anomalyPolicy || {
        status: 'pass',
        totalAnomalies: 0,
        blockedAnomalyCodes: [],
        blockedCodeHits: [],
        exceedsMaxCount: false,
        codeCounts: {}
    };
    const blockers = [
        ...countGate.failingChecks.map((item) => `count:${item}`),
        ...checksumGate.failingChecks.map((item) => `checksum:${item}`),
        ...compatDiffGate.failingChecks.map((item) => `compat:${item}`),
        ...(anomalyGate.blockedCodeHits || []).map((item) => `anomaly:${item}`),
        ...(anomalyGate.exceedsMaxCount ? ['anomaly:max-count'] : [])
    ];

    return {
        status: blockers.length === 0 ? 'pass' : 'blocked',
        canCutover: blockers.length === 0,
        blockers,
        checks: {
            counts: countGate,
            checksums: checksumGate,
            compatDiff: compatDiffGate,
            anomalyPolicy: anomalyGate
        }
    };
}

function resolveOperatorInfo(options = {}) {
    const id = options.operator || process.env.RUNTIME_STORAGE_OPERATOR || process.env.USER || process.env.USERNAME || null;

    return {
        id,
        source: options.operator ? 'option' : (id ? 'environment' : 'unknown')
    };
}

function buildAcceptanceSummary({
    report,
    sourceBundle,
    exportedBundle,
    expectedProviderRegistry,
    actualProviderRegistry,
    expectedProviderRuntime,
    actualProviderRuntime,
    expectedCredentialState,
    actualCredentialState,
    actualAdminSessionState,
    inventoryReport,
    anomalyReport,
    sourceSnapshotCheck,
    operator,
    artifactPaths,
    runRecord
}) {
    const startedAt = runRecord?.started_at || null;
    const finishedAt = runRecord?.finished_at || nowIso();
    const durationMs = startedAt && finishedAt
        ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
        : null;
    const inputSnapshotVersion = inventoryReport
        ? hashValue(stableStringify((inventoryReport.items || [])
            .filter((item) => item.category === 'domain')
            .map((item) => ({
                itemType: item.itemType,
                checksum: item.checksum,
                recordCount: item.recordCount,
                entryCount: item.entryCount,
                parseStatus: item.parseStatus
            }))))
        : null;

    return {
        generatedAt: report.generatedAt,
        runId: report.runId || null,
        operator,
        sourceSummary: report.sourceSummary,
        databaseSummary: report.databaseSummary,
        inputSnapshotVersion,
        sourceSnapshotCheck,
        anomalySummary: anomalyReport?.summary || { totalAnomalies: 0, codeCounts: {} },
        provider: {
            expected: buildProviderAcceptanceSummary(sourceBundle.providerPools, expectedProviderRegistry, expectedProviderRuntime, sourceBundle.providerPools),
            actual: buildProviderAcceptanceSummary(exportedBundle.providerPools, actualProviderRegistry, actualProviderRuntime, exportedBundle.providerPools)
        },
        credentials: buildCredentialAcceptanceSummary(actualCredentialState, inventoryReport, anomalyReport),
        usage: buildUsageAcceptanceSummary(exportedBundle.usageCache),
        sessions: buildSessionAcceptanceSummary(actualAdminSessionState),
        potluckData: buildPotluckDataAcceptanceSummary(exportedBundle.apiPotluckData),
        potluckKeys: buildPotluckKeysAcceptanceSummary(exportedBundle.apiPotluckKeys),
        diffSummary: Object.fromEntries(Object.entries(report.domains || {}).map(([domainName, domainReport]) => [
            domainName,
            domainReport.diffSummary || null
        ])),
        cutoverGate: report.cutoverGate,
        rollbackPoint: artifactPaths
            ? {
                sqliteBackupDir: artifactPaths.beforeDir,
                sourceBackupDir: artifactPaths.sourceDir
            }
            : null,
        startedAt,
        finishedAt,
        durationMs,
        failureReasons: report.cutoverGate?.blockers || []
    };
}

function buildAcceptanceMarkdown(summary = {}) {
    const lines = [
        '# Runtime Storage Acceptance Summary',
        '',
        `- Run ID: ${summary.runId || 'n/a'}`,
        `- Generated At: ${summary.generatedAt || nowIso()}`,
        `- Operator: ${summary.operator?.id || 'n/a'}`,
        `- Input Snapshot Version: ${summary.inputSnapshotVersion || 'n/a'}`,
        `- Cutover Gate: ${summary.cutoverGate?.status || 'unknown'}`,
        `- Failure Reasons: ${(summary.failureReasons || []).join(', ') || 'none'}`,
        `- Duration Ms: ${summary.durationMs ?? 'n/a'}`,
        ''
    ];

    for (const [sectionName, sectionValue] of Object.entries({
        provider: summary.provider?.actual,
        credentials: summary.credentials,
        usage: summary.usage,
        sessions: summary.sessions,
        potluckData: summary.potluckData,
        potluckKeys: summary.potluckKeys
    })) {
        lines.push(`## ${sectionName}`);
        lines.push('');
        for (const [key, value] of Object.entries(sectionValue || {})) {
            lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
        }
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

function buildDiffMarkdown(report) {
    const lines = [
        '# Runtime Storage Migration Diff Report',
        '',
        `- Run ID: ${report.runId || 'n/a'}`,
        `- Generated At: ${report.generatedAt}`,
        `- Overall Status: ${report.overallStatus}`,
        `- Validation Status: ${report.validationStatus || report.overallStatus}`,
        `- Cutover Gate: ${report.cutoverGate?.status || 'unknown'}`,
        `- Cutover Blockers: ${(report.cutoverGate?.blockers || []).join(', ') || 'none'}`,
        ''
    ];

    if (report.crashRecovery) {
        lines.push('## Crash Recovery');
        lines.push('');
        lines.push(`- Durable Boundary: ${report.crashRecovery.durableBoundary || 'n/a'}`);
        lines.push(`- Loss Window: ${report.crashRecovery.lossWindow || 'n/a'}`);
        if (Array.isArray(report.crashRecovery.mayLoseWithinWindow) && report.crashRecovery.mayLoseWithinWindow.length > 0) {
            lines.push(`- May Lose Within Window: ${report.crashRecovery.mayLoseWithinWindow.join(', ')}`);
        }
        if (Array.isArray(report.crashRecovery.memoryOnlyAlwaysLost) && report.crashRecovery.memoryOnlyAlwaysLost.length > 0) {
            lines.push(`- Memory-only Always Lost: ${report.crashRecovery.memoryOnlyAlwaysLost.join(', ')}`);
        }
        lines.push('');
    }

    for (const [domainName, domainReport] of Object.entries(report.domains || {})) {
        lines.push(`## ${domainName}`);
        lines.push('');
        lines.push(`- Status: ${domainReport.status}`);
        if (domainReport.expectedCount !== undefined) {
            lines.push(`- Expected Count: ${domainReport.expectedCount}`);
        }
        if (domainReport.actualCount !== undefined) {
            lines.push(`- Actual Count: ${domainReport.actualCount}`);
        }
        if (domainReport.expectedHash) {
            lines.push(`- Expected Hash: ${domainReport.expectedHash}`);
        }
        if (domainReport.actualHash) {
            lines.push(`- Actual Hash: ${domainReport.actualHash}`);
        }
        if (Array.isArray(domainReport.missingInDatabase) && domainReport.missingInDatabase.length > 0) {
            lines.push(`- Missing In Database: ${domainReport.missingInDatabase.slice(0, 10).join(', ')}`);
        }
        if (Array.isArray(domainReport.unexpectedInDatabase) && domainReport.unexpectedInDatabase.length > 0) {
            lines.push(`- Unexpected In Database: ${domainReport.unexpectedInDatabase.slice(0, 10).join(', ')}`);
        }
        if (Array.isArray(domainReport.mismatched) && domainReport.mismatched.length > 0) {
            lines.push(`- Mismatched Entries: ${domainReport.mismatched.slice(0, 10).map((item) => item.key).join(', ')}`);
        }
        if (domainReport.subdomains) {
            for (const [subdomainName, subdomainReport] of Object.entries(domainReport.subdomains)) {
                lines.push(`- ${subdomainName}: ${subdomainReport.status} (expectedHash=${subdomainReport.expectedHash}, actualHash=${subdomainReport.actualHash})`);
            }
        }
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

async function loadMigrationRunRecord(client, runId) {
    if (!runId) {
        return null;
    }

    const rows = await client.query(`
SELECT id, migration_type, source_version, status, summary_json, started_at, finished_at
FROM storage_migration_runs
WHERE id = ${sqlValue(runId)}
LIMIT 1;
    `);

    return rows[0] || null;
}

export async function verifyRuntimeStorageMigration(config = {}, options = {}) {
    const sourceBundle = options.sourceBundle || await loadLegacySourceBundle(config, options);
    const { storage, resolvedPaths } = await createSqliteStorage(config, options);
    const exportedBundle = await exportLegacyRuntimeStorage(config, options);
    const artifactBundle = await loadMigrationArtifacts(resolvedPaths, options.runId || null);
    const runRecord = await loadMigrationRunRecord(storage.client, options.runId || null);
    const expectedCredentialState = await collectExpectedCredentialState(sourceBundle.providerPools, sourceBundle.apiPotluckData);
    const actualCredentialState = await queryCredentialState(storage.client);
    const expectedAdminSessions = buildExpectedAdminSessionState(sourceBundle.tokenStore);
    const actualAdminSessionState = await queryAdminSessionState(storage.client);

    const expectedProviderRegistry = buildProviderRegistryComparable(sourceBundle.providerPools);
    const actualProviderRegistry = await buildActualProviderRegistryComparable(storage.client);
    const providerRegistryDiff = compareMappedCollections(
        expectedProviderRegistry,
        actualProviderRegistry,
        (item) => `${item.providerType}:${item.uuid}`,
        (expectedItem, actualItem) => {
            const mismatchedFields = [];
            for (const fieldName of ['providerId', 'displayName', 'checkModel', 'projectId', 'baseUrl', 'configHash']) {
                if (stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName])) {
                    mismatchedFields.push(fieldName);
                }
            }
            if (stableStringify(expectedItem.secretKinds) !== stableStringify(actualItem.secretKinds)) {
                mismatchedFields.push('secretKinds');
            }
            return mismatchedFields.length > 0 ? { mismatchedFields } : null;
        }
    );

    const expectedProviderRuntime = buildProviderRuntimeComparable(sourceBundle.providerPools, resolvedPaths.persistSelectionState);
    const actualProviderRuntime = await buildActualProviderRuntimeComparable(storage.client, resolvedPaths.persistSelectionState);
    const providerRuntimeDiff = compareMappedCollections(
        expectedProviderRuntime,
        actualProviderRuntime,
        (item) => `${item.providerType}:${item.uuid}`,
        (expectedItem, actualItem) => {
            const mismatchedFields = Object.keys(expectedItem).filter((fieldName) => {
                return stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName]);
            });
            return mismatchedFields.length > 0 ? { mismatchedFields } : null;
        }
    );

    const credentialAssetDiff = compareMappedCollections(
        expectedCredentialState.assets,
        actualCredentialState.assets,
        (item) => item.dedupeKey,
        (expectedItem, actualItem) => {
            const mismatchedFields = [];
            for (const fieldName of ['id', 'providerType', 'identityKey', 'sourceKind', 'sourcePath', 'sourceChecksum', 'storageMode']) {
                if (stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName])) {
                    mismatchedFields.push(fieldName);
                }
            }

            if (stableStringify(expectedItem.fileIndex) !== stableStringify(actualItem.fileIndex)) {
                mismatchedFields.push('fileIndex');
            }

            return mismatchedFields.length > 0 ? { mismatchedFields } : null;
        }
    );

    const credentialBindingDiff = compareMappedCollections(
        expectedCredentialState.bindings,
        actualCredentialState.bindings,
        (item) => `${item.bindingType}:${item.bindingTargetId}:${item.assetKey}`,
        (expectedItem, actualItem) => {
            const mismatchedFields = [];
            for (const fieldName of ['credentialAssetId', 'bindingStatus']) {
                if (stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName])) {
                    mismatchedFields.push(fieldName);
                }
            }
            return mismatchedFields.length > 0 ? { mismatchedFields } : null;
        }
    );

    const usageDomain = compareJsonDomain(sourceBundle.usageCache, exportedBundle.usageCache);
    const adminSessionDiff = compareMappedCollections(
        expectedAdminSessions,
        actualAdminSessionState.sessions,
        (item) => item.tokenHash,
        (expectedItem, actualItem) => {
            const mismatchedFields = [];
            for (const fieldName of ['subject', 'sourceIp', 'userAgent', 'metaHash']) {
                if (stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName])) {
                    mismatchedFields.push(fieldName);
                }
            }

            for (const fieldName of ['createdAt', 'expiresAt']) {
                if (expectedItem[fieldName] && stableStringify(expectedItem[fieldName]) !== stableStringify(actualItem[fieldName])) {
                    mismatchedFields.push(fieldName);
                }
            }

            return mismatchedFields.length > 0 ? { mismatchedFields } : null;
        }
    );
    const apiPotluckDataDomain = compareJsonDomain(sourceBundle.apiPotluckData, exportedBundle.apiPotluckData);
    const apiPotluckKeysDomain = compareJsonDomain(sourceBundle.apiPotluckKeys, exportedBundle.apiPotluckKeys);
    const providerRegistryDomain = buildCollectionDomainReport(
        expectedProviderRegistry,
        actualProviderRegistry,
        providerRegistryDiff
    );
    const providerRuntimeDomain = buildCollectionDomainReport(
        expectedProviderRuntime,
        actualProviderRuntime,
        providerRuntimeDiff
    );
    const sessionDomain = buildCollectionDomainReport(
        expectedAdminSessions,
        actualAdminSessionState.sessions,
        adminSessionDiff
    );
    const currentDomainSnapshot = await buildCurrentDomainInventorySnapshot(resolvedPaths, sourceBundle);
    const sourceSnapshotCheck = compareInventorySnapshots(
        Array.isArray(artifactBundle.inventoryReport?.items)
            ? artifactBundle.inventoryReport.items.filter((item) => item.category === 'domain')
            : currentDomainSnapshot,
        currentDomainSnapshot
    );
    const anomalyPolicy = buildAnomalyPolicyStatus(
        artifactBundle.anomalyReport,
        normalizeCutoverPolicy(options)
    );

    const overallStatus = [
        deriveStatusFromCollectionDiff(providerRegistryDiff),
        deriveStatusFromCollectionDiff(providerRuntimeDiff),
        deriveStatusFromCollectionDiff(credentialAssetDiff),
        deriveStatusFromCollectionDiff(credentialBindingDiff),
        usageDomain.status,
        deriveStatusFromCollectionDiff(adminSessionDiff),
        apiPotluckDataDomain.status,
        apiPotluckKeysDomain.status
    ].every((status) => status === 'pass') ? 'pass' : 'fail';

    const report = {
        runId: options.runId || null,
        generatedAt: nowIso(),
        overallStatus,
        sourceSummary: buildSummaryCounts(sourceBundle),
        databaseSummary: buildSummaryCounts(exportedBundle),
        crashRecovery: buildRuntimeStorageCrashRecoveryDiagnostics(),
        featureFlagFallback: buildRuntimeStorageFeatureFlagFallback(config, {
            triggeredBy: 'verifyRuntimeStorageMigration',
            reason: overallStatus === 'pass' ? null : `compat_diff_${overallStatus}`
        }),
        domains: {
            providerRegistry: providerRegistryDomain,
            runtimeState: providerRuntimeDomain,
            credentialBinding: {
                status: credentialAssetDiff.missingInDatabase.length === 0
                    && credentialAssetDiff.unexpectedInDatabase.length === 0
                    && credentialAssetDiff.mismatched.length === 0
                    && credentialBindingDiff.missingInDatabase.length === 0
                    && credentialBindingDiff.unexpectedInDatabase.length === 0
                    && credentialBindingDiff.mismatched.length === 0
                    ? 'pass'
                    : 'fail',
                expectedCount: expectedCredentialState.assets.length + expectedCredentialState.bindings.length,
                actualCount: actualCredentialState.assets.length + actualCredentialState.bindings.length,
                missingInDatabase: [
                    ...credentialAssetDiff.missingInDatabase.map((key) => `asset:${key}`),
                    ...credentialBindingDiff.missingInDatabase.map((key) => `binding:${key}`)
                ],
                unexpectedInDatabase: [
                    ...credentialAssetDiff.unexpectedInDatabase.map((key) => `asset:${key}`),
                    ...credentialBindingDiff.unexpectedInDatabase.map((key) => `binding:${key}`)
                ],
                mismatched: [
                    ...credentialAssetDiff.mismatched.map((item) => ({ key: `asset:${item.key}`, mismatchedFields: item.mismatchedFields })),
                    ...credentialBindingDiff.mismatched.map((item) => ({ key: `binding:${item.key}`, mismatchedFields: item.mismatchedFields }))
                ],
                expectedHash: hashValue(stableStringify({
                    assets: expectedCredentialState.assets,
                    bindings: expectedCredentialState.bindings
                })),
                actualHash: hashValue(stableStringify({
                    assets: actualCredentialState.assets,
                    bindings: actualCredentialState.bindings
                })),
                diffSummary: buildMismatchFieldSummary([
                    ...credentialAssetDiff.mismatched,
                    ...credentialBindingDiff.mismatched
                ])
            },
            sessions: sessionDomain,
            usagePlugin: {
                status: [usageDomain.status, apiPotluckDataDomain.status, apiPotluckKeysDomain.status].every((status) => status === 'pass') ? 'pass' : 'fail',
                diffSummary: {
                    mismatchCount: [usageDomain, apiPotluckDataDomain, apiPotluckKeysDomain]
                        .filter((domain) => domain.status !== 'pass').length,
                    fieldCounts: {}
                },
                subdomains: {
                    usageCache: usageDomain,
                    apiPotluckData: apiPotluckDataDomain,
                    apiPotluckKeys: apiPotluckKeysDomain
                }
            }
        }
    };

    report.cutoverGate = buildCutoverGateReport(
        report.domains,
        overallStatus,
        sourceSnapshotCheck,
        anomalyPolicy
    );
    report.validationStatus = overallStatus === 'pass' && report.cutoverGate.canCutover !== false
        ? 'pass'
        : (overallStatus === 'pass' ? 'blocked' : 'fail');
    report.acceptanceSummary = buildAcceptanceSummary({
        report,
        sourceBundle,
        exportedBundle,
        expectedProviderRegistry,
        actualProviderRegistry,
        expectedProviderRuntime,
        actualProviderRuntime,
        expectedCredentialState,
        actualCredentialState,
        actualAdminSessionState,
        inventoryReport: artifactBundle.inventoryReport,
        anomalyReport: artifactBundle.anomalyReport,
        sourceSnapshotCheck,
        operator: resolveOperatorInfo(options),
        artifactPaths: artifactBundle.artifactPaths,
        runRecord
    });

    if (options.reportDir) {
        const reportDir = resolvePathMaybeAbsolute(options.reportDir);
        await ensureDirectory(reportDir);
        await writeJsonFile(path.join(reportDir, 'diff-report.json'), report);
        await pfs.writeFile(path.join(reportDir, 'diff-report.md'), buildDiffMarkdown(report), 'utf8');
        await writeJsonFile(path.join(reportDir, 'acceptance-summary.json'), report.acceptanceSummary);
        await pfs.writeFile(path.join(reportDir, 'acceptance-summary.md'), buildAcceptanceMarkdown(report.acceptanceSummary), 'utf8');
    }

    await recordRuntimeStorageValidationStatus(report, {
        status: report.validationStatus,
        operation: 'verifyRuntimeStorageMigration',
        failoverOnFailure: report.validationStatus !== 'pass'
    });

    if (options.failOnDiff && report.overallStatus !== 'pass') {
        const error = wrapRuntimeStorageError(new Error('Runtime storage migration verification failed'), {
            code: 'runtime_storage_validation_failed',
            classification: 'migration_validation_failed',
            phase: 'validation',
            domain: 'compatibility',
            backend: 'db',
            operation: 'verifyRuntimeStorageMigration',
            details: {
                runId: report.runId || options.runId || null,
                overallStatus: report.overallStatus,
                idempotencyKey: `migration_verify_${report.runId || options.runId || 'adhoc'}`,
                replaySafe: true,
                replayBoundary: 'migration_verify_report'
            }
        });
        error.report = report;
        throw error;
    }

    if (options.enforceCutoverGate && report.cutoverGate.canCutover !== true) {
        const error = wrapRuntimeStorageError(new Error('Runtime storage cutover gate blocked'), {
            code: 'runtime_storage_validation_failed',
            classification: 'migration_validation_failed',
            phase: 'validation',
            domain: 'compatibility',
            backend: 'db',
            operation: 'verifyRuntimeStorageMigration',
            details: {
                runId: report.runId || options.runId || null,
                overallStatus: report.overallStatus,
                cutoverStatus: report.cutoverGate.status,
                blockers: report.cutoverGate.blockers,
                idempotencyKey: `migration_verify_${report.runId || options.runId || 'adhoc'}`,
                replaySafe: true,
                replayBoundary: 'migration_verify_report'
            }
        });
        error.report = report;
        throw error;
    }

    return report;
}

function buildRunManifest(runId, resolvedPaths, artifactPaths, mode) {
    return {
        runId,
        mode,
        createdAt: nowIso(),
        paths: {
            providerPoolsFilePath: resolvedPaths.providerPoolsFilePath,
            usageCacheFilePath: resolvedPaths.usageCacheFilePath,
            tokenStoreFilePath: resolvedPaths.tokenStoreFilePath,
            apiPotluckDataFilePath: resolvedPaths.apiPotluckDataFilePath,
            apiPotluckKeysFilePath: resolvedPaths.apiPotluckKeysFilePath,
            dbPath: resolvedPaths.dbPath,
            artifactRoot: artifactPaths.runRoot
        },
        reports: {
            inventoryReportPath: artifactPaths.inventoryReportPath,
            inventoryMarkdownPath: artifactPaths.inventoryMarkdownPath,
            anomalyReportPath: artifactPaths.anomalyReportPath,
            anomalyMarkdownPath: artifactPaths.anomalyMarkdownPath,
            acceptanceSummaryPath: artifactPaths.acceptanceSummaryPath,
            acceptanceMarkdownPath: artifactPaths.acceptanceMarkdownPath
        }
    };
}

export async function migrateLegacyRuntimeStorage(config = {}, options = {}) {
    const sourceBundle = await loadLegacySourceBundle(config, options);
    const { storage, resolvedPaths } = await createSqliteStorage(config, options);
    const runId = options.runId || buildRunId();
    const artifactPaths = buildArtifactPaths(resolvedPaths.artifactRoot, runId);
    const dryRun = options.execute !== true;
    const existingRun = dryRun ? null : await loadMigrationRunRecord(storage.client, runId);
    const isResume = options.resume === true && Boolean(existingRun);
    const hasProviderData = await storage.hasProviderData();
    const credentialState = await collectExpectedCredentialState(sourceBundle.providerPools, sourceBundle.apiPotluckData);
    const sourceSummary = buildSummaryCounts(sourceBundle);
    const manifest = buildRunManifest(runId, resolvedPaths, artifactPaths, dryRun ? 'dry-run' : 'execute');
    const operator = resolveOperatorInfo(options);
    const cutoverPolicy = normalizeCutoverPolicy(options);

    if (hasProviderData && options.force !== true && !isResume) {
        throw new Error('Target runtime storage already contains provider data. Use --force to continue.');
    }

    await ensureDirectory(artifactPaths.runRoot);
    await ensureDirectory(artifactPaths.sourceDir);
    await ensureDirectory(artifactPaths.beforeDir);
    await ensureDirectory(artifactPaths.exportDir);
    await ensureDirectory(artifactPaths.reportsDir);

    const preflight = await buildPreflightReports(sourceBundle, resolvedPaths, artifactPaths);
    const preflightAnomalyPolicy = buildAnomalyPolicyStatus(preflight.anomalyReport, cutoverPolicy);
    manifest.preflight = {
        inventorySummary: preflight.inventoryReport.summary,
        anomalySummary: preflight.anomalyReport.summary,
        anomalyPolicy: preflightAnomalyPolicy,
        inventoryReportPath: artifactPaths.inventoryReportPath,
        inventoryMarkdownPath: artifactPaths.inventoryMarkdownPath,
        anomalyReportPath: artifactPaths.anomalyReportPath,
        anomalyMarkdownPath: artifactPaths.anomalyMarkdownPath,
        acceptanceSummaryPath: artifactPaths.acceptanceSummaryPath,
        acceptanceMarkdownPath: artifactPaths.acceptanceMarkdownPath
    };

    manifest.backups = {
        providerPoolsCopied: await copyFileIfExists(
            resolvedPaths.providerPoolsFilePath,
            path.join(artifactPaths.sourceDir, 'provider_pools.json')
        ),
        usageCacheCopied: await copyFileIfExists(
            resolvedPaths.usageCacheFilePath,
            path.join(artifactPaths.sourceDir, 'usage-cache.json')
        ),
        tokenStoreCopied: await copyFileIfExists(
            resolvedPaths.tokenStoreFilePath,
            path.join(artifactPaths.sourceDir, 'token-store.json')
        ),
        apiPotluckDataCopied: await copyFileIfExists(
            resolvedPaths.apiPotluckDataFilePath,
            path.join(artifactPaths.sourceDir, 'api-potluck-data.json')
        ),
        apiPotluckKeysCopied: await copyFileIfExists(
            resolvedPaths.apiPotluckKeysFilePath,
            path.join(artifactPaths.sourceDir, 'api-potluck-keys.json')
        ),
        sqliteFilesCopied: await backupSqliteFiles(resolvedPaths.dbPath, artifactPaths.beforeDir)
    };
    manifest.sourceSummary = sourceSummary;
    manifest.operator = operator;
    await writeJsonFile(artifactPaths.manifestPath, manifest);

    if (dryRun) {
        const report = await verifyRuntimeStorageMigration(config, {
            ...options,
            sourceBundle,
            runId,
            reportDir: artifactPaths.reportsDir,
            outputDir: artifactPaths.exportDir
        }).catch((error) => error.report || {
            runId,
            generatedAt: nowIso(),
            overallStatus: 'fail',
            error: error.message
        });

        const dryRunResult = {
            runId,
            dryRun: true,
            sourceSummary,
            preflightSummary: manifest.preflight,
            artifactPaths,
            report
        };
        await writeJsonFile(artifactPaths.manifestPath, { ...manifest, dryRunResult });
        return dryRunResult;
    }

    await recordMigrationRunStart(storage.client, runId, {
        sourceSummary,
        preflight: manifest.preflight,
        artifactPaths,
        operator,
        resumed: isResume
    });

    await insertMigrationItems(storage.client, runId, preflight.migrationItems);

    if (preflightAnomalyPolicy.status !== 'pass' && (cutoverPolicy.maxAnomalyCount !== null || cutoverPolicy.blockedAnomalyCodes.length > 0)) {
        const preflightError = wrapRuntimeStorageError(new Error('Runtime storage migration preflight anomaly policy failed'), {
            code: 'runtime_storage_validation_failed',
            classification: 'migration_validation_failed',
            phase: 'preflight',
            domain: 'compatibility',
            backend: 'db',
            operation: 'migrateLegacyRuntimeStorage',
            details: {
                runId,
                blockers: [
                    ...(preflightAnomalyPolicy.blockedCodeHits || []).map((item) => `anomaly:${item}`),
                    ...(preflightAnomalyPolicy.exceedsMaxCount ? ['anomaly:max-count'] : [])
                ],
                idempotencyKey: `migration_import_${runId}`,
                replayBoundary: 'migration_import_preflight'
            }
        });
        const failureSummary = {
            sourceSummary,
            preflight: manifest.preflight,
            artifactPaths,
            operator,
            error: preflightError.message,
            anomalyPolicy: preflightAnomalyPolicy
        };
        manifest.result = failureSummary;
        await writeJsonFile(artifactPaths.manifestPath, manifest);
        await updateMigrationRun(storage.client, runId, 'failed', failureSummary).catch(() => undefined);
        throw preflightError;
    }

    try {
        const existingItems = await storage.client.query(`
SELECT item_type, status
FROM storage_migration_items
WHERE run_id = ${sqlValue(runId)};
        `);
        const completedStepTypes = new Set(
            existingItems
                .filter((item) => item.status === 'completed')
                .map((item) => item.item_type)
        );
        const migrationSteps = [
            {
                itemType: 'provider_registry',
                execute: async () => {
                    await storage.replaceProviderPoolsSnapshot(sourceBundle.providerPools, {
                        sourceKind: 'legacy_migration',
                        progressInterval: options.progressInterval,
                        credentialProgressInterval: options.credentialProgressInterval,
                        prepareConcurrency: options.prepareConcurrency,
                        insertBatchSize: options.insertBatchSize
                    });

                    return Object.entries(sourceBundle.providerPools || {}).map(([providerType, providers]) => ({
                        itemType: 'provider_registry',
                        sourceRef: `provider_pools.json:${providerType}`,
                        targetRef: `provider_registrations:${providerType}`,
                        status: 'completed',
                        detailJson: {
                            providerType,
                            count: Array.isArray(providers) ? providers.length : 0
                        }
                    }));
                }
            },
            {
                itemType: 'credential_inventory',
                execute: async () => {
                    await clearCredentialDomain(storage.client);
                    await importCredentialState(storage.client, credentialState, nowIso());
                    return [{
                        itemType: 'credential_inventory',
                        sourceRef: 'provider_pools.json + api-potluck-data.json',
                        targetRef: 'credential_assets + credential_bindings',
                        status: 'completed',
                        detailJson: {
                            assetCount: credentialState.assets.length,
                            bindingCount: credentialState.bindings.length
                        }
                    }];
                }
            },
            {
                itemType: 'usage_cache',
                execute: async () => {
                    await clearUsageDomain(storage.client);
                    await importUsageCache(storage.client, sourceBundle.usageCache, nowIso());
                    return [{
                        itemType: 'usage_cache',
                        sourceRef: 'usage-cache.json',
                        targetRef: 'usage_snapshots',
                        status: 'completed',
                        detailJson: {
                            providerCount: Object.keys(sourceBundle.usageCache.providers || {}).length
                        }
                    }];
                }
            },
            {
                itemType: 'token_store',
                execute: async () => {
                    await clearSessionDomain(storage.client);
                    await importTokenStore(storage.client, sourceBundle.tokenStore, nowIso());
                    return [{
                        itemType: 'token_store',
                        sourceRef: 'token-store.json',
                        targetRef: 'admin_sessions',
                        status: 'completed',
                        detailJson: {
                            sessionCount: Object.keys(sourceBundle.tokenStore.tokens || {}).length
                        }
                    }];
                }
            },
            {
                itemType: 'api_potluck_data',
                execute: async () => {
                    await clearPotluckDomain(storage.client);
                    await importPotluckData(storage.client, sourceBundle.apiPotluckData, credentialState, nowIso());
                    return [{
                        itemType: 'api_potluck_data',
                        sourceRef: 'api-potluck-data.json',
                        targetRef: 'potluck_users + potluck_config + potluck_user_credentials',
                        status: 'completed',
                        detailJson: {
                            userCount: Object.keys(sourceBundle.apiPotluckData.users || {}).length
                        }
                    }];
                }
            },
            {
                itemType: 'api_potluck_keys',
                execute: async () => {
                    await importPotluckKeys(storage.client, sourceBundle.apiPotluckKeys, nowIso());
                    return [{
                        itemType: 'api_potluck_keys',
                        sourceRef: 'api-potluck-keys.json',
                        targetRef: 'potluck_api_keys',
                        status: 'completed',
                        detailJson: {
                            keyCount: Object.keys(sourceBundle.apiPotluckKeys.keys || {}).length
                        }
                    }];
                }
            }
        ];
        const pendingSteps = migrationSteps.filter((step) => !completedStepTypes.has(step.itemType));
        const requestedBatchSize = Number.parseInt(options.stepBatchSize, 10);
        const stepBatchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0
            ? requestedBatchSize
            : Math.max(pendingSteps.length, 1);
        const requestedStopAfterBatch = Number.parseInt(options.stopAfterBatch, 10);
        const stopAfterBatch = Number.isFinite(requestedStopAfterBatch) && requestedStopAfterBatch > 0
            ? requestedStopAfterBatch
            : null;
        const totalBatchCount = pendingSteps.length === 0 ? 0 : Math.ceil(pendingSteps.length / stepBatchSize);

        let executedBatchCount = 0;
        logger.info(`[RuntimeStorageMigration] Run ${runId} starting execute mode: ${pendingSteps.length} step(s), batchSize=${stepBatchSize}, totalBatches=${totalBatchCount}`);
        for (let batchIndex = 0; batchIndex < pendingSteps.length; batchIndex += stepBatchSize) {
            const batchSteps = pendingSteps.slice(batchIndex, batchIndex + stepBatchSize);
            const batchItems = [];
            const batchNumber = executedBatchCount + 1;
            logger.info(`[RuntimeStorageMigration] Run ${runId} starting batch ${batchNumber}/${totalBatchCount}: ${batchSteps.map((step) => step.itemType).join(', ')}`);

            for (const step of batchSteps) {
                const stepStartedAt = Date.now();
                logger.info(`[RuntimeStorageMigration] Run ${runId} step started: ${step.itemType}`);
                const stepItems = await step.execute();
                batchItems.push(...stepItems);
                logger.info(`[RuntimeStorageMigration] Run ${runId} step completed: ${step.itemType} (${Date.now() - stepStartedAt}ms, items=${stepItems.length})`);
            }

            await insertMigrationItems(storage.client, runId, batchItems);
            executedBatchCount += 1;
            logger.info(`[RuntimeStorageMigration] Run ${runId} finished batch ${executedBatchCount}/${totalBatchCount}`);

            if (stopAfterBatch !== null && executedBatchCount >= stopAfterBatch && batchIndex + stepBatchSize < pendingSteps.length) {
                const pausedSummary = {
                    sourceSummary,
                    preflight: manifest.preflight,
                    artifactPaths,
                    operator,
                    resume: {
                        paused: true,
                        runId,
                        stepBatchSize,
                        executedBatchCount,
                        totalBatchCount,
                        completedStepTypes: [...completedStepTypes, ...batchSteps.map((step) => step.itemType)]
                    }
                };
                manifest.result = pausedSummary;
                await writeJsonFile(artifactPaths.manifestPath, manifest);
                await updateMigrationRun(storage.client, runId, 'paused', pausedSummary);
                return {
                    runId,
                    dryRun: false,
                    paused: true,
                    sourceSummary,
                    artifactPaths,
                    summary: pausedSummary
                };
            }
        }

        logger.info(`[RuntimeStorageMigration] Run ${runId} exporting legacy snapshot for verification`);
        const exportedBundle = await exportLegacyRuntimeStorage(config, {
            ...options,
            outputDir: artifactPaths.exportDir,
            domains: ['provider-pools', 'usage-cache', 'api-potluck-data', 'api-potluck-keys']
        });
        logger.info(`[RuntimeStorageMigration] Run ${runId} verifying migrated runtime storage`);
        const report = await verifyRuntimeStorageMigration(config, {
            ...options,
            runId,
            sourceBundle,
            outputDir: artifactPaths.exportDir,
            reportDir: artifactPaths.reportsDir
        });
        const summary = {
            sourceSummary,
            preflight: manifest.preflight,
            exportedSummary: buildSummaryCounts(exportedBundle),
            verificationStatus: report.overallStatus,
            validationStatus: report.validationStatus,
            cutoverGate: report.cutoverGate,
            acceptanceSummary: report.acceptanceSummary,
            artifactPaths,
            operator,
            resume: {
                used: isResume,
                stepBatchSize,
                executedBatchCount,
                totalBatchCount
            }
        };

        manifest.result = summary;
        await writeJsonFile(artifactPaths.manifestPath, manifest);
        logger.info(`[RuntimeStorageMigration] Run ${runId} completed with validation status ${report.validationStatus}`);
        await updateMigrationRun(
            storage.client,
            runId,
            report.validationStatus === 'pass' ? 'completed' : 'completed_with_diff',
            summary
        );

        return {
            runId,
            dryRun: false,
            sourceSummary,
            artifactPaths,
            report,
            summary
        };
    } catch (error) {
        const failureSummary = {
            sourceSummary,
            preflight: manifest.preflight,
            artifactPaths,
            operator,
            error: error.message
        };
        manifest.result = failureSummary;
        await writeJsonFile(artifactPaths.manifestPath, manifest);
        await updateMigrationRun(storage.client, runId, 'failed', failureSummary).catch(() => undefined);
        throw error;
    }
}

export async function rollbackRuntimeStorageMigration(config = {}, options = {}) {
    if (!options.runId) {
        throw new Error('rollback requires runId');
    }

    const resolvedPaths = resolveRuntimeStoragePaths(config, options);
    const artifactPaths = buildArtifactPaths(resolvedPaths.artifactRoot, options.runId);
    if (!fs.existsSync(artifactPaths.runRoot)) {
        throw new Error(`Migration artifact directory not found: ${artifactPaths.runRoot}`);
    }

    const restoredFiles = [];
    const restoredDbFiles = await restoreSqliteFiles(artifactPaths.beforeDir, resolvedPaths.dbPath);
    restoredFiles.push(...restoredDbFiles);

    if (options.restoreLegacyFiles !== false) {
        const sourceRestores = [
            ['provider_pools.json', resolvedPaths.providerPoolsFilePath],
            ['usage-cache.json', resolvedPaths.usageCacheFilePath],
            ['token-store.json', resolvedPaths.tokenStoreFilePath],
            ['api-potluck-data.json', resolvedPaths.apiPotluckDataFilePath],
            ['api-potluck-keys.json', resolvedPaths.apiPotluckKeysFilePath]
        ];

        for (const [fileName, targetPath] of sourceRestores) {
            const backupPath = path.join(artifactPaths.sourceDir, fileName);
            if (!fs.existsSync(backupPath)) {
                continue;
            }
            await ensureDirectory(path.dirname(targetPath));
            await pfs.copyFile(backupPath, targetPath);
            restoredFiles.push(targetPath);
        }
    }

    const rollbackNotePath = path.join(artifactPaths.reportsDir, `rollback-${Date.now()}.json`);
    await writeJsonFile(rollbackNotePath, {
        runId: options.runId,
        restoredAt: nowIso(),
        restoredFiles
    });

    return {
        runId: options.runId,
        restoredFiles,
        rollbackNotePath
    };
}

export async function listRuntimeStorageMigrationRuns(config = {}, options = {}) {
    const { storage } = await createSqliteStorage(config, options);
    return await storage.client.query(`
SELECT id, migration_type, source_version, status, summary_json, started_at, finished_at
FROM storage_migration_runs
ORDER BY started_at DESC, id DESC;
    `);
}

export async function getRuntimeStorageMigrationRun(config = {}, runId, options = {}) {
    if (!runId) {
        throw new Error('runId is required');
    }

    const { storage } = await createSqliteStorage(config, options);
    const runRows = await storage.client.query(`
SELECT id, migration_type, source_version, status, summary_json, started_at, finished_at
FROM storage_migration_runs
WHERE id = ${sqlValue(runId)}
LIMIT 1;
    `);
    const itemRows = await storage.client.query(`
SELECT id, item_type, source_ref, target_ref, status, error_message, detail_json, created_at
FROM storage_migration_items
WHERE run_id = ${sqlValue(runId)}
ORDER BY created_at ASC, id ASC;
    `);

    if (!runRows[0]) {
        return null;
    }

    return {
        ...runRows[0],
        summary_json: parseJsonSafe(runRows[0].summary_json, {}),
        items: itemRows.map((itemRow) => ({
            ...itemRow,
            detail_json: parseJsonSafe(itemRow.detail_json, {})
        }))
    };
}

export async function readAdminConfig(configPath = 'configs/config.json', overrides = {}) {
    const absoluteConfigPath = resolvePathMaybeAbsolute(configPath);
    const configFromFile = await readJsonFile(absoluteConfigPath, {});
    const runtimeDefaults = getRuntimeStorageDefaults();
    const potluckDataPath = overrides.API_POTLUCK_DATA_FILE_PATH
        || overrides.POTLUCK_USER_DATA_FILE_PATH
        || configFromFile.API_POTLUCK_DATA_FILE_PATH
        || configFromFile.POTLUCK_USER_DATA_FILE_PATH
        || DEFAULT_API_POTLUCK_DATA_PATH;
    const potluckKeysPath = overrides.API_POTLUCK_KEYS_FILE_PATH
        || overrides.POTLUCK_KEYS_FILE_PATH
        || configFromFile.API_POTLUCK_KEYS_FILE_PATH
        || configFromFile.POTLUCK_KEYS_FILE_PATH
        || DEFAULT_API_POTLUCK_KEYS_PATH;

    return {
        ...runtimeDefaults,
        ...configFromFile,
        ...overrides,
        PROVIDER_POOLS_FILE_PATH: overrides.PROVIDER_POOLS_FILE_PATH || configFromFile.PROVIDER_POOLS_FILE_PATH || DEFAULT_PROVIDER_POOLS_PATH,
        RUNTIME_STORAGE_DB_PATH: overrides.RUNTIME_STORAGE_DB_PATH || configFromFile.RUNTIME_STORAGE_DB_PATH || runtimeDefaults.RUNTIME_STORAGE_DB_PATH,
        USAGE_CACHE_FILE_PATH: overrides.USAGE_CACHE_FILE_PATH || configFromFile.USAGE_CACHE_FILE_PATH || DEFAULT_USAGE_CACHE_PATH,
        API_POTLUCK_DATA_FILE_PATH: potluckDataPath,
        API_POTLUCK_KEYS_FILE_PATH: potluckKeysPath,
        POTLUCK_USER_DATA_FILE_PATH: potluckDataPath,
        POTLUCK_KEYS_FILE_PATH: potluckKeysPath,
        RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT: overrides.RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT || configFromFile.RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT
    };
}
