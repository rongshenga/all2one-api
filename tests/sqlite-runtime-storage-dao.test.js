import { jest } from '@jest/globals';
import { SqliteRuntimeStorage } from '../src/storage/backends/sqlite-runtime-storage.js';

describe('SqliteRuntimeStorage DAO SQL', () => {
    let storage;
    let mockClient;

    beforeEach(() => {
        storage = new SqliteRuntimeStorage({
            RUNTIME_STORAGE_DB_PATH: '/tmp/runtime-storage-dao.sqlite',
            PROVIDER_POOLS_FILE_PATH: '/tmp/provider_pools.json',
            LOG_OUTPUT_MODE: 'none'
        });
        mockClient = {
            exec: jest.fn(async () => undefined),
            query: jest.fn(async () => [])
        };
        storage.client = mockClient;
        storage.initialize = jest.fn(async () => storage);
    });

    test('should build transactional provider replace SQL with escaped values and compat metadata', async () => {
        const exportedSnapshot = {
            'grok-custom': []
        };
        storage.exportProviderPoolsSnapshot = jest.fn(async () => exportedSnapshot);

        const providerPools = {
            'grok-custom': [
                {
                    uuid: 'grok-1',
                    customName: "O'Reilly",
                    GROK_COOKIE_TOKEN: "tok'en",
                    isHealthy: false,
                    errorCount: 3
                }
            ]
        };

        await expect(storage.replaceProviderPoolsSnapshot(providerPools, {
            sourceKind: 'dao_test'
        })).resolves.toEqual(exportedSnapshot);

        const sql = mockClient.exec.mock.calls[0][0];
        expect(sql).toContain('BEGIN IMMEDIATE;');
        expect(sql).toContain('DELETE FROM provider_registrations;');
        expect(sql).toContain('INSERT INTO provider_registrations');
        expect(sql).toContain('INSERT INTO provider_runtime_state');
        expect(sql).toContain('INSERT INTO provider_inline_secrets');
        expect(sql).toContain("O''Reilly");
        expect(sql).toContain("tok''en");
        expect(sql).toContain("'last_provider_import_source'");
        expect(sql).toContain("'dao_test'");
        expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    });

    test('should persist runtime flush SQL without selection sequence when disabled', async () => {
        const record = {
            providerId: 'prov_grok_1',
            providerType: 'grok-custom',
            runtimeState: {
                usageCount: 5,
                errorCount: 2,
                lastSelectionSeq: 987654,
                lastErrorMessage: "can't refresh"
            }
        };

        await expect(storage.flushProviderRuntimeState([record], {
            persistSelectionState: false
        })).resolves.toEqual({ flushedCount: 1 });

        const sql = mockClient.exec.mock.calls[0][0];
        expect(sql).toContain('BEGIN IMMEDIATE;');
        expect(sql).toContain('INSERT INTO provider_runtime_state');
        expect(sql).toContain("can''t refresh");
        expect(sql).not.toContain('987654');
        expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    });

    test('should persist runtime flush SQL with selection sequence when enabled', async () => {
        const record = {
            providerId: 'prov_grok_2',
            providerType: 'grok-custom',
            runtimeState: {
                usageCount: 1,
                lastSelectionSeq: 987654
            }
        };

        await expect(storage.flushProviderRuntimeState([record], {
            persistSelectionState: true
        })).resolves.toEqual({ flushedCount: 1 });

        const sql = mockClient.exec.mock.calls[0][0];
        expect(sql).toContain('987654');
    });


    test('should skip runtime flush exec when records batch is empty', async () => {
        await expect(storage.flushProviderRuntimeState([], {
            persistSelectionState: true
        })).resolves.toEqual({
            flushedCount: 0
        });
        expect(mockClient.exec).not.toHaveBeenCalled();
    });

    test('should merge multi-record runtime flush into one transactional exec call', async () => {
        const records = Array.from({ length: 3 }, (_, index) => ({
            providerId: `prov_grok_${index + 1}`,
            providerType: 'grok-custom',
            runtimeState: {
                usageCount: index + 1,
                errorCount: index,
                lastSelectionSeq: 10 + index
            }
        }));

        await expect(storage.flushProviderRuntimeState(records, {
            persistSelectionState: true
        })).resolves.toEqual({
            flushedCount: 3
        });
        expect(mockClient.exec).toHaveBeenCalledTimes(1);
        const sql = mockClient.exec.mock.calls[0][0];
        expect(sql).toContain('BEGIN IMMEDIATE;');
        expect(sql).toContain("'prov_grok_1'");
        expect(sql).toContain("'prov_grok_2'");
        expect(sql).toContain("'prov_grok_3'");
        expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    });

    test('should not amplify dao exec calls when runtime flush fails once', async () => {
        const flushError = new Error('database is locked');
        mockClient.exec.mockRejectedValueOnce(flushError);

        await expect(storage.flushProviderRuntimeState([
            {
                providerId: 'prov_grok_fail',
                providerType: 'grok-custom',
                runtimeState: {
                    usageCount: 1
                }
            }
        ])).rejects.toThrow('database is locked');
        expect(mockClient.exec).toHaveBeenCalledTimes(1);
    });

    test('should skip delete transaction when no expired admin sessions exist', async () => {
        mockClient.query
            .mockResolvedValueOnce([{ count: 1 }])
            .mockResolvedValueOnce([{ meta_key: 'legacy_import_admin_sessions' }])
            .mockResolvedValueOnce([]);

        await expect(storage.cleanupExpiredAdminSessions()).resolves.toEqual({
            deletedCount: 0
        });
        expect(mockClient.exec).not.toHaveBeenCalled();
    });

    test('should aggregate provider data count rows into boolean state', async () => {
        mockClient.query
            .mockResolvedValueOnce([{ count: 0 }])
            .mockResolvedValueOnce([{ count: 2 }]);

        await expect(storage.hasProviderData()).resolves.toBe(false);
        await expect(storage.hasProviderData()).resolves.toBe(true);
    });

    test('should build admin session upsert SQL with escaped metadata', async () => {
        const tokenInfo = {
            username: "O'Reilly",
            sourceIp: '127.0.0.1',
            userAgent: "cli'bot",
            loginTime: 1700000000000,
            expiryTime: 1700003600000
        };

        await expect(storage.saveAdminSession('token-1', tokenInfo)).resolves.toEqual(tokenInfo);

        const sql = mockClient.exec.mock.calls[0][0];
        expect(sql).toContain('BEGIN IMMEDIATE;');
        expect(sql).toContain('INSERT INTO admin_sessions');
        expect(sql).toContain('ON CONFLICT(id) DO UPDATE SET');
        expect(sql).toContain("O''Reilly");
        expect(sql).toContain("cli''bot");
        expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    });


    test('should skip synchronous last_seen write for recently seen admin sessions', async () => {
        const now = new Date().toISOString();
        mockClient.query
            .mockResolvedValueOnce([{ count: 1 }])
            .mockResolvedValueOnce([{ meta_key: 'legacy_import_admin_sessions' }])
            .mockResolvedValueOnce([
                {
                    id: 'session-token-1',
                    subject: 'admin',
                    expires_at: new Date(Date.now() + 60_000).toISOString(),
                    created_at: now,
                    last_seen_at: now,
                    source_ip: '127.0.0.1',
                    user_agent: 'jest-session-read',
                    meta_json: JSON.stringify({
                        username: 'admin',
                        loginTime: Date.now() - 1_000,
                        expiryTime: Date.now() + 60_000
                    })
                }
            ]);

        await expect(storage.getAdminSession('token-1')).resolves.toMatchObject({
            username: 'admin',
            sourceIp: '127.0.0.1',
            userAgent: 'jest-session-read'
        });
        expect(mockClient.exec).not.toHaveBeenCalled();
    });

    test('should return null without querying when credential asset match conditions are missing', async () => {
        await expect(storage.findCredentialAsset('grok-custom', {})).resolves.toBeNull();
        expect(mockClient.query).not.toHaveBeenCalled();
    });

    test('should build provider-filtered credential list SQL and preserve ordering', async () => {
        mockClient.query.mockResolvedValueOnce([
            {
                id: 'asset-1',
                provider_type: 'grok-custom',
                source_path: 'configs/grok/account-1.json'
            }
        ]);

        const rows = await storage.listCredentialAssets('grok-custom');

        expect(rows).toEqual([
            expect.objectContaining({
                id: 'asset-1',
                provider_type: 'grok-custom'
            })
        ]);
        expect(mockClient.query.mock.calls[0][0]).toContain("WHERE a.provider_type = 'grok-custom'");
        expect(mockClient.query.mock.calls[0][0]).toContain('ORDER BY a.provider_type ASC, a.updated_at DESC');
    });

    test('should build credential list SQL with sort filter pagination and escaped values', async () => {
        mockClient.query.mockResolvedValueOnce([]);

        await expect(storage.listCredentialAssets('openai-codex-oauth', {
            sort: 'asc',
            limit: 10,
            offset: 20,
            identityKey: "user'oauth",
            email: 'User@Example.com',
            sourceKind: "batch'import"
        })).resolves.toEqual([]);

        const sql = mockClient.query.mock.calls[0][0];
        expect(sql).toContain("a.provider_type = 'openai-codex-oauth'");
        expect(sql).toContain("a.identity_key = 'user''oauth'");
        expect(sql).toContain("a.email = 'user@example.com'");
        expect(sql).toContain("a.source_kind = 'batch''import'");
        expect(sql).toContain('ORDER BY a.provider_type ASC, a.updated_at ASC, a.id ASC');
        expect(sql).toContain('LIMIT 10 OFFSET 20');
    });

    test('should return empty credential asset list when filtered query finds no rows', async () => {
        mockClient.query.mockResolvedValueOnce([]);

        await expect(storage.listCredentialAssets('grok-custom', {
            email: 'missing@example.com'
        })).resolves.toEqual([]);
    });

    test('should export provider compat snapshot with secret fields and runtime aliases mapped', async () => {
        mockClient.query
            .mockResolvedValueOnce([{ count: 1 }])
            .mockResolvedValueOnce([
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
                    usage_count: 5,
                    error_count: 2,
                    last_used_at: '2026-03-06T02:00:00.123Z',
                    last_health_check_at: '2026-03-06T03:00:00.123Z',
                    last_health_check_model: 'grok-4',
                    last_error_time: '2026-03-06T04:00:00.123Z',
                    last_error_message: 'quota exhausted',
                    scheduled_recovery_at: '2026-03-06T05:00:00.123Z',
                    refresh_count: 7,
                    last_selection_seq: 11
                }
            ])
            .mockResolvedValueOnce([
                {
                    provider_id: 'prov_grok_1',
                    secret_kind: 'GROK_COOKIE_TOKEN',
                    secret_payload: JSON.stringify('secret-cookie')
                }
            ])
            .mockResolvedValueOnce([]);

        await expect(storage.exportProviderPoolsSnapshot()).resolves.toEqual({
            'grok-custom': [
                expect.objectContaining({
                    uuid: 'grok-1',
                    customName: 'Mapped Grok',
                    checkModelName: 'grok-4',
                    PROJECT_ID: 'project-1',
                    GROK_BASE_URL: 'https://grok.com',
                    GROK_COOKIE_TOKEN: 'secret-cookie',
                    queueLimit: 3,
                    isHealthy: false,
                    isDisabled: true,
                    usageCount: 5,
                    errorCount: 2,
                    lastUsed: '2026-03-06T02:00:00.123Z',
                    lastHealthCheckTime: '2026-03-06T03:00:00.123Z',
                    lastHealthCheckModel: 'grok-4',
                    lastErrorTime: '2026-03-06T04:00:00.123Z',
                    lastErrorMessage: 'quota exhausted',
                    scheduledRecoveryTime: '2026-03-06T05:00:00.123Z',
                    refreshCount: 7,
                    _lastSelectionSeq: 11
                })
            ]
        });
        expect(mockClient.query.mock.calls[1][0]).toContain('LIMIT 1000 OFFSET 0');
        expect(mockClient.query.mock.calls[2][0]).toContain("WHERE provider_id IN ('prov_grok_1')");
        expect(mockClient.query.mock.calls[3][0]).toContain("AND b.binding_target_id IN ('prov_grok_1')");
    });

    test('should skip routing uuid update query when required identifiers are missing', async () => {
        await expect(storage.updateProviderRoutingUuid({
            providerType: 'grok-custom'
        })).resolves.toEqual({ updated: false });
        expect(mockClient.exec).not.toHaveBeenCalled();
    });
test('should surface transactional exec failures without masking commit errors', async () => {
    const commitError = new Error('cannot commit transaction');
    mockClient.exec.mockRejectedValueOnce(commitError);

    await expect(storage.replaceProviderPoolsSnapshot({
        'grok-custom': [
            {
                uuid: 'grok-1',
                customName: 'Broken Grok',
                GROK_COOKIE_TOKEN: 'broken-token'
            }
        ]
    })).rejects.toThrow('cannot commit transaction');
    expect(mockClient.exec).toHaveBeenCalledTimes(1);
});

    test('should page provider usage snapshot queries in sqlite storage', async () => {
        mockClient.query
            .mockResolvedValueOnce([{ count: 1 }])
            .mockResolvedValueOnce([{ meta_key: 'legacy_import_usage_cache' }])
            .mockResolvedValueOnce([
                {
                    id: 'usage_openai-codex-oauth_all',
                    provider_type: 'openai-codex-oauth',
                    snapshot_at: '2026-03-09T10:00:00.000Z',
                    total_count: 88610,
                    success_count: 240,
                    error_count: 10,
                    processed_count: 250,
                    payload_json: null
                }
            ])
            .mockResolvedValueOnce([
                {
                    id: 'inst-101',
                    snapshot_id: 'usage_openai-codex-oauth_all',
                    instance_key: 'openai-codex-oauth:101',
                    uuid: 'codex-101',
                    display_name: 'Codex 101',
                    success: 1,
                    error_message: null,
                    is_disabled: 0,
                    is_healthy: 1,
                    last_refreshed_at: '2026-03-09T10:00:00.000Z',
                    subscription_title: null,
                    subscription_type: null,
                    subscription_upgrade_capability: null,
                    subscription_overage_capability: null,
                    user_email: null,
                    user_id: null,
                    instance_order: 101
                }
            ])
            .mockResolvedValueOnce([]);

        const snapshot = await storage.loadProviderUsageSnapshot('openai-codex-oauth', {
            page: 2,
            limit: 100
        });

        expect(snapshot).toMatchObject({
            providerType: 'openai-codex-oauth',
            page: 2,
            limit: 100,
            availableCount: 250,
            totalPages: 3,
            hasPrevPage: true,
            hasNextPage: true
        });
        expect(snapshot.instances).toHaveLength(1);
        expect(snapshot.instances[0]).toMatchObject({
            uuid: 'codex-101',
            name: 'Codex 101',
            success: true
        });
        expect(mockClient.query.mock.calls[2][0]).toContain('NULL AS payload_json');
        expect(mockClient.query.mock.calls[3][0]).toContain('LIMIT 100 OFFSET 100');
    });

test('should fail fast before issuing SQL when potluck payload serialization throws', async () => {
    const circular = {};
    circular.self = circular;

    await expect(storage.savePotluckUserData({
        config: {
            bad: circular
        },
        users: {}
    })).rejects.toThrow(/circular/i);
    expect(mockClient.exec).not.toHaveBeenCalled();
});
});
