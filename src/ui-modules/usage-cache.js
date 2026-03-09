import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');
const USAGE_CACHE_TMP_FILE = `${USAGE_CACHE_FILE}.tmp`;
let usageCacheWriteQueue = Promise.resolve();

function createUsageCacheReadTimeoutError(message, timeoutMs, details = {}) {
    const error = new Error(message);
    error.code = 'usage_cache_read_timeout';
    error.timeoutMs = timeoutMs;
    error.details = details;
    return error;
}

async function withUsageCacheReadTimeout(promiseFactory, timeoutMs, message, details = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await promiseFactory();
    }

    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(createUsageCacheReadTimeoutError(message, timeoutMs, details));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            Promise.resolve().then(() => promiseFactory()),
            timeoutPromise
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

function logUsageCacheLifecycle(enabled, message, payload = null) {
    if (!enabled) {
        return;
    }

    if (payload !== null && payload !== undefined) {
        logger.info(`[Usage Cache] ${message}`, payload);
        return;
    }

    logger.info(`[Usage Cache] ${message}`);
}

function createEmptyUsageCache() {
    return {
        timestamp: new Date().toISOString(),
        providers: {}
    };
}

function normalizeTimestamp(value, fallback = null) {
    if (typeof value === 'string' && value.trim()) {
        const parsedDate = new Date(value);
        if (!Number.isNaN(parsedDate.getTime())) {
            return parsedDate.toISOString();
        }
    }
    return fallback;
}

function normalizeUsageInstance(instance, fallbackTimestamp = null) {
    if (!instance || typeof instance !== 'object') {
        return null;
    }

    return {
        ...instance,
        lastRefreshedAt: normalizeTimestamp(
            instance.lastRefreshedAt || instance.timestamp || instance.cachedAt,
            fallbackTimestamp
        )
    }; 
}

function normalizeProviderUsage(providerType, usageData = {}, fallbackTimestamp = null) {
    const providerTimestamp = normalizeTimestamp(
        usageData.timestamp || usageData.refreshedAt || usageData.cachedAt,
        fallbackTimestamp || new Date().toISOString()
    );
    const instances = Array.isArray(usageData.instances)
        ? usageData.instances
            .map((instance) => normalizeUsageInstance(instance, providerTimestamp))
            .filter(Boolean)
        : [];
    const successCount = Number.isFinite(usageData.successCount)
        ? usageData.successCount
        : instances.filter((instance) => instance.success === true).length;
    const errorCount = Number.isFinite(usageData.errorCount)
        ? usageData.errorCount
        : instances.filter((instance) => instance.success !== true).length;
    const totalCount = Number.isFinite(usageData.totalCount)
        ? usageData.totalCount
        : instances.length;
    const processedCount = Number.isFinite(usageData.processedCount)
        ? usageData.processedCount
        : instances.length;

    return {
        ...usageData,
        providerType: usageData.providerType || providerType,
        timestamp: providerTimestamp,
        instances,
        totalCount,
        successCount,
        errorCount,
        processedCount
    };
}

function normalizeUsageCache(cache) {
    if (!cache || typeof cache !== 'object') {
        return createEmptyUsageCache();
    }

    const cacheTimestamp = normalizeTimestamp(cache.timestamp, new Date().toISOString());
    const normalizedCache = {
        ...cache,
        timestamp: cacheTimestamp,
        providers: {}
    };

    for (const [providerType, providerUsage] of Object.entries(cache.providers || {})) {
        normalizedCache.providers[providerType] = normalizeProviderUsage(providerType, providerUsage, cacheTimestamp);
    }

    return normalizedCache;
}

function summarizeUsageCache(cache) {
    const normalizedCache = normalizeUsageCache(cache);
    const providers = {};

    for (const [providerType, providerUsage] of Object.entries(normalizedCache.providers || {})) {
        providers[providerType] = {
            providerType,
            timestamp: providerUsage.timestamp || normalizedCache.timestamp,
            totalCount: Number(providerUsage.totalCount ?? 0),
            successCount: Number(providerUsage.successCount ?? 0),
            errorCount: Number(providerUsage.errorCount ?? 0),
            processedCount: Number.isFinite(providerUsage.processedCount)
                ? providerUsage.processedCount
                : (Array.isArray(providerUsage.instances) ? providerUsage.instances.length : Number(providerUsage.totalCount ?? 0)),
            instances: [],
            detailsLoaded: false
        };
    }

    return {
        timestamp: normalizedCache.timestamp,
        providers
    };
}

function enqueueUsageCacheWrite(writer) {
    const run = usageCacheWriteQueue.then(writer, writer);
    usageCacheWriteQueue = run.catch((error) => {
        logger.error('[Usage Cache] Queued usage cache write failed:', error.message);
    });
    return run;
}

async function writeUsageCacheFile(usageData) {
    await fs.mkdir(path.dirname(USAGE_CACHE_FILE), { recursive: true });
    await fs.writeFile(USAGE_CACHE_TMP_FILE, JSON.stringify(usageData, null, 2), 'utf8');
    await fs.rename(USAGE_CACHE_TMP_FILE, USAGE_CACHE_FILE);
    logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
}

function getUsageStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage || typeof runtimeStorage.loadUsageCacheSnapshot !== 'function') {
        return null;
    }
    return runtimeStorage;
}

function getRuntimeStorageBackend(runtimeStorage = null) {
    const storage = runtimeStorage || getRuntimeStorage();
    if (!storage) {
        return null;
    }

    try {
        const info = typeof storage.getInfo === 'function' ? storage.getInfo() : null;
        if (info?.backend && typeof info.backend === 'string') {
            return info.backend.toLowerCase();
        }
    } catch {
        // ignore
    }

    if (storage.kind && typeof storage.kind === 'string') {
        return storage.kind.toLowerCase();
    }

    return null;
}

function shouldDisableUsageFileFallback(runtimeStorage = null) {
    const backend = getRuntimeStorageBackend(runtimeStorage);
    return backend === 'db' || backend === 'dual-write';
}

export async function readUsageCache(options = {}) {
    const runtimeReadTimeoutMs = Number.isFinite(Number(options.runtimeReadTimeoutMs)) && Number(options.runtimeReadTimeoutMs) > 0
        ? Number(options.runtimeReadTimeoutMs)
        : null;
    const lifecycleLoggingEnabled = options.logLifecycle === true;
    const debugLabel = typeof options.debugLabel === 'string' && options.debugLabel.trim()
        ? options.debugLabel.trim()
        : 'readUsageCache';
    const runtimeStorage = getUsageStorage();
    if (runtimeStorage) {
        const runtimeReadStartedAt = Date.now();
        logUsageCacheLifecycle(lifecycleLoggingEnabled, 'Runtime storage usage cache read started', {
            debugLabel,
            timeoutMs: runtimeReadTimeoutMs
        });

        try {
            const snapshot = await withUsageCacheReadTimeout(
                async () => await runtimeStorage.loadUsageCacheSnapshot(),
                runtimeReadTimeoutMs,
                `Runtime storage usage cache read timed out after ${runtimeReadTimeoutMs}ms`,
                {
                    debugLabel,
                    stage: 'runtimeStorage.loadUsageCacheSnapshot'
                }
            );
            logUsageCacheLifecycle(lifecycleLoggingEnabled, 'Runtime storage usage cache read completed', {
                debugLabel,
                durationMs: Date.now() - runtimeReadStartedAt,
                hit: Boolean(snapshot)
            });
            return snapshot ? normalizeUsageCache(snapshot) : null;
        } catch (error) {
            logger.warn('[Usage Cache] Failed to read usage cache from runtime storage:', {
                debugLabel,
                durationMs: Date.now() - runtimeReadStartedAt,
                message: error.message,
                code: error.code || null,
                timeoutMs: error.timeoutMs || runtimeReadTimeoutMs
            });
            if (shouldDisableUsageFileFallback(runtimeStorage)) {
                logUsageCacheLifecycle(lifecycleLoggingEnabled, 'Runtime storage usage cache fallback disabled', {
                    debugLabel,
                    backend: getRuntimeStorageBackend(runtimeStorage)
                });
                return null;
            }
        }
    }

    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const fileReadStartedAt = Date.now();
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            const parsedCache = normalizeUsageCache(JSON.parse(content));
            logUsageCacheLifecycle(lifecycleLoggingEnabled, 'File usage cache read completed', {
                debugLabel,
                durationMs: Date.now() - fileReadStartedAt,
                hit: true,
                filePath: USAGE_CACHE_FILE
            });
            return parsedCache;
        }
        logUsageCacheLifecycle(lifecycleLoggingEnabled, 'Usage cache file missing', {
            debugLabel,
            filePath: USAGE_CACHE_FILE
        });
        return null;
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

export async function readUsageCacheSummary(options = {}) {
    const runtimeStorage = getUsageStorage();
    if (runtimeStorage && typeof runtimeStorage.loadUsageCacheSummary === 'function') {
        try {
            const summary = await withUsageCacheReadTimeout(
                async () => await runtimeStorage.loadUsageCacheSummary(),
                Number.isFinite(Number(options.runtimeReadTimeoutMs)) && Number(options.runtimeReadTimeoutMs) > 0
                    ? Number(options.runtimeReadTimeoutMs)
                    : null,
                `Runtime storage usage cache summary read timed out after ${Number(options.runtimeReadTimeoutMs || 0)}ms`,
                {
                    debugLabel: options.debugLabel || 'readUsageCacheSummary',
                    stage: 'runtimeStorage.loadUsageCacheSummary'
                }
            );
            return summary ? summarizeUsageCache(summary) : null;
        } catch (error) {
            logger.warn('[Usage Cache] Failed to read usage cache summary from runtime storage:', error.message);
        }
    }

    const cache = await readUsageCache(options);
    return cache ? summarizeUsageCache(cache) : null;
}

export async function writeUsageCache(usageData) {
    const normalizedUsageData = normalizeUsageCache(usageData);
    try {
        await enqueueUsageCacheWrite(async () => {
            const runtimeStorage = getUsageStorage();
            if (runtimeStorage && typeof runtimeStorage.replaceUsageCacheSnapshot === 'function') {
                await runtimeStorage.replaceUsageCacheSnapshot(normalizedUsageData);
                return;
            }
            await writeUsageCacheFile(normalizedUsageData);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

export async function readProviderUsageCache(providerType) {
    const runtimeStorage = getUsageStorage();
    if (runtimeStorage && typeof runtimeStorage.loadProviderUsageSnapshot === 'function') {
        try {
            const snapshot = await runtimeStorage.loadProviderUsageSnapshot(providerType);
            if (snapshot) {
                const providerUsage = normalizeProviderUsage(providerType, snapshot, snapshot.timestamp || null);
                return {
                    ...providerUsage,
                    cachedAt: providerUsage.timestamp,
                    fromCache: true
                };
            }
            if (shouldDisableUsageFileFallback(runtimeStorage)) {
                return null;
            }
        } catch (error) {
            logger.warn(`[Usage Cache] Failed to read provider usage cache from runtime storage for ${providerType}:`, error.message);
            if (shouldDisableUsageFileFallback(runtimeStorage)) {
                return null;
            }
        }
    }

    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        const providerUsage = normalizeProviderUsage(providerType, cache.providers[providerType], cache.timestamp);
        return {
            ...providerUsage,
            cachedAt: providerUsage.timestamp,
            fromCache: true
        };
    }
    return null;
}

export async function updateProviderUsageCache(providerType, usageData) {
    try {
        await enqueueUsageCacheWrite(async () => {
            const runtimeStorage = getUsageStorage();
            const normalizedProviderUsage = normalizeProviderUsage(providerType, usageData, new Date().toISOString());
            if (runtimeStorage && typeof runtimeStorage.upsertProviderUsageSnapshot === 'function') {
                await runtimeStorage.upsertProviderUsageSnapshot(providerType, normalizedProviderUsage);
                return;
            }

            const cache = (await readUsageCache()) || createEmptyUsageCache();
            cache.providers[providerType] = normalizedProviderUsage;
            cache.timestamp = new Date().toISOString();
            await writeUsageCacheFile(cache);
        });
    } catch (error) {
        logger.error('[Usage Cache] Failed to update provider usage cache:', error.message);
    }
}
