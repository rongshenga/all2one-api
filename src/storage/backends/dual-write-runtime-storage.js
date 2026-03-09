import { createHash } from 'crypto';
import { getRuntimeStorageErrorPolicy, wrapRuntimeStorageError } from '../runtime-storage-error.js';

function getBackendInfo(storage) {
    try {
        return storage?.getInfo?.().backend || storage?.kind || 'unknown';
    } catch {
        return storage?.kind || 'unknown';
    }
}

function buildOperationKey(prefix, parts = []) {
    const normalizedParts = Array.isArray(parts)
        ? parts
            .filter((part) => part !== undefined && part !== null && String(part).trim())
            .map((part) => String(part).trim())
        : [];
    return `${prefix}_${createHash('sha256').update(`${prefix}::${normalizedParts.join('::')}`).digest('hex').slice(0, 24)}`;
}

function buildHashedTokenKey(token) {
    if (!token) {
        return null;
    }

    return `session_${createHash('sha256').update(String(token)).digest('hex').slice(0, 16)}`;
}

function buildDualWriteOperationDetails(operation, args = []) {
    switch (operation) {
    case 'replaceProviderPoolsSnapshot': {
        const providerPools = args[0] && typeof args[0] === 'object' ? args[0] : {};
        return {
            providerTypeCount: Object.keys(providerPools).length,
            idempotencyKey: 'provider_snapshot_replace_full',
            replaySafe: true,
            replayBoundary: 'provider_snapshot_replace'
        };
    }
    case 'linkCredentialFiles': {
        const credPaths = Array.isArray(args[0])
            ? args[0].filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).sort()
            : [];
        return {
            credentialPathCount: credPaths.length,
            idempotencyKey: buildOperationKey('provider_link_credentials', credPaths),
            replaySafe: true,
            replayBoundary: 'provider_credential_binding_upsert'
        };
    }
    case 'flushProviderRuntimeState': {
        const records = Array.isArray(args[0]) ? args[0] : [];
        const providerIds = records.map((record) => record?.providerId || null).filter(Boolean).sort();
        return {
            providerId: providerIds[0] || null,
            providerCount: providerIds.length,
            idempotencyKey: buildOperationKey('provider_runtime_flush', providerIds),
            replaySafe: true,
            replayBoundary: 'provider_runtime_state_upsert'
        };
    }
    case 'updateProviderRoutingUuid': {
        const update = args[0] || {};
        return {
            providerId: update.providerId || null,
            newRoutingUuid: update.newRoutingUuid || null,
            idempotencyKey: buildOperationKey('provider_routing_uuid', [
                update.providerId || `${update.providerType || 'unknown'}:${update.oldRoutingUuid || 'unknown'}`,
                update.newRoutingUuid || 'missing'
            ]),
            replaySafe: true,
            replayBoundary: 'provider_registration_routing_uuid'
        };
    }
    case 'replaceUsageCacheSnapshot': {
        const usageCache = args[0] || {};
        return {
            providerCount: Object.keys(usageCache.providers || {}).length,
            idempotencyKey: 'usage_cache_replace_full',
            replaySafe: true,
            replayBoundary: 'usage_cache_replace'
        };
    }
    case 'upsertProviderUsageSnapshot':
        return {
            providerType: args[0] || null,
            idempotencyKey: buildOperationKey('provider_usage', [args[0] || 'unknown']),
            replaySafe: true,
            replayBoundary: 'provider_usage_upsert'
        };
    case 'saveUsageRefreshTask': {
        const task = args[0] || {};
        return {
            taskId: task.id || null,
            providerType: task.providerType || null,
            idempotencyKey: buildOperationKey('usage_refresh_task', [task.id || 'missing']),
            replaySafe: true,
            replayBoundary: 'usage_refresh_task_upsert'
        };
    }
    case 'markInterruptedUsageRefreshTasks':
        return {
            idempotencyKey: 'usage_refresh_task_mark_interrupted_all',
            replaySafe: true,
            replayBoundary: 'usage_refresh_task_interrupt_mark'
        };
    case 'saveAdminSession':
        return {
            sessionKey: buildHashedTokenKey(args[0]),
            idempotencyKey: buildOperationKey('admin_session', [args[0] || 'missing']),
            replaySafe: true,
            replayBoundary: 'admin_session_upsert'
        };
    case 'deleteAdminSession':
        return {
            sessionKey: buildHashedTokenKey(args[0]),
            idempotencyKey: buildOperationKey('admin_session_delete', [args[0] || 'missing']),
            replaySafe: true,
            replayBoundary: 'admin_session_delete'
        };
    case 'cleanupExpiredAdminSessions':
        return {
            idempotencyKey: 'admin_session_cleanup_expired',
            replaySafe: true,
            replayBoundary: 'admin_session_cleanup'
        };
    case 'savePotluckUserData': {
        const store = args[0] || {};
        return {
            userCount: Object.keys(store.users || {}).length,
            idempotencyKey: 'potluck_user_store_replace_full',
            replaySafe: true,
            replayBoundary: 'potluck_user_store_replace'
        };
    }
    case 'savePotluckKeyStore': {
        const store = args[0] || {};
        return {
            keyCount: Object.keys(store.keys || {}).length,
            idempotencyKey: 'potluck_key_store_replace_full',
            replaySafe: true,
            replayBoundary: 'potluck_key_store_replace'
        };
    }
    default:
        return undefined;
    }
}

function wrapDualWriteFailure(error, storage, operation, phase, role, details = {}) {
    const classification = role === 'secondary' ? 'secondary_write_failed' : undefined;
    const policy = classification ? getRuntimeStorageErrorPolicy(classification) : undefined;

    return wrapRuntimeStorageError(error, {
        code: `runtime_storage_${role}_${phase}_failed`,
        classification,
        phase: `${phase}_${role}`,
        domain: phase === 'read' || phase === 'write' || phase === 'flush' || phase === 'export'
            ? details.domain || 'runtime_storage'
            : 'runtime_storage',
        backend: getBackendInfo(storage),
        operation,
        retryable: classification ? policy.retryable : undefined,
        details: {
            storageRole: role,
            ...details
        }
    });
}

async function executePrimary(storage, operation, phase, executor, details) {
    try {
        return await executor(storage);
    } catch (error) {
        throw wrapDualWriteFailure(error, storage, operation, phase, 'primary', {
            ...details,
            primaryCommitted: false,
            secondaryAttempted: false
        });
    }
}

async function executeSecondary(storage, operation, phase, executor, details) {
    try {
        return await executor(storage);
    } catch (error) {
        throw wrapDualWriteFailure(error, storage, operation, phase, 'secondary', {
            ...details,
            primaryCommitted: true,
            secondaryAttempted: true
        });
    }
}

async function executeMirroredWrite(instance, operation, phase, args, primaryExecutor, secondaryExecutor) {
    const details = buildDualWriteOperationDetails(operation, args);
    const result = await executePrimary(instance.primaryStorage, operation, phase, primaryExecutor, details);
    await executeSecondary(instance.secondaryStorage, operation, phase, secondaryExecutor, details);
    return result;
}

export class DualWriteRuntimeStorage {
    constructor(primaryStorage, secondaryStorage) {
        this.primaryStorage = primaryStorage;
        this.secondaryStorage = secondaryStorage;
        this.kind = 'dual-write';
    }

    async initialize() {
        await executePrimary(this.primaryStorage, 'initialize', 'initialize', async (storage) => await storage.initialize());
        await executeSecondary(this.secondaryStorage, 'initialize', 'initialize', async (storage) => await storage.initialize());
        return this;
    }

    getInfo() {
        return {
            backend: 'dual-write',
            primary: this.primaryStorage.getInfo(),
            secondary: this.secondaryStorage.getInfo()
        };
    }

    async loadProviderPoolsSnapshot(options = {}) {
        return await executePrimary(this.primaryStorage, 'loadProviderPoolsSnapshot', 'read', async (storage) => {
            return await storage.loadProviderPoolsSnapshot(options);
        }, buildDualWriteOperationDetails('loadProviderPoolsSnapshot', [options]));
    }

    async exportProviderPoolsSnapshot(options = {}) {
        return await executePrimary(this.primaryStorage, 'exportProviderPoolsSnapshot', 'export', async (storage) => {
            return await storage.exportProviderPoolsSnapshot(options);
        }, {
            replaySafe: true,
            replayBoundary: 'compat_export_provider_pools',
            idempotencyKey: 'provider_compat_export'
        });
    }

    async loadProviderPoolsSummary(options = {}) {
        return await executePrimary(this.primaryStorage, 'loadProviderPoolsSummary', 'read', async (storage) => {
            return await storage.loadProviderPoolsSummary(options);
        }, {
            replaySafe: true,
            replayBoundary: 'provider_summary_read',
            idempotencyKey: 'provider_summary_read'
        });
    }

    async replaceProviderPoolsSnapshot(providerPools = {}, options = {}) {
        return await executeMirroredWrite(
            this,
            'replaceProviderPoolsSnapshot',
            'write',
            [providerPools, options],
            async (storage) => await storage.replaceProviderPoolsSnapshot(providerPools, options),
            async (storage) => await storage.replaceProviderPoolsSnapshot(providerPools, options)
        );
    }

    async findCredentialAsset(providerType, match = {}) {
        return await executePrimary(this.primaryStorage, 'findCredentialAsset', 'read', async (storage) => {
            return await storage.findCredentialAsset(providerType, match);
        }, {
            providerType,
            replaySafe: true,
            replayBoundary: 'credential_asset_lookup'
        });
    }

    async listCredentialAssets(providerType, options = {}) {
        return await executePrimary(this.primaryStorage, 'listCredentialAssets', 'read', async (storage) => {
            return await storage.listCredentialAssets(providerType, options);
        }, {
            providerType: providerType || null,
            replaySafe: true,
            replayBoundary: 'credential_asset_list'
        });
    }

    async linkCredentialFiles(credPaths = [], options = {}) {
        const result = await executePrimary(this.primaryStorage, 'linkCredentialFiles', 'write', async (storage) => {
            return await storage.linkCredentialFiles(credPaths, options);
        }, buildDualWriteOperationDetails('linkCredentialFiles', [credPaths, options]));
        if (result?.providerPools) {
            await executeSecondary(this.secondaryStorage, 'linkCredentialFiles', 'write', async (storage) => {
                return await storage.replaceProviderPoolsSnapshot(result.providerPools, options);
            }, buildDualWriteOperationDetails('linkCredentialFiles', [credPaths, options]));
        }
        return result;
    }

    async flushProviderRuntimeState(records = [], options = {}) {
        return await executeMirroredWrite(
            this,
            'flushProviderRuntimeState',
            'write',
            [records, options],
            async (storage) => await storage.flushProviderRuntimeState(records, options),
            async (storage) => await storage.flushProviderRuntimeState(records, options)
        );
    }

    async updateProviderRoutingUuid(update = {}) {
        return await executeMirroredWrite(
            this,
            'updateProviderRoutingUuid',
            'write',
            [update],
            async (storage) => await storage.updateProviderRoutingUuid(update),
            async (storage) => await storage.updateProviderRoutingUuid(update)
        );
    }

    async hasProviderData() {
        return await executePrimary(this.primaryStorage, 'hasProviderData', 'read', async (storage) => {
            return await storage.hasProviderData();
        }, {
            replaySafe: true,
            replayBoundary: 'provider_data_probe'
        });
    }

    async loadUsageCacheSnapshot() {
        return await executePrimary(this.primaryStorage, 'loadUsageCacheSnapshot', 'read', async (storage) => {
            return await storage.loadUsageCacheSnapshot();
        }, {
            replaySafe: true,
            replayBoundary: 'usage_cache_read'
        });
    }

    async loadUsageCacheSummary() {
        return await executePrimary(this.primaryStorage, 'loadUsageCacheSummary', 'read', async (storage) => {
            if (typeof storage.loadUsageCacheSummary === 'function') {
                return await storage.loadUsageCacheSummary();
            }
            return await storage.loadUsageCacheSnapshot();
        }, {
            replaySafe: true,
            replayBoundary: 'usage_cache_summary_read'
        });
    }

    async replaceUsageCacheSnapshot(usageCache = null) {
        return await executeMirroredWrite(
            this,
            'replaceUsageCacheSnapshot',
            'write',
            [usageCache],
            async (storage) => await storage.replaceUsageCacheSnapshot(usageCache),
            async (storage) => await storage.replaceUsageCacheSnapshot(usageCache)
        );
    }

    async loadProviderUsageSnapshot(providerType) {
        return await executePrimary(this.primaryStorage, 'loadProviderUsageSnapshot', 'read', async (storage) => {
            return await storage.loadProviderUsageSnapshot(providerType);
        }, {
            providerType,
            replaySafe: true,
            replayBoundary: 'provider_usage_read'
        });
    }

    async upsertProviderUsageSnapshot(providerType, snapshot = {}) {
        return await executeMirroredWrite(
            this,
            'upsertProviderUsageSnapshot',
            'write',
            [providerType, snapshot],
            async (storage) => await storage.upsertProviderUsageSnapshot(providerType, snapshot),
            async (storage) => await storage.upsertProviderUsageSnapshot(providerType, snapshot)
        );
    }

    async saveUsageRefreshTask(task = {}) {
        return await executeMirroredWrite(
            this,
            'saveUsageRefreshTask',
            'write',
            [task],
            async (storage) => await storage.saveUsageRefreshTask(task),
            async (storage) => await storage.saveUsageRefreshTask(task)
        );
    }

    async loadUsageRefreshTask(taskId) {
        return await executePrimary(this.primaryStorage, 'loadUsageRefreshTask', 'read', async (storage) => {
            return await storage.loadUsageRefreshTask(taskId);
        }, {
            taskId,
            replaySafe: true,
            replayBoundary: 'usage_refresh_task_read'
        });
    }

    async markInterruptedUsageRefreshTasks() {
        return await executeMirroredWrite(
            this,
            'markInterruptedUsageRefreshTasks',
            'write',
            [],
            async (storage) => await storage.markInterruptedUsageRefreshTasks(),
            async (storage) => await storage.markInterruptedUsageRefreshTasks()
        );
    }

    async getAdminSession(token) {
        return await executePrimary(this.primaryStorage, 'getAdminSession', 'read', async (storage) => {
            return await storage.getAdminSession(token);
        }, {
            sessionKey: buildHashedTokenKey(token),
            replaySafe: true,
            replayBoundary: 'admin_session_read'
        });
    }

    async saveAdminSession(token, tokenInfo = {}) {
        return await executeMirroredWrite(
            this,
            'saveAdminSession',
            'write',
            [token, tokenInfo],
            async (storage) => await storage.saveAdminSession(token, tokenInfo),
            async (storage) => await storage.saveAdminSession(token, tokenInfo)
        );
    }

    async deleteAdminSession(token) {
        return await executeMirroredWrite(
            this,
            'deleteAdminSession',
            'write',
            [token],
            async (storage) => await storage.deleteAdminSession(token),
            async (storage) => await storage.deleteAdminSession(token)
        );
    }

    async cleanupExpiredAdminSessions() {
        return await executeMirroredWrite(
            this,
            'cleanupExpiredAdminSessions',
            'write',
            [],
            async (storage) => await storage.cleanupExpiredAdminSessions(),
            async (storage) => await storage.cleanupExpiredAdminSessions()
        );
    }

    async loadPotluckUserData() {
        return await executePrimary(this.primaryStorage, 'loadPotluckUserData', 'read', async (storage) => {
            return await storage.loadPotluckUserData();
        }, {
            replaySafe: true,
            replayBoundary: 'potluck_user_store_read'
        });
    }

    async savePotluckUserData(store = {}) {
        return await executeMirroredWrite(
            this,
            'savePotluckUserData',
            'write',
            [store],
            async (storage) => await storage.savePotluckUserData(store),
            async (storage) => await storage.savePotluckUserData(store)
        );
    }

    async loadPotluckKeyStore() {
        return await executePrimary(this.primaryStorage, 'loadPotluckKeyStore', 'read', async (storage) => {
            return await storage.loadPotluckKeyStore();
        }, {
            replaySafe: true,
            replayBoundary: 'potluck_key_store_read'
        });
    }

    async savePotluckKeyStore(store = {}) {
        return await executeMirroredWrite(
            this,
            'savePotluckKeyStore',
            'write',
            [store],
            async (storage) => await storage.savePotluckKeyStore(store),
            async (storage) => await storage.savePotluckKeyStore(store)
        );
    }

    async close() {
        await executePrimary(this.primaryStorage, 'close', 'close', async (storage) => await storage.close());
        await executeSecondary(this.secondaryStorage, 'close', 'close', async (storage) => await storage.close());
    }
}
