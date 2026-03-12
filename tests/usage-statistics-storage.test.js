import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { initializeRuntimeStorage, closeRuntimeStorage } from '../src/storage/runtime-storage-registry.js';

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('usage statistics runtime storage', () => {
    afterEach(async () => {
        await closeRuntimeStorage();
    });

    test('should persist usage events and aggregate overview/trends/dimensions/events', async () => {
        const tempDir = await createTempDir('usage-stats-storage-');
        const dbPath = path.join(tempDir, 'runtime.sqlite');
        const config = {
            RUNTIME_STORAGE_BACKEND: 'db',
            RUNTIME_STORAGE_DB_PATH: dbPath,
            PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider_pools.json')
        };

        const storage = await initializeRuntimeStorage(config);

        await storage.upsertUsageStatisticsModelPrices([
            {
                model: 'gpt-4o-mini',
                currency: 'USD',
                promptPricePer1k: 0.15,
                completionPricePer1k: 0.6,
                updatedBy: 'test'
            }
        ]);

        const now = Date.now();
        const events = [
            {
                id: 'evt-1',
                occurredAt: new Date(now - 15 * 60 * 1000).toISOString(),
                requestPath: '/openai/v1/chat/completions',
                endpointType: 'openai_chat',
                isStream: false,
                fromProvider: 'openai',
                toProvider: 'openai-codex-oauth',
                providerUuid: 'codex-1',
                providerCustomName: 'Codex Alpha',
                model: 'gpt-4o-mini',
                authType: 'potluck_api_key',
                authSubjectHash: 'hash-1',
                authSubjectMask: 'maki_***0001',
                requestStatus: 'success',
                statusCode: 200,
                latencyMs: 1200,
                promptTokens: 200,
                completionTokens: 100,
                totalTokens: 300,
                cachedTokens: 50,
                reasoningTokens: 0,
                usageIncomplete: 0,
                meta: {
                    monitorRequestId: null
                }
            },
            {
                id: 'evt-2',
                occurredAt: new Date(now - 5 * 60 * 1000).toISOString(),
                requestPath: '/openai/v1/chat/completions',
                endpointType: 'openai_chat',
                isStream: true,
                fromProvider: 'openai',
                toProvider: 'openai-codex-oauth',
                providerUuid: 'codex-2',
                providerCustomName: 'Codex Beta',
                model: 'gpt-4o-mini',
                authType: 'potluck_api_key',
                authSubjectHash: 'hash-1',
                authSubjectMask: 'maki_***0001',
                requestStatus: 'error',
                statusCode: 429,
                errorCode: 'http_429',
                errorMessage: 'rate limit',
                latencyMs: 3000,
                promptTokens: 100,
                completionTokens: 0,
                totalTokens: 100,
                cachedTokens: 0,
                reasoningTokens: 0,
                usageIncomplete: 0,
                meta: {
                    monitorRequestId: null
                }
            }
        ];

        const appendResult = await storage.appendUsageStatisticsEvents(events);
        expect(appendResult).toMatchObject({
            insertedCount: 2
        });

        const range = {
            from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
            to: new Date(now + 60 * 1000).toISOString()
        };

        const overview = await storage.queryUsageStatisticsOverview(range);
        expect(overview).toMatchObject({
            totalRequests: 2,
            successRequests: 1,
            errorRequests: 1,
            totalTokens: 400
        });
        expect(overview.totalCost).toBeGreaterThan(0);

        const trends = await storage.queryUsageStatisticsTrends({
            ...range,
            bucket: 'hour'
        });
        expect(Array.isArray(trends.points)).toBe(true);
        expect(trends.points.length).toBeGreaterThan(0);

        const heatmap = await storage.queryUsageStatisticsHeatmap(range);
        expect(Array.isArray(heatmap.cells)).toBe(true);
        expect(heatmap.cells.some((cell) => Number(cell.requestCount || 0) > 0)).toBe(true);

        const modelDimensions = await storage.queryUsageStatisticsDimensions({
            ...range,
            dimension: 'models'
        });
        expect(modelDimensions.items[0]).toMatchObject({
            model: 'gpt-4o-mini',
            requestCount: 2
        });

        const credentialDimensions = await storage.queryUsageStatisticsDimensions({
            ...range,
            dimension: 'credentials'
        });
        expect(credentialDimensions.items.length).toBe(2);

        const eventsResult = await storage.queryUsageStatisticsEvents({
            ...range,
            limit: 10,
            page: 1,
            sort: 'desc'
        });
        expect(eventsResult.totalCount).toBe(2);
        expect(eventsResult.items).toHaveLength(2);
        expect(eventsResult.items[0]).toHaveProperty('estimatedCost');

        const prices = await storage.listUsageStatisticsModelPrices();
        expect(prices).toEqual([
            expect.objectContaining({
                model: 'gpt-4o-mini',
                currency: 'USD'
            })
        ]);
    });
});
