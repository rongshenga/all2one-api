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

let exportLegacyRuntimeStorage;
let getRuntimeStorageMigrationRun;
let listRuntimeStorageMigrationRuns;
let migrateLegacyRuntimeStorage;
let rollbackRuntimeStorageMigration;
let verifyRuntimeStorageMigration;
let SqliteRuntimeStorage;

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function createRuntimeMigrationFixture(prefix = 'runtime-storage-fixture-', overrides = {}) {
    const tempDir = await createTempDir(prefix);
    const dbPath = path.join(tempDir, 'runtime.sqlite');
    const artifactRoot = path.join(tempDir, 'artifacts');
    const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
    const usageCachePath = path.join(tempDir, 'usage-cache.json');
    const tokenStorePath = path.join(tempDir, 'token-store.json');
    const apiPotluckDataPath = path.join(tempDir, 'api-potluck-data.json');
    const apiPotluckKeysPath = path.join(tempDir, 'api-potluck-keys.json');
    const credentialPath = path.join(tempDir, 'gemini', 'account-1.json');

    await fs.mkdir(path.dirname(credentialPath), { recursive: true });
    if (overrides.writeCredential !== false) {
        await fs.writeFile(credentialPath, JSON.stringify(
            overrides.credentialPayload || { refreshToken: 'fixture-refresh-token' },
            null,
            2
        ), 'utf8');
    }

    const sourceProviderPools = overrides.providerPools ?? {
        'grok-custom': [
            {
                uuid: 'grok-fixture-1',
                customName: 'Fixture Grok',
                GROK_BASE_URL: 'https://grok.fixture.example.com',
                GROK_COOKIE_TOKEN: 'fixture-cookie-token',
                checkModelName: 'grok-3',
                isHealthy: false,
                isDisabled: false,
                usageCount: 5,
                errorCount: 2,
                lastErrorMessage: 'quota exhausted',
                lastErrorTime: '2026-03-01T10:00:00.000Z',
                lastHealthCheckTime: '2026-03-01T10:10:00.000Z',
                lastHealthCheckModel: 'grok-3',
                refreshCount: 4,
                queueLimit: 8
            }
        ],
        'gemini-cli-oauth': [
            {
                uuid: 'gemini-fixture-1',
                customName: 'Fixture Gemini',
                GEMINI_OAUTH_CREDS_FILE_PATH: credentialPath,
                PROJECT_ID: 'fixture-project-1',
                isHealthy: true,
                usageCount: 1,
                errorCount: 0,
                refreshCount: 0,
                checkModelName: 'gemini-2.5-pro'
            }
        ]
    };
    const sourceUsageCache = overrides.usageCache ?? {
        timestamp: '2026-03-01T10:30:00.000Z',
        providers: {
            'grok-custom': {
                providerType: 'grok-custom',
                timestamp: '2026-03-01T10:30:00.000Z',
                totalCount: 3,
                successCount: 2,
                errorCount: 1,
                processedCount: 3,
                instances: [
                    {
                        uuid: 'grok-fixture-1',
                        success: true,
                        lastRefreshedAt: '2026-03-01T10:30:00.000Z'
                    }
                ]
            }
        }
    };
    const sourceTokenStore = overrides.tokenStore ?? {
        tokens: {
            fixture_admin_token: {
                username: 'admin',
                loginTime: Date.parse('2026-03-06T10:00:00.000Z'),
                expiryTime: Date.parse('2099-03-07T12:00:00.000Z'),
                sourceIp: '127.0.0.1',
                userAgent: 'jest-runtime-fixture'
            }
        }
    };
    const sourceApiPotluckData = overrides.apiPotluckData ?? {
        config: {
            defaultDailyLimit: 500,
            bonusPerCredential: 300,
            bonusValidityDays: 30,
            persistInterval: 5000
        },
        users: {
            fixture_user: {
                credentials: [
                    {
                        id: 'fixture_cred_1',
                        path: credentialPath,
                        provider: 'gemini-cli-oauth',
                        authMethod: 'refresh-token',
                        addedAt: '2026-03-01T10:05:00.000Z'
                    }
                ],
                credentialBonuses: [
                    {
                        credentialId: 'fixture_cred_1',
                        grantedAt: '2026-03-01T10:06:00.000Z',
                        usedCount: 0
                    }
                ],
                createdAt: '2026-03-01T10:00:00.000Z'
            }
        }
    };
    const sourceApiPotluckKeys = overrides.apiPotluckKeys ?? {
        keys: {
            fixture_key: {
                id: 'fixture_key',
                name: 'Fixture User',
                createdAt: '2026-03-01T10:00:00.000Z',
                dailyLimit: 500,
                todayUsage: 10,
                totalUsage: 25,
                lastResetDate: '2026-03-01',
                lastUsedAt: '2026-03-01T10:20:00.000Z',
                enabled: true,
                bonusRemaining: 100
            }
        }
    };

    if (typeof overrides.providerPoolsRaw === 'string') {
        await fs.writeFile(providerPoolsPath, overrides.providerPoolsRaw, 'utf8');
    } else {
        await writeJson(providerPoolsPath, sourceProviderPools);
    }

    if (typeof overrides.usageCacheRaw === 'string') {
        await fs.writeFile(usageCachePath, overrides.usageCacheRaw, 'utf8');
    } else {
        await writeJson(usageCachePath, sourceUsageCache);
    }

    if (typeof overrides.tokenStoreRaw === 'string') {
        await fs.writeFile(tokenStorePath, overrides.tokenStoreRaw, 'utf8');
    } else {
        await writeJson(tokenStorePath, sourceTokenStore);
    }

    if (typeof overrides.apiPotluckDataRaw === 'string') {
        await fs.writeFile(apiPotluckDataPath, overrides.apiPotluckDataRaw, 'utf8');
    } else {
        await writeJson(apiPotluckDataPath, sourceApiPotluckData);
    }

    if (typeof overrides.apiPotluckKeysRaw === 'string') {
        await fs.writeFile(apiPotluckKeysPath, overrides.apiPotluckKeysRaw, 'utf8');
    } else {
        await writeJson(apiPotluckKeysPath, sourceApiPotluckKeys);
    }

    const config = {
        PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
        USAGE_CACHE_FILE_PATH: usageCachePath,
        TOKEN_STORE_FILE_PATH: tokenStorePath,
        API_POTLUCK_DATA_FILE_PATH: apiPotluckDataPath,
        API_POTLUCK_KEYS_FILE_PATH: apiPotluckKeysPath,
        RUNTIME_STORAGE_DB_PATH: dbPath,
        RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT: artifactRoot,
        RUNTIME_STORAGE_BACKEND: 'db'
    };

    return {
        tempDir,
        dbPath,
        artifactRoot,
        providerPoolsPath,
        usageCachePath,
        tokenStorePath,
        apiPotluckDataPath,
        apiPotluckKeysPath,
        credentialPath,
        config,
        sourceProviderPools,
        sourceUsageCache,
        sourceTokenStore,
        sourceApiPotluckData,
        sourceApiPotluckKeys
    };
}

describe('Runtime storage migration service', () => {
    beforeAll(async () => {
        jest.resetModules();
        jest.doMock('../src/utils/logger.js', () => ({
            __esModule: true,
            default: mockLogger
        }));

        ({
            exportLegacyRuntimeStorage,
            getRuntimeStorageMigrationRun,
            listRuntimeStorageMigrationRuns,
            migrateLegacyRuntimeStorage,
            rollbackRuntimeStorageMigration,
            verifyRuntimeStorageMigration
        } = await import('../src/storage/runtime-storage-migration-service.js'));
        ({ SqliteRuntimeStorage } = await import('../src/storage/backends/sqlite-runtime-storage.js'));
    });

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockLogger.initialize.mockClear();
        mockLogger.cleanupOldLogs.mockClear();
    });

    test('should migrate, verify, export and rollback runtime storage artifacts', async () => {
        const tempDir = await createTempDir('runtime-storage-migration-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const artifactRoot = path.join(tempDir, 'artifacts');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const usageCachePath = path.join(tempDir, 'usage-cache.json');
        const tokenStorePath = path.join(tempDir, 'token-store.json');
        const apiPotluckDataPath = path.join(tempDir, 'api-potluck-data.json');
        const apiPotluckKeysPath = path.join(tempDir, 'api-potluck-keys.json');
        const credentialPath = path.join(tempDir, 'gemini', 'gemini-account.json');
        const duplicateCredentialPath = path.join(tempDir, 'gemini', 'gemini-account-copy.json');
        const orphanCredentialPath = path.join(tempDir, 'gemini', 'orphan-account.json');
        const invalidCredentialPath = path.join(tempDir, 'gemini', 'invalid-account.json');
        const brokenCredentialPath = path.join(tempDir, 'gemini', 'broken-account.json');
        const providerPoolsTmpPath = path.join(tempDir, 'provider_pools.json.20260306.tmp');

        await fs.mkdir(path.dirname(credentialPath), { recursive: true });
        await fs.writeFile(credentialPath, JSON.stringify({ refreshToken: 'refresh-token' }, null, 2), 'utf8');
        await fs.writeFile(duplicateCredentialPath, JSON.stringify({ refreshToken: 'refresh-token' }, null, 2), 'utf8');
        await fs.writeFile(orphanCredentialPath, JSON.stringify({ refreshToken: 'orphan-refresh-token' }, null, 2), 'utf8');
        await fs.writeFile(invalidCredentialPath, JSON.stringify({ hello: 'world' }, null, 2), 'utf8');
        await fs.writeFile(brokenCredentialPath, '{"broken":', 'utf8');
        await fs.writeFile(providerPoolsTmpPath, JSON.stringify({ stale: true }, null, 2), 'utf8');

        const existingSnapshot = {
            'openai-custom': [
                {
                    uuid: 'existing-openai-1',
                    customName: 'Existing OpenAI',
                    OPENAI_BASE_URL: 'https://api.openai.com/v1',
                    OPENAI_API_KEY: 'existing-key',
                    isHealthy: true,
                    usageCount: 1,
                    errorCount: 0,
                    checkModelName: 'gpt-4.1'
                }
            ]
        };

        const seedStorage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });
        await seedStorage.initialize();
        await seedStorage.replaceProviderPoolsSnapshot(existingSnapshot, { sourceKind: 'seed' });

        const sourceProviderPools = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: 'Grok One',
                    GROK_BASE_URL: 'https://grok.example.com',
                    GROK_COOKIE_TOKEN: 'cookie-token',
                    checkModelName: 'grok-3',
                    isHealthy: false,
                    isDisabled: false,
                    usageCount: 5,
                    errorCount: 2,
                    lastErrorMessage: 'quota exhausted',
                    lastErrorTime: '2026-03-01T10:00:00.000Z',
                    lastHealthCheckTime: '2026-03-01T10:10:00.000Z',
                    lastHealthCheckModel: 'grok-3',
                    refreshCount: 4,
                    queueLimit: 8
                }
            ],
            'gemini-cli-oauth': [
                {
                    uuid: 'gemini-1',
                    customName: 'Gemini One',
                    GEMINI_OAUTH_CREDS_FILE_PATH: credentialPath,
                    PROJECT_ID: 'project-1',
                    isHealthy: true,
                    usageCount: 1,
                    errorCount: 0,
                    refreshCount: 0,
                    checkModelName: 'gemini-2.5-pro'
                }
            ]
        };

        const sourceUsageCache = {
            timestamp: '2026-03-01T10:30:00.000Z',
            providers: {
                'grok-custom': {
                    providerType: 'grok-custom',
                    timestamp: '2026-03-01T10:30:00.000Z',
                    totalCount: 3,
                    successCount: 2,
                    errorCount: 1,
                    processedCount: 3,
                    instances: [
                        {
                            uuid: 'grok-1',
                            success: true,
                            lastRefreshedAt: '2026-03-01T10:30:00.000Z'
                        }
                    ]
                }
            }
        };

        const sourceApiPotluckData = {
            config: {
                defaultDailyLimit: 500,
                bonusPerCredential: 300,
                bonusValidityDays: 30,
                persistInterval: 5000
            },
            users: {
                'maki_demo_user': {
                    credentials: [
                        {
                            id: 'cred_demo_1',
                            path: credentialPath,
                            provider: 'gemini-cli-oauth',
                            authMethod: 'refresh-token',
                            addedAt: '2026-03-01T10:05:00.000Z'
                        }
                    ],
                    credentialBonuses: [
                        {
                            credentialId: 'cred_demo_1',
                            grantedAt: '2026-03-01T10:06:00.000Z',
                            usedCount: 0
                        }
                    ],
                    createdAt: '2026-03-01T10:00:00.000Z'
                }
            }
        };

        const sourceApiPotluckKeys = {
            keys: {
                'maki_demo_key': {
                    id: 'maki_demo_key',
                    name: 'Demo User',
                    createdAt: '2026-03-01T10:00:00.000Z',
                    dailyLimit: 500,
                    todayUsage: 10,
                    totalUsage: 25,
                    lastResetDate: '2026-03-01',
                    lastUsedAt: '2026-03-01T10:20:00.000Z',
                    enabled: true,
                    bonusRemaining: 100
                }
            }
        };

        const sourceTokenStore = {
            tokens: {
                admin_token_1: {
                    username: 'admin',
                    loginTime: Date.parse('2026-03-06T10:00:00.000Z'),
                    expiryTime: Date.parse('2099-03-07T12:00:00.000Z'),
                    sourceIp: '127.0.0.1',
                    userAgent: 'jest-migration-test'
                }
            }
        };

        await writeJson(providerPoolsPath, sourceProviderPools);
        await writeJson(usageCachePath, sourceUsageCache);
        await writeJson(tokenStorePath, sourceTokenStore);
        await writeJson(apiPotluckDataPath, sourceApiPotluckData);
        await writeJson(apiPotluckKeysPath, sourceApiPotluckKeys);

        const config = {
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            USAGE_CACHE_FILE_PATH: usageCachePath,
            TOKEN_STORE_FILE_PATH: tokenStorePath,
            API_POTLUCK_DATA_FILE_PATH: apiPotluckDataPath,
            API_POTLUCK_KEYS_FILE_PATH: apiPotluckKeysPath,
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT: artifactRoot,
            RUNTIME_STORAGE_BACKEND: 'db'
        };

        const migrationResult = await migrateLegacyRuntimeStorage(config, {
            execute: true,
            force: true
        });

        expect(migrationResult.dryRun).toBe(false);
        expect(migrationResult.report.overallStatus).toBe('pass');
        expect(migrationResult.report.validationStatus).toBe('pass');
        expect(migrationResult.report.cutoverGate).toMatchObject({
            status: 'pass',
            canCutover: true,
            blockers: []
        });
        expect(await fs.stat(path.join(migrationResult.artifactPaths.exportDir, 'provider_pools.json'))).toBeTruthy();
        expect(await fs.stat(path.join(migrationResult.artifactPaths.reportsDir, 'diff-report.json'))).toBeTruthy();
        expect(await fs.stat(path.join(migrationResult.artifactPaths.reportsDir, 'acceptance-summary.json'))).toBeTruthy();
        expect(await fs.stat(migrationResult.artifactPaths.inventoryReportPath)).toBeTruthy();
        expect(await fs.stat(migrationResult.artifactPaths.anomalyReportPath)).toBeTruthy();

        const migratedStorage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            TOKEN_STORE_FILE_PATH: tokenStorePath
        });
        await migratedStorage.initialize();
        await writeJson(tokenStorePath, { tokens: {} });
        expect(await migratedStorage.getAdminSession('admin_token_1')).toMatchObject({
            username: 'admin',
            sourceIp: '127.0.0.1',
            userAgent: 'jest-migration-test'
        });
        await migratedStorage.close();
        await writeJson(tokenStorePath, sourceTokenStore);

        const inventoryReport = JSON.parse(await fs.readFile(migrationResult.artifactPaths.inventoryReportPath, 'utf8'));
        const anomalyReport = JSON.parse(await fs.readFile(migrationResult.artifactPaths.anomalyReportPath, 'utf8'));
        const acceptanceSummary = JSON.parse(await fs.readFile(path.join(migrationResult.artifactPaths.reportsDir, 'acceptance-summary.json'), 'utf8'));
        const tokenStoreInventoryItem = inventoryReport.items.find((item) => item.itemType === 'token_store_file');
        expect(tokenStoreInventoryItem).toBeTruthy();
        expect(tokenStoreInventoryItem.parseStatus).toBe('parsed');
        expect(tokenStoreInventoryItem.recordCount).toBe(1);
        expect(anomalyReport.summary.codeCounts).toMatchObject({
            provider_pools_tmp_file: 1,
            orphan_credential_file: expect.any(Number),
            duplicate_credential_file: 1,
            invalid_credential_file: 1,
            parse_failed_credential_file: 1
        });
        expect(acceptanceSummary.provider.actual).toMatchObject({
            providerTypeCount: 2,
            providerCount: 2,
            healthyCount: 1,
            unhealthyCount: 1
        });
        expect(acceptanceSummary.credentials).toMatchObject({
            assetCount: 1,
            bindingCount: 2,
            dedupeGroupCount: 1,
            dedupeHitCount: 1
        });
        expect(acceptanceSummary.usage).toMatchObject({
            providerCount: 1,
            totalCount: 3,
            successCount: 2,
            errorCount: 1
        });
        expect(acceptanceSummary.sessions).toMatchObject({
            sessionCount: 1,
            uniqueTokenHashCount: 1
        });
        expect(acceptanceSummary.potluckData).toMatchObject({
            userCount: 1,
            credentialCount: 1,
            bonusCount: 1
        });
        expect(acceptanceSummary.potluckKeys).toMatchObject({
            keyCount: 1,
            enabledCount: 1
        });
        expect(acceptanceSummary.inputSnapshotVersion).toEqual(expect.any(String));
        expect(acceptanceSummary.rollbackPoint).toMatchObject({
            sqliteBackupDir: migrationResult.artifactPaths.beforeDir,
            sourceBackupDir: migrationResult.artifactPaths.sourceDir
        });

        const verifyResult = await verifyRuntimeStorageMigration(config, {
            runId: migrationResult.runId,
            failOnDiff: true
        });
        expect(verifyResult.overallStatus).toBe('pass');
        expect(verifyResult.validationStatus).toBe('pass');
        expect(verifyResult.crashRecovery).toMatchObject({
            durableBoundary: 'only_committed_transactions_and_successful_flush_batches_are_durable',
            lossWindow: 'unflushed_hot_state_only'
        });
        expect(verifyResult.domains.providerRegistry).toMatchObject({
            status: 'pass',
            expectedCount: 2,
            actualCount: 2,
            expectedHash: expect.any(String),
            actualHash: expect.any(String)
        });
        expect(verifyResult.domains.sessions).toMatchObject({
            status: 'pass',
            expectedCount: 1,
            actualCount: 1
        });
        expect(verifyResult.databaseSummary).toMatchObject({
            sessionCount: 1
        });
        expect(verifyResult.featureFlagFallback).toMatchObject({
            RUNTIME_STORAGE_BACKEND: 'file',
            RUNTIME_STORAGE_DUAL_WRITE: false,
            triggeredBy: 'verifyRuntimeStorageMigration'
        });
        expect(verifyResult.acceptanceSummary.credentials).toMatchObject({
            dedupeHitCount: 1
        });
        const diffMarkdown = await fs.readFile(path.join(migrationResult.artifactPaths.reportsDir, 'diff-report.md'), 'utf8');
        expect(diffMarkdown).toContain('## Crash Recovery');
        expect(diffMarkdown).toContain('Durable Boundary: only_committed_transactions_and_successful_flush_batches_are_durable');

        const exportedBundle = await exportLegacyRuntimeStorage(config, {
            domains: ['provider-pools', 'usage-cache', 'api-potluck-data', 'api-potluck-keys']
        });
        expect(Object.keys(exportedBundle.providerPools).sort()).toEqual(Object.keys(sourceProviderPools).sort());
        expect(exportedBundle.providerPools).toMatchObject(sourceProviderPools);
        expect(exportedBundle.usageCache).toEqual(sourceUsageCache);
        expect(exportedBundle.sessionSummary).toMatchObject({
            sessionCount: 1
        });
        expect(exportedBundle.apiPotluckData).toEqual(sourceApiPotluckData);
        expect(exportedBundle.apiPotluckKeys).toEqual(sourceApiPotluckKeys);

        const secondVerifyResult = await verifyRuntimeStorageMigration(config, {
            runId: migrationResult.runId,
            failOnDiff: true
        });
        expect(secondVerifyResult.overallStatus).toBe('pass');

        const secondExportedBundle = await exportLegacyRuntimeStorage(config, {
            domains: ['provider-pools', 'usage-cache', 'api-potluck-data', 'api-potluck-keys']
        });
        expect(secondExportedBundle.providerPools).toMatchObject(sourceProviderPools);
        expect(secondExportedBundle.usageCache).toEqual(sourceUsageCache);

        await migratedStorage.client.exec(`
BEGIN IMMEDIATE;
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
    'session-crash-reimport',
    'token-hash-crash-reimport',
    'admin',
    '2026-03-06T13:30:00.000Z',
    '2026-03-06T11:30:00.000Z',
    '2026-03-06T11:30:00.000Z',
    '127.0.0.2',
    'migration-crash-probe',
    '{"username":"admin"}'
);
UPDATE runtime_storage_meta
SET meta_value = 'crash-probe'
WHERE meta_key = 'schema_version';
        `);
        await migratedStorage.close();

        const crashRecoveredBundle = await exportLegacyRuntimeStorage(config, {
            domains: ['provider-pools', 'usage-cache']
        });
        expect(crashRecoveredBundle.providerPools).toMatchObject(sourceProviderPools);
        expect(crashRecoveredBundle.usageCache).toEqual(sourceUsageCache);

        const runs = await listRuntimeStorageMigrationRuns(config);
        expect(runs[0].id).toBe(migrationResult.runId);

        const runDetail = await getRuntimeStorageMigrationRun(config, migrationResult.runId);
        expect(runDetail).toBeTruthy();
        expect(runDetail.items.length).toBeGreaterThan(0);
        expect(runDetail.items.some((item) => item.item_type === 'token_store_file' && item.detail_json.parseStatus === 'parsed')).toBe(true);
        expect(runDetail.items.some((item) => item.item_type === 'token_store' && item.detail_json.sessionCount === 1)).toBe(true);
        expect(runDetail.summary_json).toMatchObject({
            verificationStatus: 'pass',
            validationStatus: 'pass',
            cutoverGate: {
                status: 'pass',
                canCutover: true
            }
        });

        await writeJson(tokenStorePath, { tokens: { overwritten: true } });

        const rollbackResult = await rollbackRuntimeStorageMigration(config, {
            runId: migrationResult.runId
        });
        expect(rollbackResult.restoredFiles.length).toBeGreaterThan(0);
        expect(rollbackResult.restoredFiles).toContain(tokenStorePath);
        expect(JSON.parse(await fs.readFile(tokenStorePath, 'utf8'))).toEqual(sourceTokenStore);

        const secondRollbackResult = await rollbackRuntimeStorageMigration(config, {
            runId: migrationResult.runId
        });
        expect(secondRollbackResult.restoredFiles).toContain(tokenStorePath);

        const rolledBackBundle = await exportLegacyRuntimeStorage(config, {
            domains: ['provider-pools']
        });
        expect(Object.keys(rolledBackBundle.providerPools).sort()).toEqual(Object.keys(existingSnapshot).sort());
        expect(rolledBackBundle.providerPools).toMatchObject(existingSnapshot);

        const rerunMigrationResult = await migrateLegacyRuntimeStorage(config, {
            execute: true,
            force: true
        });
        expect(rerunMigrationResult.dryRun).toBe(false);
        expect(rerunMigrationResult.report.overallStatus).toBe('pass');
    });

    test('should preserve usage cache compat export when potluck migration clears plugin domain', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-usage-compat-preserve-', {
            usageCache: {
                timestamp: '2026-03-01T10:31:00.000Z',
                providers: {
                    'grok-custom': {
                        providerType: 'grok-custom',
                        timestamp: '2026-03-01T10:30:00.000Z',
                        totalCount: 3,
                        successCount: 2,
                        errorCount: 1,
                        processedCount: 3,
                        instances: [
                            {
                                uuid: 'grok-fixture-1',
                                name: 'grok-fixture-1',
                                success: true,
                                error: null,
                                isDisabled: false,
                                isHealthy: true,
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
                                },
                                lastRefreshedAt: '2026-03-01T10:30:00.000Z'
                            }
                        ]
                    },
                    'gemini-cli-oauth': {
                        providerType: 'gemini-cli-oauth',
                        timestamp: '2026-03-01T10:29:30.000Z',
                        totalCount: 1,
                        successCount: 1,
                        errorCount: 0,
                        processedCount: 1,
                        instances: []
                    }
                }
            },
            apiPotluckData: {
                config: {
                    defaultDailyLimit: 500
                },
                users: {}
            },
            apiPotluckKeys: {
                keys: {}
            }
        });

        const result = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true
        });
        const exportedUsageCache = await readJson(path.join(result.artifactPaths.exportDir, 'usage-cache.json'));

        expect(result.report.overallStatus).toBe('pass');
        expect(result.report.domains.usagePlugin).toMatchObject({
            status: 'pass',
            subdomains: {
                usageCache: {
                    status: 'pass'
                }
            }
        });
        expect(exportedUsageCache.timestamp).toBe(fixture.sourceUsageCache.timestamp);
        expect(exportedUsageCache.providers).toEqual(fixture.sourceUsageCache.providers);
    });

    test('should throw diff report when failOnDiff detects mismatched source bundle', async () => {
        const tempDir = await createTempDir('runtime-storage-verify-fail-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const usageCachePath = path.join(tempDir, 'usage-cache.json');
        const apiPotluckDataPath = path.join(tempDir, 'api-potluck-data.json');
        const apiPotluckKeysPath = path.join(tempDir, 'api-potluck-keys.json');

        const storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });
        await storage.initialize();
        await storage.close();

        const config = {
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath,
            USAGE_CACHE_FILE_PATH: usageCachePath,
            API_POTLUCK_DATA_FILE_PATH: apiPotluckDataPath,
            API_POTLUCK_KEYS_FILE_PATH: apiPotluckKeysPath,
            RUNTIME_STORAGE_DB_PATH: dbPath,
            RUNTIME_STORAGE_BACKEND: 'db'
        };

        const sourceBundle = {
            providerPools: {
                'grok-custom': [
                    {
                        uuid: 'grok-1',
                        customName: 'Expected Grok',
                        GROK_COOKIE_TOKEN: 'expected-token',
                        isHealthy: true,
                        isDisabled: false,
                        usageCount: 1,
                        errorCount: 0,
                        refreshCount: 0,
                        checkModelName: 'grok-3'
                    }
                ]
            },
            usageCache: {
                timestamp: '2026-03-06T00:00:00.000Z',
                providers: {}
            },
            apiPotluckData: {
                config: {},
                users: {}
            },
            apiPotluckKeys: {
                keys: {}
            }
        };

        await expect(verifyRuntimeStorageMigration(config, {
            sourceBundle,
            failOnDiff: true
        })).rejects.toMatchObject({
            message: 'Runtime storage migration verification failed',
            code: 'runtime_storage_validation_failed',
            classification: 'migration_validation_failed',
            retryable: false,
            report: expect.objectContaining({
                overallStatus: 'fail'
            }),
            details: expect.objectContaining({
                replaySafe: true,
                replayBoundary: 'migration_verify_report'
            })
        });
    });

    test.each([
        {
            name: 'empty provider pools file',
            providerPoolsRaw: '',
            expectedParseStatus: 'parse_failed'
        },
        {
            name: 'invalid provider pools json',
            providerPoolsRaw: '{"grok-custom":',
            expectedParseStatus: 'parse_failed'
        }
    ])('should inventory $name without breaking migration', async ({ providerPoolsRaw, expectedParseStatus }) => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-provider-file-', {
            providerPoolsRaw
        });

        const result = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true
        });
        const inventoryReport = await readJson(result.artifactPaths.inventoryReportPath);
        const providerPoolsItem = inventoryReport.items.find((item) => item.itemType === 'provider_pools_file');

        expect(result.report.overallStatus).toBe('pass');
        expect(providerPoolsItem).toMatchObject({
            parseStatus: expectedParseStatus,
            recordCount: 0
        });
        expect(result.report.domains.providerRegistry).toMatchObject({
            status: 'pass',
            expectedCount: 0,
            actualCount: 0
        });
    });

    test('should normalize mixed provider records with defaults and file credentials', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-provider-mixed-');

        const providerPools = {
            'grok-custom': [
                {
                    uuid: 'grok-edge-1',
                    customName: 'Edge Grok',
                    GROK_COOKIE_TOKEN: 'inline-secret',
                    checkModelName: 'grok-3'
                }
            ],
            'gemini-cli-oauth': [
                {
                    uuid: 'gemini-edge-1',
                    customName: 'Edge Gemini',
                    GEMINI_OAUTH_CREDS_FILE_PATH: fixture.credentialPath,
                    PROJECT_ID: 'edge-project'
                }
            ]
        };
        await writeJson(fixture.providerPoolsPath, providerPools);

        const result = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true
        });
        const exported = await exportLegacyRuntimeStorage(fixture.config, {
            domains: ['provider-pools']
        });

        expect(result.report.overallStatus).toBe('pass');
        expect(exported.providerPools['grok-custom'][0]).toMatchObject({
            uuid: 'grok-edge-1',
            customName: 'Edge Grok',
            GROK_COOKIE_TOKEN: 'inline-secret',
            isHealthy: true,
            isDisabled: false,
            usageCount: 0,
            errorCount: 0,
            refreshCount: 0,
            checkModelName: 'grok-3'
        });
        expect(exported.providerPools['gemini-cli-oauth'][0]).toMatchObject({
            uuid: 'gemini-edge-1',
            customName: 'Edge Gemini',
            GEMINI_OAUTH_CREDS_FILE_PATH: fixture.credentialPath,
            PROJECT_ID: 'edge-project',
            isHealthy: true,
            usageCount: 0
        });
        expect(result.report.acceptanceSummary.provider.actual).toMatchObject({
            providerWithCredentialPathCount: 1,
            providerCount: 2
        });
    });

    test('should reject duplicate provider uuids during migration', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-duplicate-uuid-', {
            providerPools: {
                'grok-custom': [
                    { uuid: 'dup-uuid', customName: 'First Duplicate' },
                    { uuid: 'dup-uuid', customName: 'Second Duplicate' }
                ]
            }
        });

        await expect(migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            runId: 'duplicate_uuid_run'
        })).rejects.toMatchObject({
            classification: 'constraint_conflict'
        });

        const runDetail = await getRuntimeStorageMigrationRun(fixture.config, 'duplicate_uuid_run');
        expect(runDetail.status).toBe('failed');
    });

    test('should normalize dirty usage, session and potluck payloads during migration', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-dirty-payloads-', {
            usageCache: {
                providers: {
                    'grok-custom': {
                        totalCount: '9',
                        successCount: '4',
                        errorCount: -2,
                        instances: [
                            {
                                uuid: 'grok-fixture-1',
                                success: false
                            }
                        ]
                    }
                }
            },
            tokenStore: {
                tokens: {
                    invalid_time_token: {
                        username: 'admin',
                        loginTime: 'bad-login-time',
                        expiryTime: 'bad-expiry-time'
                    },
                    active_token: {
                        username: 'runtime-admin',
                        loginTime: Date.parse('2026-03-06T10:00:00.000Z'),
                        expiryTime: Date.parse('2099-03-07T10:00:00.000Z'),
                        sourceIp: '10.0.0.1'
                    }
                }
            },
            apiPotluckData: {
                config: {
                    defaultDailyLimit: 0
                },
                users: {
                    orphan_user: {
                        credentials: [
                            {
                                id: 'missing-credential',
                                path: './missing/credential.json',
                                provider: 'gemini-cli-oauth'
                            }
                        ],
                        credentialBonuses: [
                            {
                                credentialId: 'missing-credential'
                            }
                        ],
                        createdAt: null
                    }
                }
            },
            apiPotluckKeys: {
                keys: {
                    zero_key: {
                        id: 'zero_key',
                        createdAt: '2026-03-01T10:00:00.000Z',
                        dailyLimit: 0,
                        enabled: false,
                        bonusRemaining: 0
                    },
                    unlimited_key: {
                        id: 'unlimited_key',
                        createdAt: null,
                        dailyLimit: -1,
                        enabled: true,
                        bonusRemaining: 1
                    }
                }
            }
        });

        const result = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true
        });
        const exported = await exportLegacyRuntimeStorage(fixture.config, {
            domains: ['usage-cache', 'api-potluck-data', 'api-potluck-keys']
        });
        const anomalyReport = await readJson(result.artifactPaths.anomalyReportPath);

        expect(result.report.overallStatus).toBe('pass');
        expect(exported.usageCache.providers['grok-custom']).toMatchObject({
            totalCount: 1,
            successCount: 0,
            errorCount: -2,
            processedCount: 1,
            timestamp: expect.any(String)
        });
        expect(result.report.acceptanceSummary.sessions).toMatchObject({
            sessionCount: 2,
            uniqueTokenHashCount: 2
        });
        expect(exported.apiPotluckKeys.keys.zero_key).toMatchObject({
            dailyLimit: 0,
            enabled: false
        });
        expect(exported.apiPotluckKeys.keys.unlimited_key).toMatchObject({
            dailyLimit: -1,
            enabled: true
        });
        expect(anomalyReport.summary.codeCounts).toMatchObject({
            missing_referenced_credential_file: 1
        });
    });

    test('should support batched migration pause and resume without duplicating items', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-resume-');

        const pausedResult = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            runId: 'resume_run',
            stepBatchSize: 2,
            stopAfterBatch: 1,
            operator: 'resume-operator'
        });
        expect(pausedResult.paused).toBe(true);

        const pausedRunDetail = await getRuntimeStorageMigrationRun(fixture.config, 'resume_run');
        expect(pausedRunDetail.status).toBe('paused');

        const resumedResult = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            runId: 'resume_run',
            resume: true,
            stepBatchSize: 2,
            operator: 'resume-operator'
        });
        expect(resumedResult.report.overallStatus).toBe('pass');
        expect(resumedResult.summary.resume).toMatchObject({
            used: true,
            stepBatchSize: 2
        });

        const resumedRunDetail = await getRuntimeStorageMigrationRun(fixture.config, 'resume_run');
        expect(resumedRunDetail.status).toBe('completed');
        expect(resumedRunDetail.items.filter((item) => item.item_type === 'credential_inventory')).toHaveLength(1);

        const rerunResult = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            stepBatchSize: 20
        });
        expect(rerunResult.report.overallStatus).toBe('pass');
    });

    test('should block cutover when source snapshot drifts after migration', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-cutover-drift-');

        const migrationResult = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            operator: 'cutover-check'
        });

        await writeJson(fixture.providerPoolsPath, {
            'grok-custom': [
                {
                    uuid: 'drifted-provider',
                    customName: 'Drifted Provider'
                }
            ]
        });

        await expect(verifyRuntimeStorageMigration(fixture.config, {
            runId: migrationResult.runId,
            enforceCutoverGate: true
        })).rejects.toMatchObject({
            message: 'Runtime storage cutover gate blocked',
            report: expect.objectContaining({
                cutoverGate: expect.objectContaining({
                    status: 'blocked',
                    blockers: expect.arrayContaining(['checksum:sourceSnapshot'])
                })
            })
        });
    });

    test('should block execute when preflight anomaly policy is exceeded', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-anomaly-policy-');
        const duplicateCredentialPath = path.join(fixture.tempDir, 'gemini', 'account-duplicate.json');
        await fs.writeFile(duplicateCredentialPath, JSON.stringify({ refreshToken: 'fixture-refresh-token' }, null, 2), 'utf8');
        await fs.writeFile(path.join(fixture.tempDir, 'provider_pools.json.20260306.tmp'), JSON.stringify({ stale: true }, null, 2), 'utf8');

        await expect(migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            runId: 'anomaly_policy_run',
            maxAnomalyCount: 0
        })).rejects.toMatchObject({
            classification: 'migration_validation_failed'
        });

        const runDetail = await getRuntimeStorageMigrationRun(fixture.config, 'anomaly_policy_run');
        expect(runDetail.status).toBe('failed');
    });

    test('should not treat omitted anomaly threshold as zero during execute migration', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-anomaly-default-', {
            providerPools: {
                'gemini-cli-oauth': []
            },
            apiPotluckData: {
                config: {},
                users: {}
            }
        });

        const result = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true
        });
        const manifest = await readJson(path.join(fixture.artifactRoot, result.runId, 'manifest.json'));

        expect(result.runId).toBeTruthy();
        expect(manifest.preflight.anomalyPolicy).toMatchObject({
            status: 'pass',
            maxAnomalyCount: null,
            totalAnomalies: 1,
            codeCounts: {
                orphan_credential_file: 1
            }
        });
    });

    test('should preserve db read-write-export-rollback-reimport closed loop after migration', async () => {
        const fixture = await createRuntimeMigrationFixture('runtime-storage-closed-loop-');

        const migrationResult = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            operator: 'closed-loop-operator'
        });

        const storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: fixture.dbPath,
            PROVIDER_POOLS_FILE_PATH: fixture.providerPoolsPath,
            TOKEN_STORE_FILE_PATH: fixture.tokenStorePath
        });
        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot({
            ...fixture.sourceProviderPools,
            'grok-custom': [
                {
                    ...fixture.sourceProviderPools['grok-custom'][0],
                    usageCount: 9,
                    errorCount: 3,
                    lastErrorMessage: 'updated-after-migration'
                }
            ]
        }, {
            sourceKind: 'closed_loop_test'
        });
        await storage.upsertProviderUsageSnapshot('grok-custom', {
            providerType: 'grok-custom',
            timestamp: '2026-03-02T00:00:00.000Z',
            totalCount: 9,
            successCount: 7,
            errorCount: 2,
            processedCount: 9,
            instances: [
                {
                    uuid: 'grok-fixture-1',
                    success: true,
                    lastRefreshedAt: '2026-03-02T00:00:00.000Z'
                }
            ]
        });
        await storage.saveAdminSession('post_migration_token', {
            username: 'runtime-admin',
            loginTime: Date.parse('2026-03-02T00:00:00.000Z'),
            expiryTime: Date.parse('2026-03-03T00:00:00.000Z'),
            sourceIp: '10.0.0.2'
        });
        await storage.savePotluckUserData({
            config: {
                defaultDailyLimit: 777
            },
            users: {
                runtime_user: {
                    credentials: [
                        {
                            id: 'runtime_cred_1',
                            path: fixture.credentialPath,
                            provider: 'gemini-cli-oauth',
                            authMethod: 'refresh-token',
                            addedAt: '2026-03-02T01:00:00.000Z'
                        }
                    ],
                    credentialBonuses: [],
                    createdAt: '2026-03-02T01:00:00.000Z'
                }
            }
        });
        await storage.savePotluckKeyStore({
            keys: {
                runtime_key: {
                    id: 'runtime_key',
                    name: 'Runtime Key',
                    createdAt: '2026-03-02T02:00:00.000Z',
                    dailyLimit: 777,
                    todayUsage: 1,
                    totalUsage: 1,
                    lastResetDate: '2026-03-02',
                    enabled: true,
                    bonusRemaining: 0
                }
            }
        });
        await storage.close();

        const exported = await exportLegacyRuntimeStorage(fixture.config, {
            domains: ['provider-pools', 'usage-cache', 'api-potluck-data', 'api-potluck-keys']
        });
        expect(exported.providerPools['grok-custom'][0]).toMatchObject({
            usageCount: 9,
            errorCount: 3,
            lastErrorMessage: 'updated-after-migration'
        });
        expect(exported.usageCache.providers['grok-custom']).toMatchObject({
            totalCount: 9,
            successCount: 7,
            errorCount: 2
        });
        expect(exported.sessionSummary).toMatchObject({
            sessionCount: 2
        });
        expect(exported.apiPotluckData.users.runtime_user).toBeTruthy();
        expect(exported.apiPotluckKeys.keys.runtime_key).toBeTruthy();

        await rollbackRuntimeStorageMigration(fixture.config, {
            runId: migrationResult.runId
        });
        expect(await readJson(fixture.providerPoolsPath)).toEqual(fixture.sourceProviderPools);
        expect(await readJson(fixture.usageCachePath)).toEqual(fixture.sourceUsageCache);
        expect(await readJson(fixture.tokenStorePath)).toEqual(fixture.sourceTokenStore);
        expect(await readJson(fixture.apiPotluckDataPath)).toEqual(fixture.sourceApiPotluckData);
        expect(await readJson(fixture.apiPotluckKeysPath)).toEqual(fixture.sourceApiPotluckKeys);

        const rerun = await migrateLegacyRuntimeStorage(fixture.config, {
            execute: true,
            force: true,
            operator: 'closed-loop-rerun'
        });
        expect(rerun.report.overallStatus).toBe('pass');
        expect(rerun.report.validationStatus).toBe('pass');
    });

});
