import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const mockBroadcastEvent = jest.fn();

let initializeRuntimeStorage;
let closeRuntimeStorage;
let readUsageCache;
let writeUsageCache;
let readProviderUsageCache;
let handleGetUsageRefreshTask;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createMockRes() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers;
        },
        end(payload = '') {
            this.body = payload;
        }
    };
}

describe('Usage runtime storage integration', () => {
    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/core/config-manager.js', () => ({
            CONFIG: {}
        }));
        jest.doMock('../src/providers/adapter.js', () => ({
            serviceInstances: {},
            getServiceAdapter: jest.fn()
        }));
        jest.doMock('../src/services/usage-service.js', () => ({
            formatKiroUsage: (value) => value,
            formatGeminiUsage: (value) => value,
            formatAntigravityUsage: (value) => value,
            formatCodexUsage: (value) => value,
            formatGrokUsage: (value) => value
        }));
        jest.doMock('../src/ui-modules/event-broadcast.js', () => ({
            broadcastEvent: mockBroadcastEvent
        }));

        ({ initializeRuntimeStorage, closeRuntimeStorage } = await import('../src/storage/runtime-storage-registry.js'));
        ({ readUsageCache, writeUsageCache, readProviderUsageCache } = await import('../src/ui-modules/usage-cache.js'));
        ({ handleGetUsageRefreshTask } = await import('../src/ui-modules/usage-api.js'));
    });

    afterEach(async () => {
        await closeRuntimeStorage();
        mockBroadcastEvent.mockReset();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should restore usage cache from sqlite-backed runtime storage after restart', async () => {
        const tempDir = await createTempDir('usage-runtime-storage-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        };

        await initializeRuntimeStorage(config);
        await writeUsageCache({
            timestamp: '2026-03-06T11:00:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T11:00:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: [
                        {
                            uuid: 'grok-1',
                            name: 'Grok One',
                            success: true,
                            usage: { usageBreakdown: [] },
                            lastRefreshedAt: '2026-03-06T11:00:00.000Z'
                        }
                    ]
                }
            }
        });

        await closeRuntimeStorage();
        await initializeRuntimeStorage(config);

        const restoredCache = await readUsageCache();
        const restoredProviderCache = await readProviderUsageCache('grok-custom');
        expect(restoredCache.providers['grok-custom']).toMatchObject({
            totalCount: 1,
            successCount: 1,
            errorCount: 0
        });
        expect(restoredProviderCache).toMatchObject({
            providerType: 'grok-custom',
            totalCount: 1,
            successCount: 1,
            errorCount: 0,
            fromCache: true
        });
    });

    test('should read paginated provider usage cache from sqlite-backed runtime storage', async () => {
        const tempDir = await createTempDir('usage-runtime-storage-page-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        };

        await initializeRuntimeStorage(config);
        await writeUsageCache({
            timestamp: '2026-03-09T11:00:00.000Z',
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    timestamp: '2026-03-09T11:00:00.000Z',
                    totalCount: 5,
                    successCount: 5,
                    errorCount: 0,
                    processedCount: 5,
                    instances: Array.from({ length: 5 }, (_, index) => ({
                        uuid: `codex-${index + 1}`,
                        name: `Codex ${index + 1}`,
                        success: true,
                        usage: { usageBreakdown: [] },
                        lastRefreshedAt: '2026-03-09T11:00:00.000Z'
                    }))
                }
            }
        });

        const pagedProviderCache = await readProviderUsageCache('openai-codex-oauth', {
            page: 2,
            limit: 2
        });

        expect(pagedProviderCache).toMatchObject({
            providerType: 'openai-codex-oauth',
            totalCount: 5,
            availableCount: 5,
            page: 2,
            limit: 2,
            totalPages: 3,
            hasPrevPage: true,
            hasNextPage: true,
            fromCache: true
        });
        expect(pagedProviderCache.instances).toHaveLength(2);
        expect(pagedProviderCache.instances.map((instance) => instance.uuid)).toEqual(['codex-3', 'codex-4']);
    });

    test('should expose persisted usage refresh task status through usage API after restart', async () => {
        const tempDir = await createTempDir('usage-task-runtime-storage-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        };

        const storage = await initializeRuntimeStorage(config);
        await storage.saveUsageRefreshTask({
            id: 'persisted-task-1',
            type: 'provider',
            providerType: 'grok-custom',
            status: 'failed',
            createdAt: '2026-03-06T11:00:00.000Z',
            startedAt: '2026-03-06T11:00:01.000Z',
            finishedAt: '2026-03-06T11:00:02.000Z',
            error: 'persisted failure',
            result: null,
            progress: {
                totalProviders: 1,
                processedProviders: 1,
                currentProvider: 'grok-custom',
                totalInstances: 3,
                processedInstances: 3,
                successCount: 2,
                errorCount: 1,
                currentGroup: 1,
                totalGroups: 1,
                percent: 100
            }
        });

        const res = createMockRes();
        const handled = await handleGetUsageRefreshTask({}, res, 'persisted-task-1');
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({
            taskId: 'persisted-task-1',
            status: 'failed',
            providerType: 'grok-custom',
            error: 'persisted failure'
        });
    });
});
