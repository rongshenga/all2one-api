import { jest } from '@jest/globals';
import * as fs from 'fs';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const mockBroadcastEvent = jest.fn();
const mockGetServiceAdapter = jest.fn();

let ProviderPoolManager;

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return {
        promise,
        resolve,
        reject
    };
}

describe('ProviderPoolManager refresh recovery', () => {
    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/ui-modules/event-broadcast.js', () => ({
            broadcastEvent: mockBroadcastEvent
        }));

        jest.doMock('../src/providers/adapter.js', () => ({
            getServiceAdapter: mockGetServiceAdapter,
            getRegisteredProviders: jest.fn(() => [])
        }));

        const module = await import('../src/providers/provider-pool-manager.js');
        ProviderPoolManager = module.ProviderPoolManager;
    });

    beforeEach(() => {
        mockBroadcastEvent.mockReset();
        mockGetServiceAdapter.mockReset();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('resetProviderRefreshStatus should recover unhealthy provider state after refresh succeeds', () => {
        const providerType = 'gemini-cli-oauth';
        const provider = {
            config: {
                uuid: 'gemini-1',
                isHealthy: false,
                needsRefresh: true,
                refreshCount: 3,
                errorCount: 10,
                lastErrorTime: '2026-03-06T01:02:03.000Z',
                lastErrorMessage: 'Refresh failed: token expired',
                scheduledRecoveryTime: '2026-03-06T03:00:00.000Z',
                _lastSelectionSeq: 99
            }
        };

        const manager = Object.create(ProviderPoolManager.prototype);
        manager._findProvider = jest.fn(() => provider);
        manager._debouncedSave = jest.fn();
        manager._logHealthStatusChange = jest.fn();
        manager._log = jest.fn();
        manager._minSelectionSeqByType = {
            [providerType]: 99
        };

        manager.resetProviderRefreshStatus(providerType, 'gemini-1');

        expect(provider.config.isHealthy).toBe(true);
        expect(provider.config.needsRefresh).toBe(false);
        expect(provider.config.refreshCount).toBe(0);
        expect(provider.config.errorCount).toBe(0);
        expect(provider.config.lastErrorTime).toBeNull();
        expect(provider.config.lastErrorMessage).toBeNull();
        expect(provider.config.scheduledRecoveryTime).toBeNull();
        expect(provider.config._lastSelectionSeq).toBe(0);
        expect(typeof provider.config.lastHealthCheckTime).toBe('string');
        expect(manager._minSelectionSeqByType[providerType]).toBe(0);
        expect(manager._logHealthStatusChange).toHaveBeenCalledWith(providerType, provider.config, 'unhealthy', 'healthy', null);
        expect(manager._log).toHaveBeenCalledWith('info', `Reset refresh status and marked healthy for provider gemini-1 (${providerType})`);
        expect(manager._debouncedSave).toHaveBeenCalledWith(providerType, 'gemini-1');
    });

    test('refresh limit reason should use the configured max attempts consistently', async () => {
        const providerType = 'gemini-cli-oauth';
        const config = {
            uuid: 'gemini-2',
            refreshCount: ProviderPoolManager.MAX_REFRESH_ATTEMPTS
        };
        const providerStatus = {
            uuid: 'gemini-2',
            config
        };

        const manager = Object.create(ProviderPoolManager.prototype);
        manager._log = jest.fn();
        manager.markProviderUnhealthyImmediately = jest.fn();

        await manager._refreshNodeToken(providerType, providerStatus);

        const reason = `Maximum refresh count (${ProviderPoolManager.MAX_REFRESH_ATTEMPTS}) reached`;
        expect(manager._log).toHaveBeenCalledWith('warn', `Node gemini-2 has reached ${reason}, marking as unhealthy`);
        expect(manager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(providerType, config, reason);
        expect(mockGetServiceAdapter).not.toHaveBeenCalled();
    });

    test('markProviderNeedRefresh should keep needsRefresh in memory only', () => {
        const providerType = 'gemini-cli-oauth';
        const provider = {
            config: {
                uuid: 'gemini-3',
                needsRefresh: false
            }
        };

        const manager = Object.create(ProviderPoolManager.prototype);
        manager._findProvider = jest.fn(() => provider);
        manager._enqueueRefresh = jest.fn();
        manager._debouncedSave = jest.fn();
        manager._log = jest.fn();

        manager.markProviderNeedRefresh(providerType, { uuid: 'gemini-3' });

        expect(provider.config.needsRefresh).toBe(true);
        expect(manager._enqueueRefresh).toHaveBeenCalledWith(providerType, provider, true);
        expect(manager._debouncedSave).not.toHaveBeenCalled();
    });

    test('should batch runtime flush through RuntimeStorage without persisting selection seq by default', async () => {
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async () => ({ flushedCount: 1 })),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage,
            saveDebounceTime: 60
        });

        await manager.selectProvider('grok-custom');
        await manager._flushPendingSaves();

        expect(runtimeStorage.updateProviderRoutingUuid).not.toHaveBeenCalled();
        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledWith([
            expect.objectContaining({
                providerType: 'grok-custom',
                routingUuid: 'grok-1',
                persistSelectionState: false,
                runtimeState: expect.objectContaining({
                    usageCount: 1,
                    lastSelectionSeq: null
                })
            })
        ], expect.objectContaining({
            persistSelectionState: false,
            batchIndex: 0,
            totalBatches: 1,
            crashRecoveryBoundary: 'unflushed_window_only'
        }));
    });

    test('refreshProviderUuid should flush routing uuid update through RuntimeStorage', async () => {
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async () => ({ flushedCount: 1 })),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: true }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage,
            saveDebounceTime: 60
        });

        const newUuid = manager.refreshProviderUuid('grok-custom', { uuid: 'grok-1' });
        await manager._flushPendingSaves();

        expect(runtimeStorage.updateProviderRoutingUuid).toHaveBeenCalledWith(expect.objectContaining({
            providerType: 'grok-custom',
            oldRoutingUuid: 'grok-1',
            newRoutingUuid: newUuid
        }));
        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledWith([
            expect.objectContaining({
                providerType: 'grok-custom',
                routingUuid: newUuid
            })
        ], expect.any(Object));
    });


    test('getHotStatePolicy should distinguish memory-only and durable runtime fields', () => {
        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com'
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false,
                RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD: 8,
                RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE: 4,
                RUNTIME_STORAGE_PROVIDER_FLUSH_RETRY_DELAY_MS: 1200,
                RUNTIME_STORAGE_LARGE_POOL_THRESHOLD: 100000,
                RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE: 1000,
                RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE: 2000
            },
            runtimeStorage: {
                flushProviderRuntimeState: jest.fn(async () => ({ flushedCount: 0 })),
                updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
            },
            saveDebounceTime: 500
        });

        const policy = manager.getHotStatePolicy();
        expect(policy.memoryOnlyFields).toEqual(expect.arrayContaining([
            'needsRefresh',
            'activeCount',
            'refreshingUuids',
            'pendingSaves'
        ]));
        expect(policy.durableRuntimeFields).toEqual(expect.arrayContaining([
            'usageCount',
            'lastUsed',
            'lastErrorMessage',
            'scheduledRecoveryTime'
        ]));
        expect(policy.conditionalDurableFields).toEqual([]);
        expect(policy.flushPolicy).toMatchObject({
            debounceMs: 500,
            dirtyThreshold: 8,
            batchSize: 4,
            retryDelayMs: 1200,
            flushOnReload: true,
            flushOnShutdown: true
        });
        expect(policy.performanceTargets).toMatchObject({
            largePoolThreshold: 100000,
            compatExportPageSize: 1000,
            startupRestorePageSize: 2000
        });
        expect(policy.crashRecovery).toMatchObject({
            durableBoundary: 'only_successful_flush_batches_are_durable'
        });
        expect(policy.crashRecovery.memoryOnlyAlwaysLost).toEqual(expect.arrayContaining(['needsRefresh']));
        expect(policy.crashRecovery.mayLoseWithinWindow).toEqual(expect.arrayContaining(['usageCount', 'lastUsed']));
    });

    test('should flush immediately when dirty runtime mutations reach threshold', async () => {
        jest.useFakeTimers();

        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async () => ({ flushedCount: 2 })),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    usageCount: 0,
                    errorCount: 0
                },
                {
                    uuid: 'grok-2',
                    customName: 'Grok Two',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false,
                RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD: 2
            },
            runtimeStorage,
            saveDebounceTime: 60000
        });

        manager._debouncedSave('grok-custom', 'grok-1');
        manager._debouncedSave('grok-custom', 'grok-2');
        await jest.runOnlyPendingTimersAsync();

        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledTimes(1);
        expect(manager.lastFlushSummary).toMatchObject({
            status: 'success',
            flushReason: 'dirty_threshold',
            providerCount: 2,
            batchCount: 1,
            thresholdReached: true
        });

        jest.useRealTimers();
    });

    test('should split provider runtime flush into multiple batches for large dirty sets', async () => {
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async (records) => ({ flushedCount: records.length })),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    usageCount: 0,
                    errorCount: 0
                },
                {
                    uuid: 'grok-2',
                    customName: 'Grok Two',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    usageCount: 0,
                    errorCount: 0
                },
                {
                    uuid: 'grok-3',
                    customName: 'Grok Three',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false,
                RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE: 2
            },
            runtimeStorage,
            saveDebounceTime: 1000
        });

        manager._debouncedSave('grok-custom', 'grok-1');
        manager._debouncedSave('grok-custom', 'grok-2');
        manager._debouncedSave('grok-custom', 'grok-3');
        const result = await manager.flushRuntimeState({
            reason: 'manual_test'
        });

        expect(result).toMatchObject({
            flushedCount: 3,
            batchCount: 2,
            flushReason: 'manual_test'
        });
        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledTimes(2);
        expect(runtimeStorage.flushProviderRuntimeState.mock.calls[0][0]).toHaveLength(2);
        expect(runtimeStorage.flushProviderRuntimeState.mock.calls[0][1]).toMatchObject({
            batchIndex: 0,
            totalBatches: 2,
            batchSize: 2,
            crashRecoveryBoundary: 'unflushed_window_only'
        });
        expect(runtimeStorage.flushProviderRuntimeState.mock.calls[1][0]).toHaveLength(1);
        expect(runtimeStorage.flushProviderRuntimeState.mock.calls[1][1]).toMatchObject({
            batchIndex: 1,
            totalBatches: 2,
            batchSize: 2,
            crashRecoveryBoundary: 'unflushed_window_only'
        });
        expect(manager.lastFlushSummary).toMatchObject({
            status: 'success',
            flushReason: 'manual_test',
            providerCount: 3,
            batchCount: 2
        });
    });

    test('refreshProviderUuid should return null when provider does not exist', () => {
        const manager = Object.create(ProviderPoolManager.prototype);
        manager._findProvider = jest.fn(() => null);
        manager._log = jest.fn();
        manager._debouncedSave = jest.fn();

        const result = manager.refreshProviderUuid('grok-custom', { uuid: 'missing-uuid' });

        expect(result).toBeNull();
        expect(manager._debouncedSave).not.toHaveBeenCalled();
        expect(manager._log).toHaveBeenCalledWith('warn', 'Provider not found for UUID refresh: missing-uuid in grok-custom');
    });

    test('should requeue pending runtime flush records when RuntimeStorage flush fails', async () => {
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async () => {
                throw new Error('flush failed');
            }),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'token-1',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage,
            saveDebounceTime: 60
        });

        manager._schedulePendingFlush = jest.fn();
        manager._log = jest.fn();
        manager._debouncedSave('grok-custom', 'grok-1');
        manager._schedulePendingFlush.mockClear();

        await expect(manager._flushPendingSaves()).rejects.toThrow('flush failed');

        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledTimes(1);
        expect(manager.pendingSaves.size).toBe(1);
        expect(manager._schedulePendingFlush).toHaveBeenCalledTimes(1);
        expect(manager._log).toHaveBeenCalledWith('error', expect.stringContaining('Failed to flush runtime state:'));
    });

    test('should drop failed runtime flush retries after pending mutations are superseded', async () => {
        const deferred = createDeferred();
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async () => {
                await deferred.promise;
                throw new Error('flush failed');
            }),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'token-1',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage,
            saveDebounceTime: 60
        });

        manager._schedulePendingFlush = jest.fn();
        manager._log = jest.fn();
        manager._debouncedSave('grok-custom', 'grok-1');
        manager._schedulePendingFlush.mockClear();

        const flushPromise = manager._flushPendingSaves();
        await Promise.resolve();

        const discardResult = manager.discardPendingRuntimeMutations('provider_pools_snapshot_replace');
        expect(discardResult.droppedSaveCount).toBe(0);
        expect(discardResult.droppedRoutingCount).toBe(0);

        deferred.resolve();
        await expect(flushPromise).rejects.toThrow('flush failed');

        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledTimes(1);
        expect(manager.pendingSaves.size).toBe(0);
        expect(manager._schedulePendingFlush).not.toHaveBeenCalled();
        expect(manager._log).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('Dropped failed runtime flush retry because provider snapshot already superseded this batch')
        );
    });

    test('should return idle summary when flush queue is empty', async () => {
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async () => ({ flushedCount: 0 })),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage,
            saveDebounceTime: 1000
        });

        await expect(manager.flushRuntimeState({
            reason: 'idle_test'
        })).resolves.toMatchObject({
            flushedCount: 0,
            routingUpdateCount: 0,
            batchCount: 0,
            flushReason: 'idle_test'
        });
        expect(runtimeStorage.flushProviderRuntimeState).not.toHaveBeenCalled();
        expect(runtimeStorage.updateProviderRoutingUuid).not.toHaveBeenCalled();
    });

    test('should merge overlapping provider mutations into a follow-up flush while one flush is in flight', async () => {
        jest.useFakeTimers();

        const firstFlush = createDeferred();
        const flushedRecords = [];
        const runtimeStorage = {
            flushProviderRuntimeState: jest.fn(async (records = []) => {
                flushedRecords.push(records.map((record) => ({
                    providerId: record.providerId,
                    providerType: record.providerType,
                    routingUuid: record.routingUuid,
                    runtimeState: {
                        ...record.runtimeState
                    }
                })));

                if (flushedRecords.length === 1) {
                    await firstFlush.promise;
                }

                return {
                    flushedCount: records.length
                };
            }),
            updateProviderRoutingUuid: jest.fn(async () => ({ updated: false }))
        };

        const manager = new ProviderPoolManager({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 0,
                    errorCount: 0
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage,
            saveDebounceTime: 60000
        });

        manager._debouncedSave('grok-custom', 'grok-1');

        const firstFlushPromise = manager._flushPendingSaves({
            reason: 'concurrency_test'
        });
        const overlappingFlushPromise = manager._flushPendingSaves({
            reason: 'overlap_should_not_duplicate'
        });

        await Promise.resolve();
        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledTimes(1);

        manager.disableProvider('grok-custom', { uuid: 'grok-1' });
        expect(manager.pendingSaves.size).toBe(1);

        firstFlush.resolve();
        await Promise.all([firstFlushPromise, overlappingFlushPromise]);
        await jest.runOnlyPendingTimersAsync();

        expect(runtimeStorage.flushProviderRuntimeState).toHaveBeenCalledTimes(2);
        expect(flushedRecords[0]).toHaveLength(1);
        expect(flushedRecords[0][0]).toMatchObject({
            providerType: 'grok-custom',
            routingUuid: 'grok-1',
            runtimeState: expect.objectContaining({
                isDisabled: false
            })
        });
        expect(flushedRecords[1]).toHaveLength(1);
        expect(flushedRecords[1][0]).toMatchObject({
            providerType: 'grok-custom',
            routingUuid: 'grok-1',
            runtimeState: expect.objectContaining({
                isDisabled: true
            })
        });
        expect(manager.pendingSaves.size).toBe(0);
        expect(manager.lastFlushSummary).toMatchObject({
            status: 'success',
            flushReason: 'follow_up',
            providerCount: 1,
            batchCount: 1
        });

        jest.useRealTimers();
    });

    test('should enqueue near-expiry providers from runtime storage candidates in db_only mode', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => [])
        };
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': [
                {
                    uuid: 'gemini-db-1',
                    customName: 'Gemini DB One',
                    GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/legacy.json',
                    isHealthy: true,
                    isDisabled: false
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                AUTH_STORAGE_MODE: 'db_only'
            },
            runtimeStorage,
            saveDebounceTime: 1000
        });

        const providerEntry = manager.providerStatus['gemini-cli-oauth'][0];
        runtimeStorage.listCredentialExpiryCandidates.mockResolvedValueOnce([
            {
                provider_id: providerEntry.providerId,
                encrypted_payload: JSON.stringify({
                    expiry_date: Date.now() + 5 * 60 * 1000
                })
            }
        ]);
        manager._enqueueRefresh = jest.fn();

        await manager.checkAndRefreshExpiringNodes();
        expect(runtimeStorage.listCredentialExpiryCandidates).toHaveBeenCalledWith('gemini-cli-oauth', expect.any(Object));
        expect(manager._enqueueRefresh).toHaveBeenCalledWith('gemini-cli-oauth', providerEntry);
    });

    test('should not fallback to credential files when db_only mode has no expiry candidate', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => [])
        };
        const readSpy = jest.spyOn(fs, 'readFileSync');
        const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);

        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': [
                {
                    uuid: 'gemini-db-2',
                    customName: 'Gemini DB Two',
                    GEMINI_OAUTH_CREDS_FILE_PATH: 'configs/gemini/legacy.json',
                    isHealthy: true,
                    isDisabled: false
                }
            ]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                AUTH_STORAGE_MODE: 'db_only'
            },
            runtimeStorage,
            saveDebounceTime: 1000
        });
        manager._enqueueRefresh = jest.fn();

        await manager.checkAndRefreshExpiringNodes();
        expect(manager._enqueueRefresh).not.toHaveBeenCalled();
        expect(readSpy).not.toHaveBeenCalled();

        readSpy.mockRestore();
        existsSpy.mockRestore();
    });
});
