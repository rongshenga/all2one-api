import { createHash } from 'crypto';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import os from 'os';
import * as path from 'path';
import logger from '../../utils/logger.js';
import {
    createProviderConfig,
    detectProviderFromPath,
    formatSystemPath
} from '../../utils/provider-utils.js';
import { FileRuntimeStorage } from './file-runtime-storage.js';
import { SqliteCliClient } from '../sqlite-cli-client.js';
import { wrapRuntimeStorageError } from '../runtime-storage-error.js';
import {
    buildCredentialAssetRecord,
    buildCredentialBindingId,
    buildProviderPoolsSnapshot,
    splitProviderConfig,
    sqlValue
} from '../provider-storage-mapper.js';

function nowIso() {
    return new Date().toISOString();
}

function buildGeneratedProviderId(providerType, credentialAssetId, relativePath) {
    const hash = createHash('sha256')
        .update(`${providerType}::${credentialAssetId}::${relativePath || ''}`)
        .digest('hex')
        .slice(0, 24);

    return `prov_${hash}`;
}

function normalizePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mergeProviderPoolsSnapshot(target = {}, pageSnapshot = {}) {
    for (const [providerType, providers] of Object.entries(pageSnapshot || {})) {
        if (!Array.isArray(providers) || providers.length === 0) {
            continue;
        }
        if (!target[providerType]) {
            target[providerType] = [];
        }
        target[providerType].push(...providers);
    }

    return target;
}

function buildSqlInList(values = []) {
    const normalizedValues = Array.isArray(values)
        ? values.filter((value) => value !== undefined && value !== null && String(value).trim())
        : [];
    return normalizedValues.length > 0
        ? normalizedValues.map((value) => sqlValue(String(value).trim())).join(', ')
        : null;
}

function normalizeProjectRelativePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') {
        return null;
    }

    const absolutePath = path.isAbsolute(rawPath)
        ? rawPath
        : path.join(process.cwd(), rawPath);

    return path.relative(process.cwd(), absolutePath).replace(/\\/g, '/');
}

async function readCredentialAssetRecord(providerType, rawPath, sourceKind, timestamp) {
    const relativePath = normalizeProjectRelativePath(rawPath);
    if (!relativePath) {
        return null;
    }

    const absolutePath = path.isAbsolute(rawPath)
        ? rawPath
        : path.join(process.cwd(), rawPath);

    let rawContent = '';
    let payload = null;
    let stats = null;

    if (fs.existsSync(absolutePath)) {
        try {
            stats = await pfs.stat(absolutePath);
            rawContent = await pfs.readFile(absolutePath, 'utf8');
            payload = JSON.parse(rawContent);
        } catch (error) {
            logger.warn(`[RuntimeStorage:db] Failed to parse credential file ${relativePath}: ${error.message}`);
        }
    }

    return buildCredentialAssetRecord({
        providerType,
        sourcePath: relativePath,
        payload,
        rawContent,
        stats,
        sourceKind,
        timestamp
    });
}

function summarizeProviderPools(providerPools = {}) {
    const providerTypeEntries = Object.entries(providerPools || {}).filter(([, providers]) => Array.isArray(providers));
    return {
        providerTypeCount: providerTypeEntries.length,
        providerCount: providerTypeEntries.reduce((total, [, providers]) => total + providers.length, 0)
    };
}

function buildProviderIdentityConflictEntry(providerType, providerIndex, normalizedProvider) {
    return {
        providerType,
        providerIndex,
        providerId: normalizedProvider.providerId,
        routingUuid: normalizedProvider.registration?.routingUuid || null,
        displayName: normalizedProvider.registration?.displayName || null,
        credentialPaths: (normalizedProvider.credentialReferences || []).map((item) => item.filePath),
        inlineSecretKinds: (normalizedProvider.inlineSecrets || []).map((item) => item.secretKind).sort()
    };
}

function flattenProviderIdentityConflictEntry(prefix, entry = {}) {
    return {
        [`${prefix}ProviderType`]: entry.providerType || null,
        [`${prefix}ProviderIndex`]: entry.providerIndex ?? null,
        [`${prefix}RoutingUuid`]: entry.routingUuid || null,
        [`${prefix}DisplayName`]: entry.displayName || null,
        [`${prefix}CredentialPaths`]: Array.isArray(entry.credentialPaths) ? entry.credentialPaths.join(', ') : '',
        [`${prefix}InlineSecretKinds`]: Array.isArray(entry.inlineSecretKinds) ? entry.inlineSecretKinds.join(', ') : ''
    };
}

function assertUniqueProviderIdentity(seenProviderIds, entry, sourceKind) {
    const previousEntry = seenProviderIds.get(entry.providerId);
    if (!previousEntry) {
        seenProviderIds.set(entry.providerId, entry);
        return;
    }

    throw wrapRuntimeStorageError(new Error(`Duplicate provider identity detected for ${entry.providerType} (${entry.providerId})`), {
        code: 'runtime_storage_provider_identity_conflict',
        classification: 'constraint_conflict',
        phase: 'write',
        domain: 'provider',
        backend: 'db',
        operation: 'replaceProviderPoolsSnapshot',
        details: {
            sourceKind: sourceKind || null,
            providerId: entry.providerId,
            ...flattenProviderIdentityConflictEntry('previous', previousEntry),
            ...flattenProviderIdentityConflictEntry('current', entry)
        }
    });
}

function getAvailableParallelism() {
    if (typeof os.availableParallelism === 'function') {
        return Math.max(1, os.availableParallelism());
    }

    const cpuList = typeof os.cpus === 'function' ? os.cpus() : [];
    return Math.max(1, Array.isArray(cpuList) ? cpuList.length : 1);
}

function resolvePrepareConcurrency(requestedConcurrency) {
    const cpuTargetConcurrency = Math.max(1, Math.floor(getAvailableParallelism() * 0.8));
    return Math.max(1, normalizePositiveInt(requestedConcurrency, cpuTargetConcurrency));
}

function buildCredentialReferenceCacheKey(providerType, filePath) {
    const normalizedPath = normalizeProjectRelativePath(filePath);
    return normalizedPath ? `${providerType}::${normalizedPath}` : null;
}

function reinsertMapEntry(targetMap, key, value) {
    if (targetMap.has(key)) {
        targetMap.delete(key);
    }
    targetMap.set(key, value);
}

async function mapWithConcurrency(items, concurrency, iterator, onProgress = null) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const total = items.length;
    const workerCount = Math.max(1, Math.min(total, normalizePositiveInt(concurrency, total)));
    const results = new Array(total);
    let nextIndex = 0;
    let completedCount = 0;

    const runWorker = async () => {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= total) {
                return;
            }

            results[currentIndex] = await iterator(items[currentIndex], currentIndex);
            completedCount += 1;
            if (typeof onProgress === 'function') {
                onProgress({
                    completedCount,
                    totalCount: total,
                    item: items[currentIndex],
                    itemIndex: currentIndex
                });
            }
        }
    };

    await Promise.all(Array.from({ length: workerCount }, async () => await runWorker()));
    return results;
}

function appendInsertBatchStatements(statements, tableName, columns, rows = [], options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return 0;
    }

    const batchSize = Math.max(1, normalizePositiveInt(options.batchSize, 250));
    const suffix = options.suffix
        ? `
${String(options.suffix).trim().replace(/;\s*$/, '')}`
        : '';

    for (let index = 0; index < rows.length; index += batchSize) {
        const batchRows = rows.slice(index, index + batchSize);
        const valuesSql = batchRows
            .map((row) => `(${columns.map((column) => sqlValue(row[column])).join(', ')})`)
            .join(',\n');

        statements.push(`
INSERT INTO ${tableName} (
    ${columns.join(',\n    ')}
) VALUES
${valuesSql}${suffix};
        `);
    }

    return rows.length;
}

function appendCredentialFileIndexResetStatements(statements, credentialAssetIds = [], timestamp, batchSize) {
    const uniqueAssetIds = [...new Set((credentialAssetIds || []).filter(Boolean))];
    for (let index = 0; index < uniqueAssetIds.length; index += batchSize) {
        const batchIds = uniqueAssetIds.slice(index, index + batchSize);
        const batchSql = buildSqlInList(batchIds);
        if (!batchSql) {
            continue;
        }

        statements.push(`
UPDATE credential_file_index
SET is_primary = 0,
    updated_at = ${sqlValue(timestamp)}
WHERE credential_asset_id IN (${batchSql});
        `);
    }
}

function appendCredentialFileIndexDeleteStatements(statements, filePaths = [], batchSize) {
    const uniquePaths = [...new Set((filePaths || []).filter(Boolean))];
    for (let index = 0; index < uniquePaths.length; index += batchSize) {
        const batchPaths = uniquePaths.slice(index, index + batchSize);
        const batchSql = buildSqlInList(batchPaths);
        if (!batchSql) {
            continue;
        }

        statements.push(`
DELETE FROM credential_file_index
WHERE file_path IN (${batchSql});
        `);
    }
}

async function prepareProviderPoolsSnapshotImport(providerPools = {}, options = {}) {
    const sourceKind = options.sourceKind || 'provider_pools_json';
    const { providerTypeCount, providerCount } = summarizeProviderPools(providerPools);
    const seenProviderIds = new Map();
    const progressInterval = Math.max(1, normalizePositiveInt(options.progressInterval, 2000));
    const prepareConcurrency = resolvePrepareConcurrency(options.prepareConcurrency);
    const credentialProgressInterval = Math.max(1, normalizePositiveInt(options.credentialProgressInterval, 1000));
    const normalizedProviderRows = [];
    const credentialRequests = new Map();
    let processedProviders = 0;
    let credentialReferenceCount = 0;

    logger.info(`[RuntimeStorage:db] Replacing provider pools snapshot from ${sourceKind}: ${providerTypeCount} types / ${providerCount} providers`);
    logger.info(`[RuntimeStorage:db] Preparing provider snapshot import with target concurrency ${prepareConcurrency} (~80% CPU budget)`);

    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        if (!Array.isArray(providers)) {
            continue;
        }

        logger.info(`[RuntimeStorage:db] Importing provider type ${providerType}: ${providers.length} providers`);

        for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
            const providerConfig = providers[providerIndex];
            const normalized = splitProviderConfig(providerType, providerConfig);
            const identityEntry = buildProviderIdentityConflictEntry(providerType, providerIndex, normalized);
            assertUniqueProviderIdentity(seenProviderIds, identityEntry, sourceKind);

            const credentialCacheKeys = [];
            for (const credentialReference of normalized.credentialReferences || []) {
                const cacheKey = buildCredentialReferenceCacheKey(providerType, credentialReference.filePath);
                if (!cacheKey) {
                    continue;
                }

                credentialReferenceCount += 1;
                credentialCacheKeys.push(cacheKey);
                if (!credentialRequests.has(cacheKey)) {
                    credentialRequests.set(cacheKey, {
                        cacheKey,
                        providerType,
                        filePath: credentialReference.filePath
                    });
                }
            }

            normalizedProviderRows.push({
                providerType,
                normalized,
                credentialCacheKeys
            });

            processedProviders += 1;
            if (processedProviders === providerCount || processedProviders % progressInterval === 0) {
                logger.info(`[RuntimeStorage:db] Provider snapshot progress: ${processedProviders}/${providerCount}`);
            }
        }
    }

    const credentialRequestList = Array.from(credentialRequests.values());
    logger.info(`[RuntimeStorage:db] Preparing credential asset cache: ${credentialRequestList.length} unique file(s) from ${credentialReferenceCount} reference(s)`);

    const credentialResults = await mapWithConcurrency(
        credentialRequestList,
        prepareConcurrency,
        async (request) => await readCredentialAssetRecord(
            request.providerType,
            request.filePath,
            sourceKind,
            options.timestamp
        ),
        ({ completedCount, totalCount }) => {
            if (completedCount === totalCount || completedCount % credentialProgressInterval === 0) {
                logger.info(`[RuntimeStorage:db] Credential preload progress: ${completedCount}/${totalCount}`);
            }
        }
    );

    const assetRecordByCacheKey = new Map();
    for (let index = 0; index < credentialRequestList.length; index += 1) {
        assetRecordByCacheKey.set(credentialRequestList[index].cacheKey, credentialResults[index] || null);
    }

    const registrations = [];
    const runtimeStates = [];
    const inlineSecrets = [];
    const latestAssetRecords = new Map();
    const latestBindingAssetIds = new Map();

    for (const providerRow of normalizedProviderRows) {
        const registration = providerRow.normalized.registration;
        const runtimeState = providerRow.normalized.runtimeState;

        registrations.push({
            provider_id: registration.providerId,
            provider_type: registration.providerType,
            routing_uuid: registration.routingUuid,
            display_name: registration.displayName,
            check_model: registration.checkModel,
            project_id: registration.projectId,
            base_url: registration.baseUrl,
            config_json: registration.configJson,
            source_kind: sourceKind,
            created_at: options.timestamp,
            updated_at: options.timestamp
        });

        runtimeStates.push({
            provider_id: runtimeState.providerId,
            is_healthy: runtimeState.isHealthy,
            is_disabled: runtimeState.isDisabled,
            usage_count: runtimeState.usageCount,
            error_count: runtimeState.errorCount,
            last_used_at: runtimeState.lastUsed,
            last_health_check_at: runtimeState.lastHealthCheckTime,
            last_health_check_model: runtimeState.lastHealthCheckModel,
            last_error_time: runtimeState.lastErrorTime,
            last_error_message: runtimeState.lastErrorMessage,
            scheduled_recovery_at: runtimeState.scheduledRecoveryTime,
            refresh_count: runtimeState.refreshCount,
            last_selection_seq: runtimeState.lastSelectionSeq,
            updated_at: options.timestamp
        });

        for (const secret of providerRow.normalized.inlineSecrets || []) {
            inlineSecrets.push({
                provider_id: secret.providerId,
                secret_kind: secret.secretKind,
                secret_payload: secret.secretPayload,
                protection_mode: secret.protectionMode,
                updated_at: options.timestamp
            });
        }

        for (const cacheKey of providerRow.credentialCacheKeys) {
            const assetRecord = assetRecordByCacheKey.get(cacheKey);
            if (!assetRecord?.asset?.id) {
                continue;
            }

            reinsertMapEntry(latestAssetRecords, assetRecord.asset.id, assetRecord);
            latestBindingAssetIds.set(providerRow.normalized.providerId, assetRecord.asset.id);
        }
    }

    const credentialAssets = [];
    const credentialFileIndexes = [];
    for (const assetRecord of latestAssetRecords.values()) {
        const asset = assetRecord.asset;
        credentialAssets.push({
            id: asset.id,
            provider_type: asset.providerType,
            identity_key: asset.identityKey,
            dedupe_key: asset.dedupeKey,
            email: asset.email,
            account_id: asset.accountId,
            external_user_id: asset.externalUserId,
            source_kind: asset.sourceKind,
            source_path: asset.sourcePath,
            source_checksum: asset.sourceChecksum,
            storage_mode: asset.storageMode,
            is_active: asset.isActive,
            last_imported_at: asset.lastImportedAt,
            last_refreshed_at: asset.lastRefreshedAt,
            created_at: asset.createdAt,
            updated_at: asset.updatedAt
        });

        if (assetRecord.fileIndex) {
            credentialFileIndexes.push({
                id: assetRecord.fileIndex.id,
                credential_asset_id: assetRecord.fileIndex.credentialAssetId,
                file_path: assetRecord.fileIndex.filePath,
                file_name: assetRecord.fileIndex.fileName,
                file_size: assetRecord.fileIndex.fileSize,
                checksum: assetRecord.fileIndex.checksum,
                mtime: assetRecord.fileIndex.mtime,
                is_primary: assetRecord.fileIndex.isPrimary,
                created_at: assetRecord.fileIndex.createdAt,
                updated_at: assetRecord.fileIndex.updatedAt
            });
        }
    }

    const credentialBindings = [];
    for (const [providerId, credentialAssetId] of latestBindingAssetIds.entries()) {
        credentialBindings.push({
            id: buildCredentialBindingId('provider_registration', providerId, credentialAssetId),
            credential_asset_id: credentialAssetId,
            binding_type: 'provider_registration',
            binding_target_id: providerId,
            binding_status: 'active',
            created_at: options.timestamp,
            updated_at: options.timestamp
        });
    }

    logger.info(`[RuntimeStorage:db] Prepared provider snapshot payload: registrations=${registrations.length}, runtimeStates=${runtimeStates.length}, secrets=${inlineSecrets.length}, credentialAssets=${credentialAssets.length}, credentialBindings=${credentialBindings.length}`);

    return {
        providerTypeCount,
        providerCount,
        prepareConcurrency,
        credentialReferenceCount,
        uniqueCredentialReferenceCount: credentialRequestList.length,
        registrations,
        runtimeStates,
        inlineSecrets,
        credentialAssets,
        credentialFileIndexes,
        credentialBindings
    };
}

function pushProviderStatements(statements, normalizedProvider, sourceKind, timestamp) {
    const registration = normalizedProvider.registration;
    const runtimeState = normalizedProvider.runtimeState;

    statements.push(`
INSERT INTO provider_registrations (
    provider_id,
    provider_type,
    routing_uuid,
    display_name,
    check_model,
    project_id,
    base_url,
    config_json,
    source_kind,
    created_at,
    updated_at
) VALUES (
    ${sqlValue(registration.providerId)},
    ${sqlValue(registration.providerType)},
    ${sqlValue(registration.routingUuid)},
    ${sqlValue(registration.displayName)},
    ${sqlValue(registration.checkModel)},
    ${sqlValue(registration.projectId)},
    ${sqlValue(registration.baseUrl)},
    ${sqlValue(registration.configJson)},
    ${sqlValue(sourceKind)},
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)}
);
    `);

    statements.push(`
INSERT INTO provider_runtime_state (
    provider_id,
    is_healthy,
    is_disabled,
    usage_count,
    error_count,
    last_used_at,
    last_health_check_at,
    last_health_check_model,
    last_error_time,
    last_error_message,
    scheduled_recovery_at,
    refresh_count,
    last_selection_seq,
    updated_at
) VALUES (
    ${sqlValue(runtimeState.providerId)},
    ${sqlValue(runtimeState.isHealthy)},
    ${sqlValue(runtimeState.isDisabled)},
    ${sqlValue(runtimeState.usageCount)},
    ${sqlValue(runtimeState.errorCount)},
    ${sqlValue(runtimeState.lastUsed)},
    ${sqlValue(runtimeState.lastHealthCheckTime)},
    ${sqlValue(runtimeState.lastHealthCheckModel)},
    ${sqlValue(runtimeState.lastErrorTime)},
    ${sqlValue(runtimeState.lastErrorMessage)},
    ${sqlValue(runtimeState.scheduledRecoveryTime)},
    ${sqlValue(runtimeState.refreshCount)},
    ${sqlValue(runtimeState.lastSelectionSeq)},
    ${sqlValue(timestamp)}
);
    `);

    for (const secret of normalizedProvider.inlineSecrets) {
        statements.push(`
INSERT INTO provider_inline_secrets (
    provider_id,
    secret_kind,
    secret_payload,
    protection_mode,
    updated_at
) VALUES (
    ${sqlValue(secret.providerId)},
    ${sqlValue(secret.secretKind)},
    ${sqlValue(secret.secretPayload)},
    ${sqlValue(secret.protectionMode)},
    ${sqlValue(timestamp)}
);
        `);
    }
}

function pushCredentialAssetStatements(statements, assetRecord, timestamp) {
    const asset = assetRecord.asset;
    const fileIndex = assetRecord.fileIndex;

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
    ${sqlValue(asset.email)},
    ${sqlValue(asset.accountId)},
    ${sqlValue(asset.externalUserId)},
    ${sqlValue(asset.sourceKind)},
    ${sqlValue(asset.sourcePath)},
    ${sqlValue(asset.sourceChecksum)},
    ${sqlValue(asset.storageMode)},
    ${sqlValue(asset.isActive)},
    ${sqlValue(asset.lastImportedAt)},
    ${sqlValue(asset.lastRefreshedAt)},
    ${sqlValue(asset.createdAt)},
    ${sqlValue(asset.updatedAt)}
)
ON CONFLICT(id) DO UPDATE SET
    identity_key = COALESCE(excluded.identity_key, credential_assets.identity_key),
    dedupe_key = excluded.dedupe_key,
    email = COALESCE(excluded.email, credential_assets.email),
    account_id = COALESCE(excluded.account_id, credential_assets.account_id),
    external_user_id = COALESCE(excluded.external_user_id, credential_assets.external_user_id),
    source_kind = excluded.source_kind,
    source_path = COALESCE(excluded.source_path, credential_assets.source_path),
    source_checksum = COALESCE(excluded.source_checksum, credential_assets.source_checksum),
    storage_mode = excluded.storage_mode,
    is_active = excluded.is_active,
    last_imported_at = COALESCE(excluded.last_imported_at, credential_assets.last_imported_at),
    updated_at = excluded.updated_at;
    `);

    if (!fileIndex) {
        return;
    }

    statements.push(`
UPDATE credential_file_index
SET is_primary = 0,
    updated_at = ${sqlValue(timestamp)}
WHERE credential_asset_id = ${sqlValue(fileIndex.credentialAssetId)}
  AND file_path <> ${sqlValue(fileIndex.filePath)};
    `);

    statements.push(`
DELETE FROM credential_file_index
WHERE file_path = ${sqlValue(fileIndex.filePath)};
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
    ${sqlValue(fileIndex.id)},
    ${sqlValue(fileIndex.credentialAssetId)},
    ${sqlValue(fileIndex.filePath)},
    ${sqlValue(fileIndex.fileName)},
    ${sqlValue(fileIndex.fileSize)},
    ${sqlValue(fileIndex.checksum)},
    ${sqlValue(fileIndex.mtime)},
    ${sqlValue(fileIndex.isPrimary)},
    ${sqlValue(fileIndex.createdAt)},
    ${sqlValue(fileIndex.updatedAt)}
);
    `);
}

function pushCredentialBindingStatements(statements, providerId, credentialAssetId, timestamp) {
    const bindingId = buildCredentialBindingId('provider_registration', providerId, credentialAssetId);

    statements.push(`
UPDATE credential_bindings
SET binding_status = 'inactive',
    updated_at = ${sqlValue(timestamp)}
WHERE binding_type = 'provider_registration'
  AND binding_target_id = ${sqlValue(providerId)}
  AND id <> ${sqlValue(bindingId)};
    `);

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
    ${sqlValue(bindingId)},
    ${sqlValue(credentialAssetId)},
    'provider_registration',
    ${sqlValue(providerId)},
    'active',
    ${sqlValue(timestamp)},
    ${sqlValue(timestamp)}
)
ON CONFLICT(id) DO UPDATE SET
    binding_status = excluded.binding_status,
    updated_at = excluded.updated_at;
    `);
}

function parseJsonField(value, fallback = null) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function normalizeIsoOrNull(value) {
    if (!value) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDateOnly(value) {
    if (!value) {
        return null;
    }

    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        return value.trim();
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function hashValue(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function buildUsageSnapshotId(providerType, providerId = 'all') {
    return `usage_${hashValue(`${providerType}::${providerId}`).slice(0, 24)}`;
}

function buildUsageSnapshotInstanceKey(instance = {}, index = 0) {
    if (instance.uuid) {
        return String(instance.uuid);
    }

    if (instance.name) {
        return `${String(instance.name)}::${index}`;
    }

    return `instance_${index}`;
}

function buildUsageSnapshotInstanceId(providerType, instanceKey) {
    return `usage_inst_${hashValue(`${providerType}::${instanceKey}`).slice(0, 24)}`;
}

function buildUsageSnapshotBreakdownId(instanceId, breakdownIndex) {
    return `usage_brk_${hashValue(`${instanceId}::${breakdownIndex}`).slice(0, 24)}`;
}

function buildUsageSnapshotFreeTrialId(breakdownId) {
    return `usage_ft_${hashValue(breakdownId).slice(0, 24)}`;
}

function buildUsageSnapshotBonusId(breakdownId, bonusIndex) {
    return `usage_bonus_${hashValue(`${breakdownId}::${bonusIndex}`).slice(0, 24)}`;
}

function normalizeNumberOrNull(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUsageFreeTrialRecord(freeTrial = null) {
    if (!freeTrial || typeof freeTrial !== 'object') {
        return null;
    }

    return {
        status: freeTrial.status || null,
        currentUsage: normalizeNumberOrNull(freeTrial.currentUsage),
        usageLimit: normalizeNumberOrNull(freeTrial.usageLimit),
        expiresAt: normalizeIsoOrNull(freeTrial.expiresAt)
    };
}

function normalizeUsageBonusRecord(bonus = null) {
    if (!bonus || typeof bonus !== 'object') {
        return null;
    }

    return {
        code: bonus.code || null,
        displayName: bonus.displayName || null,
        description: bonus.description || null,
        status: bonus.status || null,
        currentUsage: normalizeNumberOrNull(bonus.currentUsage),
        usageLimit: normalizeNumberOrNull(bonus.usageLimit),
        redeemedAt: normalizeIsoOrNull(bonus.redeemedAt),
        expiresAt: normalizeIsoOrNull(bonus.expiresAt)
    };
}

function normalizeUsageBreakdownRecord(breakdown = {}) {
    const rateLimit = breakdown?.rateLimit && typeof breakdown.rateLimit === 'object'
        ? breakdown.rateLimit
        : null;
    const primaryWindow = rateLimit?.primary_window && typeof rateLimit.primary_window === 'object'
        ? rateLimit.primary_window
        : null;
    const secondaryWindow = rateLimit?.secondary_window && typeof rateLimit.secondary_window === 'object'
        ? rateLimit.secondary_window
        : null;

    return {
        resourceType: breakdown.resourceType || null,
        displayName: breakdown.displayName || null,
        displayNamePlural: breakdown.displayNamePlural || null,
        unit: breakdown.unit || null,
        currency: breakdown.currency || null,
        currentUsage: normalizeNumberOrNull(breakdown.currentUsage),
        usageLimit: normalizeNumberOrNull(breakdown.usageLimit),
        currentOverages: normalizeNumberOrNull(breakdown.currentOverages),
        overageCap: normalizeNumberOrNull(breakdown.overageCap),
        overageRate: normalizeNumberOrNull(breakdown.overageRate),
        overageCharges: normalizeNumberOrNull(breakdown.overageCharges),
        nextDateReset: normalizeIsoOrNull(breakdown.nextDateReset || breakdown.resetTime),
        modelName: breakdown.modelName || null,
        remaining: normalizeNumberOrNull(breakdown.remaining),
        remainingPercent: normalizeNumberOrNull(breakdown.remainingPercent),
        resetTime: breakdown.resetTime || null,
        resetTimeRaw: breakdown.resetTimeRaw == null ? null : String(breakdown.resetTimeRaw),
        rateLimitAllowed: rateLimit?.allowed === undefined ? null : (rateLimit.allowed ? 1 : 0),
        rateLimitReached: rateLimit?.limit_reached === undefined ? null : (rateLimit.limit_reached ? 1 : 0),
        primaryLimitWindowSeconds: normalizeNumberOrNull(primaryWindow?.limit_window_seconds),
        primaryResetAfterSeconds: normalizeNumberOrNull(primaryWindow?.reset_after_seconds),
        primaryResetAt: normalizeNumberOrNull(primaryWindow?.reset_at),
        primaryUsedPercent: normalizeNumberOrNull(primaryWindow?.used_percent),
        secondaryLimitWindowSeconds: normalizeNumberOrNull(secondaryWindow?.limit_window_seconds),
        secondaryResetAfterSeconds: normalizeNumberOrNull(secondaryWindow?.reset_after_seconds),
        secondaryResetAt: normalizeNumberOrNull(secondaryWindow?.reset_at),
        secondaryUsedPercent: normalizeNumberOrNull(secondaryWindow?.used_percent),
        freeTrial: normalizeUsageFreeTrialRecord(breakdown.freeTrial),
        bonuses: Array.isArray(breakdown.bonuses)
            ? breakdown.bonuses.map((bonus) => normalizeUsageBonusRecord(bonus)).filter(Boolean)
            : []
    };
}

function normalizeUsageInstanceRecord(instance = {}, index = 0, fallbackTimestamp = null) {
    const usage = instance?.usage && typeof instance.usage === 'object' ? instance.usage : null;
    const subscription = usage?.subscription && typeof usage.subscription === 'object' ? usage.subscription : null;
    const user = usage?.user && typeof usage.user === 'object' ? usage.user : null;

    return {
        instanceKey: buildUsageSnapshotInstanceKey(instance, index),
        uuid: instance.uuid || null,
        name: instance.name || instance.uuid || `instance_${index}`,
        success: instance.success === true,
        error: instance.error ? String(instance.error) : null,
        isDisabled: instance.isDisabled === true,
        isHealthy: instance.isHealthy === undefined ? null : Boolean(instance.isHealthy),
        lastRefreshedAt: normalizeIsoOrNull(instance.lastRefreshedAt || instance.timestamp || instance.cachedAt || fallbackTimestamp) || fallbackTimestamp,
        subscriptionTitle: subscription?.title || null,
        subscriptionType: subscription?.type || null,
        subscriptionUpgradeCapability: subscription?.upgradeCapability || null,
        subscriptionOverageCapability: subscription?.overageCapability || null,
        userEmail: user?.email || null,
        userId: user?.userId || null,
        usageBreakdown: Array.isArray(usage?.usageBreakdown)
            ? usage.usageBreakdown.map((breakdown) => normalizeUsageBreakdownRecord(breakdown))
            : []
    };
}

function normalizeUsageSnapshotRecord(providerType, snapshot = {}, fallbackTimestamp = null) {
    const normalizedSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const timestamp = normalizeIsoOrNull(normalizedSnapshot.timestamp || fallbackTimestamp) || nowIso();
    const instances = Array.isArray(normalizedSnapshot.instances)
        ? normalizedSnapshot.instances.map((instance, index) => normalizeUsageInstanceRecord(instance, index, timestamp))
        : [];

    return {
        providerType,
        timestamp,
        totalCount: Number(normalizedSnapshot.totalCount ?? instances.length ?? 0),
        successCount: Number(normalizedSnapshot.successCount ?? instances.filter((instance) => instance.success).length ?? 0),
        errorCount: Number(normalizedSnapshot.errorCount ?? instances.filter((instance) => !instance.success).length ?? 0),
        processedCount: Number.isFinite(normalizedSnapshot.processedCount)
            ? normalizedSnapshot.processedCount
            : instances.length,
        instances
    };
}

function normalizeUsageCompatInstanceRecord(instance = {}, fallbackTimestamp = null) {
    if (!instance || typeof instance !== 'object') {
        return null;
    }

    return {
        ...instance,
        lastRefreshedAt: normalizeIsoOrNull(
            instance.lastRefreshedAt || instance.timestamp || instance.cachedAt || fallbackTimestamp
        ) || fallbackTimestamp || null
    };
}

function normalizeUsageCompatSnapshotRecord(providerType, snapshot = {}, fallbackTimestamp = null) {
    const normalizedSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const timestamp = normalizeIsoOrNull(normalizedSnapshot.timestamp || fallbackTimestamp) || nowIso();
    const instances = Array.isArray(normalizedSnapshot.instances)
        ? normalizedSnapshot.instances
            .map((instance) => normalizeUsageCompatInstanceRecord(instance, timestamp))
            .filter(Boolean)
        : [];
    const successCount = Number.isFinite(normalizedSnapshot.successCount)
        ? normalizedSnapshot.successCount
        : instances.filter((instance) => instance.success === true).length;
    const errorCount = Number.isFinite(normalizedSnapshot.errorCount)
        ? normalizedSnapshot.errorCount
        : instances.filter((instance) => instance.success !== true).length;
    const totalCount = Number.isFinite(normalizedSnapshot.totalCount)
        ? normalizedSnapshot.totalCount
        : instances.length;
    const processedCount = Number.isFinite(normalizedSnapshot.processedCount)
        ? normalizedSnapshot.processedCount
        : instances.length;

    return {
        ...normalizedSnapshot,
        providerType: normalizedSnapshot.providerType || providerType,
        timestamp,
        instances,
        totalCount,
        successCount,
        errorCount,
        processedCount
    };
}

function buildUsageSnapshotSummaryRecord(row = {}) {
    return {
        providerType: row.provider_type || null,
        timestamp: normalizeIsoOrNull(row.snapshot_at) || nowIso(),
        totalCount: Number(row.total_count ?? 0),
        successCount: Number(row.success_count ?? 0),
        errorCount: Number(row.error_count ?? 0),
        processedCount: Number(row.processed_count ?? row.total_count ?? 0)
    };
}

function buildLegacyUsageSnapshotFromRow(row = {}) {
    const payload = parseJsonField(row.payload_json, {}) || {};
    return {
        ...payload,
        providerType: payload.providerType || row.provider_type,
        timestamp: normalizeIsoOrNull(payload.timestamp || row.snapshot_at) || nowIso(),
        totalCount: Number(row.total_count ?? payload.totalCount ?? 0),
        successCount: Number(row.success_count ?? payload.successCount ?? 0),
        errorCount: Number(row.error_count ?? payload.errorCount ?? 0),
        processedCount: Number.isFinite(payload.processedCount)
            ? payload.processedCount
            : Number(row.processed_count ?? row.total_count ?? 0)
    };
}

function buildUsageSnapshotPersistenceRows(providerType, snapshot = {}, fallbackTimestamp = null) {
    const normalizedSnapshot = normalizeUsageSnapshotRecord(providerType, snapshot, fallbackTimestamp);
    const compatSnapshot = normalizeUsageCompatSnapshotRecord(providerType, snapshot, fallbackTimestamp);
    const snapshotId = buildUsageSnapshotId(providerType);
    const snapshotRow = {
        id: snapshotId,
        provider_type: providerType,
        provider_id: null,
        snapshot_at: normalizedSnapshot.timestamp,
        total_count: Number(normalizedSnapshot.totalCount ?? 0),
        success_count: Number(normalizedSnapshot.successCount ?? 0),
        error_count: Number(normalizedSnapshot.errorCount ?? 0),
        processed_count: Number(normalizedSnapshot.processedCount ?? normalizedSnapshot.instances.length ?? 0),
        payload_json: JSON.stringify(compatSnapshot)
    };

    const instanceRows = [];
    const breakdownRows = [];
    const freeTrialRows = [];
    const bonusRows = [];

    normalizedSnapshot.instances.forEach((instance, instanceIndex) => {
        const instanceId = buildUsageSnapshotInstanceId(providerType, instance.instanceKey);
        instanceRows.push({
            id: instanceId,
            snapshot_id: snapshotId,
            instance_key: instance.instanceKey,
            uuid: instance.uuid,
            display_name: instance.name && instance.name !== instance.uuid ? instance.name : null,
            success: instance.success === true,
            error_message: instance.error || null,
            is_disabled: instance.isDisabled === true,
            is_healthy: instance.isHealthy === null || instance.isHealthy === undefined ? null : (instance.isHealthy === true),
            last_refreshed_at: normalizeIsoOrNull(instance.lastRefreshedAt) || normalizedSnapshot.timestamp,
            subscription_title: instance.subscriptionTitle || null,
            subscription_type: instance.subscriptionType || null,
            subscription_upgrade_capability: instance.subscriptionUpgradeCapability || null,
            subscription_overage_capability: instance.subscriptionOverageCapability || null,
            user_email: instance.userEmail || null,
            user_id: instance.userId || null,
            instance_order: instanceIndex
        });

        instance.usageBreakdown.forEach((breakdown, breakdownIndex) => {
            const breakdownId = buildUsageSnapshotBreakdownId(instanceId, breakdownIndex);
            breakdownRows.push({
                id: breakdownId,
                instance_id: instanceId,
                breakdown_order: breakdownIndex,
                resource_type: breakdown.resourceType || null,
                display_name: breakdown.displayName || null,
                display_name_plural: breakdown.displayNamePlural || null,
                unit: breakdown.unit || null,
                currency: breakdown.currency || null,
                current_usage: breakdown.currentUsage,
                usage_limit: breakdown.usageLimit,
                current_overages: breakdown.currentOverages,
                overage_cap: breakdown.overageCap,
                overage_rate: breakdown.overageRate,
                overage_charges: breakdown.overageCharges,
                next_date_reset: breakdown.nextDateReset || null,
                model_name: breakdown.modelName || null,
                remaining: breakdown.remaining,
                remaining_percent: breakdown.remainingPercent,
                reset_time: breakdown.resetTime || null,
                reset_time_raw: breakdown.resetTimeRaw || null,
                rate_limit_allowed: breakdown.rateLimitAllowed,
                rate_limit_reached: breakdown.rateLimitReached,
                primary_limit_window_seconds: breakdown.primaryLimitWindowSeconds,
                primary_reset_after_seconds: breakdown.primaryResetAfterSeconds,
                primary_reset_at: breakdown.primaryResetAt,
                primary_used_percent: breakdown.primaryUsedPercent,
                secondary_limit_window_seconds: breakdown.secondaryLimitWindowSeconds,
                secondary_reset_after_seconds: breakdown.secondaryResetAfterSeconds,
                secondary_reset_at: breakdown.secondaryResetAt,
                secondary_used_percent: breakdown.secondaryUsedPercent
            });

            if (breakdown.freeTrial) {
                freeTrialRows.push({
                    id: buildUsageSnapshotFreeTrialId(breakdownId),
                    breakdown_id: breakdownId,
                    status: breakdown.freeTrial.status || null,
                    current_usage: breakdown.freeTrial.currentUsage,
                    usage_limit: breakdown.freeTrial.usageLimit,
                    expires_at: breakdown.freeTrial.expiresAt || null
                });
            }

            breakdown.bonuses.forEach((bonus, bonusIndex) => {
                bonusRows.push({
                    id: buildUsageSnapshotBonusId(breakdownId, bonusIndex),
                    breakdown_id: breakdownId,
                    bonus_order: bonusIndex,
                    code: bonus.code || null,
                    display_name: bonus.displayName || null,
                    description: bonus.description || null,
                    status: bonus.status || null,
                    current_usage: bonus.currentUsage,
                    usage_limit: bonus.usageLimit,
                    redeemed_at: bonus.redeemedAt || null,
                    expires_at: bonus.expiresAt || null
                });
            });
        });
    });

    return {
        normalizedSnapshot,
        snapshotRow,
        instanceRows,
        breakdownRows,
        freeTrialRows,
        bonusRows
    };
}

function parseSqliteBoolean(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    return Number(value) !== 0;
}

function hasAnyMeaningfulValue(values = []) {
    return values.some((value) => value !== undefined && value !== null && value !== '');
}

function buildUsageBreakdownFromStructuredRow(row = {}, freeTrialRow = null, bonusRows = []) {
    const breakdown = {
        resourceType: row.resource_type || null,
        displayName: row.display_name || null,
        displayNamePlural: row.display_name_plural || null,
        unit: row.unit || null,
        currency: row.currency || null,
        currentUsage: normalizeNumberOrNull(row.current_usage),
        usageLimit: normalizeNumberOrNull(row.usage_limit),
        currentOverages: normalizeNumberOrNull(row.current_overages),
        overageCap: normalizeNumberOrNull(row.overage_cap),
        overageRate: normalizeNumberOrNull(row.overage_rate),
        overageCharges: normalizeNumberOrNull(row.overage_charges),
        nextDateReset: normalizeIsoOrNull(row.next_date_reset),
        modelName: row.model_name || null,
        remaining: normalizeNumberOrNull(row.remaining),
        remainingPercent: normalizeNumberOrNull(row.remaining_percent),
        resetTime: row.reset_time || null,
        resetTimeRaw: row.reset_time_raw || null,
        bonuses: Array.isArray(bonusRows)
            ? bonusRows.map((bonusRow) => ({
                code: bonusRow.code || null,
                displayName: bonusRow.display_name || null,
                description: bonusRow.description || null,
                status: bonusRow.status || null,
                currentUsage: normalizeNumberOrNull(bonusRow.current_usage),
                usageLimit: normalizeNumberOrNull(bonusRow.usage_limit),
                redeemedAt: normalizeIsoOrNull(bonusRow.redeemed_at),
                expiresAt: normalizeIsoOrNull(bonusRow.expires_at)
            }))
            : []
    };

    const hasRateLimit = hasAnyMeaningfulValue([
        row.rate_limit_allowed,
        row.rate_limit_reached,
        row.primary_limit_window_seconds,
        row.primary_reset_after_seconds,
        row.primary_reset_at,
        row.primary_used_percent,
        row.secondary_limit_window_seconds,
        row.secondary_reset_after_seconds,
        row.secondary_reset_at,
        row.secondary_used_percent
    ]);
    if (hasRateLimit) {
        breakdown.rateLimit = {
            allowed: parseSqliteBoolean(row.rate_limit_allowed),
            limit_reached: parseSqliteBoolean(row.rate_limit_reached),
            primary_window: {
                limit_window_seconds: normalizeNumberOrNull(row.primary_limit_window_seconds),
                reset_after_seconds: normalizeNumberOrNull(row.primary_reset_after_seconds),
                reset_at: normalizeNumberOrNull(row.primary_reset_at),
                used_percent: normalizeNumberOrNull(row.primary_used_percent)
            },
            secondary_window: {
                limit_window_seconds: normalizeNumberOrNull(row.secondary_limit_window_seconds),
                reset_after_seconds: normalizeNumberOrNull(row.secondary_reset_after_seconds),
                reset_at: normalizeNumberOrNull(row.secondary_reset_at),
                used_percent: normalizeNumberOrNull(row.secondary_used_percent)
            }
        };
    }

    if (freeTrialRow) {
        breakdown.freeTrial = {
            status: freeTrialRow.status || null,
            currentUsage: normalizeNumberOrNull(freeTrialRow.current_usage),
            usageLimit: normalizeNumberOrNull(freeTrialRow.usage_limit),
            expiresAt: normalizeIsoOrNull(freeTrialRow.expires_at)
        };
    }

    return breakdown;
}

function buildUsageInstanceFromStructuredRow(row = {}, breakdowns = []) {
    const instance = {
        success: parseSqliteBoolean(row.success) === true
    };

    if (row.uuid) {
        instance.uuid = row.uuid;
    }

    if (row.display_name) {
        instance.name = row.display_name;
    }

    if (row.error_message) {
        instance.error = row.error_message;
    }

    if (parseSqliteBoolean(row.is_disabled) === true) {
        instance.isDisabled = true;
    }

    const isHealthy = parseSqliteBoolean(row.is_healthy);
    if (isHealthy !== null) {
        instance.isHealthy = isHealthy;
    }

    const lastRefreshedAt = normalizeIsoOrNull(row.last_refreshed_at);
    if (lastRefreshedAt) {
        instance.lastRefreshedAt = lastRefreshedAt;
    }

    const usage = {
        usageBreakdown: breakdowns
    };

    if (hasAnyMeaningfulValue([
        row.subscription_title,
        row.subscription_type,
        row.subscription_upgrade_capability,
        row.subscription_overage_capability
    ])) {
        usage.subscription = {
            title: row.subscription_title || null,
            type: row.subscription_type || null,
            upgradeCapability: row.subscription_upgrade_capability || null,
            overageCapability: row.subscription_overage_capability || null
        };
    }

    if (hasAnyMeaningfulValue([row.user_email, row.user_id])) {
        usage.user = {
            email: row.user_email || null,
            userId: row.user_id || null
        };
    }

    if (breakdowns.length > 0 || usage.subscription || usage.user) {
        instance.usage = usage;
    }

    return instance;
}

function buildAdminSessionId(token) {
    return `admin_sess_${hashValue(token).slice(0, 24)}`;
}

function buildPotluckUserId(userIdentifier) {
    return `potluck_user_${hashValue(userIdentifier).slice(0, 24)}`;
}

function buildPotluckKeyRowId(keyId) {
    return `potluck_key_${hashValue(keyId).slice(0, 24)}`;
}

function buildPotluckUsageDailyId(keyId, usageDate) {
    return `potluck_daily_${hashValue(`${keyId}::${usageDate}`).slice(0, 24)}`;
}

function createEmptyPotluckUserData() {
    return {
        config: {},
        users: {}
    };
}

function createEmptyPotluckKeyStore() {
    return {
        keys: {}
    };
}

function hasPotluckUserData(store) {
    return Boolean(
        store
        && typeof store === 'object'
        && ((store.config && Object.keys(store.config).length > 0)
            || (store.users && Object.keys(store.users).length > 0))
    );
}

function hasPotluckKeyStore(store) {
    return Boolean(
        store
        && typeof store === 'object'
        && store.keys
        && Object.keys(store.keys).length > 0
    );
}

async function readJsonFileSafe(filePath, fallbackValue = null) {
    try {
        const raw = await pfs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`[RuntimeStorage:db] Failed to read legacy file ${filePath}: ${error.message}`);
        }
        return fallbackValue;
    }
}

const LEGACY_IMPORT_MARKERS = Object.freeze({
    providerPools: 'legacy_import_provider_pools',
    usageCache: 'legacy_import_usage_cache',
    adminSessions: 'legacy_import_admin_sessions',
    potluckUserData: 'legacy_import_potluck_user_data',
    potluckKeyStore: 'legacy_import_potluck_key_store'
});


export class SqliteRuntimeStorage {
    constructor(config = {}) {
        this.config = config;
        this.dbPath = config.RUNTIME_STORAGE_DB_PATH || 'configs/runtime/runtime-storage.sqlite';
        this.filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        this.compatExportPageSize = normalizePositiveInt(config.RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE, 1000);
        this.startupRestorePageSize = normalizePositiveInt(config.RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE, 2000);
        this.client = new SqliteCliClient(this.dbPath, {
            sqliteBinary: config.RUNTIME_STORAGE_SQLITE_BINARY || 'sqlite3',
            busyTimeoutMs: config.RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS ?? 5000,
            maxRetryAttempts: config.RUNTIME_STORAGE_DB_RETRY_ATTEMPTS ?? 2,
            retryDelayMs: config.RUNTIME_STORAGE_DB_RETRY_DELAY_MS ?? 75
        });
        this.fileStorage = new FileRuntimeStorage(config);
        this.kind = 'db';
        this.initialized = false;
        const configuredAdminSessionTouchIntervalMs = Number.parseInt(config.RUNTIME_STORAGE_ADMIN_SESSION_TOUCH_INTERVAL_MS, 10);
        this.adminSessionTouchIntervalMs = Number.isFinite(configuredAdminSessionTouchIntervalMs)
            ? Math.max(0, configuredAdminSessionTouchIntervalMs)
            : 5 * 60 * 1000;
        this.adminSessionTouchTimestamps = new Map();
        this.adminSessionTouchInFlight = new Map();
    }

    getInfo() {
        return {
            backend: 'db',
            driver: 'sqlite3-cli',
            dbPath: this.dbPath,
            filePath: this.filePath,
            compatExportPageSize: this.compatExportPageSize,
            startupRestorePageSize: this.startupRestorePageSize
        };
    }

    async initialize() {
        if (this.initialized) {
            return this;
        }

        await pfs.mkdir(path.dirname(this.dbPath), { recursive: true });
        await this.client.initialize(this.#buildSchemaSql());
        await this.#ensureUsageSchemaUpgrade();
        await this.client.exec(`
INSERT INTO runtime_storage_meta (meta_key, meta_value, updated_at)
VALUES
    ('schema_version', '1', ${sqlValue(nowIso())}),
    ('backend_impl', 'sqlite3-cli', ${sqlValue(nowIso())})
ON CONFLICT(meta_key) DO UPDATE SET
    meta_value = excluded.meta_value,
    updated_at = excluded.updated_at;
        `);
        this.initialized = true;
        await this.markInterruptedUsageRefreshTasks();
        return this;
    }

    async hasProviderData() {
        await this.initialize();
        const rows = await this.client.query('SELECT COUNT(*) AS count FROM provider_registrations;');
        return Number(rows[0]?.count || 0) > 0;
    }

    async loadProviderPoolsSnapshot(options = {}) {
        await this.initialize();

        const hasData = await this.hasProviderData();
        const autoImportFromFile = options.autoImportFromFile !== false;
        const importFilePath = options.filePath || this.filePath;
        const importMarkerKey = LEGACY_IMPORT_MARKERS.providerPools;

        if (hasData) {
            await this.#ensureLegacyImportMarker(importMarkerKey, 'existing_data');
        } else if (autoImportFromFile && importFilePath && fs.existsSync(importFilePath)) {
            const legacyImportMarked = await this.#hasLegacyImportMarker(importMarkerKey);
            if (!legacyImportMarked) {
                const snapshot = await this.fileStorage.loadProviderPoolsSnapshot();
                if (Object.keys(snapshot).length > 0) {
                    await this.replaceProviderPoolsSnapshot(snapshot, {
                        sourceKind: 'provider_pools_json'
                    });
                    await this.#setLegacyImportMarker(importMarkerKey, 'imported_from_legacy_file');
                    logger.info(`[RuntimeStorage:db] Seeded provider pools from ${importFilePath}`);
                }
            }
        }

        return await this.exportProviderPoolsSnapshot({
            ...options,
            pageSize: normalizePositiveInt(
                options.pageSize ?? options.restorePageSize,
                this.startupRestorePageSize
            )
        });
    }

    async loadProviderPoolsSummary(options = {}) {
        await this.initialize();

        const hasData = await this.hasProviderData();
        const autoImportFromFile = options.autoImportFromFile !== false;
        const importFilePath = options.filePath || this.filePath;
        const importMarkerKey = LEGACY_IMPORT_MARKERS.providerPools;

        if (hasData) {
            await this.#ensureLegacyImportMarker(importMarkerKey, 'existing_data');
        } else if (autoImportFromFile && importFilePath && fs.existsSync(importFilePath)) {
            const legacyImportMarked = await this.#hasLegacyImportMarker(importMarkerKey);
            if (!legacyImportMarked) {
                const snapshot = await this.fileStorage.loadProviderPoolsSnapshot();
                if (Object.keys(snapshot).length > 0) {
                    await this.replaceProviderPoolsSnapshot(snapshot, {
                        sourceKind: 'provider_pools_json'
                    });
                    await this.#setLegacyImportMarker(importMarkerKey, 'imported_from_legacy_file');
                    logger.info(`[RuntimeStorage:db] Seeded provider pools from ${importFilePath}`);
                }
            }
        }

        const rows = await this.client.query(`
SELECT
    r.provider_type,
    COUNT(*) AS total_count,
    SUM(CASE WHEN COALESCE(s.is_healthy, 1) = 1 AND COALESCE(s.is_disabled, 0) = 0 THEN 1 ELSE 0 END) AS healthy_count,
    SUM(COALESCE(s.usage_count, 0)) AS usage_count,
    SUM(COALESCE(s.error_count, 0)) AS error_count
FROM provider_registrations r
LEFT JOIN provider_runtime_state s
    ON s.provider_id = r.provider_id
GROUP BY r.provider_type
ORDER BY r.provider_type ASC;
        `);

        return rows.reduce((summaries, row) => {
            const providerType = row.provider_type || row.providerType;
            if (!providerType) {
                return summaries;
            }
            summaries[providerType] = {
                totalCount: Number(row.total_count || 0),
                healthyCount: Number(row.healthy_count || 0),
                usageCount: Number(row.usage_count || 0),
                errorCount: Number(row.error_count || 0)
            };
            return summaries;
        }, {});
    }

    async exportProviderPoolsSnapshot(options = {}) {
        await this.initialize();

        const pageSize = normalizePositiveInt(
            options.pageSize ?? options.compatExportPageSize,
            this.compatExportPageSize
        );
        const countRows = await this.client.query('SELECT COUNT(*) AS count FROM provider_registrations;');
        const totalProviders = Number(countRows[0]?.count || 0);
        if (totalProviders <= 0) {
            return {};
        }

        const snapshot = {};
        for (let offset = 0; offset < totalProviders; offset += pageSize) {
            const rows = await this.client.query(`
SELECT
    r.provider_id,
    r.provider_type,
    r.routing_uuid,
    r.display_name,
    r.check_model,
    r.project_id,
    r.base_url,
    r.config_json,
    r.source_kind,
    r.created_at,
    r.updated_at,
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
ORDER BY r.provider_type ASC, r.rowid ASC
LIMIT ${pageSize} OFFSET ${offset};
            `);
            if (rows.length === 0) {
                break;
            }

            const providerIds = rows
                .map((row) => row.provider_id || row.providerId)
                .filter(Boolean);
            const providerIdSql = buildSqlInList(providerIds);

            let secretRows = [];
            let credentialRows = [];
            if (providerIdSql) {
                secretRows = await this.client.query(`
SELECT provider_id, secret_kind, secret_payload, protection_mode, updated_at
FROM provider_inline_secrets
WHERE provider_id IN (${providerIdSql})
ORDER BY provider_id ASC, secret_kind ASC;
                `);
                credentialRows = await this.client.query(`
SELECT
    b.binding_target_id AS provider_id,
    b.credential_asset_id,
    COALESCE(fi.file_path, a.source_path) AS file_path,
    a.source_path
FROM credential_bindings b
JOIN credential_assets a
    ON a.id = b.credential_asset_id
LEFT JOIN credential_file_index fi
    ON fi.credential_asset_id = a.id
   AND fi.is_primary = 1
WHERE b.binding_type = 'provider_registration'
  AND COALESCE(b.binding_status, 'active') = 'active'
  AND b.binding_target_id IN (${providerIdSql})
ORDER BY b.binding_target_id ASC, b.updated_at DESC;
                `);
            }

            mergeProviderPoolsSnapshot(snapshot, buildProviderPoolsSnapshot(rows, secretRows, credentialRows));
        }

        return snapshot;
    }

    async replaceProviderPoolsSnapshot(providerPools = {}, options = {}) {
        await this.initialize();

        const timestamp = nowIso();
        const sourceKind = options.sourceKind || 'provider_pools_json';
        const insertBatchSize = Math.max(1, normalizePositiveInt(options.insertBatchSize, 250));
        const preparedImport = await prepareProviderPoolsSnapshotImport(providerPools, {
            sourceKind,
            timestamp,
            progressInterval: options.progressInterval,
            credentialProgressInterval: options.credentialProgressInterval,
            prepareConcurrency: options.prepareConcurrency
        });

        const statements = [];
        statements.push('BEGIN IMMEDIATE;');
        statements.push(`DELETE FROM credential_bindings WHERE binding_type = 'provider_registration';`);
        statements.push('DELETE FROM provider_inline_secrets;');
        statements.push('DELETE FROM provider_runtime_state;');
        statements.push('DELETE FROM provider_registrations;');

        appendInsertBatchStatements(statements, 'provider_registrations', [
            'provider_id',
            'provider_type',
            'routing_uuid',
            'display_name',
            'check_model',
            'project_id',
            'base_url',
            'config_json',
            'source_kind',
            'created_at',
            'updated_at'
        ], preparedImport.registrations, {
            batchSize: insertBatchSize
        });

        appendInsertBatchStatements(statements, 'provider_runtime_state', [
            'provider_id',
            'is_healthy',
            'is_disabled',
            'usage_count',
            'error_count',
            'last_used_at',
            'last_health_check_at',
            'last_health_check_model',
            'last_error_time',
            'last_error_message',
            'scheduled_recovery_at',
            'refresh_count',
            'last_selection_seq',
            'updated_at'
        ], preparedImport.runtimeStates, {
            batchSize: insertBatchSize
        });

        appendInsertBatchStatements(statements, 'provider_inline_secrets', [
            'provider_id',
            'secret_kind',
            'secret_payload',
            'protection_mode',
            'updated_at'
        ], preparedImport.inlineSecrets, {
            batchSize: insertBatchSize
        });

        appendInsertBatchStatements(statements, 'credential_assets', [
            'id',
            'provider_type',
            'identity_key',
            'dedupe_key',
            'email',
            'account_id',
            'external_user_id',
            'source_kind',
            'source_path',
            'source_checksum',
            'storage_mode',
            'is_active',
            'last_imported_at',
            'last_refreshed_at',
            'created_at',
            'updated_at'
        ], preparedImport.credentialAssets, {
            batchSize: insertBatchSize,
            suffix: `ON CONFLICT(id) DO UPDATE SET
    identity_key = COALESCE(excluded.identity_key, credential_assets.identity_key),
    dedupe_key = excluded.dedupe_key,
    email = COALESCE(excluded.email, credential_assets.email),
    account_id = COALESCE(excluded.account_id, credential_assets.account_id),
    external_user_id = COALESCE(excluded.external_user_id, credential_assets.external_user_id),
    source_kind = excluded.source_kind,
    source_path = COALESCE(excluded.source_path, credential_assets.source_path),
    source_checksum = COALESCE(excluded.source_checksum, credential_assets.source_checksum),
    storage_mode = excluded.storage_mode,
    is_active = excluded.is_active,
    last_imported_at = COALESCE(excluded.last_imported_at, credential_assets.last_imported_at),
    updated_at = excluded.updated_at`
        });

        appendCredentialFileIndexResetStatements(
            statements,
            preparedImport.credentialFileIndexes.map((row) => row.credential_asset_id),
            timestamp,
            insertBatchSize
        );
        appendCredentialFileIndexDeleteStatements(
            statements,
            preparedImport.credentialFileIndexes.map((row) => row.file_path),
            insertBatchSize
        );
        appendInsertBatchStatements(statements, 'credential_file_index', [
            'id',
            'credential_asset_id',
            'file_path',
            'file_name',
            'file_size',
            'checksum',
            'mtime',
            'is_primary',
            'created_at',
            'updated_at'
        ], preparedImport.credentialFileIndexes, {
            batchSize: insertBatchSize
        });

        appendInsertBatchStatements(statements, 'credential_bindings', [
            'id',
            'credential_asset_id',
            'binding_type',
            'binding_target_id',
            'binding_status',
            'created_at',
            'updated_at'
        ], preparedImport.credentialBindings, {
            batchSize: insertBatchSize
        });

        statements.push(`
INSERT INTO runtime_storage_meta (meta_key, meta_value, updated_at)
VALUES ('last_provider_import_source', ${sqlValue(sourceKind)}, ${sqlValue(timestamp)})
ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at;
        `);
        statements.push('COMMIT;');

        logger.info(`[RuntimeStorage:db] Executing provider snapshot SQL payload with insertBatchSize=${insertBatchSize} (${statements.length} statement group(s))`);
        await this.client.exec(statements.join('\n'), {
            operation: 'replaceProviderPoolsSnapshot'
        });
        logger.info(`[RuntimeStorage:db] Replaced provider pools snapshot from ${sourceKind}: ${preparedImport.providerTypeCount} types / ${preparedImport.providerCount} providers`);
        return await this.exportProviderPoolsSnapshot();
    }

    async findCredentialAsset(providerType, match = {}) {
        await this.initialize();

        const conditions = [];
        if (match.dedupeKey) {
            conditions.push(`a.dedupe_key = ${sqlValue(match.dedupeKey)}`);
        }
        if (match.identityKey) {
            conditions.push(`a.identity_key = ${sqlValue(match.identityKey)}`);
        }

        if (conditions.length === 0) {
            return null;
        }

        const rows = await this.client.query(`
SELECT
    a.id,
    a.provider_type,
    a.identity_key,
    a.dedupe_key,
    a.email,
    a.account_id,
    a.external_user_id,
    a.source_kind,
    COALESCE(fi.file_path, a.source_path) AS source_path,
    a.source_checksum,
    a.storage_mode,
    a.last_imported_at,
    a.updated_at
FROM credential_assets a
LEFT JOIN credential_file_index fi
    ON fi.credential_asset_id = a.id
   AND fi.is_primary = 1
WHERE a.provider_type = ${sqlValue(providerType)}
  AND (${conditions.join(' OR ')})
ORDER BY a.updated_at DESC
LIMIT 1;
        `);

        return rows[0] || null;
    }

    async listCredentialAssets(providerType, options = {}) {
        await this.initialize();

        const queryOptions = normalizeCredentialListOptions(options);
        const filters = [];
        if (providerType) {
            filters.push(`a.provider_type = ${sqlValue(providerType)}`);
        }
        if (queryOptions.identityKey) {
            filters.push(`a.identity_key = ${sqlValue(queryOptions.identityKey)}`);
        }
        if (queryOptions.email) {
            filters.push(`a.email = ${sqlValue(queryOptions.email)}`);
        }
        if (queryOptions.sourceKind) {
            filters.push(`a.source_kind = ${sqlValue(queryOptions.sourceKind)}`);
        }

        const whereClause = filters.length > 0
            ? `WHERE ${filters.join(' AND ')}`
            : '';
        const limitClause = queryOptions.limit ? `\nLIMIT ${queryOptions.limit}` : '';
        const offsetClause = queryOptions.limit && queryOptions.offset > 0 ? ` OFFSET ${queryOptions.offset}` : '';

        return await this.client.query(`
	SELECT
	    a.id,
	    a.provider_type,
	    a.identity_key,
	    a.dedupe_key,
	    a.email,
	    a.account_id,
	    a.external_user_id,
	    a.source_kind,
	    COALESCE(fi.file_path, a.source_path) AS source_path,
	    a.source_checksum,
	    a.storage_mode,
	    a.last_imported_at,
	    a.updated_at
	FROM credential_assets a
	LEFT JOIN credential_file_index fi
	    ON fi.credential_asset_id = a.id
	   AND fi.is_primary = 1
	${whereClause}
	ORDER BY a.provider_type ASC, a.updated_at ${queryOptions.sort === 'asc' ? 'ASC' : 'DESC'}, a.id ASC${limitClause}${offsetClause};
        `);
    }

    async linkCredentialFiles(credPaths = [], options = {}) {
        await this.initialize();

        const normalizedInputPaths = Array.isArray(credPaths)
            ? credPaths.filter((item) => typeof item === 'string' && item.trim())
            : [];

        if (normalizedInputPaths.length === 0) {
            return {
                providerPools: await this.exportProviderPoolsSnapshot(),
                totalNewProviders: 0,
                allNewProviders: {}
            };
        }

        const timestamp = nowIso();
        const sourceKind = options.sourceKind || 'auto_link';
        const statements = ['BEGIN IMMEDIATE;'];
        const allNewProviders = {};
        const linkedAssetKeys = new Set();
        const createdProviderIds = new Map();

        for (const rawPath of normalizedInputPaths) {
            const relativePath = normalizeProjectRelativePath(rawPath);
            if (!relativePath) {
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

            const mapping = detectProviderFromPath(relativePath.toLowerCase());
            if (!mapping) {
                continue;
            }

            const assetRecord = await readCredentialAssetRecord(
                mapping.providerType,
                relativePath,
                sourceKind,
                timestamp
            );
            if (!assetRecord?.asset?.id) {
                continue;
            }

            pushCredentialAssetStatements(statements, assetRecord, timestamp);

            const linkedAssetKey = `${mapping.providerType}::${assetRecord.asset.id}`;
            if (linkedAssetKeys.has(linkedAssetKey)) {
                continue;
            }

            const existingBindingRows = await this.client.query(`
SELECT r.provider_id
FROM credential_bindings b
JOIN provider_registrations r
    ON r.provider_id = b.binding_target_id
WHERE b.binding_type = 'provider_registration'
  AND COALESCE(b.binding_status, 'active') = 'active'
  AND b.credential_asset_id = ${sqlValue(assetRecord.asset.id)}
  AND r.provider_type = ${sqlValue(mapping.providerType)}
LIMIT 1;
            `);
            if (existingBindingRows.length > 0) {
                linkedAssetKeys.add(linkedAssetKey);
                continue;
            }

            const providerConfig = createProviderConfig({
                credPathKey: mapping.credPathKey,
                credPath: formatSystemPath(relativePath),
                defaultCheckModel: mapping.defaultCheckModel,
                needsProjectId: mapping.needsProjectId,
                urlKeys: mapping.urlKeys
            });
            Object.defineProperty(providerConfig, '__providerId', {
                value: buildGeneratedProviderId(mapping.providerType, assetRecord.asset.id, relativePath),
                enumerable: false,
                configurable: true,
                writable: true
            });

            const normalizedProvider = splitProviderConfig(mapping.providerType, providerConfig);
            pushProviderStatements(statements, normalizedProvider, sourceKind, timestamp);
            pushCredentialBindingStatements(
                statements,
                normalizedProvider.providerId,
                assetRecord.asset.id,
                timestamp
            );

            linkedAssetKeys.add(linkedAssetKey);
            createdProviderIds.set(normalizedProvider.providerId, mapping.displayName);
        }

        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));

        const providerPools = await this.exportProviderPoolsSnapshot();
        for (const [providerType, providers] of Object.entries(providerPools)) {
            for (const provider of providers) {
                const displayName = createdProviderIds.get(provider.__providerId);
                if (!displayName) {
                    continue;
                }

                if (!allNewProviders[displayName]) {
                    allNewProviders[displayName] = [];
                }
                allNewProviders[displayName].push(provider);
            }
        }

        return {
            providerPools,
            totalNewProviders: createdProviderIds.size,
            allNewProviders
        };
    }

    async flushProviderRuntimeState(records = [], options = {}) {
        await this.initialize();

        const runtimeRecords = Array.isArray(records)
            ? records.filter((record) => record?.providerId && record?.providerType)
            : [];

        if (runtimeRecords.length === 0) {
            return { flushedCount: 0 };
        }

        const timestamp = nowIso();
        const statements = ['BEGIN IMMEDIATE;'];

        for (const record of runtimeRecords) {
            const runtimeState = record.runtimeState || {};
            const persistSelectionState = record.persistSelectionState ?? options.persistSelectionState ?? false;

            statements.push(`
INSERT INTO provider_runtime_state (
    provider_id,
    is_healthy,
    is_disabled,
    usage_count,
    error_count,
    last_used_at,
    last_health_check_at,
    last_health_check_model,
    last_error_time,
    last_error_message,
    scheduled_recovery_at,
    refresh_count,
    last_selection_seq,
    updated_at
) VALUES (
    ${sqlValue(record.providerId)},
    ${sqlValue(runtimeState.isHealthy ?? true)},
    ${sqlValue(runtimeState.isDisabled ?? false)},
    ${sqlValue(runtimeState.usageCount ?? 0)},
    ${sqlValue(runtimeState.errorCount ?? 0)},
    ${sqlValue(runtimeState.lastUsed ?? null)},
    ${sqlValue(runtimeState.lastHealthCheckTime ?? null)},
    ${sqlValue(runtimeState.lastHealthCheckModel ?? null)},
    ${sqlValue(runtimeState.lastErrorTime ?? null)},
    ${sqlValue(runtimeState.lastErrorMessage ?? null)},
    ${sqlValue(runtimeState.scheduledRecoveryTime ?? null)},
    ${sqlValue(runtimeState.refreshCount ?? 0)},
    ${sqlValue(persistSelectionState ? (runtimeState.lastSelectionSeq ?? null) : null)},
    ${sqlValue(timestamp)}
)
ON CONFLICT(provider_id) DO UPDATE SET
    is_healthy = excluded.is_healthy,
    is_disabled = excluded.is_disabled,
    usage_count = excluded.usage_count,
    error_count = excluded.error_count,
    last_used_at = excluded.last_used_at,
    last_health_check_at = excluded.last_health_check_at,
    last_health_check_model = excluded.last_health_check_model,
    last_error_time = excluded.last_error_time,
    last_error_message = excluded.last_error_message,
    scheduled_recovery_at = excluded.scheduled_recovery_at,
    refresh_count = excluded.refresh_count,
    last_selection_seq = excluded.last_selection_seq,
    updated_at = excluded.updated_at;
            `);
        }

        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));
        return { flushedCount: runtimeRecords.length };
    }

    async updateProviderRoutingUuid(update = {}) {
        await this.initialize();

        const providerId = update?.providerId;
        const providerType = update?.providerType;
        const oldRoutingUuid = update?.oldRoutingUuid;
        const newRoutingUuid = update?.newRoutingUuid;

        if (!newRoutingUuid || (!providerId && !(providerType && oldRoutingUuid))) {
            return { updated: false };
        }

        const timestamp = nowIso();
        const whereClause = providerId
            ? `provider_id = ${sqlValue(providerId)}`
            : `provider_type = ${sqlValue(providerType)} AND routing_uuid = ${sqlValue(oldRoutingUuid)}`;

        await this.client.exec(`
BEGIN IMMEDIATE;
UPDATE provider_registrations
SET routing_uuid = ${sqlValue(newRoutingUuid)},
    updated_at = ${sqlValue(timestamp)}
WHERE ${whereClause};
COMMIT;
        `);

        return { updated: true };
    }


        async loadUsageCacheSummary() {
        await this.initialize();
        await this.#ensureUsageCacheSeeded();

        const rows = await this.client.query(`
SELECT id, provider_type, snapshot_at, total_count, success_count, error_count, processed_count
FROM (
    SELECT
        id,
        provider_type,
        snapshot_at,
        total_count,
        success_count,
        error_count,
        processed_count,
        ROW_NUMBER() OVER (
            PARTITION BY provider_type
            ORDER BY snapshot_at DESC, id DESC
        ) AS row_rank
    FROM usage_snapshots
    WHERE provider_id IS NULL
)
WHERE row_rank = 1
ORDER BY provider_type ASC;
        `);

        if (rows.length === 0) {
            return null;
        }

        const providers = {};
        let latestTimestamp = null;

        for (const row of rows) {
            const summary = buildUsageSnapshotSummaryRecord(row);
            latestTimestamp = !latestTimestamp || summary.timestamp > latestTimestamp
                ? summary.timestamp
                : latestTimestamp;
            providers[row.provider_type] = {
                ...summary,
                instances: []
            };
        }

        const cacheTimestamp = await this.#loadUsageCacheTimestamp(latestTimestamp || nowIso());
        return {
            timestamp: cacheTimestamp,
            providers
        };
    }

    async loadUsageCacheSnapshot() {
        await this.initialize();
        await this.#ensureUsageCacheSeeded();

        const rows = await this.client.query(`
SELECT id, provider_type, snapshot_at, total_count, success_count, error_count, processed_count, payload_json
FROM (
    SELECT
        id,
        provider_type,
        snapshot_at,
        total_count,
        success_count,
        error_count,
        processed_count,
        payload_json,
        ROW_NUMBER() OVER (
            PARTITION BY provider_type
            ORDER BY snapshot_at DESC, id DESC
        ) AS row_rank
    FROM usage_snapshots
    WHERE provider_id IS NULL
)
WHERE row_rank = 1
ORDER BY provider_type ASC;
        `);

        if (rows.length === 0) {
            return null;
        }

        const providers = {};
        let latestTimestamp = null;

        for (const row of rows) {
            const snapshot = await this.#loadProviderUsageSnapshotFromRow(row);
            if (!snapshot) {
                continue;
            }

            latestTimestamp = !latestTimestamp || snapshot.timestamp > latestTimestamp
                ? snapshot.timestamp
                : latestTimestamp;
            providers[row.provider_type] = snapshot;
        }

        if (Object.keys(providers).length === 0) {
            return null;
        }

        const cacheTimestamp = await this.#loadUsageCacheTimestamp(latestTimestamp || nowIso());
        return {
            timestamp: cacheTimestamp,
            providers
        };
    }

    async replaceUsageCacheSnapshot(usageCache = null) {
        await this.initialize();

        const providers = usageCache?.providers && typeof usageCache.providers === 'object'
            ? usageCache.providers
            : {};
        const fallbackTimestamp = normalizeIsoOrNull(usageCache?.timestamp) || nowIso();
        const snapshotRows = [];
        const instanceRows = [];
        const breakdownRows = [];
        const freeTrialRows = [];
        const bonusRows = [];
        const normalizedProviders = {};

        for (const [providerType, snapshot] of Object.entries(providers)) {
            const preparedRows = buildUsageSnapshotPersistenceRows(providerType, snapshot, fallbackTimestamp);
            normalizedProviders[providerType] = preparedRows.normalizedSnapshot;
            snapshotRows.push(preparedRows.snapshotRow);
            instanceRows.push(...preparedRows.instanceRows);
            breakdownRows.push(...preparedRows.breakdownRows);
            freeTrialRows.push(...preparedRows.freeTrialRows);
            bonusRows.push(...preparedRows.bonusRows);
        }

        const statements = [
            'BEGIN IMMEDIATE;',
            "DELETE FROM runtime_settings WHERE scope = 'compat_export' AND key = 'usage-cache';",
            'DELETE FROM usage_snapshots WHERE provider_id IS NULL;'
        ];

        statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'usage_cache',
    'timestamp',
    ${sqlValue(JSON.stringify(fallbackTimestamp))},
    ${sqlValue(nowIso())}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
        `);

        appendInsertBatchStatements(statements, 'usage_snapshots', [
            'id',
            'provider_type',
            'provider_id',
            'snapshot_at',
            'total_count',
            'success_count',
            'error_count',
            'processed_count',
            'payload_json'
        ], snapshotRows, {
            suffix: `
ON CONFLICT(id) DO UPDATE SET
    provider_type = excluded.provider_type,
    provider_id = excluded.provider_id,
    snapshot_at = excluded.snapshot_at,
    total_count = excluded.total_count,
    success_count = excluded.success_count,
    error_count = excluded.error_count,
    processed_count = excluded.processed_count,
    payload_json = excluded.payload_json`
        });
        appendInsertBatchStatements(statements, 'usage_snapshot_instances', [
            'id',
            'snapshot_id',
            'instance_key',
            'uuid',
            'display_name',
            'success',
            'error_message',
            'is_disabled',
            'is_healthy',
            'last_refreshed_at',
            'subscription_title',
            'subscription_type',
            'subscription_upgrade_capability',
            'subscription_overage_capability',
            'user_email',
            'user_id',
            'instance_order'
        ], instanceRows);
        appendInsertBatchStatements(statements, 'usage_snapshot_breakdowns', [
            'id',
            'instance_id',
            'breakdown_order',
            'resource_type',
            'display_name',
            'display_name_plural',
            'unit',
            'currency',
            'current_usage',
            'usage_limit',
            'current_overages',
            'overage_cap',
            'overage_rate',
            'overage_charges',
            'next_date_reset',
            'model_name',
            'remaining',
            'remaining_percent',
            'reset_time',
            'reset_time_raw',
            'rate_limit_allowed',
            'rate_limit_reached',
            'primary_limit_window_seconds',
            'primary_reset_after_seconds',
            'primary_reset_at',
            'primary_used_percent',
            'secondary_limit_window_seconds',
            'secondary_reset_after_seconds',
            'secondary_reset_at',
            'secondary_used_percent'
        ], breakdownRows);
        appendInsertBatchStatements(statements, 'usage_snapshot_free_trials', [
            'id',
            'breakdown_id',
            'status',
            'current_usage',
            'usage_limit',
            'expires_at'
        ], freeTrialRows);
        appendInsertBatchStatements(statements, 'usage_snapshot_bonuses', [
            'id',
            'breakdown_id',
            'bonus_order',
            'code',
            'display_name',
            'description',
            'status',
            'current_usage',
            'usage_limit',
            'redeemed_at',
            'expires_at'
        ], bonusRows);

        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));
        return {
            timestamp: fallbackTimestamp,
            providers: normalizedProviders
        };
    }

    async loadProviderUsageSnapshot(providerType) {
        await this.initialize();
        await this.#ensureUsageCacheSeeded();

        const row = (await this.client.query(`
SELECT id, provider_type, snapshot_at, total_count, success_count, error_count, processed_count, payload_json
FROM usage_snapshots
WHERE provider_id IS NULL AND provider_type = ${sqlValue(providerType)}
ORDER BY snapshot_at DESC, id DESC
LIMIT 1;
        `))[0];

        if (!row) {
            return null;
        }

        return await this.#loadProviderUsageSnapshotFromRow(row);
    }

    async upsertProviderUsageSnapshot(providerType, snapshot = {}) {
        await this.initialize();

        const preparedRows = buildUsageSnapshotPersistenceRows(providerType, snapshot, nowIso());
        const { normalizedSnapshot, snapshotRow, instanceRows, breakdownRows, freeTrialRows, bonusRows } = preparedRows;

        const cacheTimestamp = normalizeIsoOrNull(normalizedSnapshot.timestamp) || nowIso();
        const statements = [
            'BEGIN IMMEDIATE;',
            `DELETE FROM usage_snapshots WHERE provider_id IS NULL AND provider_type = ${sqlValue(providerType)} AND id <> ${sqlValue(snapshotRow.id)};`,
            `
INSERT INTO usage_snapshots (
    id,
    provider_type,
    provider_id,
    snapshot_at,
    total_count,
    success_count,
    error_count,
    processed_count,
    payload_json
) VALUES (
    ${sqlValue(snapshotRow.id)},
    ${sqlValue(snapshotRow.provider_type)},
    ${sqlValue(snapshotRow.provider_id)},
    ${sqlValue(snapshotRow.snapshot_at)},
    ${sqlValue(snapshotRow.total_count)},
    ${sqlValue(snapshotRow.success_count)},
    ${sqlValue(snapshotRow.error_count)},
    ${sqlValue(snapshotRow.processed_count)},
    ${sqlValue(snapshotRow.payload_json)}
)
ON CONFLICT(id) DO UPDATE SET
    provider_type = excluded.provider_type,
    provider_id = excluded.provider_id,
    snapshot_at = excluded.snapshot_at,
    total_count = excluded.total_count,
    success_count = excluded.success_count,
    error_count = excluded.error_count,
    processed_count = excluded.processed_count,
    payload_json = excluded.payload_json;
            `,
            `DELETE FROM usage_snapshot_instances WHERE snapshot_id = ${sqlValue(snapshotRow.id)};`,
            "DELETE FROM runtime_settings WHERE scope = 'compat_export' AND key = 'usage-cache';",
            `
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'usage_cache',
    'timestamp',
    ${sqlValue(JSON.stringify(cacheTimestamp))},
    ${sqlValue(nowIso())}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
            `
        ];

        appendInsertBatchStatements(statements, 'usage_snapshot_instances', [
            'id',
            'snapshot_id',
            'instance_key',
            'uuid',
            'display_name',
            'success',
            'error_message',
            'is_disabled',
            'is_healthy',
            'last_refreshed_at',
            'subscription_title',
            'subscription_type',
            'subscription_upgrade_capability',
            'subscription_overage_capability',
            'user_email',
            'user_id',
            'instance_order'
        ], instanceRows);
        appendInsertBatchStatements(statements, 'usage_snapshot_breakdowns', [
            'id',
            'instance_id',
            'breakdown_order',
            'resource_type',
            'display_name',
            'display_name_plural',
            'unit',
            'currency',
            'current_usage',
            'usage_limit',
            'current_overages',
            'overage_cap',
            'overage_rate',
            'overage_charges',
            'next_date_reset',
            'model_name',
            'remaining',
            'remaining_percent',
            'reset_time',
            'reset_time_raw',
            'rate_limit_allowed',
            'rate_limit_reached',
            'primary_limit_window_seconds',
            'primary_reset_after_seconds',
            'primary_reset_at',
            'primary_used_percent',
            'secondary_limit_window_seconds',
            'secondary_reset_after_seconds',
            'secondary_reset_at',
            'secondary_used_percent'
        ], breakdownRows);
        appendInsertBatchStatements(statements, 'usage_snapshot_free_trials', [
            'id',
            'breakdown_id',
            'status',
            'current_usage',
            'usage_limit',
            'expires_at'
        ], freeTrialRows);
        appendInsertBatchStatements(statements, 'usage_snapshot_bonuses', [
            'id',
            'breakdown_id',
            'bonus_order',
            'code',
            'display_name',
            'description',
            'status',
            'current_usage',
            'usage_limit',
            'redeemed_at',
            'expires_at'
        ], bonusRows);

        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));
        return normalizedSnapshot;
    }

    async saveUsageRefreshTask(task = {}) {
        await this.initialize();
        if (!task?.id) {
            return null;
        }

        await this.client.exec(`
BEGIN IMMEDIATE;
INSERT INTO usage_refresh_tasks (
    id,
    task_type,
    provider_type,
    status,
    progress_json,
    result_json,
    error_message,
    created_at,
    started_at,
    finished_at
) VALUES (
    ${sqlValue(task.id)},
    ${sqlValue(task.type || 'provider')},
    ${sqlValue(task.providerType || null)},
    ${sqlValue(task.status || 'running')},
    ${sqlValue(JSON.stringify(task.progress || {}))},
    ${sqlValue(task.result ? JSON.stringify(task.result) : null)},
    ${sqlValue(task.error || null)},
    ${sqlValue(task.createdAt || nowIso())},
    ${sqlValue(task.startedAt || null)},
    ${sqlValue(task.finishedAt || null)}
)
ON CONFLICT(id) DO UPDATE SET
    task_type = excluded.task_type,
    provider_type = excluded.provider_type,
    status = excluded.status,
    progress_json = excluded.progress_json,
    result_json = excluded.result_json,
    error_message = excluded.error_message,
    created_at = excluded.created_at,
    started_at = excluded.started_at,
    finished_at = excluded.finished_at;
COMMIT;
        `);

        return task;
    }

    async loadUsageRefreshTask(taskId) {
        await this.initialize();

        const row = (await this.client.query(`
SELECT id, task_type, provider_type, status, progress_json, result_json, error_message, created_at, started_at, finished_at
FROM usage_refresh_tasks
WHERE id = ${sqlValue(taskId)}
LIMIT 1;
        `))[0];

        if (!row) {
            return null;
        }

        const createdAtMs = new Date(row.created_at).getTime();
        return {
            id: row.id,
            type: row.task_type,
            providerType: row.provider_type || null,
            status: row.status,
            createdAt: row.created_at,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
            startedAt: row.started_at || null,
            finishedAt: row.finished_at || null,
            error: row.error_message || null,
            result: parseJsonField(row.result_json, null),
            progress: parseJsonField(row.progress_json, {}) || {}
        };
    }

    async markInterruptedUsageRefreshTasks() {
        await this.initialize();

        const runningRows = await this.client.query(`
SELECT id
FROM usage_refresh_tasks
WHERE status = 'running';
        `);
        if (runningRows.length === 0) {
            return 0;
        }

        const interruptedAt = nowIso();
        await this.client.exec(`
BEGIN IMMEDIATE;
UPDATE usage_refresh_tasks
SET status = 'failed',
    error_message = COALESCE(error_message, 'Usage refresh task interrupted by process restart'),
    finished_at = COALESCE(finished_at, ${sqlValue(interruptedAt)})
WHERE status = 'running';
COMMIT;
        `);
        return runningRows.length;
    }

    async #ensureUsageSchemaUpgrade() {
        const usageSnapshotColumns = await this.client.query('PRAGMA table_info(usage_snapshots);');
        const usageSnapshotColumnNames = new Set(
            usageSnapshotColumns.map((column) => String(column.name || '').toLowerCase())
        );

        if (!usageSnapshotColumnNames.has('processed_count')) {
            await this.client.exec(`
ALTER TABLE usage_snapshots ADD COLUMN processed_count INTEGER NOT NULL DEFAULT 0;
UPDATE usage_snapshots
SET processed_count = total_count
WHERE processed_count IS NULL OR processed_count = 0;
            `);
        }
    }

    async #hasLegacyImportMarker(markerKey) {
        if (!markerKey) {
            return false;
        }

        const rows = await this.client.query(`
SELECT meta_key
FROM runtime_storage_meta
WHERE meta_key = ${sqlValue(markerKey)}
LIMIT 1;
        `);
        return rows.length > 0;
    }

    async #setLegacyImportMarker(markerKey, markerValue = '1') {
        if (!markerKey) {
            return;
        }

        await this.client.exec(`
INSERT INTO runtime_storage_meta (meta_key, meta_value, updated_at)
VALUES (
    ${sqlValue(markerKey)},
    ${sqlValue(markerValue)},
    ${sqlValue(nowIso())}
)
ON CONFLICT(meta_key) DO UPDATE SET
    meta_value = excluded.meta_value,
    updated_at = excluded.updated_at;
        `);
    }

    async #ensureLegacyImportMarker(markerKey, markerValue = '1') {
        const markerExists = await this.#hasLegacyImportMarker(markerKey);
        if (markerExists) {
            return false;
        }

        await this.#setLegacyImportMarker(markerKey, markerValue);
        return true;
    }

    async #ensureUsageCacheSeeded() {
        const countRows = await this.client.query(`
SELECT COUNT(*) AS count
FROM usage_snapshots
WHERE provider_id IS NULL;
        `);
        const snapshotCount = Number(countRows[0]?.count || 0);
        const importMarkerKey = LEGACY_IMPORT_MARKERS.usageCache;
        if (snapshotCount > 0) {
            await this.#ensureLegacyImportMarker(importMarkerKey, 'existing_data');
            return snapshotCount;
        }

        const legacyImportMarked = await this.#hasLegacyImportMarker(importMarkerKey);
        if (legacyImportMarked) {
            return 0;
        }

        const legacyCache = await this.fileStorage.loadUsageCacheSnapshot();
        if (legacyCache?.providers && Object.keys(legacyCache.providers).length > 0) {
            await this.replaceUsageCacheSnapshot(legacyCache);
            await this.#setLegacyImportMarker(importMarkerKey, 'imported_from_legacy_file');
            logger.info('[RuntimeStorage:db] Imported legacy usage cache into sqlite runtime storage');
            return Object.keys(legacyCache.providers).length;
        }

        return 0;
    }

    async #loadUsageCacheTimestamp(fallbackTimestamp = null) {
        const row = (await this.client.query(`
SELECT value_json
FROM runtime_settings
WHERE scope = 'usage_cache' AND key = 'timestamp'
LIMIT 1;
        `))[0];

        const cachedTimestamp = normalizeIsoOrNull(parseJsonField(row?.value_json, null));
        return cachedTimestamp || fallbackTimestamp || nowIso();
    }

    async #loadProviderUsageSnapshotFromRow(row) {
        if (!row) {
            return null;
        }

        if (row.payload_json) {
            return buildLegacyUsageSnapshotFromRow(row);
        }

        const summary = buildUsageSnapshotSummaryRecord(row);
        const instanceRows = await this.client.query(`
SELECT
    id,
    snapshot_id,
    instance_key,
    uuid,
    display_name,
    success,
    error_message,
    is_disabled,
    is_healthy,
    last_refreshed_at,
    subscription_title,
    subscription_type,
    subscription_upgrade_capability,
    subscription_overage_capability,
    user_email,
    user_id,
    instance_order
FROM usage_snapshot_instances
WHERE snapshot_id = ${sqlValue(row.id)}
ORDER BY instance_order ASC, id ASC;
        `);

        if (instanceRows.length === 0) {
            if (row.payload_json) {
                return buildLegacyUsageSnapshotFromRow(row);
            }

            return {
                ...summary,
                instances: []
            };
        }

        const breakdownRows = await this.client.query(`
SELECT
    b.id,
    b.instance_id,
    b.breakdown_order,
    b.resource_type,
    b.display_name,
    b.display_name_plural,
    b.unit,
    b.currency,
    b.current_usage,
    b.usage_limit,
    b.current_overages,
    b.overage_cap,
    b.overage_rate,
    b.overage_charges,
    b.next_date_reset,
    b.model_name,
    b.remaining,
    b.remaining_percent,
    b.reset_time,
    b.reset_time_raw,
    b.rate_limit_allowed,
    b.rate_limit_reached,
    b.primary_limit_window_seconds,
    b.primary_reset_after_seconds,
    b.primary_reset_at,
    b.primary_used_percent,
    b.secondary_limit_window_seconds,
    b.secondary_reset_after_seconds,
    b.secondary_reset_at,
    b.secondary_used_percent,
    i.instance_order
FROM usage_snapshot_breakdowns b
INNER JOIN usage_snapshot_instances i ON i.id = b.instance_id
WHERE i.snapshot_id = ${sqlValue(row.id)}
ORDER BY i.instance_order ASC, b.breakdown_order ASC, b.id ASC;
        `);

        const freeTrialRows = breakdownRows.length > 0
            ? await this.client.query(`
SELECT
    f.id,
    f.breakdown_id,
    f.status,
    f.current_usage,
    f.usage_limit,
    f.expires_at
FROM usage_snapshot_free_trials f
INNER JOIN usage_snapshot_breakdowns b ON b.id = f.breakdown_id
INNER JOIN usage_snapshot_instances i ON i.id = b.instance_id
WHERE i.snapshot_id = ${sqlValue(row.id)};
            `)
            : [];

        const bonusRows = breakdownRows.length > 0
            ? await this.client.query(`
SELECT
    bo.id,
    bo.breakdown_id,
    bo.bonus_order,
    bo.code,
    bo.display_name,
    bo.description,
    bo.status,
    bo.current_usage,
    bo.usage_limit,
    bo.redeemed_at,
    bo.expires_at,
    i.instance_order,
    b.breakdown_order
FROM usage_snapshot_bonuses bo
INNER JOIN usage_snapshot_breakdowns b ON b.id = bo.breakdown_id
INNER JOIN usage_snapshot_instances i ON i.id = b.instance_id
WHERE i.snapshot_id = ${sqlValue(row.id)}
ORDER BY i.instance_order ASC, b.breakdown_order ASC, bo.bonus_order ASC, bo.id ASC;
            `)
            : [];

        const freeTrialByBreakdownId = new Map(
            freeTrialRows.map((freeTrialRow) => [freeTrialRow.breakdown_id, freeTrialRow])
        );
        const bonusesByBreakdownId = new Map();
        for (const bonusRow of bonusRows) {
            if (!bonusesByBreakdownId.has(bonusRow.breakdown_id)) {
                bonusesByBreakdownId.set(bonusRow.breakdown_id, []);
            }
            bonusesByBreakdownId.get(bonusRow.breakdown_id).push(bonusRow);
        }

        const breakdownsByInstanceId = new Map();
        for (const breakdownRow of breakdownRows) {
            if (!breakdownsByInstanceId.has(breakdownRow.instance_id)) {
                breakdownsByInstanceId.set(breakdownRow.instance_id, []);
            }
            breakdownsByInstanceId.get(breakdownRow.instance_id).push(
                buildUsageBreakdownFromStructuredRow(
                    breakdownRow,
                    freeTrialByBreakdownId.get(breakdownRow.id) || null,
                    bonusesByBreakdownId.get(breakdownRow.id) || []
                )
            );
        }

        return {
            ...summary,
            instances: instanceRows.map((instanceRow) => buildUsageInstanceFromStructuredRow(
                instanceRow,
                breakdownsByInstanceId.get(instanceRow.id) || []
            ))
        };
    }

    #scheduleAdminSessionTouch(sessionId, lastSeenAt = null) {
        if (!sessionId || this.adminSessionTouchIntervalMs <= 0) {
            return;
        }

        const cachedTouchedAt = this.adminSessionTouchTimestamps.get(sessionId);
        const persistedTouchedAt = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
        const baselineTouchedAt = Number.isFinite(cachedTouchedAt)
            ? cachedTouchedAt
            : (Number.isFinite(persistedTouchedAt) ? persistedTouchedAt : 0);
        const now = Date.now();

        if (baselineTouchedAt > 0 && now - baselineTouchedAt < this.adminSessionTouchIntervalMs) {
            return;
        }

        if (this.adminSessionTouchInFlight.has(sessionId)) {
            return;
        }

        const touchedAtIso = nowIso();
        this.adminSessionTouchTimestamps.set(sessionId, now);

        const touchTask = this.client.exec(`
BEGIN IMMEDIATE;
UPDATE admin_sessions
SET last_seen_at = ${sqlValue(touchedAtIso)}
WHERE id = ${sqlValue(sessionId)};
COMMIT;
        `).catch((error) => {
            this.adminSessionTouchTimestamps.delete(sessionId);
            logger.warn(`[RuntimeStorage:db] Failed to update admin session last_seen_at for ${sessionId}: ${error.message}`);
        }).finally(() => {
            this.adminSessionTouchInFlight.delete(sessionId);
        });

        this.adminSessionTouchInFlight.set(sessionId, touchTask);
    }

    async getAdminSession(token) {
        await this.initialize();
        await this.#importLegacyAdminSessionsIfNeeded();

        const tokenHash = hashValue(token);
        const row = (await this.client.query(`
SELECT id, subject, expires_at, created_at, last_seen_at, source_ip, user_agent, meta_json
FROM admin_sessions
WHERE token_hash = ${sqlValue(tokenHash)}
LIMIT 1;
        `))[0];

        if (!row) {
            return null;
        }

        const expiresAt = normalizeIsoOrNull(row.expires_at);
        if (expiresAt && Date.now() > new Date(expiresAt).getTime()) {
            await this.deleteAdminSession(token);
            return null;
        }

        const tokenInfo = parseJsonField(row.meta_json, {}) || {};
        tokenInfo.username = tokenInfo.username || row.subject || 'admin';
        tokenInfo.loginTime = tokenInfo.loginTime || (row.created_at ? new Date(row.created_at).getTime() : Date.now());
        tokenInfo.expiryTime = tokenInfo.expiryTime || (expiresAt ? new Date(expiresAt).getTime() : Date.now());
        tokenInfo.sourceIp = tokenInfo.sourceIp || row.source_ip || null;
        tokenInfo.userAgent = tokenInfo.userAgent || row.user_agent || null;

        this.#scheduleAdminSessionTouch(row.id, row.last_seen_at);

        return tokenInfo;
    }

    async saveAdminSession(token, tokenInfo = {}) {
        await this.initialize();

        const timestamp = nowIso();
        const expiresAt = normalizeIsoOrNull(tokenInfo.expiryTime) || normalizeIsoOrNull(new Date(Number(tokenInfo.expiryTime || Date.now())).toISOString()) || timestamp;
        const createdAt = normalizeIsoOrNull(tokenInfo.loginTime) || normalizeIsoOrNull(new Date(Number(tokenInfo.loginTime || Date.now())).toISOString()) || timestamp;
        const tokenHash = hashValue(token);

        await this.client.exec(`
BEGIN IMMEDIATE;
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
    ${sqlValue(buildAdminSessionId(token))},
    ${sqlValue(tokenHash)},
    ${sqlValue(tokenInfo.username || 'admin')},
    ${sqlValue(expiresAt)},
    ${sqlValue(createdAt)},
    ${sqlValue(timestamp)},
    ${sqlValue(tokenInfo.sourceIp || null)},
    ${sqlValue(tokenInfo.userAgent || null)},
    ${sqlValue(JSON.stringify(tokenInfo))}
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
COMMIT;
        `);

        return tokenInfo;
    }

    async deleteAdminSession(token) {
        await this.initialize();
        const tokenHash = hashValue(token);
        this.adminSessionTouchTimestamps.delete(buildAdminSessionId(token));
        this.adminSessionTouchInFlight.delete(buildAdminSessionId(token));
        await this.client.exec(`
BEGIN IMMEDIATE;
DELETE FROM admin_sessions
WHERE token_hash = ${sqlValue(tokenHash)};
COMMIT;
        `);
        return true;
    }

    async cleanupExpiredAdminSessions() {
        await this.initialize();
        await this.#importLegacyAdminSessionsIfNeeded();

        const expiredRows = await this.client.query(`
SELECT id
FROM admin_sessions
WHERE expires_at < ${sqlValue(nowIso())};
        `);
        if (expiredRows.length === 0) {
            return { deletedCount: 0 };
        }

        for (const row of expiredRows) {
            if (!row?.id) {
                continue;
            }
            this.adminSessionTouchTimestamps.delete(row.id);
            this.adminSessionTouchInFlight.delete(row.id);
        }

        await this.client.exec(`
BEGIN IMMEDIATE;
DELETE FROM admin_sessions
WHERE expires_at < ${sqlValue(nowIso())};
COMMIT;
        `);
        return { deletedCount: expiredRows.length };
    }

    async loadPotluckUserData() {
        await this.initialize();
        await this.#importLegacyPotluckUserDataIfNeeded();

        const configRows = await this.client.query(`
SELECT key, value_json
FROM potluck_config
ORDER BY key ASC;
        `);
        const userRows = await this.client.query(`
SELECT user_identifier, meta_json, created_at
FROM potluck_users
ORDER BY rowid ASC;
        `);

        const store = createEmptyPotluckUserData();
        for (const row of configRows) {
            store.config[row.key] = parseJsonField(row.value_json, null);
        }

        for (const row of userRows) {
            const meta = parseJsonField(row.meta_json, {}) || {};
            store.users[row.user_identifier] = {
                ...meta,
                credentials: Array.isArray(meta.credentials) ? meta.credentials : [],
                credentialBonuses: Array.isArray(meta.credentialBonuses) ? meta.credentialBonuses : [],
                createdAt: meta.createdAt || row.created_at || nowIso()
            };
        }

        return store;
    }

    async savePotluckUserData(store = createEmptyPotluckUserData()) {
        await this.initialize();

        const timestamp = nowIso();
        const normalizedStore = {
            config: store?.config && typeof store.config === 'object' ? store.config : {},
            users: store?.users && typeof store.users === 'object' ? store.users : {}
        };
        const userEntries = Object.entries(normalizedStore.users);
        const userIds = userEntries.map(([userIdentifier]) => buildPotluckUserId(userIdentifier));
        const statements = [
            'BEGIN IMMEDIATE;',
            'DELETE FROM potluck_config;',
            'DELETE FROM potluck_user_credentials;'
        ];

        if (userIds.length === 0) {
            statements.push('DELETE FROM potluck_users;');
        } else {
            statements.push(`DELETE FROM potluck_users WHERE id NOT IN (${userIds.map((userId) => sqlValue(userId)).join(', ')});`);
        }

        for (const [key, value] of Object.entries(normalizedStore.config)) {
            statements.push(`
INSERT INTO potluck_config (key, value_json, updated_at)
VALUES (
    ${sqlValue(key)},
    ${sqlValue(JSON.stringify(value))},
    ${sqlValue(timestamp)}
);
            `);
        }

        for (const [userIdentifier, userData] of userEntries) {
            const userId = buildPotluckUserId(userIdentifier);
            const createdAt = normalizeIsoOrNull(userData?.createdAt) || timestamp;
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
    ${sqlValue(userId)},
    ${sqlValue(userIdentifier)},
    NULL,
    ${sqlValue('active')},
    NULL,
    NULL,
    NULL,
    ${sqlValue(JSON.stringify(userData || {}))},
    ${sqlValue(createdAt)},
    ${sqlValue(timestamp)}
)
ON CONFLICT(id) DO UPDATE SET
    user_identifier = excluded.user_identifier,
    display_name = excluded.display_name,
    status = excluded.status,
    daily_limit = excluded.daily_limit,
    bonus_remaining = excluded.bonus_remaining,
    bonus_expires_at = excluded.bonus_expires_at,
    meta_json = excluded.meta_json,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;
            `);
        }

        statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'compat_export',
    'api-potluck-data',
    ${sqlValue(JSON.stringify(normalizedStore))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
        `);

        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));
        return normalizedStore;
    }

    async loadPotluckKeyStore() {
        await this.initialize();
        await this.#importLegacyPotluckKeyStoreIfNeeded();

        const keyRows = await this.client.query(`
SELECT id, key_id, name, enabled, daily_limit, used_today, bonus_remaining, last_reset_at, created_at
FROM potluck_api_keys
ORDER BY rowid ASC;
        `);
        const metaRows = await this.client.query(`
SELECT key, value_json
FROM runtime_settings
WHERE scope = 'potluck-key-meta'
ORDER BY key ASC;
        `);

        const metaMap = new Map(metaRows.map((row) => [row.key, parseJsonField(row.value_json, {}) || {}]));
        const keyStore = createEmptyPotluckKeyStore();

        keyRows.forEach((row, index) => {
            const meta = metaMap.get(row.key_id) || {};
            keyStore.keys[row.key_id] = {
                ...meta,
                id: row.key_id,
                name: row.name || meta.name || `Key-${index + 1}`,
                createdAt: meta.createdAt || row.created_at || nowIso(),
                dailyLimit: Number(row.daily_limit ?? meta.dailyLimit ?? 0),
                todayUsage: Number(row.used_today ?? meta.todayUsage ?? 0),
                totalUsage: Number(meta.totalUsage ?? row.used_today ?? 0),
                lastResetDate: meta.lastResetDate || normalizeDateOnly(row.last_reset_at) || nowIso().slice(0, 10),
                lastUsedAt: meta.lastUsedAt || null,
                enabled: Number(row.enabled ?? 1) !== 0,
                bonusRemaining: Number(row.bonus_remaining ?? meta.bonusRemaining ?? 0)
            };
        });

        return keyStore;
    }

    async savePotluckKeyStore(store = createEmptyPotluckKeyStore()) {
        await this.initialize();

        const timestamp = nowIso();
        const normalizedStore = {
            keys: store?.keys && typeof store.keys === 'object' ? store.keys : {}
        };
        const keyEntries = Object.entries(normalizedStore.keys);
        const keyIds = keyEntries.map(([keyId]) => buildPotluckKeyRowId(keyId));
        const statements = [
            'BEGIN IMMEDIATE;',
            'DELETE FROM potluck_key_usage_daily;'
        ];

        if (keyIds.length === 0) {
            statements.push("DELETE FROM runtime_settings WHERE scope = 'potluck-key-meta';");
            statements.push('DELETE FROM potluck_api_keys;');
        } else {
            statements.push(`DELETE FROM potluck_api_keys WHERE id NOT IN (${keyIds.map((keyId) => sqlValue(keyId)).join(', ')});`);
            statements.push(`DELETE FROM runtime_settings WHERE scope = 'potluck-key-meta' AND key NOT IN (${keyEntries.map(([keyId]) => sqlValue(keyId)).join(', ')});`);
        }

        for (const [keyId, keyData] of keyEntries) {
            const rowId = buildPotluckKeyRowId(keyId);
            const lastResetDate = normalizeDateOnly(keyData?.lastResetDate) || nowIso().slice(0, 10);
            const createdAt = normalizeIsoOrNull(keyData?.createdAt) || timestamp;
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
    ${sqlValue(rowId)},
    ${sqlValue(keyId)},
    ${sqlValue(hashValue(keyId))},
    ${sqlValue(keyData?.name || null)},
    ${sqlValue(keyData?.enabled !== false ? 1 : 0)},
    ${sqlValue(Number(keyData?.dailyLimit ?? 0))},
    ${sqlValue(Number(keyData?.todayUsage ?? 0))},
    ${sqlValue(Number(keyData?.bonusRemaining ?? 0))},
    ${sqlValue(`${lastResetDate}T00:00:00.000Z`)},
    ${sqlValue(keyData?.ownerUserId ? buildPotluckUserId(keyData.ownerUserId) : null)},
    ${sqlValue(createdAt)},
    ${sqlValue(timestamp)}
)
ON CONFLICT(id) DO UPDATE SET
    key_id = excluded.key_id,
    key_hash = excluded.key_hash,
    name = excluded.name,
    enabled = excluded.enabled,
    daily_limit = excluded.daily_limit,
    used_today = excluded.used_today,
    bonus_remaining = excluded.bonus_remaining,
    last_reset_at = excluded.last_reset_at,
    owner_user_id = excluded.owner_user_id,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at;
            `);
            statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'potluck-key-meta',
    ${sqlValue(keyId)},
    ${sqlValue(JSON.stringify(keyData || {}))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
            `);
            statements.push(`
INSERT INTO potluck_key_usage_daily (
    id,
    api_key_id,
    usage_date,
    request_count,
    quota_used,
    error_count,
    updated_at
) VALUES (
    ${sqlValue(buildPotluckUsageDailyId(keyId, lastResetDate))},
    ${sqlValue(rowId)},
    ${sqlValue(lastResetDate)},
    ${sqlValue(Number(keyData?.todayUsage ?? 0))},
    ${sqlValue(Number(keyData?.todayUsage ?? 0))},
    0,
    ${sqlValue(timestamp)}
);
            `);
        }

        statements.push(`
INSERT INTO runtime_settings (scope, key, value_json, updated_at)
VALUES (
    'compat_export',
    'api-potluck-keys',
    ${sqlValue(JSON.stringify(normalizedStore))},
    ${sqlValue(timestamp)}
)
ON CONFLICT(scope, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = excluded.updated_at;
        `);

        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));
        return normalizedStore;
    }

    async #importLegacyAdminSessionsIfNeeded() {
        const countRows = await this.client.query('SELECT COUNT(*) AS count FROM admin_sessions;');
        const importMarkerKey = LEGACY_IMPORT_MARKERS.adminSessions;
        if (Number(countRows[0]?.count || 0) > 0) {
            await this.#ensureLegacyImportMarker(importMarkerKey, 'existing_data');
            return;
        }

        const legacyImportMarked = await this.#hasLegacyImportMarker(importMarkerKey);
        if (legacyImportMarked) {
            return;
        }

        const tokenStorePath = this.config.TOKEN_STORE_FILE_PATH || 'configs/token-store.json';
        const legacyStore = await readJsonFileSafe(tokenStorePath, { tokens: {} });
        const entries = Object.entries(legacyStore?.tokens || {});
        if (entries.length === 0) {
            return;
        }

        const timestamp = nowIso();
        const statements = ['BEGIN IMMEDIATE;'];
        for (const [token, tokenInfo] of entries) {
            const expiresAt = normalizeIsoOrNull(tokenInfo?.expiryTime) || normalizeIsoOrNull(new Date(Number(tokenInfo?.expiryTime || Date.now())).toISOString()) || timestamp;
            const createdAt = normalizeIsoOrNull(tokenInfo?.loginTime) || normalizeIsoOrNull(new Date(Number(tokenInfo?.loginTime || Date.now())).toISOString()) || timestamp;
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
    ${sqlValue(buildAdminSessionId(token))},
    ${sqlValue(hashValue(token))},
    ${sqlValue(tokenInfo?.username || 'admin')},
    ${sqlValue(expiresAt)},
    ${sqlValue(createdAt)},
    ${sqlValue(timestamp)},
    ${sqlValue(tokenInfo?.sourceIp || null)},
    ${sqlValue(tokenInfo?.userAgent || null)},
    ${sqlValue(JSON.stringify(tokenInfo || {}))}
);
            `);
        }
        statements.push('COMMIT;');
        await this.client.exec(statements.join('\n'));
        await this.#setLegacyImportMarker(importMarkerKey, 'imported_from_legacy_file');
        logger.info('[RuntimeStorage:db] Imported legacy admin sessions into sqlite runtime storage');
    }

    async #importLegacyPotluckUserDataIfNeeded() {
        const userCountRows = await this.client.query('SELECT COUNT(*) AS count FROM potluck_users;');
        const configCountRows = await this.client.query('SELECT COUNT(*) AS count FROM potluck_config;');
        const importMarkerKey = LEGACY_IMPORT_MARKERS.potluckUserData;
        if (Number(userCountRows[0]?.count || 0) > 0 || Number(configCountRows[0]?.count || 0) > 0) {
            await this.#ensureLegacyImportMarker(importMarkerKey, 'existing_data');
            return;
        }

        const legacyImportMarked = await this.#hasLegacyImportMarker(importMarkerKey);
        if (legacyImportMarked) {
            return;
        }

        const legacyStore = await this.fileStorage.loadPotluckUserData();
        if (!hasPotluckUserData(legacyStore)) {
            return;
        }

        await this.savePotluckUserData(legacyStore);
        await this.#setLegacyImportMarker(importMarkerKey, 'imported_from_legacy_file');
        logger.info('[RuntimeStorage:db] Imported legacy API Potluck user data into sqlite runtime storage');
    }

    async #importLegacyPotluckKeyStoreIfNeeded() {
        const keyCountRows = await this.client.query('SELECT COUNT(*) AS count FROM potluck_api_keys;');
        const importMarkerKey = LEGACY_IMPORT_MARKERS.potluckKeyStore;
        if (Number(keyCountRows[0]?.count || 0) > 0) {
            await this.#ensureLegacyImportMarker(importMarkerKey, 'existing_data');
            return;
        }

        const legacyImportMarked = await this.#hasLegacyImportMarker(importMarkerKey);
        if (legacyImportMarked) {
            return;
        }

        const legacyStore = await this.fileStorage.loadPotluckKeyStore();
        if (!hasPotluckKeyStore(legacyStore)) {
            return;
        }

        await this.savePotluckKeyStore(legacyStore);
        await this.#setLegacyImportMarker(importMarkerKey, 'imported_from_legacy_file');
        logger.info('[RuntimeStorage:db] Imported legacy API Potluck key store into sqlite runtime storage');
    }

    async close() {
        return undefined;
    }

    #buildSchemaSql() {
        return `
CREATE TABLE IF NOT EXISTS runtime_storage_meta (
    meta_key TEXT PRIMARY KEY,
    meta_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_registrations (
    provider_id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    routing_uuid TEXT NOT NULL,
    display_name TEXT,
    check_model TEXT,
    project_id TEXT,
    base_url TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    source_kind TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_registrations_type_uuid
    ON provider_registrations (provider_type, routing_uuid);

CREATE TABLE IF NOT EXISTS provider_runtime_state (
    provider_id TEXT PRIMARY KEY,
    is_healthy INTEGER NOT NULL DEFAULT 1,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    last_health_check_at TEXT,
    last_health_check_model TEXT,
    last_error_time TEXT,
    last_error_message TEXT,
    scheduled_recovery_at TEXT,
    refresh_count INTEGER NOT NULL DEFAULT 0,
    last_selection_seq INTEGER,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(provider_id) REFERENCES provider_registrations(provider_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_inline_secrets (
    provider_id TEXT NOT NULL,
    secret_kind TEXT NOT NULL,
    secret_payload TEXT NOT NULL,
    protection_mode TEXT NOT NULL DEFAULT 'plain_text',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, secret_kind),
    FOREIGN KEY(provider_id) REFERENCES provider_registrations(provider_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_health_events (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT,
    status_code INTEGER,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(provider_id) REFERENCES provider_registrations(provider_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_group_state (
    provider_type TEXT NOT NULL,
    group_key TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0,
    healthy_count INTEGER,
    unhealthy_ratio REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider_type, group_key)
);

CREATE TABLE IF NOT EXISTS credential_assets (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    identity_key TEXT,
    dedupe_key TEXT,
    email TEXT,
    account_id TEXT,
    external_user_id TEXT,
    source_kind TEXT,
    source_path TEXT,
    source_checksum TEXT,
    storage_mode TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_imported_at TEXT,
    last_refreshed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_assets_provider_dedupe
    ON credential_assets (provider_type, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_credential_assets_identity_key ON credential_assets (identity_key);
CREATE INDEX IF NOT EXISTS idx_credential_assets_email ON credential_assets (email);
CREATE INDEX IF NOT EXISTS idx_credential_assets_account_id ON credential_assets (account_id);

CREATE TABLE IF NOT EXISTS credential_bindings (
    id TEXT PRIMARY KEY,
    credential_asset_id TEXT NOT NULL,
    binding_type TEXT NOT NULL,
    binding_target_id TEXT NOT NULL,
    binding_status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(credential_asset_id) REFERENCES credential_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credential_import_jobs (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    source_kind TEXT,
    total_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    summary_json TEXT,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS credential_file_index (
    id TEXT PRIMARY KEY,
    credential_asset_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    checksum TEXT,
    mtime TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(credential_asset_id) REFERENCES credential_assets(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_file_index_path
    ON credential_file_index (file_path);

CREATE TABLE IF NOT EXISTS usage_snapshots (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL,
    provider_id TEXT,
    snapshot_at TEXT NOT NULL,
    total_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT,
    FOREIGN KEY(provider_id) REFERENCES provider_registrations(provider_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_type_time
    ON usage_snapshots (provider_type, snapshot_at);

CREATE TABLE IF NOT EXISTS usage_snapshot_instances (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    instance_key TEXT NOT NULL,
    uuid TEXT,
    display_name TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    is_healthy INTEGER,
    last_refreshed_at TEXT,
    subscription_title TEXT,
    subscription_type TEXT,
    subscription_upgrade_capability TEXT,
    subscription_overage_capability TEXT,
    user_email TEXT,
    user_id TEXT,
    instance_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(snapshot_id) REFERENCES usage_snapshots(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshot_instances_snapshot_order
    ON usage_snapshot_instances (snapshot_id, instance_order);

CREATE TABLE IF NOT EXISTS usage_snapshot_breakdowns (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    breakdown_order INTEGER NOT NULL DEFAULT 0,
    resource_type TEXT,
    display_name TEXT,
    display_name_plural TEXT,
    unit TEXT,
    currency TEXT,
    current_usage REAL,
    usage_limit REAL,
    current_overages REAL,
    overage_cap REAL,
    overage_rate REAL,
    overage_charges REAL,
    next_date_reset TEXT,
    model_name TEXT,
    remaining REAL,
    remaining_percent REAL,
    reset_time TEXT,
    reset_time_raw TEXT,
    rate_limit_allowed INTEGER,
    rate_limit_reached INTEGER,
    primary_limit_window_seconds REAL,
    primary_reset_after_seconds REAL,
    primary_reset_at REAL,
    primary_used_percent REAL,
    secondary_limit_window_seconds REAL,
    secondary_reset_after_seconds REAL,
    secondary_reset_at REAL,
    secondary_used_percent REAL,
    FOREIGN KEY(instance_id) REFERENCES usage_snapshot_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshot_breakdowns_instance_order
    ON usage_snapshot_breakdowns (instance_id, breakdown_order);

CREATE TABLE IF NOT EXISTS usage_snapshot_free_trials (
    id TEXT PRIMARY KEY,
    breakdown_id TEXT NOT NULL,
    status TEXT,
    current_usage REAL,
    usage_limit REAL,
    expires_at TEXT,
    FOREIGN KEY(breakdown_id) REFERENCES usage_snapshot_breakdowns(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_snapshot_free_trials_breakdown
    ON usage_snapshot_free_trials (breakdown_id);

CREATE TABLE IF NOT EXISTS usage_snapshot_bonuses (
    id TEXT PRIMARY KEY,
    breakdown_id TEXT NOT NULL,
    bonus_order INTEGER NOT NULL DEFAULT 0,
    code TEXT,
    display_name TEXT,
    description TEXT,
    status TEXT,
    current_usage REAL,
    usage_limit REAL,
    redeemed_at TEXT,
    expires_at TEXT,
    FOREIGN KEY(breakdown_id) REFERENCES usage_snapshot_breakdowns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshot_bonuses_breakdown_order
    ON usage_snapshot_bonuses (breakdown_id, bonus_order);

CREATE TABLE IF NOT EXISTS usage_refresh_tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    provider_type TEXT,
    status TEXT NOT NULL,
    progress_json TEXT,
    result_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    subject TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    source_ip TEXT,
    user_agent TEXT,
    meta_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_sessions_token_hash
    ON admin_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
    ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS runtime_settings (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS potluck_users (
    id TEXT PRIMARY KEY,
    user_identifier TEXT NOT NULL,
    display_name TEXT,
    status TEXT,
    daily_limit INTEGER,
    bonus_remaining INTEGER,
    bonus_expires_at TEXT,
    meta_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS potluck_user_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    credential_asset_id TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    binding_status TEXT,
    linked_at TEXT,
    meta_json TEXT,
    FOREIGN KEY(user_id) REFERENCES potluck_users(id) ON DELETE CASCADE,
    FOREIGN KEY(credential_asset_id) REFERENCES credential_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS potluck_api_keys (
    id TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    daily_limit INTEGER,
    used_today INTEGER NOT NULL DEFAULT 0,
    bonus_remaining INTEGER,
    last_reset_at TEXT,
    owner_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES potluck_users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_potluck_api_keys_key_id
    ON potluck_api_keys (key_id);
CREATE INDEX IF NOT EXISTS idx_potluck_api_keys_owner_enabled
    ON potluck_api_keys (owner_user_id, enabled);

CREATE TABLE IF NOT EXISTS potluck_key_usage_daily (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    quota_used INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(api_key_id) REFERENCES potluck_api_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS potluck_config (
    key TEXT PRIMARY KEY,
    value_json TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_migration_runs (
    id TEXT PRIMARY KEY,
    migration_type TEXT NOT NULL,
    source_version TEXT,
    status TEXT NOT NULL,
    summary_json TEXT,
    started_at TEXT,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS storage_migration_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    source_ref TEXT,
    target_ref TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES storage_migration_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_storage_migration_items_run_status
    ON storage_migration_items (run_id, status);

CREATE TABLE IF NOT EXISTS credential_secret_blobs (
    credential_asset_id TEXT PRIMARY KEY,
    encrypted_payload TEXT NOT NULL,
    payload_version TEXT,
    key_version TEXT,
    checksum TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(credential_asset_id) REFERENCES credential_assets(id) ON DELETE CASCADE
);
        `;
    }
}


function buildSqliteStorageOperationKey(prefix, parts = []) {
    const normalizedParts = Array.isArray(parts)
        ? parts
            .filter((part) => part !== undefined && part !== null && String(part).trim())
            .map((part) => String(part).trim())
        : [];
    const hash = createHash('sha256')
        .update(`${prefix}::${normalizedParts.join('::')}`)
        .digest('hex')
        .slice(0, 24);
    return `${prefix}_${hash}`;
}

function buildHashedTokenKey(token) {
    if (!token) {
        return null;
    }

    return `session_${createHash('sha256').update(String(token)).digest('hex').slice(0, 16)}`;
}

function normalizeOperationPathList(paths = []) {
    return Array.isArray(paths)
        ? paths
            .filter((item) => typeof item === 'string' && item.trim())
            .map((item) => item.trim())
            .sort()
        : [];
}

function normalizeCredentialListOptions(options = {}) {
    const normalized = options && typeof options === 'object' && !Array.isArray(options)
        ? options
        : {};
    const limit = Number.parseInt(normalized.limit, 10);
    const offset = Number.parseInt(normalized.offset, 10);

    return {
        sort: normalized.sort === 'asc' ? 'asc' : 'desc',
        identityKey: typeof normalized.identityKey === 'string' && normalized.identityKey.trim()
            ? normalized.identityKey.trim()
            : null,
        email: typeof normalized.email === 'string' && normalized.email.trim()
            ? normalized.email.trim().toLowerCase()
            : null,
        sourceKind: typeof normalized.sourceKind === 'string' && normalized.sourceKind.trim()
            ? normalized.sourceKind.trim()
            : null,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : null,
        offset: Number.isFinite(offset) && offset >= 0 ? offset : 0
    };
}

function buildSqliteOperationDetails(instance, operation, args = []) {
    const lockRetryWindowMs = Number(instance?.client?.maxRetryAttempts || 0) * Number(instance?.client?.retryDelayMs || 0);

    switch (operation) {
    case 'exportProviderPoolsSnapshot':
        return {
            replaySafe: true,
            replayBoundary: 'compat_export_provider_pools',
            idempotencyKey: 'provider_compat_export'
        };
    case 'replaceProviderPoolsSnapshot': {
        const providerPools = args[0] && typeof args[0] === 'object' ? args[0] : {};
        const options = args[1] || {};
        return {
            providerTypeCount: Object.keys(providerPools).length,
            sourceKind: options.sourceKind || null,
            replaySafe: true,
            replayBoundary: 'provider_snapshot_replace',
            idempotencyKey: 'provider_snapshot_replace_full'
        };
    }
    case 'findCredentialAsset': {
        const match = args[1] || {};
        return {
            providerType: args[0] || null,
            identityKey: match.identityKey || null,
            dedupeKey: match.dedupeKey || null,
            replaySafe: true,
            replayBoundary: 'credential_asset_lookup'
        };
    }
    case 'listCredentialAssets': {
        const options = normalizeCredentialListOptions(args[1]);
        return {
            providerType: args[0] || null,
            sort: options.sort,
            limit: options.limit,
            offset: options.offset,
            replaySafe: true,
            replayBoundary: 'credential_asset_list'
        };
    }
    case 'linkCredentialFiles': {
        const credPaths = normalizeOperationPathList(args[0]);
        const options = args[1] || {};
        return {
            credentialPathCount: credPaths.length,
            sourceKind: options.sourceKind || null,
            replaySafe: true,
            replayBoundary: 'provider_credential_binding_upsert',
            idempotencyKey: buildSqliteStorageOperationKey('provider_link_credentials', credPaths)
        };
    }
    case 'flushProviderRuntimeState': {
        const records = Array.isArray(args[0]) ? args[0] : [];
        const options = args[1] || {};
        const providerIds = records
            .map((record) => record?.providerId || null)
            .filter(Boolean)
            .sort();
        return {
            providerId: providerIds[0] || null,
            providerCount: providerIds.length,
            persistSelectionState: options.persistSelectionState === true,
            replaySafe: true,
            replayBoundary: 'provider_runtime_state_upsert',
            idempotencyKey: buildSqliteStorageOperationKey('provider_runtime_flush', [
                ...providerIds,
                options.persistSelectionState === true ? 'selection' : 'runtime'
            ]),
            lockRetryWindowMs
        };
    }
    case 'updateProviderRoutingUuid': {
        const update = args[0] || {};
        return {
            providerId: update.providerId || null,
            oldRoutingUuid: update.oldRoutingUuid || null,
            newRoutingUuid: update.newRoutingUuid || null,
            replaySafe: true,
            replayBoundary: 'provider_registration_routing_uuid',
            idempotencyKey: buildSqliteStorageOperationKey('provider_routing_uuid', [
                update.providerId || `${update.providerType || 'unknown'}:${update.oldRoutingUuid || 'unknown'}`,
                update.newRoutingUuid || 'missing'
            ])
        };
    }
    case 'loadUsageCacheSummary':
        return {
            replaySafe: true,
            replayBoundary: 'usage_cache_summary_read',
            idempotencyKey: 'usage_cache_summary_read'
        };
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
            idempotencyKey: buildSqliteStorageOperationKey('provider_usage', [args[0] || 'unknown'])
        };
    case 'saveUsageRefreshTask': {
        const task = args[0] || {};
        return {
            taskId: task.id || null,
            providerType: task.providerType || null,
            replaySafe: true,
            replayBoundary: 'usage_refresh_task_upsert',
            idempotencyKey: buildSqliteStorageOperationKey('usage_refresh_task', [task.id || 'missing'])
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
            sessionKey: buildHashedTokenKey(args[0]),
            replaySafe: true,
            replayBoundary: 'admin_session_upsert',
            idempotencyKey: buildSqliteStorageOperationKey('admin_session', [args[0] || 'missing'])
        };
    case 'deleteAdminSession':
        return {
            sessionKey: buildHashedTokenKey(args[0]),
            replaySafe: true,
            replayBoundary: 'admin_session_delete',
            idempotencyKey: buildSqliteStorageOperationKey('admin_session_delete', [args[0] || 'missing'])
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
        return lockRetryWindowMs > 0 ? { lockRetryWindowMs } : undefined;
    }
}

const SQLITE_STORAGE_OPERATION_META = {
    initialize: { phase: 'initialize', domain: 'runtime_storage' },
    hasProviderData: { phase: 'read', domain: 'provider' },
    loadProviderPoolsSnapshot: { phase: 'read', domain: 'provider' },
    loadProviderPoolsSummary: { phase: 'read', domain: 'provider' },
    exportProviderPoolsSnapshot: { phase: 'export', domain: 'provider' },
    replaceProviderPoolsSnapshot: { phase: 'write', domain: 'provider' },
    findCredentialAsset: { phase: 'read', domain: 'provider' },
    listCredentialAssets: { phase: 'read', domain: 'provider' },
    linkCredentialFiles: { phase: 'write', domain: 'provider' },
    flushProviderRuntimeState: { phase: 'flush', domain: 'provider' },
    updateProviderRoutingUuid: { phase: 'flush', domain: 'provider' },
    loadUsageCacheSnapshot: { phase: 'read', domain: 'usage' },
    loadUsageCacheSummary: { phase: 'read', domain: 'usage' },
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

for (const [operation, meta] of Object.entries(SQLITE_STORAGE_OPERATION_META)) {
    const original = SqliteRuntimeStorage.prototype[operation];
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
                backend: 'db',
                operation,
                details: buildSqliteOperationDetails(this, operation, args)
            });
        }
    };

    wrapped.__runtimeStorageWrapped = true;
    SqliteRuntimeStorage.prototype[operation] = wrapped;
}
