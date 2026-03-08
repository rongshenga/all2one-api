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

const mockBroadcastEvent = jest.fn();
const mockGetServiceAdapter = jest.fn();

let createRuntimeStorage;
let ProviderPoolManager;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Runtime storage extended domains', () => {
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

        ({ createRuntimeStorage } = await import('../src/storage/runtime-storage-factory.js'));
        ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
    });

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
        mockBroadcastEvent.mockReset();
        mockGetServiceAdapter.mockReset();
    });

    test('should expose domain facades without breaking legacy runtime storage methods', async () => {
        const tempDir = await createTempDir('runtime-storage-facade-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const originalCwd = process.cwd();
        process.chdir(tempDir);

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        try {
            await storage.initialize();

            expect(storage.kind).toBe('db');
            expect(typeof storage.getDomains).toBe('function');
            expect(typeof storage.provider.loadPoolsSnapshot).toBe('function');
            expect(typeof storage.usage.loadCacheSummary).toBe('function');
            expect(typeof storage.usage.saveRefreshTask).toBe('function');
            expect(typeof storage.session.getSession).toBe('function');
            expect(typeof storage.plugin.savePotluckUserData).toBe('function');
            expect(typeof storage.migration.listRuns).toBe('function');
            expect(storage.client).toBeDefined();

            await storage.provider.replacePoolsSnapshot({
                'grok-custom': [
                    {
                        uuid: 'grok-1',
                        customName: 'Grok One',
                        GROK_BASE_URL: 'https://grok.com',
                        GROK_COOKIE_TOKEN: 'cookie-token'
                    }
                ]
            });

            const legacySnapshot = await storage.loadProviderPoolsSnapshot();
            const usageSummary = await storage.loadUsageCacheSummary();
            const domainSnapshot = await storage.provider.exportPoolsSnapshot();
            expect(usageSummary).toBeNull();
            expect(domainSnapshot).toEqual(legacySnapshot);
            expect(domainSnapshot['grok-custom'][0]).toMatchObject({
                uuid: 'grok-1',
                customName: 'Grok One'
            });

            const runs = await storage.migration.listRuns();
            expect(Array.isArray(runs)).toBe(true);
            expect(runs).toHaveLength(0);
        } finally {
            await storage.close();
            process.chdir(originalCwd);
        }
    });

    test('should persist usage, session and potluck runtime state through sqlite storage restart', async () => {
        const tempDir = await createTempDir('runtime-storage-domains-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const expectedUsageCache = {
            timestamp: '2026-03-06T10:00:00.000Z',
            providers: {
                'gemini-cli-oauth': {
                    providerType: 'gemini-cli-oauth',
                    timestamp: '2026-03-06T10:00:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: [
                        {
                            uuid: 'gemini-1',
                            name: 'gemini-1',
                            success: true,
                            error: null,
                            isDisabled: false,
                            isHealthy: true,
                            lastRefreshedAt: '2026-03-06T10:00:00.000Z',
                            usage: {
                                user: {
                                    email: null,
                                    userId: null
                                },
                                usageBreakdown: [
                                    {
                                        resourceType: 'tokens',
                                        currentUsage: 0,
                                        usageLimit: 100,
                                        inputTokenLimit: 0,
                                        outputTokenLimit: 0,
                                        nextDateReset: null,
                                        freeTrial: null,
                                        bonuses: []
                                    }
                                ]
                            }
                        }
                    ]
                }
            }
        };

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        await storage.initialize();
        await storage.replaceUsageCacheSnapshot(expectedUsageCache);
        await storage.saveUsageRefreshTask({
            id: 'usage-task-1',
            type: 'provider',
            providerType: 'gemini-cli-oauth',
            status: 'running',
            createdAt: '2026-03-06T10:00:00.000Z',
            startedAt: '2026-03-06T10:00:01.000Z',
            finishedAt: null,
            error: null,
            result: null,
            progress: {
                totalProviders: 1,
                processedProviders: 0,
                currentProvider: 'gemini-cli-oauth',
                totalInstances: 1,
                processedInstances: 0,
                successCount: 0,
                errorCount: 0,
                currentGroup: 0,
                totalGroups: 1,
                percent: 0
            }
        });
        await storage.saveAdminSession('token-1', {
            username: 'admin',
            loginTime: Date.parse('2026-03-06T10:00:00.000Z'),
            expiryTime: Date.parse('2099-03-06T12:00:00.000Z'),
            sourceIp: '127.0.0.1',
            userAgent: 'jest-runtime-test'
        });
        await storage.savePotluckUserData({
            config: {
                defaultDailyLimit: 700,
                bonusPerCredential: 333,
                bonusValidityDays: 20,
                persistInterval: 1500
            },
            users: {
                maki_demo: {
                    credentials: [
                        {
                            id: 'cred-1',
                            path: 'configs/kiro/demo.json',
                            provider: 'claude-kiro-oauth',
                            authMethod: 'builder-id',
                            addedAt: '2026-03-06T10:00:00.000Z'
                        }
                    ],
                    credentialBonuses: [
                        {
                            credentialId: 'cred-1',
                            grantedAt: '2026-03-06T10:00:00.000Z',
                            usedCount: 1
                        }
                    ],
                    createdAt: '2026-03-06T10:00:00.000Z'
                }
            }
        });
        await storage.savePotluckKeyStore({
            keys: {
                maki_demo: {
                    id: 'maki_demo',
                    name: 'Demo Key',
                    createdAt: '2026-03-06T10:00:00.000Z',
                    dailyLimit: 700,
                    todayUsage: 3,
                    totalUsage: 9,
                    lastResetDate: '2026-03-06',
                    lastUsedAt: '2026-03-06T10:30:00.000Z',
                    enabled: true,
                    bonusRemaining: 5
                }
            }
        });
        await storage.close();

        const reopened = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });
        await reopened.initialize();

        const usageCache = await reopened.loadUsageCacheSnapshot();
        expect(usageCache).toEqual(expectedUsageCache);

        const persistedTask = await reopened.loadUsageRefreshTask('usage-task-1');
        expect(persistedTask.status).toBe('failed');
        expect(persistedTask.error).toContain('interrupted');

        const session = await reopened.getAdminSession('token-1');
        expect(session).toMatchObject({
            username: 'admin',
            sourceIp: '127.0.0.1',
            userAgent: 'jest-runtime-test'
        });

        const potluckUsers = await reopened.loadPotluckUserData();
        expect(potluckUsers.config).toMatchObject({
            defaultDailyLimit: 700,
            bonusPerCredential: 333,
            bonusValidityDays: 20,
            persistInterval: 1500
        });
        expect(potluckUsers.users.maki_demo.credentials).toHaveLength(1);
        expect(potluckUsers.users.maki_demo.credentialBonuses).toHaveLength(1);

        const potluckKeys = await reopened.loadPotluckKeyStore();
        expect(potluckKeys.keys.maki_demo).toMatchObject({
            id: 'maki_demo',
            name: 'Demo Key',
            dailyLimit: 700,
            todayUsage: 3,
            totalUsage: 9,
            bonusRemaining: 5,
            enabled: true
        });

        await reopened.close();
    });

    test('should keep only the last flushed provider runtime snapshot durable across restart', async () => {
        const tempDir = await createTempDir('runtime-storage-provider-crash-window-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Durable Grok',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'durable-cookie',
                    isHealthy: true,
                    usageCount: 10,
                    errorCount: 1,
                    lastUsed: '2026-03-06T10:00:00.000Z'
                }
            ]
        });

        const loadedSnapshot = await storage.loadProviderPoolsSnapshot({
            filePath: providerPoolsPath,
            autoImportFromFile: false
        });
        const manager = new ProviderPoolManager(loadedSnapshot, {
            globalConfig: {
                LOG_LEVEL: 'error',
                PERSIST_SELECTION_STATE: false
            },
            runtimeStorage: storage,
            saveDebounceTime: 60000
        });

        const selected = await manager.selectProvider('grok-custom');
        expect(selected.usageCount).toBe(11);

        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
            manager.saveTimer = null;
        }

        const snapshotBeforeRestart = await storage.exportProviderPoolsSnapshot();
        expect(snapshotBeforeRestart['grok-custom'][0]).toMatchObject({
            usageCount: 10,
            errorCount: 1,
            lastUsed: '2026-03-06T10:00:00.000Z'
        });

        await storage.close();

        const reopened = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });
        await reopened.initialize();

        const snapshotAfterRestart = await reopened.exportProviderPoolsSnapshot();
        expect(snapshotAfterRestart['grok-custom'][0]).toMatchObject({
            usageCount: 10,
            errorCount: 1,
            lastUsed: '2026-03-06T10:00:00.000Z'
        });

        await reopened.close();
    });

    test('should recover committed records without schema drift after an interrupted sqlite transaction', async () => {
        const tempDir = await createTempDir('runtime-storage-crash-recovery-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Crash Safe Grok',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'crash-safe-cookie',
                    isHealthy: true,
                    usageCount: 10,
                    errorCount: 0,
                    lastUsed: '2026-03-06T09:00:00.000Z'
                }
            ]
        });
        await storage.saveAdminSession('token-durable', {
            username: 'admin',
            loginTime: Date.parse('2026-03-06T09:00:00.000Z'),
            expiryTime: Date.parse('2099-03-06T12:00:00.000Z'),
            sourceIp: '127.0.0.1',
            userAgent: 'jest-crash-test'
        });

        const schemaBefore = await storage.client.query(`
SELECT name
FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
ORDER BY name ASC;
        `);

        await storage.client.exec(`
BEGIN IMMEDIATE;
UPDATE provider_runtime_state
SET usage_count = 999,
    updated_at = '2026-03-06T11:00:00.000Z'
WHERE provider_id IN (
    SELECT provider_id
    FROM provider_registrations
    WHERE provider_type = 'grok-custom'
);
INSERT INTO admin_sessions (
    id,
    token_hash,
    subject,
    expires_at,
    created_at,
    last_seen_at,
    source_ip,
    user_agent,
    meta_json
) VALUES (
    'session-crash-probe',
    'token-hash-crash-probe',
    'admin',
    '2026-03-06T13:00:00.000Z',
    '2026-03-06T11:00:00.000Z',
    '2026-03-06T11:00:00.000Z',
    '127.0.0.2',
    'crash-probe',
    '{"username":"admin"}'
);
        `);

        await storage.close();

        const reopened = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });
        await reopened.initialize();

        const integrityRows = await reopened.client.query('PRAGMA integrity_check;');
        expect(integrityRows[0].integrity_check).toBe('ok');

        const schemaAfter = await reopened.client.query(`
SELECT name
FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
ORDER BY name ASC;
        `);
        expect(schemaAfter.map((row) => row.name)).toEqual(schemaBefore.map((row) => row.name));

        const durableSession = await reopened.getAdminSession('token-durable');
        expect(durableSession).toMatchObject({
            username: 'admin',
            sourceIp: '127.0.0.1',
            userAgent: 'jest-crash-test'
        });

        const halfWrittenRows = await reopened.client.query(`
SELECT id
FROM admin_sessions
WHERE id = 'session-crash-probe'
LIMIT 1;
        `);
        expect(halfWrittenRows).toEqual([]);

        const recoveredSnapshot = await reopened.exportProviderPoolsSnapshot();
        expect(recoveredSnapshot['grok-custom'][0]).toMatchObject({
            customName: 'Crash Safe Grok',
            usageCount: 10,
            lastUsed: '2026-03-06T09:00:00.000Z'
        });

        await reopened.saveAdminSession('token-after-restart', {
            username: 'admin',
            loginTime: Date.parse('2026-03-06T11:30:00.000Z'),
            expiryTime: Date.parse('2099-03-06T14:00:00.000Z'),
            sourceIp: '127.0.0.3',
            userAgent: 'post-crash-write'
        });
        expect(await reopened.getAdminSession('token-after-restart')).toMatchObject({
            username: 'admin',
            sourceIp: '127.0.0.3',
            userAgent: 'post-crash-write'
        });

        await reopened.close();
    });

    test('should serialize concurrent usage, session and potluck writes with explicit last-write-wins semantics', async () => {
        const tempDir = await createTempDir('runtime-storage-concurrency-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        const firstUsageCache = {
            timestamp: '2026-03-06T10:00:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T10:00:00.000Z',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    processedCount: 1,
                    instances: [
                        {
                            uuid: 'grok-1',
                            success: true,
                            lastRefreshedAt: '2026-03-06T10:00:00.000Z'
                        }
                    ]
                }
            }
        };
        const secondUsageCache = {
            timestamp: '2026-03-06T10:05:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-06T10:05:00.000Z',
                    totalCount: 4,
                    successCount: 3,
                    errorCount: 1,
                    processedCount: 4,
                    instances: [
                        {
                            uuid: 'grok-1',
                            success: false,
                            lastRefreshedAt: '2026-03-06T10:05:00.000Z'
                        }
                    ]
                }
            }
        };

        const firstSession = {
            username: 'admin-a',
            loginTime: Date.parse('2026-03-06T10:00:00.000Z'),
            expiryTime: Date.parse('2099-03-07T10:00:00.000Z'),
            sourceIp: '127.0.0.1',
            userAgent: 'jest-concurrency-a'
        };
        const secondSession = {
            username: 'admin-b',
            loginTime: Date.parse('2026-03-06T10:10:00.000Z'),
            expiryTime: Date.parse('2099-03-07T11:00:00.000Z'),
            sourceIp: '127.0.0.2',
            userAgent: 'jest-concurrency-b'
        };

        const firstPotluckUsers = {
            config: {
                defaultDailyLimit: 111,
                bonusPerCredential: 11,
                bonusValidityDays: 7,
                persistInterval: 1000
            },
            users: {
                first_user: {
                    credentials: [
                        {
                            id: 'cred-first',
                            path: 'configs/first.json',
                            provider: 'grok-custom',
                            authMethod: 'api-key',
                            addedAt: '2026-03-06T10:00:00.000Z'
                        }
                    ],
                    credentialBonuses: [],
                    createdAt: '2026-03-06T10:00:00.000Z'
                }
            }
        };
        const secondPotluckUsers = {
            config: {
                defaultDailyLimit: 222,
                bonusPerCredential: 22,
                bonusValidityDays: 14,
                persistInterval: 2000
            },
            users: {
                second_user: {
                    credentials: [
                        {
                            id: 'cred-second',
                            path: 'configs/second.json',
                            provider: 'gemini-cli-oauth',
                            authMethod: 'refresh-token',
                            addedAt: '2026-03-06T10:05:00.000Z'
                        }
                    ],
                    credentialBonuses: [
                        {
                            credentialId: 'cred-second',
                            grantedAt: '2026-03-06T10:05:00.000Z',
                            usedCount: 1
                        }
                    ],
                    createdAt: '2026-03-06T10:05:00.000Z'
                }
            }
        };

        const firstPotluckKeys = {
            keys: {
                first_key: {
                    id: 'first_key',
                    name: 'First Key',
                    createdAt: '2026-03-06T10:00:00.000Z',
                    dailyLimit: 111,
                    todayUsage: 1,
                    totalUsage: 2,
                    lastResetDate: '2026-03-06',
                    lastUsedAt: '2026-03-06T10:01:00.000Z',
                    enabled: true,
                    bonusRemaining: 3
                }
            }
        };
        const secondPotluckKeys = {
            keys: {
                second_key: {
                    id: 'second_key',
                    name: 'Second Key',
                    createdAt: '2026-03-06T10:05:00.000Z',
                    dailyLimit: 222,
                    todayUsage: 4,
                    totalUsage: 9,
                    lastResetDate: '2026-03-06',
                    lastUsedAt: '2026-03-06T10:06:00.000Z',
                    enabled: false,
                    bonusRemaining: 8
                }
            }
        };

        await storage.initialize();
        await Promise.all([
            storage.replaceUsageCacheSnapshot(firstUsageCache),
            storage.saveAdminSession('token-1', firstSession),
            storage.savePotluckUserData(firstPotluckUsers),
            storage.savePotluckKeyStore(firstPotluckKeys),
            storage.replaceUsageCacheSnapshot(secondUsageCache),
            storage.saveAdminSession('token-1', secondSession),
            storage.savePotluckUserData(secondPotluckUsers),
            storage.savePotluckKeyStore(secondPotluckKeys),
            storage.saveAdminSession('token-1', secondSession)
        ]);

        const usageCache = await storage.loadUsageCacheSnapshot();
        expect(usageCache).toEqual(secondUsageCache);

        const session = await storage.getAdminSession('token-1');
        expect(session).toMatchObject(secondSession);

        const potluckUsers = await storage.loadPotluckUserData();
        expect(potluckUsers).toEqual(secondPotluckUsers);

        const potluckKeys = await storage.loadPotluckKeyStore();
        expect(potluckKeys).toEqual(secondPotluckKeys);

        const sessionCountRows = await storage.client.query('SELECT COUNT(*) AS count FROM admin_sessions;');
        const usageCountRows = await storage.client.query('SELECT COUNT(*) AS count FROM usage_snapshots;');
        const potluckUserRows = await storage.client.query('SELECT COUNT(*) AS count FROM potluck_users;');
        const potluckKeyRows = await storage.client.query('SELECT COUNT(*) AS count FROM potluck_api_keys;');

        expect(Number(sessionCountRows[0]?.count || 0)).toBe(1);
        expect(Number(usageCountRows[0]?.count || 0)).toBe(1);
        expect(Number(potluckUserRows[0]?.count || 0)).toBe(1);
        expect(Number(potluckKeyRows[0]?.count || 0)).toBe(1);

        await storage.close();
    });
});


describe('Runtime storage error and retry semantics', () => {
    test('should classify sqlite lock conflicts as retryable with bounded retry policy', async () => {
        const { serializeRuntimeStorageError, wrapRuntimeStorageError } = await import('../src/storage/runtime-storage-error.js');

        const error = new Error('database is locked');
        error.code = 'SQLITE_BUSY';

        const wrapped = wrapRuntimeStorageError(error, {
            phase: 'write',
            domain: 'provider',
            backend: 'db',
            operation: 'replaceProviderPoolsSnapshot',
            details: {
                idempotencyKey: 'provider_snapshot_replace_full',
                replaySafe: true,
                replayBoundary: 'provider_snapshot_replace',
                lockRetryWindowMs: 150
            }
        });

        expect(serializeRuntimeStorageError(wrapped)).toMatchObject({
            code: 'SQLITE_BUSY',
            classification: 'lock_conflict',
            retryable: true,
            policy: {
                action: 'retry_then_fallback',
                maxRetries: 2,
                fallbackToFile: true,
                blockCutover: false,
                warningOnly: false
            },
            details: expect.objectContaining({
                replaySafe: true,
                replayBoundary: 'provider_snapshot_replace',
                lockRetryWindowMs: 150
            })
        });
    });

    test('should classify JSON parse failures as non-retryable data errors', async () => {
        const { serializeRuntimeStorageError, wrapRuntimeStorageError } = await import('../src/storage/runtime-storage-error.js');

        const wrapped = wrapRuntimeStorageError(new SyntaxError('Unexpected token ] in JSON at position 0'), {
            phase: 'query',
            domain: 'runtime_storage',
            backend: 'db',
            operation: 'sqlite_query',
            details: {
                replaySafe: true,
                replayBoundary: 'sqlite_query_parse'
            }
        });

        expect(serializeRuntimeStorageError(wrapped)).toMatchObject({
            code: 'runtime_storage_invalid_data',
            classification: 'data_error',
            retryable: false,
            policy: {
                action: 'fail_fast',
                maxRetries: 0,
                fallbackToFile: false,
                blockCutover: true,
                warningOnly: false
            },
            details: expect.objectContaining({
                replaySafe: true,
                replayBoundary: 'sqlite_query_parse'
            })
        });
    });

    test.each([
        {
            title: 'provider mutation',
            method: 'replaceProviderPoolsSnapshot',
            args: [{ 'grok-custom': [] }],
            primaryResult: { 'grok-custom': [] },
            expectedDetails: {
                replayBoundary: 'provider_snapshot_replace',
                primaryCommitted: true,
                secondaryAttempted: true
            }
        },
        {
            title: 'runtime flush',
            method: 'flushProviderRuntimeState',
            args: [[{ providerId: 'prov_1', providerType: 'grok-custom', runtimeState: {} }]],
            primaryResult: { flushedCount: 1 },
            expectedDetails: {
                providerId: 'prov_1',
                replayBoundary: 'provider_runtime_state_upsert',
                primaryCommitted: true,
                secondaryAttempted: true
            }
        },
        {
            title: 'usage refresh task write',
            method: 'saveUsageRefreshTask',
            args: [{ id: 'task-1', providerType: 'grok-custom' }],
            primaryResult: { id: 'task-1' },
            expectedDetails: {
                taskId: 'task-1',
                replayBoundary: 'usage_refresh_task_upsert',
                primaryCommitted: true,
                secondaryAttempted: true
            }
        },
        {
            title: 'admin session write',
            method: 'saveAdminSession',
            args: ['token-1', { username: 'admin' }],
            primaryResult: { username: 'admin' },
            expectedDetails: {
                replayBoundary: 'admin_session_upsert',
                primaryCommitted: true,
                secondaryAttempted: true
            }
        },
        {
            title: 'potluck user store write',
            method: 'savePotluckUserData',
            args: [{ config: {}, users: { neko: {} } }],
            primaryResult: { config: {}, users: { neko: {} } },
            expectedDetails: {
                userCount: 1,
                replayBoundary: 'potluck_user_store_replace',
                primaryCommitted: true,
                secondaryAttempted: true
            }
        }
    ])('should expose replay-safe secondary failure diagnostics for $title', async ({ method, args, primaryResult, expectedDetails }) => {
        const { DualWriteRuntimeStorage } = await import('../src/storage/backends/dual-write-runtime-storage.js');
        const { serializeRuntimeStorageError } = await import('../src/storage/runtime-storage-error.js');

        const primaryStorage = {
            kind: 'db',
            getInfo: () => ({ backend: 'db' }),
            [method]: jest.fn(async () => primaryResult)
        };
        const secondaryStorage = {
            kind: 'file',
            getInfo: () => ({ backend: 'file' }),
            [method]: jest.fn(async () => {
                throw new Error('secondary write failed');
            })
        };
        const storage = new DualWriteRuntimeStorage(primaryStorage, secondaryStorage);

        let error = null;
        try {
            await storage[method](...args);
        } catch (caughtError) {
            error = caughtError;
        }

        expect(error).toBeTruthy();
        expect(error).toMatchObject({
            code: 'runtime_storage_secondary_write_failed',
            classification: 'secondary_write_failed',
            retryable: false,
            details: expect.objectContaining({
                idempotencyKey: expect.any(String),
                replaySafe: true,
                ...expectedDetails
            })
        });

        const serialized = serializeRuntimeStorageError(error);
        expect(serialized).toMatchObject({
            code: 'runtime_storage_secondary_write_failed',
            classification: 'secondary_write_failed',
            policy: {
                action: 'warn_and_hold_cutover',
                maxRetries: 0,
                fallbackToFile: false,
                blockCutover: true,
                warningOnly: true
            },
            details: expect.objectContaining(expectedDetails)
        });

        if (method === 'saveAdminSession') {
            expect(serialized.details.sessionKey).toMatch(/^session_/);
        }
    });

    test('should stop before secondary write when primary write fails', async () => {
        const { DualWriteRuntimeStorage } = await import('../src/storage/backends/dual-write-runtime-storage.js');
        const { serializeRuntimeStorageError } = await import('../src/storage/runtime-storage-error.js');

        const primaryStorage = {
            kind: 'db',
            getInfo: () => ({ backend: 'db' }),
            replaceProviderPoolsSnapshot: jest.fn(async () => {
                const error = new Error('database is locked');
                error.code = 'SQLITE_BUSY';
                throw error;
            })
        };
        const secondaryStorage = {
            kind: 'file',
            getInfo: () => ({ backend: 'file' }),
            replaceProviderPoolsSnapshot: jest.fn(async () => ({}))
        };
        const storage = new DualWriteRuntimeStorage(primaryStorage, secondaryStorage);

        let error = null;
        try {
            await storage.replaceProviderPoolsSnapshot({ 'grok-custom': [] });
        } catch (caughtError) {
            error = caughtError;
        }

        expect(error).toMatchObject({
            code: 'runtime_storage_primary_write_failed',
            classification: 'lock_conflict',
            retryable: true,
            details: expect.objectContaining({
                primaryCommitted: false,
                secondaryAttempted: false
            })
        });
        expect(secondaryStorage.replaceProviderPoolsSnapshot).not.toHaveBeenCalled();

        const serialized = serializeRuntimeStorageError(error);
        expect(serialized.policy).toMatchObject({
            action: 'retry_then_fallback',
            maxRetries: 2,
            fallbackToFile: true,
            blockCutover: false,
            warningOnly: false
        });
    });
});
