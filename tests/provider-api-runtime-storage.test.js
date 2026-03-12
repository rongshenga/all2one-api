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

const mockGetRequestBody = jest.fn();
const mockBroadcastEvent = jest.fn();

let handleAddProvider;
let handleUpdateProvider;
let handleDeleteProvider;
let handleDisableEnableProvider;
let handleResetProviderHealth;
let handleDeleteUnhealthyProviders;
let handleRefreshUnhealthyUuids;
let handleRefreshProviderUuid;
let handleBatchImportGrokTokens;
let handleGetProviderType;
let scanConfigFiles;
let getProviderStatus;
let initializeRuntimeStorage;
let closeRuntimeStorage;
let getRuntimeStorage;
let recordRuntimeStorageValidationStatus;
let loadProviderPoolsCompatSnapshot;
let ProviderPoolManager;

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

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createDbConfig(seedProviderPools = {}, configOverrides = {}) {
    const tempDir = await createTempDir('provider-api-db-');
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
        LOG_OUTPUT_MODE: 'none',
        ...configOverrides
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

async function readRuntimeSnapshot() {
    return await getRuntimeStorage().exportProviderPoolsSnapshot();
}

describe('Provider API runtime storage compatibility', () => {
    const originalCwd = process.cwd();

    beforeAll(async () => {
        jest.resetModules();

        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        jest.doMock('../src/utils/common.js', () => {
            const actual = jest.requireActual('../src/utils/common.js');
            return {
                ...actual,
                getRequestBody: mockGetRequestBody
            };
        });

        jest.doMock('../src/ui-modules/event-broadcast.js', () => ({
            __esModule: true,
            broadcastEvent: mockBroadcastEvent,
            handleEvents: jest.fn(),
            initializeUIManagement: jest.fn(),
            handleUploadOAuthCredentials: jest.fn(),
            upload: jest.fn()
        }));

        jest.doMock('../src/providers/adapter.js', () => ({
            __esModule: true,
            getRegisteredProviders: jest.fn(() => []),
            getServiceAdapter: jest.fn(() => ({})),
            serviceInstances: {}
        }));

        jest.doMock('../src/storage/runtime-storage-registry.js', () => {
            return jest.requireActual('../src/storage/runtime-storage-registry.js');
        });

        const providerApiModule = await import('../src/ui-modules/provider-api.js');
        handleAddProvider = providerApiModule.handleAddProvider;
        handleUpdateProvider = providerApiModule.handleUpdateProvider;
        handleDeleteProvider = providerApiModule.handleDeleteProvider;
        handleDisableEnableProvider = providerApiModule.handleDisableEnableProvider;
        handleResetProviderHealth = providerApiModule.handleResetProviderHealth;
        handleDeleteUnhealthyProviders = providerApiModule.handleDeleteUnhealthyProviders;
        handleRefreshUnhealthyUuids = providerApiModule.handleRefreshUnhealthyUuids;
        handleRefreshProviderUuid = providerApiModule.handleRefreshProviderUuid;
        handleBatchImportGrokTokens = providerApiModule.handleBatchImportGrokTokens;
        handleGetProviderType = providerApiModule.handleGetProviderType;

        ({ scanConfigFiles } = await import('../src/ui-modules/config-scanner.js'));
        ({ getProviderStatus } = await import('../src/services/service-manager.js'));
        ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));

        const runtimeRegistryModule = await import('../src/storage/runtime-storage-registry.js');
        initializeRuntimeStorage = runtimeRegistryModule.initializeRuntimeStorage;
        closeRuntimeStorage = runtimeRegistryModule.closeRuntimeStorage;
        getRuntimeStorage = runtimeRegistryModule.getRuntimeStorage;
        recordRuntimeStorageValidationStatus = runtimeRegistryModule.recordRuntimeStorageValidationStatus;
        loadProviderPoolsCompatSnapshot = runtimeRegistryModule.loadProviderPoolsCompatSnapshot;
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await closeRuntimeStorage();
        mockGetRequestBody.mockReset();
        mockBroadcastEvent.mockReset();
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should persist provider CRUD and single UUID refresh through runtime storage in db mode', async () => {
        const { currentConfig } = await createDbConfig();

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'Grok A',
                GROK_COOKIE_TOKEN: 'token-a'
            }
        });

        const addRes = createMockRes();
        await handleAddProvider({}, addRes, currentConfig, null);
        const addPayload = JSON.parse(addRes.body);
        expect(addPayload.success).toBe(true);
        expect(addPayload.providerType).toBe('grok-custom');
        expect(addPayload.provider.GROK_COOKIE_TOKEN).toBe('token-a');

        const createdUuid = addPayload.provider.uuid;

        mockGetRequestBody.mockResolvedValueOnce({
            providerConfig: {
                customName: 'Grok B',
                GROK_COOKIE_TOKEN: 'token-b',
                usageCount: 999
            }
        });

        const updateRes = createMockRes();
        await handleUpdateProvider({}, updateRes, currentConfig, null, 'grok-custom', createdUuid);
        const updatePayload = JSON.parse(updateRes.body);
        expect(updatePayload.provider.customName).toBe('Grok B');
        expect(updatePayload.provider.GROK_COOKIE_TOKEN).toBe('token-b');
        expect(updatePayload.provider.usageCount).toBe(0);

        const disableRes = createMockRes();
        await handleDisableEnableProvider({}, disableRes, currentConfig, null, 'grok-custom', createdUuid, 'disable');
        expect(JSON.parse(disableRes.body).provider.isDisabled).toBe(true);

        const refreshRes = createMockRes();
        await handleRefreshProviderUuid({}, refreshRes, currentConfig, null, 'grok-custom', createdUuid);
        const refreshPayload = JSON.parse(refreshRes.body);
        expect(refreshPayload.oldUuid).toBe(createdUuid);
        expect(refreshPayload.newUuid).not.toBe(createdUuid);

        const deleteRes = createMockRes();
        await handleDeleteProvider({}, deleteRes, currentConfig, null, 'grok-custom', refreshPayload.newUuid);
        expect(JSON.parse(deleteRes.body).success).toBe(true);

        const snapshot = await readRuntimeSnapshot();
        expect(snapshot['grok-custom']).toBeUndefined();
        await expect(fs.access(currentConfig.PROVIDER_POOLS_FILE_PATH)).rejects.toThrow();
    });

    test('should persist unhealthy mutations and reset health through runtime storage in db mode', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'grok-healthy',
                    customName: 'Healthy',
                    GROK_COOKIE_TOKEN: 'healthy-token',
                    isHealthy: true,
                    errorCount: 0,
                    refreshCount: 0
                },
                {
                    uuid: 'grok-unhealthy',
                    customName: 'Unhealthy',
                    GROK_COOKIE_TOKEN: 'bad-token',
                    isHealthy: false,
                    errorCount: 3,
                    refreshCount: 2,
                    lastErrorTime: '2026-03-06T00:00:00.000Z'
                }
            ]
        });

        const refreshRes = createMockRes();
        await handleRefreshUnhealthyUuids({}, refreshRes, currentConfig, null, 'grok-custom');
        const refreshPayload = JSON.parse(refreshRes.body);
        expect(refreshPayload.refreshedCount).toBe(1);
        expect(refreshPayload.refreshedProviders[0].oldUuid).toBe('grok-unhealthy');

        let snapshot = await readRuntimeSnapshot();
        expect(snapshot['grok-custom'].map(item => item.uuid)).toContain('grok-healthy');
        expect(snapshot['grok-custom'].some(item => item.uuid === 'grok-unhealthy')).toBe(false);

        const resetRes = createMockRes();
        await handleResetProviderHealth({}, resetRes, currentConfig, null, 'grok-custom');
        expect(JSON.parse(resetRes.body).resetCount).toBe(1);

        snapshot = await readRuntimeSnapshot();
        expect(snapshot['grok-custom'].every(item => item.isHealthy === true)).toBe(true);
        expect(snapshot['grok-custom'].every(item => item.errorCount === 0)).toBe(true);

        const deleteUnhealthyRes = createMockRes();
        await handleDeleteUnhealthyProviders({}, deleteUnhealthyRes, currentConfig, null, 'grok-custom');
        expect(JSON.parse(deleteUnhealthyRes.body).deletedCount).toBe(0);
    });

    test('should delete only matching unhealthy providers by errorType and keep others', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'grok-healthy',
                    customName: 'Healthy',
                    GROK_COOKIE_TOKEN: 'healthy-token',
                    isHealthy: true,
                    errorCount: 0
                },
                {
                    uuid: 'grok-auth',
                    customName: 'Auth Unhealthy',
                    GROK_COOKIE_TOKEN: 'auth-token',
                    isHealthy: false,
                    errorCount: 2,
                    lastErrorMessage: 'Refresh failed: Failed to refresh Codex token. Please re-authenticate.'
                },
                {
                    uuid: 'grok-timeout',
                    customName: 'Timeout Unhealthy',
                    GROK_COOKIE_TOKEN: 'timeout-token',
                    isHealthy: false,
                    errorCount: 3,
                    lastErrorMessage: 'Request timeout'
                }
            ]
        });

        const deleteReq = {
            url: '/api/providers/grok-custom/delete-unhealthy?errorType=auth'
        };
        const deleteRes = createMockRes();
        await handleDeleteUnhealthyProviders(deleteReq, deleteRes, currentConfig, null, 'grok-custom');
        const deletePayload = JSON.parse(deleteRes.body);

        expect(deletePayload.deletedCount).toBe(1);
        expect(deletePayload.appliedErrorType).toBe('auth');
        expect(deletePayload.deletedProviders.map((item) => item.uuid)).toEqual(['grok-auth']);

        const snapshot = await readRuntimeSnapshot();
        expect(snapshot['grok-custom'].map((item) => item.uuid).sort()).toEqual(['grok-healthy', 'grok-timeout']);

        const listReq = {
            url: '/api/providers/grok-custom?page=1&limit=10&healthFilter=unhealthy&errorType=timeout'
        };
        const listRes = createMockRes();
        await handleGetProviderType(listReq, listRes, currentConfig, null, 'grok-custom');
        const listPayload = JSON.parse(listRes.body);

        expect(listPayload.errorType).toBe('timeout');
        expect(listPayload.filteredCount).toBe(1);
        expect(listPayload.providers.map((item) => item.uuid)).toEqual(['grok-timeout']);
    });

    test('should persist batch import through runtime storage in db mode', async () => {
        const { currentConfig } = await createDbConfig();

        mockGetRequestBody.mockResolvedValueOnce({
            ssoTokens: ['sso=abc', 'abc', 'def'],
            commonConfig: {
                customNamePrefix: 'Grok',
                GROK_BASE_URL: 'https://grok.com'
            }
        });

        const batchImportRes = createMockRes();
        await handleBatchImportGrokTokens({}, batchImportRes, currentConfig, null);
        const batchImportPayload = JSON.parse(batchImportRes.body);
        expect(batchImportPayload.successCount).toBe(2);
        expect(batchImportPayload.failedCount).toBe(1);

        const snapshot = await readRuntimeSnapshot();
        expect(snapshot['grok-custom']).toHaveLength(2);
        expect(mockBroadcastEvent).toHaveBeenCalled();
    });

    test('should read provider status and config scan usage from db-backed compatibility snapshot', async () => {
        const { tempDir, currentConfig } = await createDbConfig({
            'gemini-cli-oauth': [
                {
                    uuid: 'gemini-1',
                    customName: 'Gemini One',
                    GEMINI_OAUTH_CREDS_FILE_PATH: './configs/gemini/account-1.json',
                    isHealthy: false,
                    lastErrorTime: '2026-03-06T00:00:00.000Z',
                    lastErrorMessage: 'quota exhausted'
                }
            ]
        });

        await fs.mkdir(path.join(tempDir, 'configs', 'gemini'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'configs', 'gemini', 'account-1.json'), JSON.stringify({ access_token: 'x' }), 'utf8');
        process.chdir(tempDir);

        currentConfig.providerPools = {};

        const status = await getProviderStatus(currentConfig, { provider: 'gemini-cli-oauth' });
        expect(status.count).toBe(1);
        expect(status.unhealthyCount).toBe(1);
        expect(status.providerPoolsSlim[0].provider).toBe('gemini-cli-oauth');

        const configFiles = await scanConfigFiles(currentConfig, null);
        const scannedFile = configFiles.find(item => item.path === 'configs/gemini/account-1.json');
        expect(scannedFile).toBeTruthy();
        expect(scannedFile.isUsed).toBe(true);
        expect(scannedFile.usageInfo.usageDetails.some(item => item.providerType === 'gemini-cli-oauth')).toBe(true);
    });



    test('should reject missing provider payloads and invalid batch token input', async () => {
        const { currentConfig } = await createDbConfig();

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom'
        });
        const addRes = createMockRes();
        await handleAddProvider({}, addRes, currentConfig, null);
        expect(addRes.statusCode).toBe(400);
        expect(JSON.parse(addRes.body).error.message).toBe('providerType and providerConfig are required');

        mockGetRequestBody.mockResolvedValueOnce({});
        const updateRes = createMockRes();
        await handleUpdateProvider({}, updateRes, currentConfig, null, 'grok-custom', 'missing-provider');
        expect(updateRes.statusCode).toBe(400);
        expect(JSON.parse(updateRes.body).error.message).toBe('providerConfig is required');

        mockGetRequestBody.mockResolvedValueOnce({
            ssoTokens: ['   ', 'sso=   ', null, undefined],
            commonConfig: {
                concurrencyLimit: 'not-a-number',
                queueLimit: 'still-not-a-number'
            }
        });
        const batchImportRes = createMockRes();
        await handleBatchImportGrokTokens({}, batchImportRes, currentConfig, null);
        expect(batchImportRes.statusCode).toBe(400);
        expect(JSON.parse(batchImportRes.body)).toMatchObject({
            success: false,
            error: 'No valid SSO tokens found after normalization'
        });

        expect(await readRuntimeSnapshot()).toEqual({});
        expect(mockBroadcastEvent).not.toHaveBeenCalled();
    });

    test('should return not found for unknown provider mutations without changing snapshot', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Existing Grok',
                    GROK_COOKIE_TOKEN: 'existing-token',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 1,
                    errorCount: 0
                }
            ]
        });

        const snapshotBefore = await readRuntimeSnapshot();

        mockGetRequestBody.mockResolvedValueOnce({
            providerConfig: {
                customName: 'Missing Grok'
            }
        });
        const updateRes = createMockRes();
        await handleUpdateProvider({}, updateRes, currentConfig, null, 'grok-custom', 'missing-provider');
        expect(updateRes.statusCode).toBe(404);
        expect(JSON.parse(updateRes.body).error.message).toBe('Provider not found');

        const deleteRes = createMockRes();
        await handleDeleteProvider({}, deleteRes, currentConfig, null, 'grok-custom', 'missing-provider');
        expect(deleteRes.statusCode).toBe(404);
        expect(JSON.parse(deleteRes.body).error.message).toBe('Provider not found');

        const disableRes = createMockRes();
        await handleDisableEnableProvider({}, disableRes, currentConfig, null, 'grok-custom', 'missing-provider', 'disable');
        expect(disableRes.statusCode).toBe(404);
        expect(JSON.parse(disableRes.body).error.message).toBe('Provider not found');

        expect(await readRuntimeSnapshot()).toEqual(snapshotBefore);
        expect(mockBroadcastEvent).not.toHaveBeenCalled();
    });

    test('should surface persistence failures and preserve previous snapshot', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Existing Grok',
                    GROK_COOKIE_TOKEN: 'existing-token',
                    isHealthy: true,
                    isDisabled: false,
                    usageCount: 1,
                    errorCount: 0
                }
            ]
        });
        currentConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE = false;

        const managedState = getRuntimeStorage().__getManagedState();
        const originalReplace = managedState.activeStorage.replaceProviderPoolsSnapshot;
        const snapshotBefore = await readRuntimeSnapshot();
        managedState.activeStorage.replaceProviderPoolsSnapshot = jest.fn(async () => {
            throw new Error('persist failed');
        });

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'Broken Grok',
                GROK_COOKIE_TOKEN: 'broken-token'
            }
        });

        const res = createMockRes();
        await handleAddProvider({}, res, currentConfig, null);

        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body).error.message).toBe('persist failed');
        expect(mockBroadcastEvent).not.toHaveBeenCalled();
        expect(await readRuntimeSnapshot()).toEqual(snapshotBefore);

        managedState.activeStorage.replaceProviderPoolsSnapshot = originalReplace;
    });

    test('should return traceable diagnostics when provider mutation fails without fallback', async () => {
        const { currentConfig } = await createDbConfig();
        currentConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE = false;

        const managedState = getRuntimeStorage().__getManagedState();
        managedState.activeStorage.replaceProviderPoolsSnapshot = jest.fn(async () => {
            const error = new Error('database is locked');
            error.code = 'SQLITE_BUSY';
            throw error;
        });

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'Broken Grok',
                GROK_COOKIE_TOKEN: 'broken-token'
            }
        });

        const res = createMockRes();
        await handleAddProvider({}, res, currentConfig, null);

        expect(res.statusCode).toBe(500);
        const payload = JSON.parse(res.body);
        expect(payload.error).toMatchObject({
            message: 'database is locked',
            code: 'SQLITE_BUSY',
            phase: 'write',
            domain: 'provider',
            retryable: true
        });
        expect(payload.error.traceId).toBeTruthy();
        expect(payload.diagnostics.runtimeStorage).toMatchObject({
            backend: 'db',
            authoritativeSource: 'database'
        });
        expect(payload.diagnostics.runtimeStorageError).toMatchObject({
            message: 'database is locked',
            code: 'SQLITE_BUSY',
            retryable: true
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO.lastError.status).toBe('failed');
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should keep db backend when provider mutation fails', async () => {
        const { currentConfig } = await createDbConfig();

        const managedState = getRuntimeStorage().__getManagedState();
        managedState.activeStorage.replaceProviderPoolsSnapshot = jest.fn(async () => {
            const error = new Error('database is locked');
            error.code = 'SQLITE_BUSY';
            throw error;
        });

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'Fallback Grok',
                GROK_COOKIE_TOKEN: 'fallback-token'
            }
        });

        const res = createMockRes();
        await handleAddProvider({}, res, currentConfig, null);

        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body)).toMatchObject({
            error: expect.objectContaining({
                code: 'SQLITE_BUSY',
                phase: 'write',
                domain: 'provider'
            })
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO).toMatchObject({
            backend: 'db',
            authoritativeSource: 'database'
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO.lastFallback).toBeNull();
    });

    test('should keep provider reads consistent across manager, compat snapshot, and provider api after partial update', async () => {
        const { tempDir, currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Original Grok',
                    checkModelName: 'grok-3',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'secret-token',
                    isHealthy: true,
                    usageCount: 4,
                    errorCount: 1,
                    lastErrorTime: '2026-03-06T01:00:00.000Z'
                }
            ]
        });

        await fs.writeFile(path.join(tempDir, 'configs', 'config.json'), JSON.stringify({ ok: true }), 'utf8');
        process.chdir(tempDir);

        const providerPoolManager = new ProviderPoolManager(currentConfig.providerPools, {
            globalConfig: currentConfig,
            runtimeStorage: getRuntimeStorage(),
            saveDebounceTime: 20
        });

        mockGetRequestBody.mockResolvedValueOnce({
            providerConfig: {
                customName: 'Updated Grok',
                checkModelName: 'grok-4'
            }
        });

        const updateRes = createMockRes();
        await handleUpdateProvider({}, updateRes, currentConfig, providerPoolManager, 'grok-custom', 'grok-1');
        expect(updateRes.statusCode).toBe(200);

        const managerProvider = providerPoolManager.providerPools['grok-custom'][0];
        expect(managerProvider).toMatchObject({
            uuid: 'grok-1',
            customName: 'Updated Grok',
            checkModelName: 'grok-4',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'secret-token',
            usageCount: 4,
            errorCount: 1
        });

        const compatSnapshot = await loadProviderPoolsCompatSnapshot(currentConfig);
        expect(compatSnapshot['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Updated Grok',
            checkModelName: 'grok-4',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'secret-token'
        });

        const typeRes = createMockRes();
        await handleGetProviderType({}, typeRes, currentConfig, providerPoolManager, 'grok-custom');
        const typePayload = JSON.parse(typeRes.body);
        expect(typePayload.providers[0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Updated Grok',
            checkModelName: 'grok-4',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'secret-token'
        });

    });

    test('should validate provider mutation inputs and preserve batch import dedupe rules in db mode', async () => {
        const { tempDir, currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'dup-uuid',
                    customName: 'Existing Grok',
                    GROK_COOKIE_TOKEN: 'dup-token',
                    GROK_BASE_URL: 'https://grok.com'
                }
            ]
        });

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: '../grok-custom',
            providerConfig: {
                customName: 'Invalid Type',
                GROK_COOKIE_TOKEN: 'token-a'
            }
        });
        const invalidTypeRes = createMockRes();
        await handleAddProvider({}, invalidTypeRes, currentConfig, null);
        expect(invalidTypeRes.statusCode).toBe(400);
        expect(JSON.parse(invalidTypeRes.body).error.message).toBe('providerType is invalid');

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: '   ',
                GROK_COOKIE_TOKEN: 'token-b'
            }
        });
        const blankNameRes = createMockRes();
        await handleAddProvider({}, blankNameRes, currentConfig, null);
        expect(blankNameRes.statusCode).toBe(400);
        expect(JSON.parse(blankNameRes.body).error.message).toBe('customName must not be empty');

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'x'.repeat(256),
                GROK_COOKIE_TOKEN: 'token-c'
            }
        });
        const longNameRes = createMockRes();
        await handleAddProvider({}, longNameRes, currentConfig, null);
        expect(longNameRes.statusCode).toBe(400);
        expect(JSON.parse(longNameRes.body).error.message).toBe('customName must be at most 255 characters');

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                uuid: 'dup-uuid',
                customName: 'Duplicate UUID',
                GROK_COOKIE_TOKEN: 'token-d'
            }
        });
        const duplicateUuidRes = createMockRes();
        await handleAddProvider({}, duplicateUuidRes, currentConfig, null);
        expect(duplicateUuidRes.statusCode).toBe(409);
        expect(JSON.parse(duplicateUuidRes.body).error.message).toBe('Provider UUID already exists');

        mockGetRequestBody.mockResolvedValueOnce({
            ssoTokens: ['dup-token', ' sso=new-token ', 'new-token'],
            commonConfig: {
                customNamePrefix: 'Grok',
                GROK_BASE_URL: 'https://grok.com'
            }
        });
        const batchRes = createMockRes();
        await handleBatchImportGrokTokens({}, batchRes, currentConfig, null);
        const batchPayload = JSON.parse(batchRes.body);
        expect(batchPayload.successCount).toBe(1);
        expect(batchPayload.failedCount).toBe(2);
        expect(batchPayload.details.map(item => item.error).filter(Boolean)).toEqual(['duplicate_token', 'duplicate_token']);

    });

    test('should paginate provider type reads and reject batch imports above the configured limit', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                { uuid: 'grok-2', customName: 'Bravo', GROK_COOKIE_TOKEN: 'token-2' },
                { uuid: 'grok-1', customName: 'Alpha', GROK_COOKIE_TOKEN: 'token-1' },
                { uuid: 'grok-3', customName: 'Charlie', GROK_COOKIE_TOKEN: 'token-3' }
            ]
        }, {
            GROK_BATCH_IMPORT_LIMIT: 2
        });

        const typeRes = createMockRes();
        await handleGetProviderType({
            url: '/api/providers/grok-custom?page=2&limit=2&sort=asc'
        }, typeRes, currentConfig, null, 'grok-custom');
        const typePayload = JSON.parse(typeRes.body);
        expect(typePayload.totalCount).toBe(3);
        expect(typePayload.page).toBe(2);
        expect(typePayload.limit).toBe(2);
        expect(typePayload.totalPages).toBe(2);
        expect(typePayload.returnedCount).toBe(1);
        expect(typePayload.providers.map(item => item.customName)).toEqual(['Charlie']);

        mockGetRequestBody.mockResolvedValueOnce({
            ssoTokens: ['token-a', 'token-b', 'token-c']
        });
        const batchRes = createMockRes();
        await handleBatchImportGrokTokens({}, batchRes, currentConfig, null);
        expect(batchRes.statusCode).toBe(400);
        expect(JSON.parse(batchRes.body).error).toBe('ssoTokens exceeds batch import limit (2)');
    });

    test('should preserve previous snapshot when batch import persistence fails', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'existing-grok',
                    customName: 'Existing Grok',
                    GROK_COOKIE_TOKEN: 'existing-token'
                }
            ]
        });

        currentConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE = false;

        const snapshotBefore = await readRuntimeSnapshot();
        const managedState = getRuntimeStorage().__getManagedState();
        const originalReplace = managedState.activeStorage.storage.replaceProviderPoolsSnapshot;
        managedState.activeStorage.storage.replaceProviderPoolsSnapshot = jest.fn(async () => {
            throw new Error('batch persist failed');
        });

        mockGetRequestBody.mockResolvedValueOnce({
            ssoTokens: ['token-a', 'token-b'],
            commonConfig: {
                customNamePrefix: 'Broken',
                GROK_BASE_URL: 'https://grok.com'
            }
        });

        const res = createMockRes();
        await handleBatchImportGrokTokens({}, res, currentConfig, null);

        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body).error).toBe('batch persist failed');
        expect(managedState.activeStorage.storage.replaceProviderPoolsSnapshot).toHaveBeenCalled();
        expect(await readRuntimeSnapshot()).toEqual(snapshotBefore);
        expect(mockBroadcastEvent).not.toHaveBeenCalled();

        managedState.activeStorage.storage.replaceProviderPoolsSnapshot = originalReplace;
    });

    test('should ignore dual-write config and keep runtime storage in db mode', async () => {
        const { currentConfig } = await createDbConfig({}, {
            RUNTIME_STORAGE_DUAL_WRITE: true
        });

        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'Dual Write Grok',
                GROK_COOKIE_TOKEN: 'dual-write-token'
            }
        });

        const res = createMockRes();
        await handleAddProvider({}, res, currentConfig, null);

        const payload = JSON.parse(res.body);
        expect(res.statusCode).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.providerType).toBe('grok-custom');
        expect(payload.provider).toMatchObject({
            customName: 'Dual Write Grok'
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(currentConfig.RUNTIME_STORAGE_INFO.requestedBackend).toBe('db');
        expect(currentConfig.RUNTIME_STORAGE_INFO.dualWriteEnabled).toBe(false);
        expect(currentConfig.RUNTIME_STORAGE_INFO.lastFallback).toBeNull();
    });

    test('should keep persisted snapshot when event broadcast throws after a successful write', async () => {
        const { currentConfig } = await createDbConfig();

        mockBroadcastEvent.mockImplementationOnce(() => {
            throw new Error('event stream unavailable');
        });
        mockGetRequestBody.mockResolvedValueOnce({
            providerType: 'grok-custom',
            providerConfig: {
                customName: 'Broadcast Safe Grok',
                GROK_COOKIE_TOKEN: 'broadcast-token'
            }
        });

        const res = createMockRes();
        await handleAddProvider({}, res, currentConfig, null);

        expect(res.statusCode).toBe(200);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to broadcast config_update'));

        const snapshot = await readRuntimeSnapshot();
        expect(snapshot['grok-custom'][0]).toMatchObject({
            customName: 'Broadcast Safe Grok',
            GROK_COOKIE_TOKEN: 'broadcast-token'
        });
    });

    test('should expose export and validation diagnostics in runtime storage info', async () => {
        const { currentConfig } = await createDbConfig({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Diag Grok',
                    GROK_COOKIE_TOKEN: 'diag-token'
                }
            ]
        });

        const runtimeStorage = getRuntimeStorage();
        await runtimeStorage.exportProviderPoolsSnapshot();

        expect(currentConfig.RUNTIME_STORAGE_INFO.lastExport).toMatchObject({
            status: 'success',
            operation: 'exportProviderPoolsSnapshot',
            backend: 'db'
        });

        await recordRuntimeStorageValidationStatus({
            runId: 'run-validation-1',
            overallStatus: 'fail',
            sourceSummary: { providerCount: 1 },
            databaseSummary: { providerCount: 0 }
        }, {
            operation: 'verifyRuntimeStorageMigration',
            failoverOnFailure: true
        });

        expect(currentConfig.RUNTIME_STORAGE_INFO.lastValidation).toMatchObject({
            status: 'fail',
            runId: 'run-validation-1'
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO.crashRecovery).toMatchObject({
            durableBoundary: 'only_committed_transactions_and_successful_flush_batches_are_durable',
            lossWindow: 'unflushed_hot_state_only'
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO.lastValidation.crashRecovery).toMatchObject({
            durableBoundary: 'only_committed_transactions_and_successful_flush_batches_are_durable',
            lossWindow: 'unflushed_hot_state_only'
        });
        expect(currentConfig.RUNTIME_STORAGE_INFO.lastFallback).toBeNull();
        expect(currentConfig.RUNTIME_STORAGE_INFO.backend).toBe('db');
        expect(currentConfig.RUNTIME_STORAGE_INFO.authoritativeSource).toBe('database');
    });

test('should validate provider type config shape and custom name boundaries before persisting', async () => {
    const { currentConfig } = await createDbConfig();
    const snapshotBefore = await readRuntimeSnapshot();
    const tooLongName = 'n'.repeat(256);

    mockGetRequestBody.mockResolvedValueOnce({
        providerType: 'grok custom',
        providerConfig: {
            customName: 'Invalid Type',
            GROK_COOKIE_TOKEN: 'token-1'
        }
    });
    const invalidTypeRes = createMockRes();
    await handleAddProvider({}, invalidTypeRes, currentConfig, null);
    expect(invalidTypeRes.statusCode).toBe(400);
    expect(JSON.parse(invalidTypeRes.body).error.message).toBe('providerType is invalid');

    mockGetRequestBody.mockResolvedValueOnce({
        providerType: 'grok-custom',
        providerConfig: []
    });
    const invalidConfigRes = createMockRes();
    await handleAddProvider({}, invalidConfigRes, currentConfig, null);
    expect(invalidConfigRes.statusCode).toBe(400);
    expect(JSON.parse(invalidConfigRes.body).error.message).toBe('providerConfig must be an object');

    mockGetRequestBody.mockResolvedValueOnce({
        providerType: 'grok-custom',
        providerConfig: {
            customName: '   ',
            GROK_COOKIE_TOKEN: 'token-2'
        }
    });
    const emptyNameRes = createMockRes();
    await handleAddProvider({}, emptyNameRes, currentConfig, null);
    expect(emptyNameRes.statusCode).toBe(400);
    expect(JSON.parse(emptyNameRes.body).error.message).toBe('customName must not be empty');

    mockGetRequestBody.mockResolvedValueOnce({
        providerType: 'grok-custom',
        providerConfig: {
            customName: tooLongName,
            GROK_COOKIE_TOKEN: 'token-3'
        }
    });
    const longNameRes = createMockRes();
    await handleAddProvider({}, longNameRes, currentConfig, null);
    expect(longNameRes.statusCode).toBe(400);
    expect(JSON.parse(longNameRes.body).error.message).toBe('customName must be at most 255 characters');

    expect(await readRuntimeSnapshot()).toEqual(snapshotBefore);
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
});

test('should reject duplicate provider uuids before mutating db-backed snapshot', async () => {
    const { currentConfig } = await createDbConfig({
        'grok-custom': [
            {
                uuid: 'dup-provider',
                customName: 'Existing Grok',
                GROK_COOKIE_TOKEN: 'existing-token',
                isHealthy: true,
                isDisabled: false,
                usageCount: 1,
                errorCount: 0
            }
        ]
    });
    const snapshotBefore = await readRuntimeSnapshot();

    mockGetRequestBody.mockResolvedValueOnce({
        providerType: 'grok-custom',
        providerConfig: {
            uuid: 'dup-provider',
            customName: 'Duplicate Grok',
            GROK_COOKIE_TOKEN: 'duplicate-token'
        }
    });

    const res = createMockRes();
    await handleAddProvider({}, res, currentConfig, null);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.message).toBe('Provider UUID already exists');
    expect(await readRuntimeSnapshot()).toEqual(snapshotBefore);
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
});
});
