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

    test('should reject provider async refresh entry', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = buildProviderPool('gemini', 3);

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
            }
        };
        const providerPoolManager = {
            providerPools: {
                [providerType]: providers
            }
        };

        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({
            error: expect.objectContaining({
                code: 'usage_batch_refresh_entry_disabled',
                entryType: 'provider'
            })
        });
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

    test('should reject full async refresh entry', async () => {
        const geminiProviders = [{ uuid: 'gemini-1', customName: 'Gemini-1' }];
        const grokProviders = [{ uuid: 'grok-1', customName: 'Grok-1' }];

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
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({
            error: expect.objectContaining({
                code: 'usage_batch_refresh_entry_disabled',
                entryType: 'all'
            })
        });
    });

    test('should reject usage cache miss async bootstrap when pool is large', async () => {
        const providers = buildProviderPool('codex', 600);
        mockReadUsageCache.mockResolvedValue(null);

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
        expect(res.statusCode).toBe(503);
        expect(mockReadUsageCache).toHaveBeenCalledWith(expect.objectContaining({
            runtimeReadTimeoutMs: 1234,
            debugLabel: 'GET /api/usage'
        }));
        expect(JSON.parse(res.body)).toEqual({
            error: expect.objectContaining({
                code: 'usage_batch_refresh_entry_disabled',
                entryType: 'all'
            })
        });
    });

    test('should reject provider async refresh entry with query overrides', async () => {
        const providerType = 'gemini-cli-oauth';
        const providers = buildProviderPool('gemini', 600);
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

        const req = {
            url: `/api/usage/${encodeURIComponent(providerType)}?refresh=true&async=true&concurrency=0&groupSize=999999&groupMinPoolSize=1`,
            headers: {
                host: 'localhost:3000'
            }
        };
        const res = createMockRes();
        const handled = await handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({
            error: expect.objectContaining({
                code: 'usage_batch_refresh_entry_disabled',
                entryType: 'provider'
            })
        });
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

    test('should reject large uncached provider detail async bootstrap', async () => {
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
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body)).toEqual({
            error: expect.objectContaining({
                code: 'usage_batch_refresh_entry_disabled',
                entryType: 'provider'
            })
        });
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
