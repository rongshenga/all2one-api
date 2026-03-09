import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('Usage cache runtime fallback policy', () => {
    let readUsageCache;
    let readProviderUsageCache;
    let mockRuntimeStorage;
    let mockExistsSync;
    let mockFsPromises;

    beforeEach(async () => {
        jest.resetModules();

        mockRuntimeStorage = {
            loadUsageCacheSnapshot: jest.fn(),
            loadProviderUsageSnapshot: jest.fn(),
            getInfo: jest.fn(() => ({ backend: 'file' }))
        };
        mockExistsSync = jest.fn(() => false);
        mockFsPromises = {
            readFile: jest.fn(),
            writeFile: jest.fn(),
            mkdir: jest.fn(),
            rename: jest.fn()
        };

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('fs', () => ({
            __esModule: true,
            existsSync: mockExistsSync,
            promises: mockFsPromises
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            __esModule: true,
            getRuntimeStorage: jest.fn(() => mockRuntimeStorage)
        }));

        ({ readUsageCache, readProviderUsageCache } = await import('../src/ui-modules/usage-cache.js'));
    });

    afterEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should not fallback to usage-cache file when db runtime read fails', async () => {
        mockRuntimeStorage.getInfo.mockReturnValue({ backend: 'db' });
        mockRuntimeStorage.loadUsageCacheSnapshot.mockRejectedValue(new Error('sqlite locked'));
        mockExistsSync.mockReturnValue(true);
        mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
            timestamp: '2026-03-06T10:00:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T10:00:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: []
                }
            }
        }));

        await expect(readUsageCache()).resolves.toBeNull();
        expect(mockFsPromises.readFile).not.toHaveBeenCalled();
    });

    test('should keep usage-cache file fallback for file runtime mode', async () => {
        mockRuntimeStorage.getInfo.mockReturnValue({ backend: 'file' });
        mockRuntimeStorage.loadUsageCacheSnapshot.mockRejectedValue(new Error('adapter unavailable'));
        mockExistsSync.mockReturnValue(true);
        mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
            timestamp: '2026-03-06T10:00:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T10:00:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: []
                }
            }
        }));

        await expect(readUsageCache()).resolves.toMatchObject({
            providers: {
                'grok-custom': expect.objectContaining({
                    totalCount: 1
                })
            }
        });
        expect(mockFsPromises.readFile).toHaveBeenCalledTimes(1);
    });

    test('should not fallback provider usage read to file in db mode', async () => {
        mockRuntimeStorage.getInfo.mockReturnValue({ backend: 'db' });
        mockRuntimeStorage.loadProviderUsageSnapshot.mockRejectedValue(new Error('sqlite busy'));
        mockExistsSync.mockReturnValue(true);
        mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
            timestamp: '2026-03-06T10:00:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T10:00:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: []
                }
            }
        }));

        await expect(readProviderUsageCache('grok-custom')).resolves.toBeNull();
        expect(mockFsPromises.readFile).not.toHaveBeenCalled();
    });
});
