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

let createRuntimeStorage;
let splitProviderConfig;
let buildStableProviderId;
let buildProviderPoolsSnapshot;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function withWorkingDirectory(targetDir, callback) {
    const previousDir = process.cwd();
    process.chdir(targetDir);

    try {
        return await callback();
    } finally {
        process.chdir(previousDir);
    }
}

describe('Runtime storage foundation', () => {
    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        ({ createRuntimeStorage } = await import('../src/storage/runtime-storage-factory.js'));
        ({ splitProviderConfig, buildStableProviderId, buildProviderPoolsSnapshot } = await import('../src/storage/provider-storage-mapper.js'));
    });

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should split provider config into registration, runtime state and inline secrets', () => {
        const providerConfig = {
            uuid: 'grok-1',
            customName: 'Grok One',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'cookie-token',
            GROK_CF_CLEARANCE: 'cf-token',
            checkModelName: 'grok-3',
            isHealthy: false,
            isDisabled: true,
            usageCount: 9,
            errorCount: 2,
            lastErrorMessage: 'quota exhausted',
            refreshCount: 3,
            _lastSelectionSeq: 12,
            queueLimit: 8
        };

        const result = splitProviderConfig('grok-custom', providerConfig);

        expect(result.registration.providerType).toBe('grok-custom');
        expect(result.registration.routingUuid).toBe('grok-1');
        expect(result.registration.displayName).toBe('Grok One');
        expect(result.registration.checkModel).toBe('grok-3');
        expect(JSON.parse(result.registration.configJson)).toEqual({
            GROK_BASE_URL: 'https://grok.com',
            queueLimit: 8
        });

        expect(result.runtimeState).toMatchObject({
            isHealthy: false,
            isDisabled: true,
            usageCount: 9,
            errorCount: 2,
            lastErrorMessage: 'quota exhausted',
            refreshCount: 3,
            lastSelectionSeq: 12
        });

        expect(result.inlineSecrets).toEqual([
            expect.objectContaining({ secretKind: 'GROK_COOKIE_TOKEN' }),
            expect.objectContaining({ secretKind: 'GROK_CF_CLEARANCE' })
        ]);
    });

    test('should persist and export provider pools through sqlite runtime storage', async () => {
        const tempDir = await createTempDir('runtime-storage-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        await fs.mkdir(path.join(tempDir, 'configs', 'gemini'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'configs', 'gemini', 'account-1.json'), JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token'
        }, null, 2), 'utf8');
        const providerPools = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'cookie-token',
                    GROK_CF_CLEARANCE: 'cf-token',
                    isHealthy: false,
                    isDisabled: false,
                    usageCount: 5,
                    errorCount: 2,
                    lastErrorMessage: 'quota exhausted',
                    lastErrorTime: '2026-03-06T00:00:00.000Z',
                    lastHealthCheckTime: '2026-03-06T01:00:00.000Z',
                    lastHealthCheckModel: 'grok-3',
                    refreshCount: 4,
                    _lastSelectionSeq: 18,
                    checkModelName: 'grok-3',
                    queueLimit: 8
                }
            ],
            'gemini-cli-oauth': [
                {
                    uuid: 'gemini-1',
                    customName: 'Gemini One',
                    GEMINI_OAUTH_CREDS_FILE_PATH: './configs/gemini/account-1.json',
                    PROJECT_ID: 'project-1',
                    isHealthy: true,
                    usageCount: 1,
                    errorCount: 0,
                    refreshCount: 0,
                    checkModelName: 'gemini-2.5-pro'
                }
            ]
        };

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        });

        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot(providerPools);

        const exported = await storage.exportProviderPoolsSnapshot();

        expect(exported['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Grok One',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'cookie-token',
            GROK_CF_CLEARANCE: 'cf-token',
            isHealthy: false,
            usageCount: 5,
            errorCount: 2,
            lastHealthCheckModel: 'grok-3',
            checkModelName: 'grok-3',
            queueLimit: 8,
            _lastSelectionSeq: 18
        });
        expect(exported['gemini-cli-oauth'][0]).toMatchObject({
            uuid: 'gemini-1',
            customName: 'Gemini One',
            GEMINI_OAUTH_CREDS_FILE_PATH: './configs/gemini/account-1.json',
            PROJECT_ID: 'project-1',
            isHealthy: true,
            usageCount: 1,
            checkModelName: 'gemini-2.5-pro'
        });

        expect(await fs.stat(dbPath)).toBeTruthy();
    });

    test('should apply partial provider mutations without rewriting the full snapshot', async () => {
        const tempDir = await createTempDir('runtime-storage-partial-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        });

        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot({
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Original Grok',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'token-1',
                    isHealthy: true,
                    usageCount: 1
                },
                {
                    uuid: 'grok-2',
                    customName: 'Delete Me',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'token-2',
                    isHealthy: false,
                    errorCount: 2
                }
            ]
        });

        const initialSnapshot = await storage.exportProviderPoolsSnapshot();
        const existingProvider = initialSnapshot['grok-custom'][0];
        const providerToDelete = initialSnapshot['grok-custom'][1];
        const updatedProvider = {
            ...existingProvider,
            customName: 'Updated Grok',
            GROK_BASE_URL: 'https://api.grok.com',
            usageCount: 9
        };
        Object.defineProperty(updatedProvider, '__providerId', {
            value: existingProvider.__providerId,
            enumerable: false,
            configurable: true
        });

        await storage.upsertProviderPoolEntries([
            {
                providerType: 'grok-custom',
                providerConfig: updatedProvider
            }
        ], {
            sourceKind: 'partial_test'
        });

        await storage.updateProviderRoutingUuids([
            {
                providerId: existingProvider.__providerId,
                newRoutingUuid: 'grok-1-new'
            }
        ]);

        await storage.deleteProviderPoolEntries([
            {
                providerId: providerToDelete.__providerId
            }
        ]);

        const exported = await storage.exportProviderPoolsSnapshot();
        expect(exported['grok-custom']).toHaveLength(1);
        expect(exported['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1-new',
            customName: 'Updated Grok',
            GROK_BASE_URL: 'https://api.grok.com',
            GROK_COOKIE_TOKEN: 'token-1',
            usageCount: 9
        });
    });

    test('should split file-backed credentials into inventory tables while preserving compat snapshot', async () => {
        const tempDir = await createTempDir('runtime-storage-credential-split-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.mkdir(path.join(tempDir, 'configs', 'gemini'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'configs', 'gemini', 'account-1.json'), JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token'
        }, null, 2), 'utf8');

        await withWorkingDirectory(tempDir, async () => {
            const storage = createRuntimeStorage({
                RUNTIME_STORAGE_BACKEND: 'db',
                RUNTIME_STORAGE_DB_PATH: dbPath,
                PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
            });

            await storage.initialize();
            await storage.replaceProviderPoolsSnapshot({
                'gemini-cli-oauth': [
                    {
                        uuid: 'gemini-1',
                        customName: 'Gemini One',
                        GEMINI_OAUTH_CREDS_FILE_PATH: './configs/gemini/account-1.json',
                        PROJECT_ID: 'project-1',
                        checkModelName: 'gemini-2.5-pro'
                    }
                ]
            });

            const exported = await storage.exportProviderPoolsSnapshot();
            expect(exported['gemini-cli-oauth'][0]).toMatchObject({
                uuid: 'gemini-1',
                GEMINI_OAUTH_CREDS_FILE_PATH: './configs/gemini/account-1.json',
                PROJECT_ID: 'project-1',
                checkModelName: 'gemini-2.5-pro'
            });

            const registrationRows = await storage.client.query('SELECT config_json FROM provider_registrations;');
            expect(JSON.parse(registrationRows[0].config_json)).toEqual({
                PROJECT_ID: 'project-1'
            });

            const assetRows = await storage.client.query('SELECT provider_type, dedupe_key, source_path FROM credential_assets;');
            expect(assetRows).toHaveLength(1);
            expect(assetRows[0]).toMatchObject({
                provider_type: 'gemini-cli-oauth',
                source_path: 'configs/gemini/account-1.json'
            });

            const bindingRows = await storage.client.query("SELECT binding_type, binding_status FROM credential_bindings WHERE binding_type = 'provider_registration';");
            expect(bindingRows).toHaveLength(1);
            expect(bindingRows[0]).toMatchObject({
                binding_type: 'provider_registration',
                binding_status: 'active'
            });
        });
    });

    test('should dedupe auto-linked credential files by credential asset in sqlite runtime storage', async () => {
        const tempDir = await createTempDir('runtime-storage-link-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.mkdir(path.join(tempDir, 'configs', 'kiro'), { recursive: true });
        const sameCredentialPayload = {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            accessToken: 'access-token',
            refreshToken: 'refresh-token'
        };
        await fs.writeFile(path.join(tempDir, 'configs', 'kiro', 'first.json'), JSON.stringify(sameCredentialPayload, null, 2), 'utf8');
        await fs.writeFile(path.join(tempDir, 'configs', 'kiro', 'second.json'), JSON.stringify(sameCredentialPayload, null, 2), 'utf8');

        await withWorkingDirectory(tempDir, async () => {
            const storage = createRuntimeStorage({
                RUNTIME_STORAGE_BACKEND: 'db',
                RUNTIME_STORAGE_DB_PATH: dbPath,
                PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
            });

            await storage.initialize();
            const result = await storage.linkCredentialFiles([
                'configs/kiro/first.json',
                'configs/kiro/second.json'
            ]);

            expect(result.totalNewProviders).toBe(1);
            expect(result.providerPools['claude-kiro-oauth']).toHaveLength(1);

            const assetRows = await storage.client.query('SELECT id, provider_type FROM credential_assets;');
            expect(assetRows).toHaveLength(1);
            expect(assetRows[0].provider_type).toBe('claude-kiro-oauth');

            const bindingRows = await storage.client.query("SELECT id FROM credential_bindings WHERE binding_type = 'provider_registration' AND binding_status = 'active';");
            expect(bindingRows).toHaveLength(1);

            const fileIndexRows = await storage.client.query('SELECT file_path FROM credential_file_index ORDER BY file_path ASC;');
            expect(fileIndexRows).toEqual([
                { file_path: 'configs/kiro/first.json' },
                { file_path: 'configs/kiro/second.json' }
            ]);
        });
    });

    test('should keep stable provider id when uuid and runtime fields change', () => {
        const baseProvider = {
            uuid: 'grok-1',
            customName: 'Grok One',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'cookie-token',
            usageCount: 1,
            errorCount: 0,
            isHealthy: true,
            lastUsed: '2026-03-06T00:00:00.000Z'
        };

        const changedProvider = {
            ...baseProvider,
            uuid: 'grok-2',
            usageCount: 88,
            errorCount: 9,
            isHealthy: false,
            lastUsed: '2026-03-06T08:00:00.000Z'
        };

        expect(buildStableProviderId('grok-custom', changedProvider)).toBe(
            buildStableProviderId('grok-custom', baseProvider)
        );
    });

    test('should flush runtime state and routing uuid updates through sqlite runtime storage', async () => {
        const tempDir = await createTempDir('runtime-storage-flush-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerConfig = {
            uuid: 'grok-1',
            customName: 'Grok One',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'cookie-token',
            isHealthy: true,
            usageCount: 1,
            errorCount: 0,
            checkModelName: 'grok-3'
        };
        const providerPools = {
            'grok-custom': [providerConfig]
        };

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        });

        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot(providerPools);

        const providerId = splitProviderConfig('grok-custom', providerConfig).providerId;

        await storage.updateProviderRoutingUuid({
            providerId,
            providerType: 'grok-custom',
            oldRoutingUuid: 'grok-1',
            newRoutingUuid: 'grok-2'
        });

        await storage.flushProviderRuntimeState([
            {
                providerId,
                providerType: 'grok-custom',
                routingUuid: 'grok-2',
                persistSelectionState: false,
                runtimeState: {
                    isHealthy: false,
                    isDisabled: false,
                    usageCount: 7,
                    errorCount: 3,
                    lastUsed: '2026-03-06T02:00:00.000Z',
                    lastHealthCheckTime: '2026-03-06T03:00:00.000Z',
                    lastHealthCheckModel: 'grok-3',
                    lastErrorTime: '2026-03-06T04:00:00.000Z',
                    lastErrorMessage: 'quota exhausted',
                    scheduledRecoveryTime: '2026-03-06T05:00:00.000Z',
                    refreshCount: 4,
                    lastSelectionSeq: 99
                }
            }
        ], {
            persistSelectionState: false
        });

        const exported = await storage.exportProviderPoolsSnapshot();
        expect(exported['grok-custom'][0]).toMatchObject({
            uuid: 'grok-2',
            usageCount: 7,
            errorCount: 3,
            isHealthy: false,
            lastErrorMessage: 'quota exhausted',
            scheduledRecoveryTime: '2026-03-06T05:00:00.000Z'
        });
        expect(exported['grok-custom'][0]._lastSelectionSeq).toBeUndefined();
    });

    test('should map normalized provider rows into legacy-compatible snapshot with defaults and secret isolation', () => {
        const snapshot = buildProviderPoolsSnapshot([
            {
                provider_id: 'prov_grok_1',
                provider_type: 'grok-custom',
                routing_uuid: 'grok-1',
                display_name: 'Mapped Grok',
                check_model: 'grok-4',
                project_id: 'project-1',
                config_json: JSON.stringify({
                    GROK_BASE_URL: 'https://grok.com',
                    queueLimit: 3
                }),
                is_healthy: 0,
                is_disabled: 1,
                usage_count: '7',
                error_count: '2',
                last_used_at: '2026-03-06T02:00:00.123Z',
                last_health_check_at: '2026-03-06T03:00:00.123Z',
                last_health_check_model: 'grok-4',
                last_error_time: '2026-03-06T04:00:00.123Z',
                last_error_message: 'quota exhausted',
                scheduled_recovery_at: '2026-03-06T05:00:00.123Z',
                refresh_count: '9',
                last_selection_seq: '11'
            },
            {
                provider_id: 'prov_grok_2',
                provider_type: 'grok-custom',
                routing_uuid: 'grok-2',
                display_name: null,
                check_model: null,
                project_id: null,
                config_json: JSON.stringify({ GROK_BASE_URL: 'https://grok.com' }),
                is_healthy: null,
                is_disabled: null,
                usage_count: null,
                error_count: null,
                last_selection_seq: null
            }
        ], [
            {
                provider_id: 'prov_grok_1',
                secret_kind: 'GROK_COOKIE_TOKEN',
                secret_payload: JSON.stringify('secret-cookie')
            }
        ], []);

        expect(snapshot['grok-custom'][0]).toMatchObject({
            uuid: 'grok-1',
            customName: 'Mapped Grok',
            checkModelName: 'grok-4',
            PROJECT_ID: 'project-1',
            GROK_BASE_URL: 'https://grok.com',
            GROK_COOKIE_TOKEN: 'secret-cookie',
            isHealthy: false,
            isDisabled: true,
            usageCount: 7,
            errorCount: 2,
            lastUsed: '2026-03-06T02:00:00.123Z',
            lastHealthCheckTime: '2026-03-06T03:00:00.123Z',
            lastHealthCheckModel: 'grok-4',
            lastErrorTime: '2026-03-06T04:00:00.123Z',
            lastErrorMessage: 'quota exhausted',
            scheduledRecoveryTime: '2026-03-06T05:00:00.123Z',
            refreshCount: 9,
            _lastSelectionSeq: 11
        });
        expect(snapshot['grok-custom'][0].GROK_OAUTH_CREDS_FILE_PATH).toBeUndefined();
        expect(snapshot['grok-custom'][1]).toMatchObject({
            uuid: 'grok-2',
            GROK_BASE_URL: 'https://grok.com',
            isHealthy: true,
            isDisabled: false,
            usageCount: 0,
            errorCount: 0,
            refreshCount: 0
        });
        expect(snapshot['grok-custom'][1]._lastSelectionSeq).toBeUndefined();
    });

    test('should ignore invalid credential links and reject incomplete routing updates', async () => {
        const tempDir = await createTempDir('runtime-storage-invalid-link-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');

        await fs.mkdir(path.join(tempDir, 'configs', 'gemini'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'configs', 'gemini', 'account-1.txt'), 'not-json', 'utf8');

        await withWorkingDirectory(tempDir, async () => {
            const storage = createRuntimeStorage({
                RUNTIME_STORAGE_BACKEND: 'db',
                RUNTIME_STORAGE_DB_PATH: dbPath,
                PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
            });

            await storage.initialize();
            const linkResult = await storage.linkCredentialFiles([
                '',
                'configs/gemini/missing.json',
                'configs/gemini/account-1.txt'
            ]);

            expect(linkResult).toMatchObject({
                totalNewProviders: 0,
                allNewProviders: {}
            });
            expect(linkResult.providerPools).toEqual({});

            await expect(storage.updateProviderRoutingUuid({
                providerType: 'grok-custom'
            })).resolves.toEqual({ updated: false });
        });
    });

    test('should fail fast with readable conflict when provider identities collide', async () => {
        const tempDir = await createTempDir('runtime-storage-provider-id-conflict-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');

        await fs.mkdir(path.join(tempDir, 'configs', 'codex'), { recursive: true });
        const credentialPath = path.join(tempDir, 'configs', 'codex', 'shared.json');
        await fs.writeFile(credentialPath, JSON.stringify({ refresh_token: 'shared-token' }, null, 2), 'utf8');

        const storage = createRuntimeStorage({
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        await storage.initialize();

        await expect(storage.replaceProviderPoolsSnapshot({
            'openai-codex-oauth': [
                {
                    uuid: 'codex-1',
                    customName: 'Shared Codex',
                    CODEX_OAUTH_CREDS_FILE_PATH: credentialPath,
                    OPENAI_BASE_URL: 'https://api.example.com/v1'
                },
                {
                    uuid: 'codex-2',
                    customName: 'Shared Codex',
                    CODEX_OAUTH_CREDS_FILE_PATH: credentialPath,
                    OPENAI_BASE_URL: 'https://api.example.com/v1'
                }
            ]
        })).rejects.toMatchObject({
            code: 'runtime_storage_provider_identity_conflict',
            classification: 'constraint_conflict',
            phase: 'write',
            details: expect.objectContaining({
                providerId: expect.any(String),
                previousProviderType: 'openai-codex-oauth',
                currentProviderType: 'openai-codex-oauth'
            })
        });

        await storage.close();
    });

    test('should preserve previous provider snapshot when sqlite replace write fails', async () => {
        const tempDir = await createTempDir('runtime-storage-rollback-');
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
                    customName: 'Stable Grok',
                    GROK_COOKIE_TOKEN: 'stable-token'
                }
            ]
        });

        const snapshotBefore = await storage.exportProviderPoolsSnapshot();
        const originalExec = storage.client.exec;
        storage.client.exec = jest.fn(async () => {
            throw new Error('transaction failed');
        });

        await expect(storage.replaceProviderPoolsSnapshot({
            'grok-custom': [
                {
                    uuid: 'grok-2',
                    customName: 'Broken Grok',
                    GROK_COOKIE_TOKEN: 'broken-token'
                }
            ]
        })).rejects.toThrow('transaction failed');

        const snapshotAfter = await storage.exportProviderPoolsSnapshot();
        expect(snapshotAfter).toEqual(snapshotBefore);

        storage.client.exec = originalExec;
        await storage.close();
    });
});
