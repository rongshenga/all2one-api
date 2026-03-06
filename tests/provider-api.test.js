import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

let handleGetProvidersSummary;
let handleGetProviderType;

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

describe('Provider API Summary', () => {
    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/providers/adapter.js', () => ({
            getRegisteredProviders: jest.fn(() => [])
        }));

        const providerApiModule = await import('../src/ui-modules/provider-api.js');
        handleGetProvidersSummary = providerApiModule.handleGetProvidersSummary;
        handleGetProviderType = providerApiModule.handleGetProviderType;
    });

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should return compact provider summaries for list page', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = {};
        const providerPoolManager = {
            providerPools: {
                'openai-codex-oauth': [
                    { uuid: 'codex-1', isHealthy: true, isDisabled: false, usageCount: 10, errorCount: 1 },
                    { uuid: 'codex-2', isHealthy: true, isDisabled: true, usageCount: 5, errorCount: 2 }
                ],
                'grok-custom': [
                    { uuid: 'grok-1', isHealthy: false, isDisabled: false, usageCount: 3, errorCount: 4 }
                ]
            }
        };

        const handled = await handleGetProvidersSummary(req, res, currentConfig, providerPoolManager);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const payload = JSON.parse(res.body);
        expect(payload).toEqual({
            'openai-codex-oauth': {
                totalCount: 2,
                healthyCount: 1,
                usageCount: 15,
                errorCount: 3
            },
            'grok-custom': {
                totalCount: 1,
                healthyCount: 0,
                usageCount: 3,
                errorCount: 4
            }
        });
    });

    test('should return provider details with aligned summary stats', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = {};
        const providers = [
            { uuid: 'gemini-1', isHealthy: true, isDisabled: false, usageCount: 8, errorCount: 0 },
            { uuid: 'gemini-2', isHealthy: true, isDisabled: true, usageCount: 2, errorCount: 1 },
            { uuid: 'gemini-3', isHealthy: false, isDisabled: false, usageCount: 1, errorCount: 5 }
        ];
        const providerPoolManager = {
            providerPools: {
                'gemini-cli-oauth': providers
            }
        };

        const handled = await handleGetProviderType(req, res, currentConfig, providerPoolManager, 'gemini-cli-oauth');
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const payload = JSON.parse(res.body);
        expect(payload.providerType).toBe('gemini-cli-oauth');
        expect(payload.providers).toEqual(providers);
        expect(payload.totalCount).toBe(3);
        expect(payload.healthyCount).toBe(1);
        expect(payload.usageCount).toBe(11);
        expect(payload.errorCount).toBe(6);
    });
});
