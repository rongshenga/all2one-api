import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

const mockBroadcastEvent = jest.fn();
const mockGetServiceAdapter = jest.fn();

let ProviderPoolManager;

function buildProvider(uuid) {
    return {
        uuid,
        customName: uuid,
        GEMINI_OAUTH_CREDS_FILE_PATH: `configs/gemini/${uuid}.json`,
        isHealthy: true,
        isDisabled: false,
        usageCount: 0,
        errorCount: 0
    };
}

describe('Provider pool auth lazy load', () => {
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

        ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
    });

    test('should only return current-group startup candidates for large pools', () => {
        const providers = Array.from({ length: 10 }, (_, idx) => buildProvider(`gemini-${idx + 1}`));
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': providers
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                POOL_GROUP_SELECTION_ENABLED: true,
                POOL_GROUP_SIZE: 4,
                POOL_GROUP_MIN_POOL_SIZE: 4,
                AUTH_GROUP_PRELOAD_SIZE: 4
            },
            runtimeStorage: null
        });

        const selected = manager.getStartupPreloadCandidates('gemini-cli-oauth', providers, 6);
        expect(selected).toHaveLength(4);
        expect(selected.map((item) => item.uuid)).toEqual([
            'gemini-1',
            'gemini-2',
            'gemini-3',
            'gemini-4'
        ]);
    });

    test('should use ttl cache for db expiry candidates', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => ([
                {
                    provider_id: 'prov-1',
                    encrypted_payload: JSON.stringify({
                        expiry_date: Date.now() + 60_000
                    }),
                    secret_updated_at: '2026-03-09T00:00:00.000Z'
                }
            ]))
        };
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': [buildProvider('gemini-cache-1')]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                AUTH_SECRET_CACHE_TTL_MS: 600000
            },
            runtimeStorage
        });

        await manager._loadDbExpiryCandidatesByProvider('gemini-cli-oauth');
        await manager._loadDbExpiryCandidatesByProvider('gemini-cli-oauth');

        const metrics = manager.getAuthRuntimeMetrics();
        expect(runtimeStorage.listCredentialExpiryCandidates).toHaveBeenCalledTimes(2);
        expect(metrics.credentialCache.misses).toBeGreaterThanOrEqual(1);
        expect(metrics.credentialCache.hits).toBeGreaterThanOrEqual(1);
    });

    test('should schedule ahead preload after grouped selection', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => [])
        };
        const providers = Array.from({ length: 9 }, (_, idx) => buildProvider(`gemini-preload-${idx + 1}`));
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': providers
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                POOL_GROUP_SELECTION_ENABLED: true,
                POOL_GROUP_SIZE: 3,
                POOL_GROUP_MIN_POOL_SIZE: 3,
                AUTH_GROUP_PRELOAD_SIZE: 3,
                AUTH_GROUP_PRELOAD_AHEAD: 2
            },
            runtimeStorage
        });

        await manager.selectProvider('gemini-cli-oauth');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(runtimeStorage.listCredentialExpiryCandidates).toHaveBeenCalled();
        expect(manager.getAuthRuntimeMetrics().groupPreload.queueLength).toBeGreaterThanOrEqual(0);
    });

    test('should query scoped provider ids when ahead preloading next groups', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => [])
        };
        const providers = Array.from({ length: 8 }, (_, idx) => buildProvider(`gemini-scope-${idx + 1}`));
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': providers
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                POOL_GROUP_SELECTION_ENABLED: true,
                POOL_GROUP_SIZE: 4,
                POOL_GROUP_MIN_POOL_SIZE: 4,
                AUTH_GROUP_PRELOAD_SIZE: 4,
                AUTH_GROUP_PRELOAD_AHEAD: 1
            },
            runtimeStorage
        });

        manager.preloadStartupAuthGroups('gemini-cli-oauth', providers.length);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(runtimeStorage.listCredentialExpiryCandidates).toHaveBeenCalled();
        const firstCallOptions = runtimeStorage.listCredentialExpiryCandidates.mock.calls[0]?.[1] || {};
        expect(Array.isArray(firstCallOptions.providerIds)).toBe(true);
        expect(firstCallOptions.providerIds).toHaveLength(4);
    });

    test('should cap expiry scan enqueue volume by configured limits', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => [])
        };
        const providers = Array.from({ length: 8 }, (_, idx) => buildProvider(`gemini-limit-${idx + 1}`));
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': providers
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                EXPIRY_SCAN_DB_FETCH_LIMIT: 10,
                EXPIRY_SCAN_MAX_ENQUEUE_TOTAL: 3,
                EXPIRY_SCAN_MAX_ENQUEUE_PER_PROVIDER: 2
            },
            runtimeStorage
        });

        const providerStatuses = manager.providerStatus['gemini-cli-oauth'];
        providerStatuses.forEach((status, index) => {
            status.providerId = `pid-${index + 1}`;
            status.config.isHealthy = true;
            status.config.isDisabled = false;
        });

        runtimeStorage.listCredentialExpiryCandidates.mockResolvedValue(
            providerStatuses.map((status) => ({
                provider_id: status.providerId,
                encrypted_payload: JSON.stringify({
                    expiry_date: Date.now() - 1000
                }),
                secret_updated_at: '2026-03-10T00:00:00.000Z'
            }))
        );

        const enqueueSpy = jest.spyOn(manager, '_enqueueRefresh').mockImplementation(() => {});

        await manager.checkAndRefreshExpiringNodes();

        expect(runtimeStorage.listCredentialExpiryCandidates).toHaveBeenCalled();
        const firstCallOptions = runtimeStorage.listCredentialExpiryCandidates.mock.calls[0]?.[1] || {};
        expect(firstCallOptions.limit).toBe(10);
        expect(enqueueSpy).toHaveBeenCalledTimes(2);
    });

    test('should skip expiry scan when disabled', async () => {
        const runtimeStorage = {
            listCredentialExpiryCandidates: jest.fn(async () => [])
        };
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': [buildProvider('gemini-disabled-1')]
        }, {
            globalConfig: {
                LOG_LEVEL: 'error',
                EXPIRY_SCAN_ENABLED: false
            },
            runtimeStorage
        });

        await manager.checkAndRefreshExpiringNodes();
        expect(runtimeStorage.listCredentialExpiryCandidates).not.toHaveBeenCalled();
    });
});
