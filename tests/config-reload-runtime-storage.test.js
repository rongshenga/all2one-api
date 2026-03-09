import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { jest } from '@jest/globals';

const mockGetRequestBody = jest.fn();

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    initialize: jest.fn(),
    cleanupOldLogs: jest.fn()
};

let initializeConfig;
let reloadConfig;
let handleGetConfig;
let handleUpdateConfig;
let closeRuntimeStorage;
let initializeRuntimeStorage;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createMockRes() {
    return {
        statusCode: null,
        headers: null,
        body: null,
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers;
        },
        end(payload = '') {
            this.body = payload;
        }
    };
}

describe('Config reload runtime storage compatibility', () => {
    const originalCwd = process.cwd();

    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));
        jest.doMock('../src/services/service-manager.js', () => ({
            __esModule: true,
            initApiService: jest.fn()
        }));
        jest.doMock('../src/utils/common.js', () => {
            const actual = jest.requireActual('../src/utils/common.js');
            return {
                ...actual,
                getRequestBody: mockGetRequestBody
            };
        });
        jest.doMock('../src/providers/adapter.js', () => ({
            __esModule: true,
            serviceInstances: {}
        }));

        ({ initializeConfig } = await import('../src/core/config-manager.js'));
        ({ reloadConfig, handleGetConfig, handleUpdateConfig } = await import('../src/ui-modules/config-api.js'));
        ({ closeRuntimeStorage, initializeRuntimeStorage } = await import('../src/storage/runtime-storage-registry.js'));
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await closeRuntimeStorage();
        mockGetRequestBody.mockReset();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should reload provider pools from sqlite runtime storage without raw provider file', async () => {
        const tempDir = await createTempDir('config-reload-runtime-storage-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');
        const poolsPath = path.join(configsDir, 'provider_pools.json');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        const seedSnapshot = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Reload Grok',
                    GROK_COOKIE_TOKEN: 'reload-token',
                    isHealthy: true,
                    usageCount: 2,
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
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        process.chdir(tempDir);
        const runtimeStorage = await initializeRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true
        });
        await runtimeStorage.replaceProviderPoolsSnapshot(seedSnapshot, { sourceKind: 'test_seed' });

        const firstConfig = await initializeConfig([], configPath);
        expect(firstConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(firstConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Reload Grok',
            GROK_COOKIE_TOKEN: 'reload-token'
        });

        await fs.writeFile(poolsPath, JSON.stringify({}, null, 2), 'utf8');

        const reloadedConfig = await reloadConfig(null);
        expect(reloadedConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(reloadedConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Reload Grok',
            GROK_COOKIE_TOKEN: 'reload-token'
        });
    });

    test('should flush pending provider runtime state before config reload', async () => {
        const tempDir = await createTempDir('config-reload-runtime-flush-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');
        const poolsPath = path.join(configsDir, 'provider_pools.json');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        await fs.writeFile(poolsPath, JSON.stringify({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Reload Grok',
                    GROK_COOKIE_TOKEN: 'reload-token',
                    isHealthy: true,
                    usageCount: 2,
                    errorCount: 1,
                    checkModelName: 'grok-3'
                }
            ]
        }, null, 2), 'utf8');
        await fs.writeFile(configPath, JSON.stringify({
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        process.chdir(tempDir);
        await initializeConfig([], configPath);

        const providerPoolManager = {
            flushRuntimeState: jest.fn(async () => ({
                flushedCount: 1,
                flushReason: 'reload'
            })),
            initializeProviderStatus: jest.fn()
        };

        const reloadedConfig = await reloadConfig(providerPoolManager);
        expect(reloadedConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(providerPoolManager.flushRuntimeState).toHaveBeenCalledWith({
            reason: 'reload',
            requestedBy: 'config-api'
        });
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalled();
    });

    test('should rebuild provider pool manager cache from db compat snapshot during reload', async () => {
        const tempDir = await createTempDir('config-reload-runtime-storage-manager-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');
        const poolsPath = path.join(configsDir, 'provider_pools.json');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        const seedSnapshot = {
            'grok-custom': [
                {
                    uuid: 'grok-cache-1',
                    customName: 'Reload Cache Node',
                    GROK_COOKIE_TOKEN: 'cache-token',
                    isHealthy: true,
                    usageCount: 4,
                    errorCount: 0,
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
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none'
        }, null, 2), 'utf8');

        process.chdir(tempDir);
        const runtimeStorage = await initializeRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true
        });
        await runtimeStorage.replaceProviderPoolsSnapshot(seedSnapshot, { sourceKind: 'test_seed' });

        const providerPoolManager = {
            providerPools: { stale: [] },
            initializeProviderStatus: jest.fn(),
            flushRuntimeState: jest.fn()
        };

        const firstConfig = await initializeConfig([], configPath);
        expect(firstConfig.providerPools['grok-custom'][0].uuid).toBe('grok-cache-1');

        await fs.writeFile(poolsPath, JSON.stringify({}, null, 2), 'utf8');

        const reloadedConfig = await reloadConfig(providerPoolManager);
        expect(reloadedConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(reloadedConfig.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-cache-1',
            customName: 'Reload Cache Node',
            GROK_COOKIE_TOKEN: 'cache-token'
        });
        expect(providerPoolManager.flushRuntimeState).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'reload',
            requestedBy: 'config-api'
        }));
        expect(providerPoolManager.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-cache-1',
            customName: 'Reload Cache Node'
        });
        expect(providerPoolManager.initializeProviderStatus).toHaveBeenCalledTimes(1);
    });

    test('should return slim config payload without provider pools runtime snapshot', async () => {
        const tempDir = await createTempDir('config-get-slim-payload-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');

        const currentConfig = {
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            DEFAULT_MODEL_PROVIDERS: ['grok-custom'],
            SYSTEM_PROMPT_FILE_PATH: promptPath,
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_DUAL_WRITE: true,
            providerFallbackChain: { 'grok-custom': ['openai-codex-oauth'] },
            providerPools: {
                'grok-custom': Array.from({ length: 2000 }, (_, index) => ({
                    uuid: `grok-${index}`,
                    customName: `Grok ${index}`,
                    GROK_COOKIE_TOKEN: `token-${index}`
                }))
            },
            SYSTEM_PROMPT_CONTENT: 'memory only prompt',
            RUNTIME_STORAGE_INFO: {
                backend: 'db',
                dbPath: './configs/runtime.sqlite'
            }
        };

        process.chdir(tempDir);

        const res = createMockRes();
        await handleGetConfig({}, res, currentConfig);

        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(res.body);
        expect(payload.REQUIRED_API_KEY).toBe('123456');
        expect(payload.RUNTIME_STORAGE_BACKEND).toBe('db');
        expect(payload.systemPrompt).toBe('system prompt');
        expect(payload.providerPools).toBeUndefined();
        expect(payload.SYSTEM_PROMPT_CONTENT).toBeUndefined();
        expect(payload.RUNTIME_STORAGE_INFO).toBeUndefined();
        expect(Buffer.byteLength(res.body)).toBeLessThan(10000);
    });

    test('should preserve runtime storage config when saving ui changes', async () => {
        const tempDir = await createTempDir('config-save-preserve-runtime-storage-');
        const configsDir = path.join(tempDir, 'configs');
        const promptPath = path.join(configsDir, 'prompt.txt');
        const configPath = path.join(configsDir, 'config.json');

        await fs.mkdir(configsDir, { recursive: true });
        await fs.writeFile(promptPath, 'system prompt', 'utf8');
        await fs.writeFile(configPath, JSON.stringify({
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_DUAL_WRITE: true,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none',
            CUSTOM_FIELD_SHOULD_STAY: 'keep-me'
        }, null, 2), 'utf8');

        process.chdir(tempDir);

        const currentConfig = {
            REQUIRED_API_KEY: '123456',
            SERVER_PORT: 3000,
            HOST: '0.0.0.0',
            MODEL_PROVIDER: 'grok-custom',
            SYSTEM_PROMPT_FILE_PATH: './configs/prompt.txt',
            SYSTEM_PROMPT_MODE: 'overwrite',
            PROVIDER_POOLS_FILE_PATH: './configs/provider_pools.json',
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: './configs/runtime.sqlite',
            RUNTIME_STORAGE_DUAL_WRITE: true,
            RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
            LOG_OUTPUT_MODE: 'none',
            providerPools: {
                'grok-custom': [{ uuid: 'grok-1', GROK_COOKIE_TOKEN: 'secret' }]
            },
            SYSTEM_PROMPT_CONTENT: 'memory only prompt',
            RUNTIME_STORAGE_INFO: { backend: 'db' }
        };

        mockGetRequestBody.mockResolvedValue({
            SERVER_PORT: 3001,
            systemPrompt: 'updated prompt'
        });

        const res = createMockRes();
        await handleUpdateConfig({}, res, currentConfig);

        expect(res.statusCode).toBe(200);
        const savedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
        expect(savedConfig.SERVER_PORT).toBe(3001);
        expect(savedConfig.RUNTIME_STORAGE_BACKEND).toBe('db');
        expect(savedConfig.RUNTIME_STORAGE_DB_PATH).toBe('./configs/runtime.sqlite');
        expect(savedConfig.RUNTIME_STORAGE_DUAL_WRITE).toBe(true);
        expect(savedConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE).toBe(true);
        expect(savedConfig.CUSTOM_FIELD_SHOULD_STAY).toBe('keep-me');
        expect(savedConfig.providerPools).toBeUndefined();
        expect(savedConfig.SYSTEM_PROMPT_CONTENT).toBeUndefined();
        expect(savedConfig.RUNTIME_STORAGE_INFO).toBeUndefined();
        expect(await fs.readFile(promptPath, 'utf8')).toBe('updated prompt');
    });
});
