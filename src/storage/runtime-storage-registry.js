import logger from '../utils/logger.js';
import { createRuntimeStorage } from './runtime-storage-factory.js';
import {
    getRuntimeStorageErrorClassification,
    serializeRuntimeStorageError,
    wrapRuntimeStorageError
} from './runtime-storage-error.js';

let runtimeStorage = null;
let runtimeStorageState = null;

const OPERATION_META = {
    loadProviderPoolsSnapshot: { phase: 'read', domain: 'provider', trackKey: 'lastCompatLoad' },
    loadProviderPoolsSummary: { phase: 'read', domain: 'provider' },
    loadProviderTypePage: { phase: 'read', domain: 'provider' },
    exportProviderPoolsSnapshot: { phase: 'export', domain: 'provider', trackKey: 'lastExport' },
    replaceProviderPoolsSnapshot: { phase: 'write', domain: 'provider', trackKey: 'lastMutation' },
    upsertProviderPoolEntries: { phase: 'write', domain: 'provider', trackKey: 'lastMutation' },
    deleteProviderPoolEntries: { phase: 'write', domain: 'provider', trackKey: 'lastMutation' },
    getCredentialSecretBlob: { phase: 'read', domain: 'provider' },
    upsertCredentialSecretBlob: { phase: 'write', domain: 'provider' },
    listCredentialExpiryCandidates: { phase: 'read', domain: 'provider' },
    linkCredentialFiles: { phase: 'write', domain: 'provider', trackKey: 'lastMutation' },
    flushProviderRuntimeState: { phase: 'flush', domain: 'provider', trackKey: 'lastFlush' },
    updateProviderRoutingUuid: { phase: 'flush', domain: 'provider', trackKey: 'lastFlush' },
    updateProviderRoutingUuids: { phase: 'flush', domain: 'provider', trackKey: 'lastFlush' },
    loadUsageCacheSnapshot: { phase: 'read', domain: 'usage' },
    loadUsageCacheSummary: { phase: 'read', domain: 'usage' },
    replaceUsageCacheSnapshot: { phase: 'write', domain: 'usage' },
    loadProviderUsageSnapshot: { phase: 'read', domain: 'usage' },
    upsertProviderUsageSnapshot: { phase: 'write', domain: 'usage' },
    saveUsageRefreshTask: { phase: 'write', domain: 'usage' },
    loadUsageRefreshTask: { phase: 'read', domain: 'usage' },
    markInterruptedUsageRefreshTasks: { phase: 'write', domain: 'usage' },
    appendUsageStatisticsEvents: { phase: 'write', domain: 'usage_statistics' },
    queryUsageStatisticsOverview: { phase: 'read', domain: 'usage_statistics' },
    queryUsageStatisticsTrends: { phase: 'read', domain: 'usage_statistics' },
    queryUsageStatisticsHeatmap: { phase: 'read', domain: 'usage_statistics' },
    queryUsageStatisticsDimensions: { phase: 'read', domain: 'usage_statistics' },
    queryUsageStatisticsEvents: { phase: 'read', domain: 'usage_statistics' },
    listUsageStatisticsModelPrices: { phase: 'read', domain: 'usage_statistics' },
    upsertUsageStatisticsModelPrices: { phase: 'write', domain: 'usage_statistics' },
    getAdminPasswordHash: { phase: 'read', domain: 'auth' },
    saveAdminPasswordHash: { phase: 'write', domain: 'auth' },
    getAdminSession: { phase: 'read', domain: 'session' },
    saveAdminSession: { phase: 'write', domain: 'session' },
    deleteAdminSession: { phase: 'write', domain: 'session' },
    cleanupExpiredAdminSessions: { phase: 'write', domain: 'session' },
    loadPotluckUserData: { phase: 'read', domain: 'potluck' },
    savePotluckUserData: { phase: 'write', domain: 'potluck' },
    loadPotluckKeyStore: { phase: 'read', domain: 'potluck' },
    savePotluckKeyStore: { phase: 'write', domain: 'potluck' },
    initialize: { phase: 'initialize', domain: 'runtime_storage' },
    close: { phase: 'close', domain: 'runtime_storage', allowFallback: false }
};

function nowIso() {
    return new Date().toISOString();
}

function getRequestedBackend(config = {}) {
    return 'db';
}

function getAuthoritativeSource(backend) {
    return backend === 'file' ? 'file' : 'database';
}

function getStorageBackend(storage) {
    if (!storage) {
        return 'unavailable';
    }

    try {
        const info = typeof storage.getInfo === 'function' ? storage.getInfo() : null;
        if (info?.backend) {
            return info.backend;
        }
    } catch {
        // ignore
    }

    return storage.kind || 'unknown';
}

function summarizeResult(operation, result) {
    if (!result || typeof result !== 'object') {
        return undefined;
    }

    if (operation === 'flushProviderRuntimeState') {
        return {
            flushedCount: result.flushedCount ?? 0
        };
    }

    if (operation === 'exportProviderPoolsSnapshot') {
        return {
            providerTypeCount: Object.keys(result || {}).length
        };
    }

    if (operation === 'replaceProviderPoolsSnapshot') {
        return {
            providerTypeCount: Object.keys(result || {}).length
        };
    }

    if (operation === 'upsertProviderPoolEntries') {
        return {
            upsertedCount: result.upsertedCount ?? 0
        };
    }

    if (operation === 'deleteProviderPoolEntries') {
        return {
            deletedCount: result.deletedCount ?? 0
        };
    }

    if (operation === 'linkCredentialFiles') {
        return {
            totalNewProviders: result.totalNewProviders ?? 0
        };
    }

    if (operation === 'updateProviderRoutingUuid') {
        return {
            updated: result.updated === true
        };
    }

    if (operation === 'updateProviderRoutingUuids') {
        return {
            updatedCount: result.updatedCount ?? 0
        };
    }

    return undefined;
}

function createDiagnosticEntry(status, payload = {}) {
    return {
        status,
        occurredAt: nowIso(),
        ...payload
    };
}

export function buildRuntimeStorageCrashRecoveryDiagnostics() {
    return {
        durableBoundary: 'only_committed_transactions_and_successful_flush_batches_are_durable',
        lossWindow: 'unflushed_hot_state_only',
        mayLoseWithinWindow: [
            'provider_runtime_state.usageCount',
            'provider_runtime_state.lastUsed',
            'provider_runtime_state.errorCount',
            'provider_runtime_state.lastErrorTime',
            'provider_runtime_state.lastErrorMessage',
            'provider_runtime_state.lastHealthCheckTime',
            'provider_runtime_state.lastHealthCheckModel',
            'provider_runtime_state.refreshCount',
            'provider_runtime_state.lastSelectionSeq_when_persist_enabled'
        ],
        memoryOnlyAlwaysLost: [
            'provider_runtime_state.needsRefresh',
            'provider_runtime_state.activeCount',
            'provider_runtime_state.waitingCount',
            'provider_runtime_state.selectionLocks',
            'provider_runtime_state.refreshQueues',
            'provider_runtime_state.refreshBufferQueues',
            'provider_runtime_state.refreshBufferTimers',
            'provider_runtime_state.globalRefreshWaiters'
        ],
        recoveryRules: {
            usageRefreshTasks: 'running_tasks_mark_failed_on_restart',
            compatExport: 'exports_only_include_durable_database_state',
            rollbackAndReimport: 'migration_artifacts_and_legacy_import_flow_remain_supported'
        }
    };
}

export function buildRuntimeStorageFeatureFlagFallback(config = {}, options = {}) {
    return null;
}

function applyFeatureFlagFallback(state, options = {}) {
    return null;
}

function buildRuntimeStorageInfo(state) {
    const activeInfo = state?.activeStorage && typeof state.activeStorage.getInfo === 'function'
        ? state.activeStorage.getInfo()
        : {};
    const activeBackend = activeInfo.backend || state?.diagnostics?.activeBackend || 'unavailable';

    return {
        ...activeInfo,
        backend: activeBackend,
        requestedBackend: state?.diagnostics?.requestedBackend || getRequestedBackend(state?.config || {}),
        activeBackend,
        authoritativeSource: state?.diagnostics?.authoritativeSource || getAuthoritativeSource(activeBackend),
        dualWriteEnabled: false,
        fallbackEnabled: false,
        featureFlagRollback: null,
        crashRecovery: state?.diagnostics?.crashRecovery || buildRuntimeStorageCrashRecoveryDiagnostics(),
        lastCompatLoad: state?.diagnostics?.lastCompatLoad || null,
        lastMutation: state?.diagnostics?.lastMutation || null,
        lastFlush: state?.diagnostics?.lastFlush || null,
        lastExport: state?.diagnostics?.lastExport || null,
        lastValidation: state?.diagnostics?.lastValidation || null,
        lastFallback: state?.diagnostics?.lastFallback || null,
        lastError: state?.diagnostics?.lastError || null
    };
}

function syncRuntimeStorageInfo(state) {
    if (!state?.config || typeof state.config !== 'object') {
        return;
    }

    state.config.RUNTIME_STORAGE_INFO = buildRuntimeStorageInfo(state);
}

function updateActiveStorageState(state) {
    const activeBackend = getStorageBackend(state?.activeStorage);
    state.diagnostics.activeBackend = activeBackend;
    state.diagnostics.authoritativeSource = getAuthoritativeSource(activeBackend);
    state.diagnostics.dualWriteEnabled = false;
    syncRuntimeStorageInfo(state);
}

function recordOperationSuccess(state, operation, result, storage, extra = {}) {
    const meta = OPERATION_META[operation] || {};
    const backend = getStorageBackend(storage);
    const payload = createDiagnosticEntry('success', {
        operation,
        phase: meta.phase || null,
        domain: meta.domain || null,
        backend,
        authoritativeSource: getAuthoritativeSource(backend),
        ...summarizeResult(operation, result),
        ...extra
    });

    if (meta.trackKey) {
        state.diagnostics[meta.trackKey] = payload;
    }

    updateActiveStorageState(state);
}

function recordOperationFailure(state, operation, error, storage) {
    const meta = OPERATION_META[operation] || {};
    const backend = getStorageBackend(storage);
    const serializedError = serializeRuntimeStorageError(error);
    const payload = createDiagnosticEntry('failed', {
        operation,
        phase: meta.phase || error?.phase || null,
        domain: meta.domain || error?.domain || null,
        backend,
        authoritativeSource: getAuthoritativeSource(backend),
        error: serializedError
    });

    if (meta.trackKey) {
        state.diagnostics[meta.trackKey] = payload;
    }
    state.diagnostics.lastError = payload;
    updateActiveStorageState(state);
}

function shouldActivateFileFallback(state, error) {
    return false;
}

function resolveStorageErrorClassification(error, storage) {
    const classification = getRuntimeStorageErrorClassification(error);
    const backend = getStorageBackend(storage);

    if (classification === 'operation_failed' && backend !== 'file') {
        return 'backend_unavailable';
    }

    return classification;
}

function resolveStorageErrorCode(error, classification, fallbackCode) {
    if (typeof error?.code === 'string' && error.code) {
        return error.code;
    }

    return classification === 'operation_failed' ? fallbackCode : undefined;
}

async function activateFileFallback(state, error, operation) {
    return false;
}

async function executeStorageOperation(state, operation, args = []) {
    const meta = OPERATION_META[operation] || {};
    const storage = state.activeStorage;
    const method = storage?.[operation];

    if (typeof method !== 'function') {
        return undefined;
    }

    try {
        const result = await method.apply(storage, args);
        recordOperationSuccess(state, operation, result, storage);
        return result;
    } catch (error) {
        const classification = resolveStorageErrorClassification(error, storage);
        const wrappedError = wrapRuntimeStorageError(error, {
            classification,
            code: resolveStorageErrorCode(error, classification, 'runtime_storage_operation_failed'),
            phase: meta.phase || error?.phase || 'runtime_storage',
            domain: meta.domain || error?.domain || 'runtime_storage',
            backend: getStorageBackend(storage),
            operation
        });

        recordOperationFailure(state, operation, wrappedError, storage);

        throw wrappedError;
    }
}

async function initializeManagedStorage(state) {
    try {
        await state.activeStorage.initialize();
        updateActiveStorageState(state);
        return state.activeStorage;
    } catch (error) {
        const classification = resolveStorageErrorClassification(error, state.activeStorage);
        const wrappedError = wrapRuntimeStorageError(error, {
            classification,
            code: resolveStorageErrorCode(error, classification, 'runtime_storage_initialize_failed'),
            phase: 'initialize',
            domain: 'runtime_storage',
            backend: getStorageBackend(state.activeStorage),
            operation: 'initialize'
        });
        recordOperationFailure(state, 'initialize', wrappedError, state.activeStorage);
        throw wrappedError;
    }
}

async function closeManagedStorage(state) {
    const storages = new Set([state?.preferredStorage, state?.activeStorage].filter(Boolean));
    const errors = [];

    for (const storage of storages) {
        if (typeof storage.close !== 'function') {
            continue;
        }

        try {
            await storage.close();
        } catch (error) {
            errors.push(error);
        }
    }

    if (errors.length > 0) {
        throw wrapRuntimeStorageError(errors[0], {
            code: 'runtime_storage_close_failed',
            phase: 'close',
            domain: 'runtime_storage',
            backend: getStorageBackend(state?.activeStorage),
            operation: 'close'
        });
    }
}

function createManagedRuntimeStorage(preferredStorage, config = {}) {
    const state = {
        config,
        preferredStorage,
        activeStorage: preferredStorage,
        diagnostics: {
            requestedBackend: getRequestedBackend(config),
            activeBackend: getStorageBackend(preferredStorage),
            authoritativeSource: getAuthoritativeSource(getStorageBackend(preferredStorage)),
            dualWriteEnabled: false,
            fallbackEnabled: false,
            featureFlagRollback: null
        }
    };

    const managedStorage = new Proxy({}, {
        get(_target, property) {
            if (property === 'getInfo') {
                return () => buildRuntimeStorageInfo(state);
            }

            if (property === 'initialize') {
                return async () => {
                    await initializeManagedStorage(state);
                    return managedStorage;
                };
            }

            if (property === 'close') {
                return async () => {
                    await closeManagedStorage(state);
                };
            }

            if (property === '__getManagedState') {
                return () => state;
            }

            if (property === '__applyFallback') {
                return async () => false;
            }

            const value = state.activeStorage?.[property];
            if (typeof value === 'function') {
                return async (...args) => {
                    return await executeStorageOperation(state, property, args);
                };
            }

            return value;
        }
    });

    updateActiveStorageState(state);

    return {
        managedStorage,
        state
    };
}

async function resolveRuntimeStorage(config = {}) {
    if (runtimeStorage) {
        return runtimeStorage;
    }

    if (!config || Object.keys(config).length === 0) {
        return null;
    }

    return await initializeRuntimeStorage(config);
}

export async function initializeRuntimeStorage(config = {}) {
    if (runtimeStorage) {
        await closeRuntimeStorage();
    }

    const preferredStorage = createRuntimeStorage(config);
    const { managedStorage, state } = createManagedRuntimeStorage(preferredStorage, config);
    runtimeStorage = managedStorage;
    runtimeStorageState = state;
    await runtimeStorage.initialize();
    return runtimeStorage;
}

export function getRuntimeStorage() {
    return runtimeStorage;
}

export function getRuntimeStorageInfo() {
    return runtimeStorageState ? buildRuntimeStorageInfo(runtimeStorageState) : null;
}

export function recordRuntimeStorageExportStatus(summary = {}, options = {}) {
    if (!runtimeStorageState) {
        return null;
    }

    const backend = getStorageBackend(runtimeStorageState.activeStorage);
    const domains = Array.isArray(summary.domains)
        ? summary.domains
        : Object.keys(summary.exportedSummary || {}).filter((key) => summary.exportedSummary[key] !== undefined);
    const payload = createDiagnosticEntry(summary.status || 'success', {
        operation: options.operation || 'exportLegacyRuntimeStorage',
        phase: 'export',
        domain: 'runtime_storage',
        backend,
        authoritativeSource: getAuthoritativeSource(backend),
        domains,
        exportedSummary: summary.exportedSummary || null,
        outputDir: summary.outputDir || options.outputDir || null
    });

    runtimeStorageState.diagnostics.lastExport = payload;
    updateActiveStorageState(runtimeStorageState);
    return payload;
}

export async function recordRuntimeStorageValidationStatus(report = {}, options = {}) {
    if (!runtimeStorageState) {
        return null;
    }

    const backend = getStorageBackend(runtimeStorageState.activeStorage);
    const status = options.status || report.overallStatus || (options.error ? 'fail' : 'unknown');
    const payload = createDiagnosticEntry(status, {
        operation: options.operation || 'verifyRuntimeStorageMigration',
        phase: 'validation',
        domain: 'compatibility',
        backend,
        authoritativeSource: getAuthoritativeSource(backend),
        runId: report.runId || options.runId || null,
        overallStatus: report.overallStatus || status,
        validationStatus: report.validationStatus || status,
        sourceSummary: report.sourceSummary || null,
        databaseSummary: report.databaseSummary || null,
        cutoverGate: report.cutoverGate || null,
        acceptanceSummary: report.acceptanceSummary || null,
        crashRecovery: report.crashRecovery || buildRuntimeStorageCrashRecoveryDiagnostics(),
        featureFlagRollback: null
    });

    runtimeStorageState.diagnostics.crashRecovery = payload.crashRecovery;
    runtimeStorageState.diagnostics.lastValidation = payload;
    updateActiveStorageState(runtimeStorageState);

    return runtimeStorageState.diagnostics.lastValidation;
}

export async function loadProviderPoolsCompatSnapshot(config = {}, options = {}) {
    const storage = await resolveRuntimeStorage(config);
    if (!storage) {
        return {};
    }

    if (typeof storage.loadProviderPoolsSnapshot === 'function') {
        return await storage.loadProviderPoolsSnapshot(options);
    }

    if (typeof storage.exportProviderPoolsSnapshot === 'function') {
        return await storage.exportProviderPoolsSnapshot(options);
    }

    return {};
}

export async function exportProviderPoolsCompatSnapshot(config = {}, options = {}) {
    const storage = await resolveRuntimeStorage(config);
    if (!storage) {
        return {};
    }

    if (typeof storage.exportProviderPoolsSnapshot === 'function') {
        return await storage.exportProviderPoolsSnapshot(options);
    }

    return await loadProviderPoolsCompatSnapshot(config, options);
}

export async function replaceProviderPoolsCompatSnapshot(config = {}, providerPools = {}, options = {}) {
    const storage = await resolveRuntimeStorage(config);
    if (!storage || typeof storage.replaceProviderPoolsSnapshot !== 'function') {
        return providerPools;
    }

    await storage.replaceProviderPoolsSnapshot(providerPools, options);
    return await exportProviderPoolsCompatSnapshot(config, options);
}

export async function linkCredentialFilesWithRuntimeStorage(config = {}, credPaths = [], options = {}) {
    const storage = await resolveRuntimeStorage(config);
    if (!storage || typeof storage.linkCredentialFiles !== 'function') {
        return {
            providerPools: await exportProviderPoolsCompatSnapshot(config, options),
            totalNewProviders: 0,
            allNewProviders: {}
        };
    }

    return await storage.linkCredentialFiles(credPaths, options);
}

export async function listCredentialAssetsWithRuntimeStorage(config = {}, providerType = null, options = {}) {
    const storage = await resolveRuntimeStorage(config);
    if (!storage || typeof storage.listCredentialAssets !== 'function') {
        return [];
    }

    return await storage.listCredentialAssets(providerType, options);
}

export async function closeRuntimeStorage() {
    if (!runtimeStorage) {
        return;
    }

    try {
        await runtimeStorage.close();
    } finally {
        runtimeStorage = null;
        runtimeStorageState = null;
    }
}
