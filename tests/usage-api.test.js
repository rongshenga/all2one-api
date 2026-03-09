import { jest } from '@jest/globals';

jest.setTimeout(120000);

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const serviceInstances = {};
const adapterCallOrder = [];
const providerUsageHandlers = new Map();
const mockBroadcastEvent = jest.fn();

const mockGetServiceAdapter = jest.fn((config) => {
    const providerKey = config.uuid ? `${config.MODEL_PROVIDER}${config.uuid}` : config.MODEL_PROVIDER;
    if (!serviceInstances[providerKey]) {
        serviceInstances[providerKey] = {
            async getUsageLimits() {
                adapterCallOrder.push({
                    providerType: config.MODEL_PROVIDER,
                    uuid: config.uuid || null
                });
                const handler = providerUsageHandlers.get(config.MODEL_PROVIDER);
                if (typeof handler === 'function') {
                    return handler(config);
                }
                return {
                    usageBreakdown: []
                };
            }
        };
    }
    return serviceInstances[providerKey];
});

const mockReadUsageCache = jest.fn();
const mockReadUsageCacheSummary = jest.fn();
const mockWriteUsageCache = jest.fn();
const mockReadProviderUsageCache = jest.fn();
const mockUpdateProviderUsageCache = jest.fn();

const passthrough = (value) => value;

let handleGetProviderUsage;
let handleGetUsageRefreshTask;
let handleGetUsage;

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProviderPool(prefix, count) {
    return Array.from({ length: count }, (_, index) => ({
        uuid: `${prefix}-${index}`,
        customName: `${prefix.toUpperCase()}-${index}`
    }));
}

describe('Usage API Refresh Cache Strategy', () => {
    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/core/config-manager.js', () => ({
            CONFIG: {}
        }));

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/providers/adapter.js', () => ({
            serviceInstances,
            getServiceAdapter: mockGetServiceAdapter
        }));

        jest.doMock('../src/services/usage-service.js', () => ({
            formatKiroUsage: passthrough,
            formatGeminiUsage: passthrough,
            formatAntigravityUsage: passthrough,
            formatCodexUsage: passthrough,
            formatGrokUsage: passthrough
        }));

        jest.doMock('../src/ui-modules/usage-cache.js', () => ({
            readUsageCache: mockReadUsageCache,
            readUsageCacheSummary: mockReadUsageCacheSummary,
            writeUsageCache: mockWriteUsageCache,
            readProviderUsageCache: mockReadProviderUsageCache,
            updateProviderUsageCache: mockUpdateProviderUsageCache
        }));

        jest.doMock('../src/ui-modules/event-broadcast.js', () => ({
            broadcastEvent: mockBroadcastEvent
        }));

        const usageApiModule = await import('../src/ui-modules/usage-api.js');
        handleGetProviderUsage = usageApiModule.handleGetProviderUsage;
        handleGetUsageRefreshTask = usageApiModule.handleGetUsageRefreshTask;
        handleGetUsage = usageApiModule.handleGetUsage;
    });

    beforeEach(() => {
        mockReadUsageCache.mockReset();
        mockReadUsageCacheSummary.mockReset();
        mockReadUsageCacheSummary.mockImplementation((...args) => mockReadUsageCache(...args));
        mockWriteUsageCache.mockReset();
        mockReadProviderUsageCache.mockReset();
        mockUpdateProviderUsageCache.mockReset();
        mockGetServiceAdapter.mockClear();
        mockBroadcastEvent.mockReset();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        adapterCallOrder.length = 0;
        providerUsageHandlers.clear();

        for (const key of Object.keys(serviceInstances)) {
            delete serviceInstances[key];
        }
    });

    test('should persist provider snapshots incrementally during large async refresh', async () => {
        const providerType = 'gemini-cli-oauth';
        const totalProviders = 2500;
        const providers = buildProviderPool('gemini', totalProviders);

        mockReadUsageCache.mockResolvedValue(null);
        mockReadProviderUsageCache.mockResolvedValue(null);
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&async=true&concurrency=64&groupSize=100&groupMinPoolSize=2000`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();

        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 64,
            POOL_GROUP_SIZE: 100,
            POOL_GROUP_MIN_POOL_SIZE: 2000
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);

        const startPayload = JSON.parse(res.body);
        const deadline = Date.now() + 60000;
        let latestTaskStatus = null;

        while (Date.now() < deadline) {
            const taskRes = createMockRes();
            const ok = await handleGetUsageRefreshTask({}, taskRes, startPayload.taskId);
            expect(ok).toBe(true);
            expect(taskRes.statusCode).toBe(200);

            latestTaskStatus = JSON.parse(taskRes.body);
            if (latestTaskStatus.status !== 'running') {
                break;
            }

            await sleep(5);
        }

        expect(latestTaskStatus).toBeTruthy();
        expect(latestTaskStatus.status).toBe('completed');
        expect(latestTaskStatus.progress.totalInstances).toBe(totalProviders);
        expect(latestTaskStatus.progress.processedInstances).toBe(totalProviders);
        expect(latestTaskStatus.result.totalCount).toBe(totalProviders);
        expect(latestTaskStatus.result.successCount).toBe(totalProviders);
        expect(latestTaskStatus.result.errorCount).toBe(0);

        expect(mockUpdateProviderUsageCache.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(mockUpdateProviderUsageCache.mock.calls[0][0]).toBe(providerType);
        expect(mockUpdateProviderUsageCache.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                totalCount: totalProviders,
                processedCount: 1000
            })
        );
        expect(mockUpdateProviderUsageCache.mock.calls[0][1].instances).toHaveLength(1000);

        const lastCall = mockUpdateProviderUsageCache.mock.calls.at(-1);
        expect(lastCall[0]).toBe(providerType);
        expect(lastCall[1]).toEqual(
            expect.objectContaining({
                totalCount: totalProviders,
                successCount: totalProviders,
                errorCount: 0,
                processedCount: totalProviders
            })
        );
        expect(lastCall[1].instances).toHaveLength(totalProviders);
    });

    test('should refresh uncached and oldest instances first on provider refresh', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = [
            { uuid: 'alpha', customName: 'Alpha' },
            { uuid: 'beta', customName: 'Beta' },
            { uuid: 'gamma', customName: 'Gamma' }
        ];

        mockReadUsageCache.mockResolvedValue(null);
        mockReadProviderUsageCache.mockResolvedValue({
            providerType,
            timestamp: '2026-03-06T03:00:00.000Z',
            totalCount: 3,
            successCount: 2,
            errorCount: 0,
            processedCount: 2,
            instances: [
                {
                    uuid: 'beta',
                    name: 'Beta',
                    success: true,
                    usage: { usageBreakdown: [] },
                    lastRefreshedAt: '2026-03-06T02:59:00.000Z'
                },
                {
                    uuid: 'gamma',
                    name: 'Gamma',
                    success: true,
                    usage: { usageBreakdown: [] },
                    lastRefreshedAt: '2026-02-01T00:00:00.000Z'
                }
            ]
        });
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&concurrency=1`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 1
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const responsePayload = JSON.parse(res.body);
        expect(responsePayload.totalCount).toBe(3);
        expect(adapterCallOrder.map(item => item.uuid)).toEqual(['alpha', 'gamma', 'beta']);
        expect(mockUpdateProviderUsageCache).toHaveBeenCalledTimes(2);
    });

    test('should prioritize uncached provider types first in full async refresh', async () => {
        const geminiProviders = [{ uuid: 'gemini-1', customName: 'Gemini-1' }];
        const grokProviders = [{ uuid: 'grok-1', customName: 'Grok-1' }];

        mockReadUsageCache.mockResolvedValue({
            timestamp: '2026-03-06T03:00:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T02:59:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: [
                        {
                            uuid: 'grok-1',
                            name: 'Grok-1',
                            success: true,
                            usage: { usageBreakdown: [] },
                            lastRefreshedAt: '2026-03-06T02:59:00.000Z'
                        }
                    ]
                }
            }
        });
        mockReadProviderUsageCache.mockResolvedValue(null);
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);
        mockWriteUsageCache.mockResolvedValue(undefined);

        const req = {
            url: '/api/usage?refresh=true&async=true&concurrency=1',
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                'gemini-cli-oauth': geminiProviders,
                'grok-custom': grokProviders
            },
            USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 1
        };
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': geminiProviders,
                'grok-custom': grokProviders
            }
        };

        const handled = await handleGetUsage(req, res, currentConfig, providerPoolManager);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);

        const startPayload = JSON.parse(res.body);
        const deadline = Date.now() + 30000;
        let latestTaskStatus = null;

        while (Date.now() < deadline) {
            const taskRes = createMockRes();
            const ok = await handleGetUsageRefreshTask({}, taskRes, startPayload.taskId);
            expect(ok).toBe(true);
            expect(taskRes.statusCode).toBe(200);

            latestTaskStatus = JSON.parse(taskRes.body);
            if (latestTaskStatus.status !== 'running') {
                break;
            }

            await sleep(5);
        }

        expect(latestTaskStatus).toBeTruthy();
        expect(latestTaskStatus.status).toBe('completed');
        expect(adapterCallOrder.map(item => item.providerType)).toEqual([
            'gemini-cli-oauth',
            'grok-custom'
        ]);
    });

    test('should complete provider async refresh even when provider usage cache read stalls', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = buildProviderPool('gemini', 2);

        mockReadUsageCache.mockResolvedValue(null);
        mockReadProviderUsageCache.mockImplementation(() => new Promise(() => {}));
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&async=true`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            PROVIDER_USAGE_CACHE_READ_TIMEOUT_MS: 10
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);

        const startPayload = JSON.parse(res.body);
        const deadline = Date.now() + 3000;
        let latestTaskStatus = null;

        while (Date.now() < deadline) {
            const taskRes = createMockRes();
            const ok = await handleGetUsageRefreshTask({}, taskRes, startPayload.taskId);
            expect(ok).toBe(true);
            expect(taskRes.statusCode).toBe(200);

            latestTaskStatus = JSON.parse(taskRes.body);
            if (latestTaskStatus.status !== 'running') {
                break;
            }

            await sleep(5);
        }

        expect(latestTaskStatus).toBeTruthy();
        expect(latestTaskStatus.status).toBe('completed');
        expect(mockReadProviderUsageCache).not.toHaveBeenCalled();
        expect(mockUpdateProviderUsageCache).toHaveBeenCalled();
    });

    test('should bootstrap usage refresh asynchronously when cache is missing for a large provider pool', async () => {
        const providers = buildProviderPool('codex', 600);
        mockReadUsageCache.mockResolvedValue(null);
        mockWriteUsageCache.mockResolvedValue(undefined);

        const req = {
            url: '/api/usage',
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                'openai-codex-oauth': providers
            },
            USAGE_SYNC_QUERY_MAX_PROVIDER_COUNT: 500,
            USAGE_CACHE_READ_TIMEOUT_MS: 1234
        };
        const providerPoolManager = {
            providerPools: {
                'openai-codex-oauth': providers
            }
        };

        const handled = await handleGetUsage(req, res, currentConfig, providerPoolManager);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);
        expect(mockReadUsageCache).toHaveBeenCalledWith(expect.objectContaining({
            runtimeReadTimeoutMs: 1234,
            debugLabel: 'GET /api/usage'
        }));

        const payload = JSON.parse(res.body);
        expect(payload).toEqual(expect.objectContaining({
            taskId: expect.any(String),
            type: 'all'
        }));
    });

	test('should clamp oversized group size and ignore non-positive query overrides', async () => {
	    const providerType = 'gemini-cli-oauth';
    const providers = buildProviderPool('gemini', 600);
    mockReadUsageCache.mockResolvedValue(null);
    mockReadProviderUsageCache.mockResolvedValue(null);
    mockUpdateProviderUsageCache.mockResolvedValue(undefined);

    const currentConfig = {
        providerPools: {
            [providerType]: providers
        },
        USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 4,
        USAGE_QUERY_GROUP_SIZE: 100,
        USAGE_QUERY_GROUP_MIN_POOL_SIZE: 2000
    };
    const providerPoolManager = {
        providerPools: {
            [providerType]: providers
        }
    };

    const oversizedReq = {
        url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&async=true&concurrency=0&groupSize=999999&groupMinPoolSize=1`,
        headers: {
            host: 'localhost:3000'
        }
    };
    const oversizedRes = createMockRes();
    const oversizedHandled = await handleGetProviderUsage(oversizedReq, oversizedRes, currentConfig, providerPoolManager, providerType);
    expect(oversizedHandled).toBe(true);
    expect(oversizedRes.statusCode).toBe(202);

    const oversizedPayload = JSON.parse(oversizedRes.body);
    const oversizedDeadline = Date.now() + 30000;
    let oversizedStatus = null;
    while (Date.now() < oversizedDeadline) {
        const taskRes = createMockRes();
        const ok = await handleGetUsageRefreshTask({}, taskRes, oversizedPayload.taskId);
        expect(ok).toBe(true);
        oversizedStatus = JSON.parse(taskRes.body);
        if (oversizedStatus.status !== 'running') {
            break;
        }
        await sleep(5);
    }

    expect(oversizedStatus).toBeTruthy();
    expect(oversizedStatus.status).toBe('completed');
    expect(oversizedStatus.progress.totalInstances).toBe(600);
    expect(oversizedStatus.progress.totalGroups).toBe(2);

    const invalidBoundaryReq = {
        url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&async=true&groupSize=0&groupMinPoolSize=-1`,
        headers: {
            host: 'localhost:3000'
        }
    };
    const invalidBoundaryRes = createMockRes();
    const invalidHandled = await handleGetProviderUsage(invalidBoundaryReq, invalidBoundaryRes, currentConfig, providerPoolManager, providerType);
    expect(invalidHandled).toBe(true);
    expect(invalidBoundaryRes.statusCode).toBe(202);

    const invalidPayload = JSON.parse(invalidBoundaryRes.body);
    const invalidDeadline = Date.now() + 30000;
    let invalidStatus = null;
    while (Date.now() < invalidDeadline) {
        const taskRes = createMockRes();
        const ok = await handleGetUsageRefreshTask({}, taskRes, invalidPayload.taskId);
        expect(ok).toBe(true);
        invalidStatus = JSON.parse(taskRes.body);
        if (invalidStatus.status !== 'running') {
            break;
        }
        await sleep(5);
    }

    expect(invalidStatus).toBeTruthy();
    expect(invalidStatus.status).toBe('completed');
    expect(invalidStatus.progress.totalGroups).toBe(1);
});

    test('should pass timeout signal to adapter usage requests and abort timed out instance queries', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = [
            { uuid: 'gemini-1', customName: 'Gemini-1' }
        ];

        mockReadUsageCache.mockResolvedValue(null);
        mockReadProviderUsageCache.mockResolvedValue(null);
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);

        const seenOptions = [];
        serviceInstances[`${providerType}gemini-1`] = {
            getUsageLimits: jest.fn(async (options = {}) => {
                seenOptions.push(options);
                return await new Promise(() => {});
            })
        };

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            PROVIDER_USAGE_INSTANCE_TIMEOUT_MS: 10
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const payload = JSON.parse(res.body);
        expect(payload.errorCount).toBe(1);
        expect(serviceInstances[`${providerType}gemini-1`].getUsageLimits).toHaveBeenCalledTimes(1);
        expect(seenOptions).toHaveLength(1);
        expect(seenOptions[0]).toEqual(expect.objectContaining({
            timeoutMs: 10,
            signal: expect.any(Object)
        }));
        expect(seenOptions[0].signal.aborted).toBe(true);
    });

    test('should paginate cached provider usage detail responses', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = buildProviderPool('gemini', 3);

        mockReadProviderUsageCache.mockResolvedValue({
            providerType,
            totalCount: 3,
            successCount: 3,
            errorCount: 0,
            processedCount: 3,
            timestamp: '2026-03-06T10:00:00.000Z',
            instances: [
                { uuid: 'gemini-0', name: 'Gemini-0', success: true, usage: { usageBreakdown: [] } },
                { uuid: 'gemini-1', name: 'Gemini-1', success: true, usage: { usageBreakdown: [] } },
                { uuid: 'gemini-2', name: 'Gemini-2', success: true, usage: { usageBreakdown: [] } }
            ]
        });

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?page=2&limit=1`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                [providerType]: providers
            }
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const payload = JSON.parse(res.body);
        expect(mockReadProviderUsageCache).toHaveBeenCalledWith(providerType, expect.objectContaining({
            page: 2,
            limit: 1
        }));
        expect(payload.page).toBe(2);
        expect(payload.limit).toBe(1);
        expect(payload.totalPages).toBe(3);
        expect(payload.availableCount).toBe(3);
        expect(payload.instances).toHaveLength(1);
        expect(payload.instances[0].uuid).toBe('gemini-1');
    });

    test('should switch large uncached provider detail requests to async task', async () => {
        const providerType = 'openai-codex-oauth';
        const providers = buildProviderPool('codex', 600);

        mockReadProviderUsageCache.mockResolvedValue(null);

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?page=1&limit=100`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 64
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(202);

        const payload = JSON.parse(res.body);
        expect(payload.providerType).toBe(providerType);
        expect(payload.taskId).toBeTruthy();
    });

    test('should cap gemini cli usage refresh concurrency to provider-specific limit', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = buildProviderPool('gemini', 5);

        mockReadUsageCache.mockResolvedValue(null);
        mockReadProviderUsageCache.mockResolvedValue(null);
        mockUpdateProviderUsageCache.mockResolvedValue(undefined);

        let activeRequests = 0;
        let maxConcurrentRequests = 0;
        for (const provider of providers) {
            serviceInstances[`${providerType}${provider.uuid}`] = {
                getUsageLimits: jest.fn(async () => {
                    activeRequests += 1;
                    maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
                    await sleep(15);
                    activeRequests -= 1;
                    return {
                        usageBreakdown: []
                    };
                })
            };
        }

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&concurrency=8`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const currentConfig = {
            providerPools: {
                [providerType]: providers
            },
            USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 8,
            GEMINI_CLI_USAGE_QUERY_CONCURRENCY_PER_PROVIDER: 2
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const payload = JSON.parse(res.body);
        expect(payload.totalCount).toBe(5);
        expect(payload.successCount).toBe(5);
        expect(maxConcurrentRequests).toBeLessThanOrEqual(2);
    });
});
