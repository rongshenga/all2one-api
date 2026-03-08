import { spawn } from 'child_process';
import { isRetryableRuntimeStorageError } from './runtime-storage-error.js';

const dbRunQueues = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildQueueKey(dbPath, queueType = 'write') {
    return `${dbPath}::${queueType}`;
}

function inferSqliteCliErrorCode(error, fallbackMessage = '') {
    const code = String(error?.code || '').toUpperCase();
    if (code) {
        return code;
    }

    const message = String(fallbackMessage || error?.message || '').toLowerCase();
    if (message.includes('database is locked') || message.includes('busy timeout')) {
        return 'SQLITE_BUSY';
    }
    if (message.includes('database table is locked') || message.includes('sqlite_locked')) {
        return 'SQLITE_LOCKED';
    }
    if (message.includes('constraint failed') || message.includes('unique constraint')) {
        return 'SQLITE_CONSTRAINT';
    }
    if (message.includes('unexpected token') || message.includes('unexpected end of json input')) {
        return 'SQLITE_JSON_PARSE';
    }

    return 'SQLITE_CLI_FAILED';
}

function annotateSqliteCliError(error, context = {}) {
    const normalized = error instanceof Error ? error : new Error(String(error || 'sqlite3 command failed'));
    normalized.code = inferSqliteCliErrorCode(normalized, context.stderr);
    normalized.retryable = normalized.retryable ?? isRetryableRuntimeStorageError(normalized);
    normalized.backend = normalized.backend || 'db';
    normalized.phase = normalized.phase || (context.json ? 'query' : 'exec');
    normalized.operation = normalized.operation || context.operation || null;
    normalized.details = {
        ...(normalized.details || {}),
        operation: context.operation || null,
        dbPath: context.dbPath,
        sqliteBinary: context.sqliteBinary,
        attempt: context.attempt,
        maxAttempts: context.maxAttempts,
        busyTimeoutMs: context.busyTimeoutMs,
        timeoutMs: context.timeoutMs,
        retryDelayMs: context.retryDelayMs,
        jsonMode: context.json === true,
        stderr: context.stderr || undefined
    };
    return normalized;
}

export class SqliteCliClient {
    constructor(dbPath, options = {}) {
        this.dbPath = dbPath;
        this.sqliteBinary = options.sqliteBinary || 'sqlite3';
        this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
        this.maxRetryAttempts = options.maxRetryAttempts ?? 2;
        this.retryDelayMs = options.retryDelayMs ?? 75;
    }

    async initialize(schemaSql) {
        await this.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = ${this.busyTimeoutMs};
${schemaSql}
        `, {
            operation: 'initialize'
        });
    }

    async exec(sql, context = {}) {
        await this.#enqueue('write', () => this.#runWithRetry(sql, {
            ...context,
            json: false,
            operation: context.operation || 'sqlite_exec'
        }));
    }

    async query(sql, context = {}) {
        const queueType = typeof context.queueType === 'string' && context.queueType.trim()
            ? context.queueType.trim()
            : 'read';
        const stdout = await this.#enqueue(queueType, () => this.#runWithRetry(sql, {
            ...context,
            json: true,
            operation: context.operation || 'sqlite_query'
        }));
        const trimmed = stdout.trim();
        if (!trimmed) {
            return [];
        }

        const jsonStart = trimmed.indexOf('[');
        const payload = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;

        try {
            return JSON.parse(payload);
        } catch (error) {
            const parseError = annotateSqliteCliError(error, {
                dbPath: this.dbPath,
                sqliteBinary: this.sqliteBinary,
                busyTimeoutMs: this.busyTimeoutMs,
                retryDelayMs: this.retryDelayMs,
                json: true,
                operation: context.operation || 'sqlite_query',
                attempt: 1,
                maxAttempts: 1,
                stderr: 'Failed to parse sqlite3 JSON output'
            });
            parseError.code = 'SQLITE_JSON_PARSE';
            parseError.retryable = false;
            throw parseError;
        }
    }

    async #enqueue(queueType, runner) {
        const queueKey = buildQueueKey(this.dbPath, queueType);
        const previous = dbRunQueues.get(queueKey) || Promise.resolve();
        const run = previous.catch(() => undefined).then(runner);
        const tail = run.catch(() => undefined);
        dbRunQueues.set(queueKey, tail);

        try {
            return await run;
        } finally {
            if (dbRunQueues.get(queueKey) === tail) {
                dbRunQueues.delete(queueKey);
            }
        }
    }

    async #runWithRetry(sql, options = {}) {
        const maxAttempts = Math.max(1, Number(this.maxRetryAttempts || 0) + 1);
        let attempt = 0;
        let lastError = null;

        while (attempt < maxAttempts) {
            attempt += 1;
            try {
                return await this.#run(sql, options);
            } catch (error) {
                lastError = annotateSqliteCliError(error, {
                    ...options,
                    dbPath: this.dbPath,
                    sqliteBinary: this.sqliteBinary,
                    busyTimeoutMs: this.busyTimeoutMs,
                    retryDelayMs: this.retryDelayMs,
                    attempt,
                    maxAttempts,
                    stderr: error?.stderr || undefined
                });

                if (!lastError.retryable || attempt >= maxAttempts) {
                    throw lastError;
                }

                await sleep(this.retryDelayMs * attempt);
            }
        }

        throw lastError || annotateSqliteCliError(new Error('sqlite3 command failed'), {
            ...options,
            dbPath: this.dbPath,
            sqliteBinary: this.sqliteBinary,
            busyTimeoutMs: this.busyTimeoutMs,
            retryDelayMs: this.retryDelayMs,
            attempt: maxAttempts,
            maxAttempts
        });
    }

    async #run(sql, options = {}) {
        const args = [];
        if (options.json) {
            args.push('-json');
        }
        args.push('-cmd', 'PRAGMA foreign_keys = ON;');
        args.push('-cmd', `.timeout ${this.busyTimeoutMs}`);
        args.push(this.dbPath);

        return await new Promise((resolve, reject) => {
            const child = spawn(this.sqliteBinary, args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const timeoutMs = Number(options.timeoutMs || 0);
            let killTimer = null;

            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                killTimer = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGKILL');
                }, timeoutMs);
            }

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                if (killTimer) {
                    clearTimeout(killTimer);
                }
                error.stderr = stderr.trim();
                reject(error);
            });

            child.on('close', (code) => {
                if (killTimer) {
                    clearTimeout(killTimer);
                }
                if (timedOut) {
                    const failure = new Error(`sqlite3 query timed out after ${timeoutMs}ms`);
                    failure.stderr = stderr.trim();
                    failure.code = 'SQLITE_TIMEOUT';
                    failure.retryable = false;
                    reject(failure);
                    return;
                }
                if (code !== 0) {
                    const failure = new Error(stderr.trim() || `sqlite3 exited with code ${code}`);
                    failure.stderr = stderr.trim();
                    failure.code = inferSqliteCliErrorCode(failure, stderr);
                    reject(failure);
                    return;
                }
                resolve(stdout);
            });

            child.stdin.end(`${sql.trim()}\n`);
        });
    }
}
