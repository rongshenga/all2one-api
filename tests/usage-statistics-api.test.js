import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};

const mockGetRequestBody = jest.fn(async () => ({}));

const mockRuntimeStorage = {
    queryUsageStatisticsOverview: jest.fn(async () => ({
        totalRequests: 10,
        totalTokens: 1000,
        totalCost: 1.23
    })),
    queryUsageStatisticsTrends: jest.fn(async () => ({ points: [] })),
    queryUsageStatisticsHeatmap: jest.fn(async () => ({ cells: [] })),
    queryUsageStatisticsDimensions: jest.fn(async () => ({ items: [] })),
    queryUsageStatisticsEvents: jest.fn(async () => ({
        totalCount: 1,
        page: 1,
        totalPages: 1,
        items: [
            {
                occurredAt: '2026-03-11T00:00:00.000Z',
                requestStatus: 'success',
                toProvider: 'openai-codex-oauth',
                providerUuid: 'codex-1',
                model: 'gpt-4o-mini',
                endpointType: 'openai_chat',
                isStream: false,
                totalTokens: 100,
                promptTokens: 60,
                completionTokens: 40,
                estimatedCost: 0.1,
                currency: 'USD',
                latencyMs: 800,
                statusCode: 200,
                errorCode: null,
                errorMessage: null,
                authType: 'potluck_api_key',
                authSubjectMask: 'maki_***',
                requestPath: '/openai/v1/chat/completions'
            }
        ]
    })),
    listUsageStatisticsModelPrices: jest.fn(async () => ([
        {
            model: 'gpt-4o-mini',
            currency: 'USD',
            promptPricePer1k: 0.15,
            completionPricePer1k: 0.6
        }
    ])),
    upsertUsageStatisticsModelPrices: jest.fn(async () => ({
        updatedCount: 1,
        prices: [
            {
                model: 'gpt-4o-mini',
                currency: 'USD',
                promptPricePer1k: 0.15,
                completionPricePer1k: 0.6
            }
        ]
    }))
};

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

describe('usage statistics api module', () => {
    let usageStatisticsApi;

    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            getRuntimeStorage: () => mockRuntimeStorage
        }));

        jest.doMock('../src/utils/common.js', () => ({
            getRequestBody: mockGetRequestBody
        }));

        usageStatisticsApi = await import('../src/ui-modules/usage-statistics-api.js');
    });

    beforeEach(() => {
        mockGetRequestBody.mockReset();
        mockLogger.error.mockClear();
        Object.values(mockRuntimeStorage).forEach((value) => {
            if (typeof value?.mockClear === 'function') {
                value.mockClear();
            }
        });
    });

    test('should return overview payload', async () => {
        const req = {
            url: '/api/usage-statistics/overview?from=2026-03-10T00:00:00.000Z&to=2026-03-11T00:00:00.000Z',
            headers: {
                host: '127.0.0.1:3000'
            }
        };
        const res = createMockRes();

        const handled = await usageStatisticsApi.handleGetUsageStatisticsOverview(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
            data: expect.objectContaining({
                totalRequests: 10,
                totalTokens: 1000,
                totalCost: 1.23
            })
        });
    });

    test('should validate empty price payload', async () => {
        mockGetRequestBody.mockResolvedValueOnce({ prices: [] });
        const req = {
            url: '/api/usage-statistics/prices',
            headers: {
                host: '127.0.0.1:3000'
            }
        };
        const res = createMockRes();

        const handled = await usageStatisticsApi.handlePutUsageStatisticsPrices(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toEqual({
            error: {
                message: 'Prices payload is required'
            }
        });
    });

    test('should export csv content', async () => {
        const req = {
            url: '/api/usage-statistics/export?format=csv',
            headers: {
                host: '127.0.0.1:3000'
            }
        };
        const res = createMockRes();

        const handled = await usageStatisticsApi.handleExportUsageStatistics(req, res);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toContain('text/csv');
        expect(res.body).toContain('occurredAt,requestStatus,toProvider');
    });
});
