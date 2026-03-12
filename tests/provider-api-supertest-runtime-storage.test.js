import os from 'os';
import path from 'path';
import http from 'http';
import request from 'supertest';
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

const mockBroadcastEvent = jest.fn();
const mockCheckAuth = jest.fn(async () => true);

let handleUIApiRequests;
let initializeRuntimeStorage;
let closeRuntimeStorage;
let getRuntimeStorage;
let ProviderPoolManager;
let socketSupported = false;

async function detectSocketSupport() {
    return await new Promise((resolve) => {
        const probeServer = http.createServer();
        probeServer.once('error', () => resolve(false));
        probeServer.listen(0, '127.0.0.1', () => {
            probeServer.close(() => resolve(true));
        });
    });
}

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createDbConfig(seedProviderPools = {}) {
    const tempDir = await createTempDir('provider-api-http-');
    const configsDir = path.join(tempDir, 'configs');
    await fs.mkdir(configsDir, { recursive: true });

    const currentConfig = {
        REQUIRED_API_KEY: '123456',
        MODEL_PROVIDER: 'grok-custom',
        PROVIDER_POOLS_FILE_PATH: path.join(configsDir, 'provider_pools.json'),
        RUNTIME_STORAGE_BACKEND: 'db',
        RUNTIME_STORAGE_DB_PATH: path.join(configsDir, 'runtime.sqlite'),
        RUNTIME_STORAGE_AUTO_IMPORT_PROVIDER_POOLS: true,
        RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
        RUNTIME_STORAGE_SQLITE_BINARY: 'sqlite3',
        LOG_OUTPUT_MODE: 'none'
    };

    const runtimeStorage = await initializeRuntimeStorage(currentConfig);
    currentConfig.RUNTIME_STORAGE_INFO = runtimeStorage.getInfo();

    if (Object.keys(seedProviderPools).length > 0) {
        await runtimeStorage.replaceProviderPoolsSnapshot(seedProviderPools, {
            sourceKind: 'test_seed'
        });
    }

    currentConfig.providerPools = await runtimeStorage.loadProviderPoolsSnapshot({
        filePath: currentConfig.PROVIDER_POOLS_FILE_PATH,
        autoImportFromFile: false
    });

    return {
        tempDir,
        currentConfig
    };
}

function createUiServer(currentConfig, providerPoolManager) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const handled = await handleUIApiRequests(
            req.method,
            url.pathname,
            req,
            res,
            currentConfig,
            providerPoolManager
        );

        if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not found' } }));
        }
    });
}

describe('Provider API runtime storage HTTP regression', () => {
    const originalCwd = process.cwd();

    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/ui-modules/auth.js', () => ({
            __esModule: true,
            checkAuth: mockCheckAuth,
            handleLoginRequest: jest.fn(async (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return true;
            })
        }));

        jest.doMock('../src/ui-modules/event-broadcast.js', () => ({
            __esModule: true,
            broadcastEvent: mockBroadcastEvent,
            handleEvents: jest.fn(),
            initializeUIManagement: jest.fn(),
            handleUploadOAuthCredentials: jest.fn(),
            upload: jest.fn()
        }));

        jest.doMock('../src/ui-modules/oauth-api.js', () => ({
            __esModule: true,
            handleBatchImportKiroTokens: jest.fn(),
            handleBatchImportGeminiTokens: jest.fn(),
            handleBatchImportCodexTokens: jest.fn(),
            handleImportAwsCredentials: jest.fn()
        }));

        jest.doMock('../src/providers/adapter.js', () => ({
            __esModule: true,
            getRegisteredProviders: jest.fn(() => []),
            getServiceAdapter: jest.fn(() => ({})),
            serviceInstances: {}
        }));

        ({ handleUIApiRequests } = await import('../src/services/ui-manager.js'));
        ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));

        const runtimeRegistryModule = await import('../src/storage/runtime-storage-registry.js');
        initializeRuntimeStorage = runtimeRegistryModule.initializeRuntimeStorage;
        closeRuntimeStorage = runtimeRegistryModule.closeRuntimeStorage;
        getRuntimeStorage = runtimeRegistryModule.getRuntimeStorage;
        socketSupported = await detectSocketSupport();
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        if (closeRuntimeStorage) {
            await closeRuntimeStorage();
        }
        mockBroadcastEvent.mockReset();
        mockCheckAuth.mockClear();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should run provider add/list/refresh flow through supertest in db mode', async () => {
        if (!socketSupported) {
            expect(true).toBe(true);
            return;
        }

        const { tempDir, currentConfig } = await createDbConfig();
        await fs.writeFile(path.join(tempDir, 'configs', 'config.json'), JSON.stringify({ ok: true }), 'utf8');
        process.chdir(tempDir);

        const providerPoolManager = new ProviderPoolManager(currentConfig.providerPools, {
            globalConfig: currentConfig,
            runtimeStorage: getRuntimeStorage(),
            saveDebounceTime: 20
        });
        const server = createUiServer(currentConfig, providerPoolManager);

        try {
            const addRes = await request(server)
                .post('/api/providers')
                .set('Authorization', 'Bearer mock')
                .send({
                    providerType: 'grok-custom',
                    providerConfig: {
                        customName: 'HTTP Grok',
                        GROK_COOKIE_TOKEN: 'http-token',
                        GROK_BASE_URL: 'https://grok.com'
                    }
                });

            expect(addRes.status).toBe(200);
            expect(addRes.body.provider).toMatchObject({
                customName: 'HTTP Grok',
                GROK_COOKIE_TOKEN: 'http-token'
            });

            const createdUuid = addRes.body.provider.uuid;
            const listRes = await request(server)
                .get('/api/providers/grok-custom')
                .set('Authorization', 'Bearer mock');

            expect(listRes.status).toBe(200);
            expect(listRes.body.providers[0]).toMatchObject({
                uuid: createdUuid,
                customName: 'HTTP Grok',
                GROK_COOKIE_TOKEN: 'http-token'
            });

            const refreshRes = await request(server)
                .post(`/api/providers/grok-custom/${createdUuid}/refresh-uuid`)
                .set('Authorization', 'Bearer mock');

            expect(refreshRes.status).toBe(200);
            expect(refreshRes.body.oldUuid).toBe(createdUuid);
            expect(refreshRes.body.newUuid).not.toBe(createdUuid);

            const removedUploadRouteRes = await request(server)
                .get('/api/upload-configs/download-all')
                .set('Authorization', 'Bearer mock');

            expect(removedUploadRouteRes.status).toBe(404);

            const removedQuickLinkRouteRes = await request(server)
                .post('/api/quick-link-provider')
                .set('Authorization', 'Bearer mock')
                .send({ filePaths: ['configs/gemini/account-1.json'] });

            expect(removedQuickLinkRouteRes.status).toBe(404);

            const snapshot = await getRuntimeStorage().exportProviderPoolsSnapshot();
            expect(snapshot['grok-custom'][0].uuid).toBe(refreshRes.body.newUuid);
            expect(mockCheckAuth).toHaveBeenCalled();
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
