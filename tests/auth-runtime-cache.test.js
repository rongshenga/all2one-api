import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initialize: jest.fn(),
    cleanupOldLogs: jest.fn()
};

describe('Auth runtime session cache', () => {
    let verifyToken;
    let mockRuntimeStorage;
    let mockExistsSync;
    let mockFsPromises;

    beforeEach(async () => {
        jest.resetModules();

        mockRuntimeStorage = {
            getAdminSession: jest.fn(),
            saveAdminSession: jest.fn(),
            deleteAdminSession: jest.fn(),
            cleanupExpiredAdminSessions: jest.fn(),
            getInfo: jest.fn(() => ({ backend: 'file' }))
        };
        mockExistsSync = jest.fn(() => false);
        mockFsPromises = {
            readFile: jest.fn(),
            writeFile: jest.fn()
        };

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/core/config-manager.js', () => ({
            __esModule: true,
            CONFIG: {
                LOGIN_EXPIRY: 3600
            }
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

        ({ verifyToken } = await import('../src/ui-modules/auth.js'));
    });

    afterEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should cache verified admin sessions in memory', async () => {
        const tokenInfo = {
            username: 'admin',
            expiryTime: Date.now() + 60_000,
            loginTime: Date.now() - 1_000,
            sourceIp: '127.0.0.1',
            userAgent: 'jest-cache'
        };
        mockRuntimeStorage.getAdminSession.mockResolvedValue(tokenInfo);

        await expect(verifyToken('token-1')).resolves.toEqual(tokenInfo);
        await expect(verifyToken('token-1')).resolves.toEqual(tokenInfo);

        expect(mockRuntimeStorage.getAdminSession).toHaveBeenCalledTimes(1);
    });

    test('should dedupe concurrent admin session verification requests', async () => {
        let resolveSession;
        mockRuntimeStorage.getAdminSession.mockImplementationOnce(() => new Promise((resolve) => {
            resolveSession = resolve;
        }));

        const verifyPromiseA = verifyToken('token-2');
        const verifyPromiseB = verifyToken('token-2');

        expect(mockRuntimeStorage.getAdminSession).toHaveBeenCalledTimes(1);

        resolveSession({
            username: 'admin',
            expiryTime: Date.now() + 60_000,
            loginTime: Date.now() - 1_000,
            sourceIp: '127.0.0.1',
            userAgent: 'jest-concurrency'
        });

        await expect(Promise.all([verifyPromiseA, verifyPromiseB])).resolves.toEqual([
            expect.objectContaining({ username: 'admin', userAgent: 'jest-concurrency' }),
            expect.objectContaining({ username: 'admin', userAgent: 'jest-concurrency' })
        ]);
        expect(mockRuntimeStorage.getAdminSession).toHaveBeenCalledTimes(1);
    });

    test('should not fallback to token store file when db runtime storage read fails', async () => {
        const token = 'db-mode-token';
        const tokenInfo = {
            username: 'admin',
            expiryTime: Date.now() + 60_000,
            loginTime: Date.now() - 1_000
        };
        mockRuntimeStorage.getInfo.mockReturnValue({ backend: 'db' });
        mockRuntimeStorage.getAdminSession.mockRejectedValue(new Error('sqlite busy'));
        mockExistsSync.mockReturnValue(true);
        mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
            tokens: {
                [token]: tokenInfo
            }
        }));

        await expect(verifyToken(token)).resolves.toBeNull();
        expect(mockFsPromises.readFile).not.toHaveBeenCalled();
    });

    test('should keep token store fallback for file runtime storage mode', async () => {
        const token = 'file-mode-token';
        const tokenInfo = {
            username: 'admin',
            expiryTime: Date.now() + 60_000,
            loginTime: Date.now() - 1_000
        };
        mockRuntimeStorage.getInfo.mockReturnValue({ backend: 'file' });
        mockRuntimeStorage.getAdminSession.mockRejectedValue(new Error('file adapter not ready'));
        mockExistsSync.mockReturnValue(true);
        mockFsPromises.readFile.mockResolvedValue(JSON.stringify({
            tokens: {
                [token]: tokenInfo
            }
        }));

        await expect(verifyToken(token)).resolves.toEqual(tokenInfo);
        expect(mockFsPromises.readFile).toHaveBeenCalledTimes(1);
    });
});
