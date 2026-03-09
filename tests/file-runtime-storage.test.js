import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { jest } from '@jest/globals';
import { FileRuntimeStorage } from '../src/storage/backends/file-runtime-storage.js';
import { DualWriteRuntimeStorage } from '../src/storage/backends/dual-write-runtime-storage.js';

async function createTempDir(prefix) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function buildProviderPoolsSnapshot(index) {
    return {
        'grok-custom': [
            {
                uuid: `grok-${index}`,
                customName: `Grok ${index}`,
                GROK_BASE_URL: 'https://grok.com',
                checkModelName: 'grok-3'
            }
        ]
    };
}

async function listProviderPoolTempFiles(providerPoolsPath) {
    const fileDir = path.dirname(providerPoolsPath);
    const baseName = path.basename(providerPoolsPath);
    const entries = await fs.readdir(fileDir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(`${baseName}.`) && entry.name.endsWith('.tmp'))
        .map((entry) => entry.name)
        .sort();
}

describe('FileRuntimeStorage temp file handling', () => {
    test('should not leave temp files after empty and single snapshot writes', async () => {
        const tempDir = await createTempDir('file-runtime-storage-');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const storage = new FileRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        await storage.initialize();
        await storage.replaceProviderPoolsSnapshot({});
        expect(await listProviderPoolTempFiles(providerPoolsPath)).toEqual([]);

        const expectedSnapshot = buildProviderPoolsSnapshot(1);
        await storage.replaceProviderPoolsSnapshot(expectedSnapshot);

        expect(await storage.loadProviderPoolsSnapshot()).toEqual(expectedSnapshot);
        expect(await listProviderPoolTempFiles(providerPoolsPath)).toEqual([]);
    });

    test('should ignore stale temp files as authoritative input and clean them on retry writes', async () => {
        const tempDir = await createTempDir('file-runtime-storage-');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const exactTempPath = `${providerPoolsPath}.tmp`;
        const legacyTempPath = path.join(tempDir, 'provider_pools.json.20260306.tmp');
        const storage = new FileRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });

        await storage.initialize();
        await fs.writeFile(exactTempPath, JSON.stringify({ stale: 'exact' }, null, 2), 'utf8');
        await fs.writeFile(legacyTempPath, JSON.stringify({ stale: 'legacy' }, null, 2), 'utf8');

        expect(await storage.loadProviderPoolsSnapshot()).toEqual({});

        const expectedSnapshot = buildProviderPoolsSnapshot(2);
        await storage.replaceProviderPoolsSnapshot(expectedSnapshot);

        expect(await storage.loadProviderPoolsSnapshot()).toEqual(expectedSnapshot);
        expect(await listProviderPoolTempFiles(providerPoolsPath)).toEqual([]);
    });

    test('should serialize burst writes across multiple file storage instances without accumulating temp files', async () => {
        const tempDir = await createTempDir('file-runtime-storage-');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const storages = Array.from({ length: 3 }, () => new FileRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        }));

        await Promise.all(storages.map(async (storage) => await storage.initialize()));
        const expectedSnapshots = Array.from({ length: 24 }, (_, index) => buildProviderPoolsSnapshot(index + 1));

        await Promise.all(expectedSnapshots.map(async (snapshot, index) => {
            const storage = storages[index % storages.length];
            await storage.replaceProviderPoolsSnapshot(snapshot);
        }));

        expect(await storages[0].loadProviderPoolsSnapshot()).toEqual(expectedSnapshots.at(-1));
        expect(await listProviderPoolTempFiles(providerPoolsPath)).toEqual([]);
    });

    test('should avoid temp file accumulation during burst dual-write snapshot writes', async () => {
        const tempDir = await createTempDir('file-runtime-storage-');
        const providerPoolsPath = path.join(tempDir, 'provider_pools.json');
        const secondaryStorage = new FileRuntimeStorage({
            PROVIDER_POOLS_FILE_PATH: providerPoolsPath
        });
        const primaryStorage = {
            kind: 'sqlite',
            getInfo: () => ({ backend: 'sqlite' }),
            replaceProviderPoolsSnapshot: jest.fn(async (providerPools = {}) => providerPools)
        };
        const storage = new DualWriteRuntimeStorage(primaryStorage, secondaryStorage);
        const expectedSnapshots = Array.from({ length: 18 }, (_, index) => buildProviderPoolsSnapshot(index + 1));

        await secondaryStorage.initialize();
        await Promise.all(expectedSnapshots.map(async (snapshot) => {
            await storage.replaceProviderPoolsSnapshot(snapshot, {
                sourceKind: 'test_burst_dual_write'
            });
        }));

        expect(primaryStorage.replaceProviderPoolsSnapshot).toHaveBeenCalledTimes(expectedSnapshots.length);
        expect(await secondaryStorage.loadProviderPoolsSnapshot()).toEqual(expectedSnapshots.at(-1));
        expect(await listProviderPoolTempFiles(providerPoolsPath)).toEqual([]);
    });

    test('should accept API_POTLUCK path aliases when persisting potluck stores', async () => {
        const tempDir = await createTempDir('file-runtime-storage-potluck-alias-');
        const potluckDataPath = path.join(tempDir, 'custom-potluck-data.json');
        const potluckKeysPath = path.join(tempDir, 'custom-potluck-keys.json');
        const storage = new FileRuntimeStorage({
            API_POTLUCK_DATA_FILE_PATH: potluckDataPath,
            API_POTLUCK_KEYS_FILE_PATH: potluckKeysPath
        });

        await storage.initialize();
        await storage.savePotluckUserData({
            config: {
                defaultDailyLimit: 888
            },
            users: {}
        });
        await storage.savePotluckKeyStore({
            keys: {
                alias_key: {
                    id: 'alias_key',
                    name: 'Alias Key',
                    createdAt: '2026-03-06T10:00:00.000Z',
                    dailyLimit: 888,
                    todayUsage: 0,
                    totalUsage: 0,
                    lastResetDate: '2026-03-06',
                    enabled: true,
                    bonusRemaining: 0
                }
            }
        });

        expect(await fs.readFile(potluckDataPath, 'utf8')).toContain('"defaultDailyLimit": 888');
        expect(await fs.readFile(potluckKeysPath, 'utf8')).toContain('"alias_key"');
        expect(await storage.loadPotluckUserData()).toMatchObject({
            config: {
                defaultDailyLimit: 888
            }
        });
        expect(await storage.loadPotluckKeyStore()).toMatchObject({
            keys: {
                alias_key: expect.objectContaining({
                    dailyLimit: 888
                })
            }
        });
    });
});
