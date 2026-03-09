import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

describe('API potluck key manager signal handling', () => {
    let initializeKeyManager;
    let resetKeyManagerForTests;
    let createKey;
    let mockRuntimeStorage;
    let processOnSpy;
    let processOffSpy;
    let processExitSpy;

    beforeEach(async () => {
        jest.resetModules();

        mockRuntimeStorage = {
            loadPotluckKeyStore: jest.fn(async () => ({ keys: {} })),
            savePotluckKeyStore: jest.fn(async () => undefined)
        };

        processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
        processOffSpy = jest.spyOn(process, 'off').mockImplementation(() => process);
        processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined);

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            __esModule: true,
            getRuntimeStorage: jest.fn(() => mockRuntimeStorage)
        }));

        ({ initializeKeyManager, resetKeyManagerForTests, createKey } = await import('../src/plugins/api-potluck/key-manager.js'));
    });

    afterEach(async () => {
        await resetKeyManagerForTests();
        processOnSpy.mockRestore();
        processOffSpy.mockRestore();
        processExitSpy.mockRestore();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('should persist dirty key store on SIGINT without forcing process.exit', async () => {
        await initializeKeyManager(true);
        await createKey('Signal Test Key', 500);

        const sigintEntry = processOnSpy.mock.calls.find(([eventName]) => eventName === 'SIGINT');
        expect(sigintEntry).toBeTruthy();

        const sigintHandler = sigintEntry[1];
        sigintHandler();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockRuntimeStorage.savePotluckKeyStore).toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
    });

    test('should persist dirty key store on SIGTERM without forcing process.exit', async () => {
        await initializeKeyManager(true);
        await createKey('Signal Test Key', 500);

        const sigtermEntry = processOnSpy.mock.calls.find(([eventName]) => eventName === 'SIGTERM');
        expect(sigtermEntry).toBeTruthy();

        const sigtermHandler = sigtermEntry[1];
        sigtermHandler();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockRuntimeStorage.savePotluckKeyStore).toHaveBeenCalled();
        expect(processExitSpy).not.toHaveBeenCalled();
    });
});
