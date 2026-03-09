import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { jest } from '@jest/globals';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initialize: jest.fn(),
    cleanupOldLogs: jest.fn()
};

let initializeConfig;
let closeRuntimeStorage;
let initializeRuntimeStorage;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Config manager runtime storage bootstrap', () => {
    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        ({ initializeConfig } = await import('../src/core/config-manager.js'));
        ({ closeRuntimeStorage, initializeRuntimeStorage } = await import('../src/storage/runtime-storage-registry.js'));
    });

    afterEach(async () => {
        await closeRuntimeStorage();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should bootstrap provider pools from sqlite runtime storage after initial import', async () => {
        const tempDir = await createTempDir('config-runtime-storage-');
        const promptPath = path.join(tempDir, 'prompt.txt');
        const configPath = path.join(tempDir, 'config.json');
        const poolsPath = path.join(tempDir, 'provider_pools.json');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        const seedSnapshot = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'cookie-token',
                    isHealthy: true,
                    usageCount: 3,
                    errorCount: 1,
                    checkModelName: 'grok-3'
                }
            ]
        };
        await fs.writeFile(poolsPath, JSON.stringify(seedSnapshot, null, 2), 'utf8');

        await fs.writeFile(configPath, JSON.stringify({
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: promptPath,
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: poolsPath,
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        const runtimeStorage = await initializeRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: poolsPath,
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true
        });
        await runtimeStorage.replaceProviderPoolsSnapshot(seedSnapshot, {
            sourceKind: 'test_seed'
        });

        const firstConfig = await initializeConfig([], configPath);
        expect(firstConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(firstConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Grok One',
            GROK_COOKIE_TOKEN: 'cookie-token',
            usageCount: 3,
            errorCount: 1
        });

        await fs.writeFile(poolsPath, JSON.stringify({}, null, 2), 'utf8');

        const secondConfig = await initializeConfig([], configPath);
        expect(secondConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(secondConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Grok One',
            GROK_COOKIE_TOKEN: 'cookie-token',
            usageCount: 3,
            errorCount: 1
        });
    });

    test('getProviderStatus should read db compatibility snapshot without raw provider_pools file', async () => {
        const compatSnapshot = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_COOKIE_TOKEN: 'cookie-token',
                    isHealthy: false,
                    isDisabled: false,
                    lastErrorTime: '2026-03-06T00:00:00.000Z',
                    lastErrorMessage: 'quota exhausted'
                }
            ]
        };

        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/storage/runtime-storage-registry.js', () => ({
            getRuntimeStorage: jest.fn(() => null),
            loadProviderPoolsCompatSnapshot: jest.fn(async () => compatSnapshot)
        }));
        jest.doMock('../src/providers/adapter.js', () => ({
            getServiceAdapter: jest.fn(),
            serviceInstances: {}
        }));

        const { getProviderStatus } = await import('../src/services/service-manager.js');
        const result = await getProviderStatus({
            RUNTIME_STORAGE_INFO: { backend: 'db' },
            PROVIDER_POOLS_FILE_PATH: path.join(await createTempDir('provider-status-'), 'provider_pools.json')
        });

        expect(result.count).toBe(1);
        expect(result.unhealthyCount).toBe(1);
        expect(result.unhealthyRatio).toBe(1);
        expect(result.providerPoolsSlim).toEqual([
            expect.objectContaining({
                customName: 'Grok One',
                isHealthy: false,
                provider: 'grok-custom'
            })
        ]);
    });
});
