import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const mockLoadProviderPoolsCompatSnapshot = jest.fn();
const mockReplaceProviderPoolsCompatSnapshot = jest.fn();
const mockGetRuntimeStorage = jest.fn(() => null);

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

        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            getRuntimeStorage: mockGetRuntimeStorage,
            loadProviderPoolsCompatSnapshot: mockLoadProviderPoolsCompatSnapshot,
            replaceProviderPoolsCompatSnapshot: mockReplaceProviderPoolsCompatSnapshot
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
        mockLoadProviderPoolsCompatSnapshot.mockReset();
        mockLoadProviderPoolsCompatSnapshot.mockResolvedValue({});
        mockReplaceProviderPoolsCompatSnapshot.mockReset();
        mockReplaceProviderPoolsCompatSnapshot.mockImplementation(async (config, providerPools) => providerPools);
        mockGetRuntimeStorage.mockReset();
        mockGetRuntimeStorage.mockReturnValue(null);
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

    test('should read provider summaries directly from runtime storage in db mode', async () => {
        const req = {};
        const res = createMockRes();
        const currentConfig = {
            RUNTIME_STORAGE_INFO: {
                backend: 'db'
            },
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.json'
        };
        const providerPoolManager = {
            providerPools: {
                'openai-codex-oauth': [
                    { uuid: 'stale-1', isHealthy: false, isDisabled: false, usageCount: 999, errorCount: 999 }
                ]
            }
        };
        const loadPoolsSummary = jest.fn(async () => ({
            'openai-codex-oauth': {
                totalCount: 2,
                healthyCount: 1,
                usageCount: 15,
                errorCount: 3
            }
        }));
        mockGetRuntimeStorage.mockReturnValue({
            provider: {
                loadPoolsSummary
            }
        });

        const handled = await handleGetProvidersSummary(req, res, currentConfig, providerPoolManager);
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(loadPoolsSummary).toHaveBeenCalledWith(expect.objectContaining({
            filePath: 'configs/provider_pools.json',
            autoImportFromFile: true
        }));
        expect(mockLoadProviderPoolsCompatSnapshot).not.toHaveBeenCalled();

        const payload = JSON.parse(res.body);
        expect(payload).toEqual({
            'openai-codex-oauth': {
                totalCount: 2,
                healthyCount: 1,
                usageCount: 15,
                errorCount: 3
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

    test('should paginate provider details when page query is provided', async () => {
        const req = {
            url: '/api/providers/gemini-cli-oauth?page=2&limit=2&sort=asc'
        };
        const res = createMockRes();
        const currentConfig = {};
        const providers = [
            { uuid: 'gemini-2', customName: 'Bravo', isHealthy: true, isDisabled: false, usageCount: 2, errorCount: 0 },
            { uuid: 'gemini-1', customName: 'Alpha', isHealthy: true, isDisabled: false, usageCount: 8, errorCount: 0 },
            { uuid: 'gemini-3', customName: 'Charlie', isHealthy: false, isDisabled: false, usageCount: 1, errorCount: 5 }
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
        expect(payload.totalCount).toBe(3);
        expect(payload.page).toBe(2);
        expect(payload.limit).toBe(2);
        expect(payload.totalPages).toBe(2);
        expect(payload.returnedCount).toBe(1);
        expect(payload.providers.map(item => item.customName)).toEqual(['Charlie']);
    });
});
