import { createHash } from 'crypto';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import logger from '../../utils/logger.js';
import { wrapRuntimeStorageError } from '../runtime-storage-error.js';
import {
    addToUsedPaths,
    createProviderConfig,
    detectProviderFromPath,
    formatSystemPath,
    getFileName,
    isPathUsed
} from '../../utils/provider-utils.js';

function buildProviderPoolsSummary(providerPools = {}) {
    return Object.entries(providerPools || {}).reduce((summaries, [providerType, providers]) => {
        const providerList = Array.isArray(providers) ? providers : [];
        summaries[providerType] = {
            totalCount: providerList.length,
            healthyCount: providerList.filter((provider) => provider?.isHealthy && !provider?.isDisabled).length,
            usageCount: providerList.reduce((sum, provider) => sum + Number(provider?.usageCount || 0), 0),
            errorCount: providerList.reduce((sum, provider) => sum + Number(provider?.errorCount || 0), 0)
        };
        return summaries;
    }, {});
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createEmptyTokenStore() {
    return { tokens: {} };
}

function createEmptyPotluckUserData() {
    return { config: {}, users: {} };
}

function createEmptyPotluckKeyStore() {
    return { keys: {} };
}

const fileWriteQueues = new Map();

function resolveFileWriteQueueKey(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        return null;
    }

    return path.resolve(filePath);
}

async function enqueueSerializedFileWrite(filePath, executor) {
    const queueKey = resolveFileWriteQueueKey(filePath);
    if (!queueKey) {
        return await executor();
    }

    const previousOperation = fileWriteQueues.get(queueKey) || Promise.resolve();
    const nextOperation = previousOperation
        .catch(() => undefined)
        .then(async () => await executor());

    let trackedOperation = null;
    trackedOperation = nextOperation.finally(() => {
        if (fileWriteQueues.get(queueKey) === trackedOperation) {
            fileWriteQueues.delete(queueKey);
        }
    });
    fileWriteQueues.set(queueKey, trackedOperation);

    return await nextOperation;
}

export class FileRuntimeStorage {
    constructor(config = {}) {
        this.config = config;
        this.filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        this.usageCacheFile = config.USAGE_CACHE_FILE_PATH || 'configs/usage-cache.json';
        this.tokenStoreFile = config.TOKEN_STORE_FILE_PATH || 'configs/token-store.json';
        this.potluckUserDataFile = config.POTLUCK_USER_DATA_FILE_PATH
            || config.API_POTLUCK_DATA_FILE_PATH
            || 'configs/api-potluck-data.json';
        this.potluckKeysFile = config.POTLUCK_KEYS_FILE_PATH
            || config.API_POTLUCK_KEYS_FILE_PATH
            || 'configs/api-potluck-keys.json';
        this.kind = 'file';
        this.usageRefreshTasks = new Map();
    }

    async initialize() {
        return this;
    }

    getInfo() {
        return {
            backend: 'file',
            filePath: this.filePath,
            usageCacheFile: this.usageCacheFile,
            tokenStoreFile: this.tokenStoreFile,
            potluckUserDataFile: this.potluckUserDataFile,
            potluckKeysFile: this.potluckKeysFile
        };
    }

    async loadProviderPoolsSnapshot() {
        return await this.#readJsonFile(this.filePath, {});
    }

    async exportProviderPoolsSnapshot() {
        return await this.loadProviderPoolsSnapshot();
    }

    async loadProviderPoolsSummary() {
        const providerPools = await this.loadProviderPoolsSnapshot();
        return buildProviderPoolsSummary(providerPools);
    }

    async replaceProviderPoolsSnapshot(providerPools = {}) {
        await this.#writeJsonFile(this.filePath, providerPools);
        return providerPools;
    }

    async findCredentialAsset() {
        return null;
    }

    async listCredentialAssets(_providerType = null, _options = {}) {
        return [];
    }

    async linkCredentialFiles(credPaths = [], options = {}) {
        const providerPools = options.providerPools && typeof options.providerPools === 'object'
            ? cloneJson(options.providerPools)
            : await this.loadProviderPoolsSnapshot();
        const allNewProviders = {};
        let totalNewProviders = 0;

        for (const rawPath of Array.isArray(credPaths) ? credPaths : []) {
            if (typeof rawPath !== 'string' || !rawPath.trim()) {
                continue;
            }

            const absolutePath = path.isAbsolute(rawPath)
                ? rawPath
                : path.join(process.cwd(), rawPath);
            if (!fs.existsSync(absolutePath)) {
                continue;
            }
            if (path.extname(absolutePath).toLowerCase() !== '.json') {
                continue;
            }

            const relativePath = path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');
            const mapping = detectProviderFromPath(relativePath.toLowerCase());
            if (!mapping) {
                continue;
            }

            if (!providerPools[mapping.providerType]) {
                providerPools[mapping.providerType] = [];
            }

            const linkedPaths = new Set();
            for (const provider of providerPools[mapping.providerType]) {
                if (provider[mapping.credPathKey]) {
                    addToUsedPaths(linkedPaths, provider[mapping.credPathKey]);
                }
            }

            if (isPathUsed(relativePath, getFileName(absolutePath), linkedPaths)) {
                continue;
            }

            const newProvider = createProviderConfig({
                credPathKey: mapping.credPathKey,
                credPath: formatSystemPath(relativePath),
                defaultCheckModel: mapping.defaultCheckModel,
                needsProjectId: mapping.needsProjectId,
                urlKeys: mapping.urlKeys
            });
            providerPools[mapping.providerType].push(newProvider);

            totalNewProviders += 1;
            if (!allNewProviders[mapping.displayName]) {
                allNewProviders[mapping.displayName] = [];
            }
            allNewProviders[mapping.displayName].push(newProvider);
        }

        if (totalNewProviders > 0) {
            await this.replaceProviderPoolsSnapshot(providerPools);
        }

        return {
            providerPools,
            totalNewProviders,
            allNewProviders
        };
    }

    async flushProviderRuntimeState(records = [], options = {}) {
        const runtimeRecords = Array.isArray(records)
            ? records.filter((record) => record?.providerId && record?.providerType)
            : [];

        if (runtimeRecords.length === 0) {
            return { flushedCount: 0 };
        }

        const providerPools = await this.loadProviderPoolsSnapshot();
        let flushedCount = 0;

        for (const record of runtimeRecords) {
            const providers = providerPools[record.providerType];
            if (!Array.isArray(providers)) {
                continue;
            }

            const provider = providers.find((item) => {
                if (!item || typeof item !== 'object') {
                    return false;
                }
                if (item.__providerId && item.__providerId === record.providerId) {
                    return true;
                }
                return record.routingUuid && item.uuid === record.routingUuid;
            });

            if (!provider) {
                continue;
            }

            provider.__providerId = record.providerId;
            provider.isHealthy = record.runtimeState?.isHealthy ?? true;
            provider.isDisabled = record.runtimeState?.isDisabled ?? false;
            provider.usageCount = record.runtimeState?.usageCount ?? 0;
            provider.errorCount = record.runtimeState?.errorCount ?? 0;
            provider.lastUsed = record.runtimeState?.lastUsed ?? null;
            provider.lastHealthCheckTime = record.runtimeState?.lastHealthCheckTime ?? null;
            provider.lastHealthCheckModel = record.runtimeState?.lastHealthCheckModel ?? null;
            provider.lastErrorTime = record.runtimeState?.lastErrorTime ?? null;
            provider.lastErrorMessage = record.runtimeState?.lastErrorMessage ?? null;
            provider.scheduledRecoveryTime = record.runtimeState?.scheduledRecoveryTime ?? null;
            provider.refreshCount = record.runtimeState?.refreshCount ?? 0;

            const persistSelectionState = record.persistSelectionState ?? options.persistSelectionState ?? false;
            if (persistSelectionState) {
                provider._lastSelectionSeq = record.runtimeState?.lastSelectionSeq ?? null;
            }

            flushedCount += 1;
        }

        if (flushedCount > 0) {
            await this.replaceProviderPoolsSnapshot(providerPools);
        }

        return { flushedCount };
    }

    async updateProviderRoutingUuid(update = {}) {
        const providerId = update?.providerId;
        const providerType = update?.providerType;
        const oldRoutingUuid = update?.oldRoutingUuid;
        const newRoutingUuid = update?.newRoutingUuid;

        if (!newRoutingUuid || (!providerId && !(providerType && oldRoutingUuid))) {
            return { updated: false };
        }

        const providerPools = await this.loadProviderPoolsSnapshot();
        const providerTypes = providerType ? [providerType] : Object.keys(providerPools || {});

        for (const currentProviderType of providerTypes) {
            const providers = providerPools[currentProviderType];
            if (!Array.isArray(providers)) {
                continue;
            }

            const provider = providers.find((item) => {
                if (!item || typeof item !== 'object') {
                    return false;
                }
                if (providerId && item.__providerId === providerId) {
                    return true;
                }
                return oldRoutingUuid && item.uuid === oldRoutingUuid;
            });

            if (!provider) {
                continue;
            }

            provider.uuid = newRoutingUuid;
            if (providerId) {
                provider.__providerId = providerId;
            }
            await this.replaceProviderPoolsSnapshot(providerPools);
            return { updated: true };
        }

        return { updated: false };
    }

    async hasProviderData() {
        return fs.existsSync(this.filePath);
    }

    async loadUsageCacheSnapshot() {
        const snapshot = await this.#readJsonFile(this.usageCacheFile, null);
        return snapshot && typeof snapshot === 'object' ? snapshot : null;
    }

    async loadUsageCacheSummary() {
        const usageCache = await this.loadUsageCacheSnapshot();
        if (!usageCache?.providers || typeof usageCache.providers !== 'object') {
            return null;
        }

        const providers = {};
        for (const [providerType, snapshot] of Object.entries(usageCache.providers)) {
            const normalizedSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
            providers[providerType] = {
                providerType,
                timestamp: normalizedSnapshot.timestamp || usageCache.timestamp || new Date().toISOString(),
                totalCount: Number(normalizedSnapshot.totalCount ?? 0),
                successCount: Number(normalizedSnapshot.successCount ?? 0),
                errorCount: Number(normalizedSnapshot.errorCount ?? 0),
                processedCount: Number.isFinite(normalizedSnapshot.processedCount)
                    ? normalizedSnapshot.processedCount
                    : (Array.isArray(normalizedSnapshot.instances) ? normalizedSnapshot.instances.length : Number(normalizedSnapshot.totalCount ?? 0)),
                instances: [],
                detailsLoaded: false
            };
        }

        return {
            timestamp: usageCache.timestamp || new Date().toISOString(),
            providers
        };
    }

    async replaceUsageCacheSnapshot(usageCache = null) {
        if (!usageCache) {
            if (fs.existsSync(this.usageCacheFile)) {
                await pfs.unlink(this.usageCacheFile);
            }
            return null;
        }

        await this.#writeJsonFile(this.usageCacheFile, usageCache);
        return usageCache;
    }

    async loadProviderUsageSnapshot(providerType, options = {}) {
        const usageCache = await this.loadUsageCacheSnapshot();
        const snapshot = usageCache?.providers?.[providerType] || null;
        if (!snapshot) {
            return null;
        }

        const rawPage = Number.parseInt(options?.page, 10);
        const rawLimit = Number.parseInt(options?.limit, 10);
        if (!Number.isFinite(rawPage) && !Number.isFinite(rawLimit)) {
            return snapshot;
        }

        const instances = Array.isArray(snapshot.instances) ? snapshot.instances : [];
        const availableCount = Number.isFinite(snapshot.availableCount)
            ? Number(snapshot.availableCount)
            : (Number.isFinite(snapshot.processedCount) ? Number(snapshot.processedCount) : instances.length);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100;
        const totalPages = Math.max(1, Math.ceil(Math.max(availableCount, 1) / limit));
        const page = Math.min(Math.max(1, Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1), totalPages);
        const offset = (page - 1) * limit;

        return {
            ...snapshot,
            instances: instances.slice(offset, offset + limit),
            availableCount,
            page,
            limit,
            totalPages,
            hasPrevPage: page > 1,
            hasNextPage: page < totalPages
        };
    }

    async upsertProviderUsageSnapshot(providerType, snapshot) {
        const usageCache = (await this.loadUsageCacheSnapshot()) || {
            timestamp: new Date().toISOString(),
            providers: {}
        };
        usageCache.providers = usageCache.providers || {};
        usageCache.providers[providerType] = snapshot;
        usageCache.timestamp = new Date().toISOString();
        await this.replaceUsageCacheSnapshot(usageCache);
        return snapshot;
    }

    async saveUsageRefreshTask(task) {
        if (!task?.id) {
            return null;
        }
        const cloned = cloneJson(task);
        this.usageRefreshTasks.set(task.id, cloned);
        return cloned;
    }

    async loadUsageRefreshTask(taskId) {
        const task = this.usageRefreshTasks.get(taskId);
        return task ? cloneJson(task) : null;
    }

    async markInterruptedUsageRefreshTasks() {
        let updatedCount = 0;
        for (const task of this.usageRefreshTasks.values()) {
            if (!task || task.status !== 'running') {
                continue;
            }
            task.status = 'failed';
            task.error = task.error || 'Usage refresh task interrupted by process restart';
            task.finishedAt = task.finishedAt || new Date().toISOString();
            updatedCount += 1;
        }
        return updatedCount;
    }

    async getAdminSession(token) {
        const tokenStore = await this.#readJsonFile(this.tokenStoreFile, createEmptyTokenStore());
        const tokenInfo = tokenStore.tokens?.[token] || null;
        if (!tokenInfo) {
            return null;
        }

        if (Date.now() > Number(tokenInfo.expiryTime || 0)) {
            await this.deleteAdminSession(token);
            return null;
        }

        return tokenInfo;
    }

    async saveAdminSession(token, tokenInfo = {}) {
        const tokenStore = await this.#readJsonFile(this.tokenStoreFile, createEmptyTokenStore());
        tokenStore.tokens = tokenStore.tokens || {};
        tokenStore.tokens[token] = tokenInfo;
        await this.#writeJsonFile(this.tokenStoreFile, tokenStore);
        return tokenInfo;
    }

    async deleteAdminSession(token) {
        const tokenStore = await this.#readJsonFile(this.tokenStoreFile, createEmptyTokenStore());
        if (!tokenStore.tokens?.[token]) {
            return false;
        }
        delete tokenStore.tokens[token];
        await this.#writeJsonFile(this.tokenStoreFile, tokenStore);
        return true;
    }

    async cleanupExpiredAdminSessions() {
        const tokenStore = await this.#readJsonFile(this.tokenStoreFile, createEmptyTokenStore());
        const now = Date.now();
        let deletedCount = 0;

        for (const [token, tokenInfo] of Object.entries(tokenStore.tokens || {})) {
            if (now > Number(tokenInfo?.expiryTime || 0)) {
                delete tokenStore.tokens[token];
                deletedCount += 1;
            }
        }

        if (deletedCount > 0) {
            await this.#writeJsonFile(this.tokenStoreFile, tokenStore);
        }

        return { deletedCount };
    }

    async loadPotluckUserData() {
        const store = await this.#readJsonFile(this.potluckUserDataFile, createEmptyPotluckUserData());
        return {
            config: store?.config || {},
            users: store?.users || {}
        };
    }

    async savePotluckUserData(store = createEmptyPotluckUserData()) {
        const normalized = {
            config: store?.config || {},
            users: store?.users || {}
        };
        await this.#writeJsonFile(this.potluckUserDataFile, normalized);
        return normalized;
    }

    async loadPotluckKeyStore() {
        const store = await this.#readJsonFile(this.potluckKeysFile, createEmptyPotluckKeyStore());
        return {
            keys: store?.keys || {}
        };
    }

    async savePotluckKeyStore(store = createEmptyPotluckKeyStore()) {
        const normalized = {
            keys: store?.keys || {}
        };
        await this.#writeJsonFile(this.potluckKeysFile, normalized);
        return normalized;
    }

    async close() {
        this.usageRefreshTasks.clear();
        return undefined;
    }

    async #readJsonFile(filePath, fallbackValue) {
        if (!filePath) {
            return cloneJson(fallbackValue);
        }

        try {
            const raw = await pfs.readFile(filePath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.warn(`[RuntimeStorage:file] Failed to read ${filePath}: ${error.message}`);
            }
            return cloneJson(fallbackValue);
        }
    }

    async #cleanupResidualTempFiles(filePath) {
        const fileDir = path.dirname(filePath);
        const baseName = path.basename(filePath);
        const tempFilePrefix = `${baseName}.`;

        let entries = [];
        try {
            entries = await pfs.readdir(fileDir, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') {
                return;
            }
            throw error;
        }

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.startsWith(tempFilePrefix) || !entry.name.endsWith('.tmp')) {
                continue;
            }

            const tempFilePath = path.join(fileDir, entry.name);
            try {
                await pfs.unlink(tempFilePath);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }
        }
    }

    async #writeJsonFile(filePath, payload) {
        if (!filePath) {
            return;
        }

        await enqueueSerializedFileWrite(filePath, async () => {
            const fileDir = path.dirname(filePath);
            const tempPath = `${filePath}.tmp`;
            await pfs.mkdir(fileDir, { recursive: true });
            await this.#cleanupResidualTempFiles(filePath);

            try {
                await pfs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
                await pfs.rename(tempPath, filePath);
            } catch (error) {
                try {
                    await this.#cleanupResidualTempFiles(filePath);
                } catch (cleanupError) {
                    logger.warn(`[RuntimeStorage:file] Failed to cleanup temp file for ${filePath}: ${cleanupError.message}`);
                }
                throw error;
            }
        });
    }
}


function buildFileStorageOperationKey(prefix, parts = []) {
    const normalizedParts = Array.isArray(parts)
        ? parts
            .filter((part) => part !== undefined && part !== null && String(part).trim())
            .map((part) => String(part).trim())
        : [];
    return `${prefix}_${createHash('sha256').update(`${prefix}::${normalizedParts.join('::')}`).digest('hex').slice(0, 24)}`;
}

function buildFileHashedTokenKey(token) {
    if (!token) {
        return null;
    }

    return `session_${createHash('sha256').update(String(token)).digest('hex').slice(0, 16)}`;
}

function buildFileOperationDetails(operation, args = []) {
    switch (operation) {
    case 'exportProviderPoolsSnapshot':
        return {
            replaySafe: true,
            replayBoundary: 'compat_export_provider_pools',
            idempotencyKey: 'provider_compat_export'
        };
    case 'replaceProviderPoolsSnapshot': {
        const providerPools = args[0] && typeof args[0] === 'object' ? args[0] : {};
        return {
            providerTypeCount: Object.keys(providerPools).length,
            replaySafe: true,
            replayBoundary: 'provider_snapshot_replace',
            idempotencyKey: 'provider_snapshot_replace_full'
        };
    }
    case 'linkCredentialFiles': {
        const credPaths = Array.isArray(args[0])
            ? args[0].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).sort()
            : [];
        return {
            credentialPathCount: credPaths.length,
            replaySafe: true,
            replayBoundary: 'provider_credential_binding_upsert',
            idempotencyKey: buildFileStorageOperationKey('provider_link_credentials', credPaths)
        };
    }
    case 'flushProviderRuntimeState': {
        const records = Array.isArray(args[0]) ? args[0] : [];
        const providerIds = records.map((record) => record?.providerId || null).filter(Boolean).sort();
        return {
            providerId: providerIds[0] || null,
            providerCount: providerIds.length,
            replaySafe: true,
            replayBoundary: 'provider_runtime_state_flush',
            idempotencyKey: buildFileStorageOperationKey('provider_runtime_flush', providerIds)
        };
    }
    case 'updateProviderRoutingUuid': {
        const update = args[0] || {};
        return {
            providerId: update.providerId || null,
            newRoutingUuid: update.newRoutingUuid || null,
            replaySafe: true,
            replayBoundary: 'provider_registration_routing_uuid',
            idempotencyKey: buildFileStorageOperationKey('provider_routing_uuid', [
                update.providerId || `${update.providerType || 'unknown'}:${update.oldRoutingUuid || 'unknown'}`,
                update.newRoutingUuid || 'missing'
            ])
        };
    }
    case 'replaceUsageCacheSnapshot': {
        const usageCache = args[0];
        return {
            providerCount: Object.keys(usageCache?.providers || {}).length,
            replaySafe: true,
            replayBoundary: 'usage_cache_replace',
            idempotencyKey: 'usage_cache_replace_full'
        };
    }
    case 'upsertProviderUsageSnapshot':
        return {
            providerType: args[0] || null,
            replaySafe: true,
            replayBoundary: 'provider_usage_upsert',
            idempotencyKey: buildFileStorageOperationKey('provider_usage', [args[0] || 'unknown'])
        };
    case 'saveUsageRefreshTask': {
        const task = args[0] || {};
        return {
            taskId: task.id || null,
            providerType: task.providerType || null,
            replaySafe: true,
            replayBoundary: 'usage_refresh_task_upsert',
            idempotencyKey: buildFileStorageOperationKey('usage_refresh_task', [task.id || 'missing'])
        };
    }
    case 'markInterruptedUsageRefreshTasks':
        return {
            replaySafe: true,
            replayBoundary: 'usage_refresh_task_interrupt_mark',
            idempotencyKey: 'usage_refresh_task_mark_interrupted_all'
        };
    case 'saveAdminSession':
        return {
            sessionKey: buildFileHashedTokenKey(args[0]),
            replaySafe: true,
            replayBoundary: 'admin_session_upsert',
            idempotencyKey: buildFileStorageOperationKey('admin_session', [args[0] || 'missing'])
        };
    case 'deleteAdminSession':
        return {
            sessionKey: buildFileHashedTokenKey(args[0]),
            replaySafe: true,
            replayBoundary: 'admin_session_delete',
            idempotencyKey: buildFileStorageOperationKey('admin_session_delete', [args[0] || 'missing'])
        };
    case 'cleanupExpiredAdminSessions':
        return {
            replaySafe: true,
            replayBoundary: 'admin_session_cleanup',
            idempotencyKey: 'admin_session_cleanup_expired'
        };
    case 'savePotluckUserData': {
        const store = args[0] || {};
        return {
            userCount: Object.keys(store.users || {}).length,
            replaySafe: true,
            replayBoundary: 'potluck_user_store_replace',
            idempotencyKey: 'potluck_user_store_replace_full'
        };
    }
    case 'savePotluckKeyStore': {
        const store = args[0] || {};
        return {
            keyCount: Object.keys(store.keys || {}).length,
            replaySafe: true,
            replayBoundary: 'potluck_key_store_replace',
            idempotencyKey: 'potluck_key_store_replace_full'
        };
    }
    default:
        return undefined;
    }
}

const FILE_STORAGE_OPERATION_META = {
    initialize: { phase: 'initialize', domain: 'runtime_storage' },
    loadProviderPoolsSnapshot: { phase: 'read', domain: 'provider' },
    exportProviderPoolsSnapshot: { phase: 'export', domain: 'provider' },
    replaceProviderPoolsSnapshot: { phase: 'write', domain: 'provider' },
    findCredentialAsset: { phase: 'read', domain: 'provider' },
    listCredentialAssets: { phase: 'read', domain: 'provider' },
    linkCredentialFiles: { phase: 'write', domain: 'provider' },
    flushProviderRuntimeState: { phase: 'flush', domain: 'provider' },
    updateProviderRoutingUuid: { phase: 'flush', domain: 'provider' },
    loadUsageCacheSnapshot: { phase: 'read', domain: 'usage' },
    replaceUsageCacheSnapshot: { phase: 'write', domain: 'usage' },
    loadProviderUsageSnapshot: { phase: 'read', domain: 'usage' },
    upsertProviderUsageSnapshot: { phase: 'write', domain: 'usage' },
    saveUsageRefreshTask: { phase: 'write', domain: 'usage' },
    loadUsageRefreshTask: { phase: 'read', domain: 'usage' },
    markInterruptedUsageRefreshTasks: { phase: 'write', domain: 'usage' },
    getAdminSession: { phase: 'read', domain: 'session' },
    saveAdminSession: { phase: 'write', domain: 'session' },
    deleteAdminSession: { phase: 'write', domain: 'session' },
    cleanupExpiredAdminSessions: { phase: 'write', domain: 'session' },
    loadPotluckUserData: { phase: 'read', domain: 'potluck' },
    savePotluckUserData: { phase: 'write', domain: 'potluck' },
    loadPotluckKeyStore: { phase: 'read', domain: 'potluck' },
    savePotluckKeyStore: { phase: 'write', domain: 'potluck' },
    close: { phase: 'close', domain: 'runtime_storage' }
};

for (const [operation, meta] of Object.entries(FILE_STORAGE_OPERATION_META)) {
    const original = FileRuntimeStorage.prototype[operation];
    if (typeof original !== 'function' || original.__runtimeStorageWrapped === true) {
        continue;
    }

    const wrapped = async function (...args) {
        try {
            return await original.apply(this, args);
        } catch (error) {
            throw wrapRuntimeStorageError(error, {
                phase: meta.phase,
                domain: meta.domain,
                backend: 'file',
                operation,
                details: buildFileOperationDetails(operation, args)
            });
        }
    };

    wrapped.__runtimeStorageWrapped = true;
    FileRuntimeStorage.prototype[operation] = wrapped;
}
