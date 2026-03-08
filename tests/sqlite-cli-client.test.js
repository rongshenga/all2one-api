import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

function createSpawnProcess({ code = 0, stdout = '', stderr = '' } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
        end: jest.fn(() => {
            process.nextTick(() => {
                if (stdout) {
                    child.stdout.emit('data', stdout);
                }
                if (stderr) {
                    child.stderr.emit('data', stderr);
                }
                child.emit('close', code);
            });
        })
    };
    return child;
}

function createDeferredSpawnProcess() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
        end: jest.fn()
    };

    return {
        child,
        complete({ code = 0, stdout = '', stderr = '' } = {}) {
            if (stdout) {
                child.stdout.emit('data', stdout);
            }
            if (stderr) {
                child.stderr.emit('data', stderr);
            }
            child.emit('close', code);
        }
    };
}

describe('SqliteCliClient', () => {
    let SqliteCliClient;
    let mockSpawn;

    beforeEach(async () => {
        jest.resetModules();
        mockSpawn = jest.fn();
        jest.doMock('child_process', () => ({
            spawn: mockSpawn
        }));

        ({ SqliteCliClient } = await import('../src/storage/sqlite-cli-client.js'));
    });

    test('should retry retryable sqlite busy failures and eventually resolve query results', async () => {
        mockSpawn
            .mockImplementationOnce(() => createSpawnProcess({
                code: 1,
                stderr: 'database is locked'
            }))
            .mockImplementationOnce(() => createSpawnProcess({
                code: 0,
                stdout: '[]'
            }));

        const client = new SqliteCliClient('/tmp/runtime-storage-test.sqlite', {
            maxRetryAttempts: 1,
            retryDelayMs: 0
        });

        await expect(client.query('SELECT 1;', {
            operation: 'unit_query'
        })).resolves.toEqual([]);
        expect(mockSpawn).toHaveBeenCalledTimes(2);
        expect(mockSpawn.mock.calls[0][1]).toEqual(['-json', '-cmd', 'PRAGMA foreign_keys = ON;', '-cmd', '.timeout 5000', '/tmp/runtime-storage-test.sqlite']);
    });

    test('should surface sqlite json parse failures without retrying', async () => {
        mockSpawn.mockImplementationOnce(() => createSpawnProcess({
            code: 0,
            stdout: 'not-json'
        }));

        const client = new SqliteCliClient('/tmp/runtime-storage-test.sqlite', {
            maxRetryAttempts: 3,
            retryDelayMs: 0
        });

        await expect(client.query('SELECT 1;')).rejects.toMatchObject({
            code: 'SQLITE_JSON_PARSE',
            retryable: false,
            backend: 'db',
            phase: 'query'
        });
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });


    test('should send batched transactional SQL in a single sqlite3 process invocation', async () => {
        const process = createSpawnProcess({ code: 0, stdout: '' });
        mockSpawn.mockImplementationOnce(() => process);

        const client = new SqliteCliClient('/tmp/runtime-storage-batch.sqlite', {
            maxRetryAttempts: 0,
            retryDelayMs: 0
        });
        const sql = `BEGIN IMMEDIATE;
INSERT INTO test_table(id) VALUES (1);
INSERT INTO test_table(id) VALUES (2);
COMMIT;`;

        await expect(client.exec(sql, {
            operation: 'unit_batch_exec'
        })).resolves.toBeUndefined();
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(process.stdin.end).toHaveBeenCalledWith(`${sql}
`);
    });

    test('should stop retrying after the configured max attempts to avoid spawn amplification', async () => {
        mockSpawn
            .mockImplementationOnce(() => createSpawnProcess({ code: 1, stderr: 'database is locked' }))
            .mockImplementationOnce(() => createSpawnProcess({ code: 1, stderr: 'database is locked' }))
            .mockImplementationOnce(() => createSpawnProcess({ code: 1, stderr: 'database is locked' }));

        const client = new SqliteCliClient('/tmp/runtime-storage-retry-limit.sqlite', {
            maxRetryAttempts: 2,
            retryDelayMs: 0
        });

        await expect(client.exec('SELECT 1;', {
            operation: 'unit_retry_limit'
        })).rejects.toMatchObject({
            code: 'SQLITE_BUSY',
            retryable: true,
            details: expect.objectContaining({
                attempt: 3,
                maxAttempts: 3
            })
        });
        expect(mockSpawn).toHaveBeenCalledTimes(3);
    });

    test('should serialize executions for the same db path through the shared queue', async () => {
        const firstProcess = createDeferredSpawnProcess();
        const secondProcess = createDeferredSpawnProcess();

        mockSpawn
            .mockImplementationOnce(() => firstProcess.child)
            .mockImplementationOnce(() => secondProcess.child);

        const client = new SqliteCliClient('/tmp/runtime-storage-shared.sqlite', {
            maxRetryAttempts: 0,
            retryDelayMs: 0
        });

        const firstExec = client.exec('SELECT 1;');
        const secondExec = client.exec('SELECT 2;');

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockSpawn).toHaveBeenCalledTimes(1);

        firstProcess.complete();
        await firstExec;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockSpawn).toHaveBeenCalledTimes(2);
        secondProcess.complete();
        await secondExec;
    });

    test('should isolate read and write queues across multiple client instances for the same db path', async () => {
        const firstProcess = createDeferredSpawnProcess();
        const secondProcess = createDeferredSpawnProcess();
        const thirdProcess = createDeferredSpawnProcess();

        mockSpawn
            .mockImplementationOnce(() => firstProcess.child)
            .mockImplementationOnce(() => secondProcess.child)
            .mockImplementationOnce(() => thirdProcess.child);

        const firstClient = new SqliteCliClient('/tmp/runtime-storage-shared-clients.sqlite', {
            maxRetryAttempts: 0,
            retryDelayMs: 0
        });
        const secondClient = new SqliteCliClient('/tmp/runtime-storage-shared-clients.sqlite', {
            maxRetryAttempts: 0,
            retryDelayMs: 0
        });
        const thirdClient = new SqliteCliClient('/tmp/runtime-storage-shared-clients.sqlite', {
            maxRetryAttempts: 0,
            retryDelayMs: 0
        });

        const firstExec = firstClient.exec('SELECT 1;');
        const secondQuery = secondClient.query('SELECT 2;');
        const thirdExec = thirdClient.exec('SELECT 3;');

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockSpawn).toHaveBeenCalledTimes(2);

        secondProcess.complete({ stdout: '[]' });
        await expect(secondQuery).resolves.toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockSpawn).toHaveBeenCalledTimes(2);

        firstProcess.complete();
        await firstExec;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockSpawn).toHaveBeenCalledTimes(3);

        thirdProcess.complete();
        await thirdExec;
    });
});
