import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { formatKiroUsage, formatGeminiUsage, formatAntigravityUsage, formatCodexUsage, formatGrokUsage } from '../services/usage-service.js';
import { readUsageCache, readUsageCacheSummary, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import { broadcastEvent } from './event-broadcast.js';
import path from 'path';
import { randomUUID } from 'crypto';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'openai-codex-oauth', 'grok-custom'];
const DEFAULT_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 8;
const DEFAULT_GEMINI_CLI_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 2;
const MAX_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 64;
const DEFAULT_USAGE_QUERY_GROUP_SIZE = 100;
const MAX_USAGE_QUERY_GROUP_SIZE = 500;
const DEFAULT_USAGE_QUERY_GROUP_MIN_POOL_SIZE = 2000;
const USAGE_PROGRESS_EMIT_STEP = 20;
const USAGE_PROGRESS_EMIT_INTERVAL_MS = 400;
const USAGE_TASK_RETENTION_MS = 10 * 60 * 1000;
const MAX_USAGE_TASK_RECORDS = 200;
const USAGE_TASK_DEFAULT_POLL_INTERVAL_MS = 1200;
const DEFAULT_USAGE_CACHE_FLUSH_STEP = 1000;
const DEFAULT_USAGE_CACHE_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_USAGE_CACHE_READ_TIMEOUT_MS = 5000;
const DEFAULT_PROVIDER_USAGE_CACHE_READ_TIMEOUT_MS = 5000;
const DEFAULT_PROVIDER_USAGE_INSTANCE_TIMEOUT_MS = 30000;
const DEFAULT_USAGE_SYNC_QUERY_MAX_PROVIDER_COUNT = 500;
const DEFAULT_USAGE_TASK_PERSIST_INTERVAL_MS = 1000;
const usageRefreshTasks = new Map();
const usageRefreshTaskPersistState = new Map();

function normalizeUiDebugFlag(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isUsageDebugEnabled(req = null, currentConfig = {}) {
    if (process.env.NODE_ENV === 'test' || currentConfig?.UI_DEBUG_LOGGING === true) {
        return true;
    }

    const headerValue = req?.headers?.['x-ui-debug'];
    if (Array.isArray(headerValue)) {
        if (headerValue.some((item) => normalizeUiDebugFlag(item))) {
            return true;
        }
    } else if (normalizeUiDebugFlag(headerValue)) {
        return true;
    }

    try {
        const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
        return normalizeUiDebugFlag(requestUrl.searchParams.get('ui_debug'));
    } catch {
        return false;
    }
}

function logUsageRequestDebug(enabled, message, payload = null, level = 'info') {
    if (!enabled) {
        return;
    }

    const logMethod = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
    if (payload !== null && payload !== undefined) {
        logMethod(`[UI Debug][Usage API] ${message}`, payload);
        return;
    }

    logMethod(`[UI Debug][Usage API] ${message}`);
}

function getUsageProviderCount(usageResults) {
    return Object.keys(usageResults?.providers || {}).length;
}

function getUsageSummaryPayload(usageResults) {
    return {
        providerCount: getUsageProviderCount(usageResults),
        totalCount: Number(usageResults?.totalCount || 0),
        successCount: Number(usageResults?.successCount || 0),
        errorCount: Number(usageResults?.errorCount || 0),
        timestamp: usageResults?.timestamp || null,
        fromCache: usageResults?.fromCache === true
    };
}

function getUsageInstanceCount(usageResults) {
    return Array.isArray(usageResults?.instances) ? usageResults.instances.length : 0;
}

function shouldEnableUsageLifecycleLogging(currentConfig = {}) {
    return process.env.NODE_ENV === 'test' || currentConfig?.UI_DEBUG_LOGGING === true;
}

function logUsageLifecycle(enabled, message, payload = null) {
    if (!enabled) {
        return;
    }

    if (payload !== null && payload !== undefined) {
        logger.info(`[Usage API] ${message}`, payload);
        return;
    }

    logger.info(`[Usage API] ${message}`);
}

function resolveProviderUsageCacheReadTimeout(currentConfig = {}) {
    const configValue = parsePositiveInt(currentConfig?.PROVIDER_USAGE_CACHE_READ_TIMEOUT_MS);
    return configValue || DEFAULT_PROVIDER_USAGE_CACHE_READ_TIMEOUT_MS;
}

function resolveUsageCacheReadTimeout(currentConfig = {}) {
    const configValue = parsePositiveInt(currentConfig?.USAGE_CACHE_READ_TIMEOUT_MS);
    return configValue || DEFAULT_USAGE_CACHE_READ_TIMEOUT_MS;
}

function resolveProviderUsageInstanceTimeout(currentConfig = {}) {
    const configValue = parsePositiveInt(currentConfig?.PROVIDER_USAGE_INSTANCE_TIMEOUT_MS);
    return configValue || DEFAULT_PROVIDER_USAGE_INSTANCE_TIMEOUT_MS;
}

function resolveUsageSyncQueryMaxProviderCount(currentConfig = {}) {
    const configValue = parsePositiveInt(currentConfig?.USAGE_SYNC_QUERY_MAX_PROVIDER_COUNT);
    return configValue || DEFAULT_USAGE_SYNC_QUERY_MAX_PROVIDER_COUNT;
}

function getUsageProviderPoolCount(currentConfig = {}, providerPoolManager = null) {
    const providerPools = providerPoolManager?.providerPools || currentConfig?.providerPools || {};
    return Object.values(providerPools).reduce((sum, providers) => {
        return sum + (Array.isArray(providers) ? providers.length : 0);
    }, 0);
}

function shouldBootstrapUsageAsync(currentConfig = {}, providerPoolManager = null) {
    return getUsageProviderPoolCount(currentConfig, providerPoolManager) > resolveUsageSyncQueryMaxProviderCount(currentConfig);
}

function createTimeoutError(message, timeoutMs, details = {}) {
    const error = new Error(message);
    error.code = 'usage_timeout';
    error.timeoutMs = timeoutMs;
    error.details = details;
    return error;
}

async function withTimeout(promiseFactory, timeoutMs, message, details = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return await promiseFactory({ signal: null, timeoutMs: null });
    }

    let timeoutId = null;
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const timeoutError = createTimeoutError(message, timeoutMs, details);
            if (abortController) {
                abortController.abort(timeoutError);
            }
            reject(timeoutError);
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            Promise.resolve().then(() => promiseFactory({
                signal: abortController?.signal || null,
                timeoutMs
            })),
            timeoutPromise
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

function getUsageTaskStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage || typeof runtimeStorage.saveUsageRefreshTask !== 'function') {
        return null;
    }
    return runtimeStorage;
}

function isTerminalUsageRefreshTask(task) {
    return task?.status === 'completed' || task?.status === 'failed';
}

function clearUsageRefreshTaskPersistState(taskId) {
    const state = usageRefreshTaskPersistState.get(taskId);
    if (!state) {
        return;
    }

    if (state.timer) {
        clearTimeout(state.timer);
    }

    usageRefreshTaskPersistState.delete(taskId);
}

function scheduleUsageRefreshTaskPersist(runtimeStorage, taskId, delayMs) {
    const state = usageRefreshTaskPersistState.get(taskId);
    if (!state || state.timer) {
        return;
    }

    state.timer = setTimeout(() => {
        const latestState = usageRefreshTaskPersistState.get(taskId);
        if (latestState) {
            latestState.timer = null;
        }
        void flushUsageRefreshTaskPersist(runtimeStorage, taskId);
    }, Math.max(0, delayMs));

    if (typeof state.timer?.unref === 'function') {
        state.timer.unref();
    }
}

async function flushUsageRefreshTaskPersist(runtimeStorage, taskId) {
    const state = usageRefreshTaskPersistState.get(taskId);
    if (!state?.task) {
        return;
    }

    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }

    if (state.inFlight) {
        state.dirty = true;
        return state.inFlight;
    }

    state.dirty = false;
    const task = state.task;
    state.inFlight = (async () => {
        try {
            await runtimeStorage.saveUsageRefreshTask(task);
            state.lastPersistAt = Date.now();
        } catch (error) {
            logger.warn('[Usage API] Failed to persist usage refresh task:', error.message);
        } finally {
            state.inFlight = null;
            const latestTask = state.task;
            if (!latestTask) {
                clearUsageRefreshTaskPersistState(taskId);
                return;
            }

            if (state.dirty) {
                const elapsedMs = Date.now() - state.lastPersistAt;
                const delayMs = isTerminalUsageRefreshTask(latestTask)
                    ? 0
                    : Math.max(0, DEFAULT_USAGE_TASK_PERSIST_INTERVAL_MS - elapsedMs);
                scheduleUsageRefreshTaskPersist(runtimeStorage, taskId, delayMs);
                return;
            }

            if (isTerminalUsageRefreshTask(latestTask)) {
                clearUsageRefreshTaskPersistState(taskId);
            }
        }
    })();

    return state.inFlight;
}

async function persistUsageRefreshTask(task, options = {}) {
    const runtimeStorage = getUsageTaskStorage();
    if (!runtimeStorage || !task?.id) {
        return;
    }

    let state = usageRefreshTaskPersistState.get(task.id);
    if (!state) {
        state = {
            task,
            lastPersistAt: 0,
            inFlight: null,
            timer: null,
            dirty: false
        };
        usageRefreshTaskPersistState.set(task.id, state);
    } else {
        state.task = task;
    }

    const shouldForcePersist = options.force === true || state.lastPersistAt === 0 || isTerminalUsageRefreshTask(task);
    if (shouldForcePersist) {
        return await flushUsageRefreshTaskPersist(runtimeStorage, task.id);
    }

    if (state.inFlight) {
        state.dirty = true;
        return;
    }

    const elapsedMs = Date.now() - state.lastPersistAt;
    if (elapsedMs >= DEFAULT_USAGE_TASK_PERSIST_INTERVAL_MS) {
        return await flushUsageRefreshTaskPersist(runtimeStorage, task.id);
    }

    state.dirty = true;
    scheduleUsageRefreshTaskPersist(runtimeStorage, task.id, DEFAULT_USAGE_TASK_PERSIST_INTERVAL_MS - elapsedMs);
}

async function loadPersistedUsageRefreshTask(taskId) {
    const runtimeStorage = getUsageTaskStorage();
    if (!runtimeStorage || typeof runtimeStorage.loadUsageRefreshTask !== 'function') {
        return null;
    }

    try {
        return await runtimeStorage.loadUsageRefreshTask(taskId);
    } catch (error) {
        logger.warn('[Usage API] Failed to load persisted usage refresh task:', error.message);
        return null;
    }
}

/**
 * 将输入解析为正整数
 * @param {any} value - 输入值
 * @returns {number|null} 正整数或 null
 */
function parsePositiveInt(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

/**
 * 将输入解析为布尔值
 * @param {any} value - 输入值
 * @returns {boolean} 布尔值
 */
function parseBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value !== 'string') {
        return false;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * 判断是否为明确的认证错误
 * @param {number|null} statusCode - HTTP 状态码
 * @param {string|null} errorMessage - 错误信息
 * @returns {boolean} 是否为认证错误
 */
function isDefinitiveAuthError(statusCode, errorMessage = null) {
    if (statusCode === 401 || statusCode === 403) {
        return true;
    }

    if (!errorMessage || typeof errorMessage !== 'string') {
        return false;
    }

    return /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
}

/**
 * 读取提供商在池中的最新健康状态
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {string} providerType - 提供商类型
 * @param {string} uuid - 提供商 UUID
 * @returns {boolean|null} 健康状态，未找到返回 null
 */
function getLatestProviderHealthStatus(providerPoolManager, providerType, uuid) {
    if (!providerPoolManager?.providerStatus || !providerType || !uuid) {
        return null;
    }

    const providerStatusList = providerPoolManager.providerStatus[providerType];
    if (!Array.isArray(providerStatusList)) {
        return null;
    }

    const matched = providerStatusList.find(item => item?.config?.uuid === uuid);
    if (!matched || !matched.config) {
        return null;
    }

    return matched.config.isHealthy !== false;
}

/**
 * 将用量查询结果同步到提供商健康状态
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {string} providerType - 提供商类型
 * @param {Object} provider - 提供商配置
 * @param {Object} instanceResult - 查询结果
 */
function syncProviderHealthFromUsageResult(providerPoolManager, providerType, provider, instanceResult) {
    if (!providerPoolManager || !providerType || !provider?.uuid || !instanceResult) {
        return;
    }

    if (provider.isDisabled || instanceResult.success) {
        return;
    }

    const errorMessage = instanceResult.error || 'Usage query failed';
    const statusCode = Number.isFinite(instanceResult.errorStatus) ? instanceResult.errorStatus : null;
    const isAuthError = isDefinitiveAuthError(statusCode, errorMessage);

    try {
        if (isAuthError && typeof providerPoolManager.markProviderUnhealthyImmediately === 'function') {
            providerPoolManager.markProviderUnhealthyImmediately(providerType, provider, errorMessage);
        } else if (typeof providerPoolManager.markProviderUnhealthy === 'function') {
            providerPoolManager.markProviderUnhealthy(providerType, provider, errorMessage);
        }
    } catch (syncError) {
        logger.warn(`[Usage API] Failed to sync health status for ${providerType}:${provider.uuid}: ${syncError.message}`);
    }

    const latestHealth = getLatestProviderHealthStatus(providerPoolManager, providerType, provider.uuid);
    if (latestHealth !== null) {
        instanceResult.isHealthy = latestHealth;
    }
}

/**
 * 解析并发配置
 * 优先级：接口参数 > USAGE_QUERY_CONCURRENCY_PER_PROVIDER > REFRESH_CONCURRENCY_PER_PROVIDER(>1) > 默认值
 * @param {Object} currentConfig - 当前配置
 * @param {number|null} concurrencyOverride - 接口传入并发覆盖值
 * @returns {number} 并发值
 */
function resolveUsageQueryConcurrency(currentConfig, concurrencyOverride = null) {
    const overrideValue = parsePositiveInt(concurrencyOverride);
    const usageConfigValue = parsePositiveInt(currentConfig?.USAGE_QUERY_CONCURRENCY_PER_PROVIDER);
    const legacyRefreshValue = parsePositiveInt(currentConfig?.REFRESH_CONCURRENCY_PER_PROVIDER);
    const preferredLegacyValue = legacyRefreshValue && legacyRefreshValue > 1 ? legacyRefreshValue : null;

    const resolved = overrideValue
        || usageConfigValue
        || preferredLegacyValue
        || DEFAULT_USAGE_QUERY_CONCURRENCY_PER_PROVIDER;

    return Math.min(resolved, MAX_USAGE_QUERY_CONCURRENCY_PER_PROVIDER);
}

function resolveProviderUsageQueryConcurrency(providerType, currentConfig, concurrencyOverride = null) {
    const baseConcurrency = resolveUsageQueryConcurrency(currentConfig, concurrencyOverride);
    const providerSpecificLimit = providerType === 'gemini-cli-oauth'
        ? (parsePositiveInt(currentConfig?.GEMINI_CLI_USAGE_QUERY_CONCURRENCY_PER_PROVIDER)
            || DEFAULT_GEMINI_CLI_USAGE_QUERY_CONCURRENCY_PER_PROVIDER)
        : null;

    if (!providerSpecificLimit) {
        return baseConcurrency;
    }

    return Math.max(1, Math.min(baseConcurrency, providerSpecificLimit));
}

/**
 * 解析分组大小
 * @param {Object} currentConfig - 当前配置
 * @param {number|null} groupSizeOverride - 分组大小覆盖值
 * @returns {number} 分组大小
 */
function resolveUsageQueryGroupSize(currentConfig, groupSizeOverride = null) {
    const overrideValue = parsePositiveInt(groupSizeOverride);
    const configValue = parsePositiveInt(currentConfig?.USAGE_QUERY_GROUP_SIZE);
    const fallbackPoolGroupSize = parsePositiveInt(currentConfig?.POOL_GROUP_SIZE);

    const resolved = overrideValue
        || configValue
        || fallbackPoolGroupSize
        || DEFAULT_USAGE_QUERY_GROUP_SIZE;

    return Math.min(Math.max(1, resolved), MAX_USAGE_QUERY_GROUP_SIZE);
}

/**
 * 解析触发分组的最小池大小
 * @param {Object} currentConfig - 当前配置
 * @param {number|null} minPoolSizeOverride - 最小池大小覆盖值
 * @returns {number} 最小池大小
 */
function resolveUsageQueryGroupMinPoolSize(currentConfig, minPoolSizeOverride = null) {
    const overrideValue = parsePositiveInt(minPoolSizeOverride);
    const configValue = parsePositiveInt(currentConfig?.USAGE_QUERY_GROUP_MIN_POOL_SIZE);
    const fallbackPoolMinSize = parsePositiveInt(currentConfig?.POOL_GROUP_MIN_POOL_SIZE);

    const resolved = overrideValue
        || configValue
        || fallbackPoolMinSize
        || DEFAULT_USAGE_QUERY_GROUP_MIN_POOL_SIZE;

    return Math.max(1, resolved);
}

/**
 * 生成新的用量刷新任务
 * @param {Object} input - 任务参数
 * @returns {Object} 新任务对象
 */
function createUsageRefreshTask(input = {}) {
    pruneUsageRefreshTasks();

    const now = Date.now();
    const task = {
        id: randomUUID(),
        type: input.type || 'provider',
        providerType: input.providerType || null,
        status: 'running',
        createdAt: new Date(now).toISOString(),
        createdAtMs: now,
        startedAt: new Date(now).toISOString(),
        finishedAt: null,
        error: null,
        result: null,
        progress: {
            totalProviders: input.type === 'all' ? supportedProviders.length : 1,
            processedProviders: 0,
            currentProvider: input.providerType || null,
            totalInstances: 0,
            processedInstances: 0,
            successCount: 0,
            errorCount: 0,
            currentGroup: 0,
            totalGroups: 0,
            percent: 0
        }
    };

    usageRefreshTasks.set(task.id, task);
    pruneUsageRefreshTasks();
    void persistUsageRefreshTask(task, { force: true });
    return task;
}

function findRunningUsageRefreshTask(type, providerType = null) {
    pruneUsageRefreshTasks();

    for (const task of usageRefreshTasks.values()) {
        if (!task || task.status !== 'running' || task.type !== type) {
            continue;
        }

        if (type === 'provider' && task.providerType !== providerType) {
            continue;
        }

        return task;
    }

    return null;
}

/**
 * 广播用量刷新任务状态
 * @param {Object} task - 刷新任务
 */
function broadcastUsageRefreshTaskUpdate(task) {
    if (!task || (task.status !== 'completed' && task.status !== 'failed')) {
        return;
    }

    broadcastEvent('usage_refresh', {
        taskId: task.id,
        type: task.type,
        providerType: task.providerType,
        status: task.status,
        finishedAt: task.finishedAt,
        error: task.error,
        result: task.result
    });
}

/**
 * 清理过期任务记录
 */
function pruneUsageRefreshTasks() {
    const now = Date.now();

    for (const [taskId, task] of usageRefreshTasks.entries()) {
        if (!task) {
            usageRefreshTasks.delete(taskId);
            clearUsageRefreshTaskPersistState(taskId);
            continue;
        }

        if ((task.status === 'completed' || task.status === 'failed') && task.finishedAt) {
            const finishedMs = new Date(task.finishedAt).getTime();
            if (Number.isFinite(finishedMs) && now - finishedMs > USAGE_TASK_RETENTION_MS) {
                usageRefreshTasks.delete(taskId);
                clearUsageRefreshTaskPersistState(taskId);
            }
        }
    }

    if (usageRefreshTasks.size <= MAX_USAGE_TASK_RECORDS) {
        return;
    }

    const sortedRemovable = Array.from(usageRefreshTasks.values())
        .filter(task => task && task.status !== 'running')
        .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));

    let removeCount = usageRefreshTasks.size - MAX_USAGE_TASK_RECORDS;
    for (let i = 0; i < sortedRemovable.length && removeCount > 0; i++) {
        const record = sortedRemovable[i];
        if (record && record.id && usageRefreshTasks.has(record.id)) {
            usageRefreshTasks.delete(record.id);
            clearUsageRefreshTaskPersistState(record.id);
            removeCount -= 1;
        }
    }
}

/**
 * 计算任务进度百分比
 * @param {number} processed - 已处理
 * @param {number} total - 总数
 * @returns {number} 百分比
 */
function calcProgressPercent(processed, total) {
    if (total <= 0) {
        return 100;
    }
    return Math.min(100, Number(((processed / total) * 100).toFixed(2)));
}

/**
 * 并发映射工具（保序）
 * @param {Array<any>} items - 输入数组
 * @param {number} concurrency - 并发数
 * @param {(item:any, index:number)=>Promise<any>} mapper - 映射函数
 * @returns {Promise<Array<any>>} 映射结果
 */
async function mapWithConcurrency(items, concurrency, mapper) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= items.length) {
                return;
            }
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    });

    await Promise.all(workers);
    return results;
}



/**
 * 解析时间戳为毫秒值
 * @param {string|null|undefined} value - 时间戳
 * @returns {number} 毫秒值，无法解析时返回正无穷
 */
function parseTimestampMs(value) {
    if (!value || typeof value !== 'string') {
        return Number.POSITIVE_INFINITY;
    }

    const timestampMs = new Date(value).getTime();
    return Number.isFinite(timestampMs) ? timestampMs : Number.POSITIVE_INFINITY;
}

/**
 * 获取实例缓存键
 * @param {Object} provider - 提供商配置或实例缓存
 * @param {number} index - 当前索引
 * @returns {string} 缓存键
 */
function getProviderInstanceCacheKey(provider, index = 0) {
    if (provider?.uuid) {
        return `uuid:${provider.uuid}`;
    }
    if (provider?.customName) {
        return `name:${provider.customName}`;
    }
    if (provider?.name) {
        return `name:${provider.name}`;
    }
    return `index:${index}`;
}

/**
 * 获取指定类型的提供商池
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Array<Object>} 提供商实例列表
 */
function getProvidersForType(providerType, currentConfig, providerPoolManager) {
    if (providerPoolManager?.providerPools?.[providerType]) {
        return providerPoolManager.providerPools[providerType];
    }

    if (currentConfig?.providerPools?.[providerType]) {
        return currentConfig.providerPools[providerType];
    }

    return [];
}

/**
 * 规范化缓存实例结果
 * @param {string} providerType - 提供商类型
 * @param {Object} provider - 当前提供商配置
 * @param {Object|null} cachedInstance - 缓存实例结果
 * @returns {Object|null} 规范化后的实例结果
 */
function normalizeCachedInstanceResult(providerType, provider, cachedInstance) {
    if (!cachedInstance) {
        return null;
    }

    return {
        uuid: cachedInstance.uuid || provider?.uuid || 'unknown',
        name: cachedInstance.name || getProviderDisplayName(provider, providerType),
        isHealthy: provider?.isHealthy !== false,
        isDisabled: provider?.isDisabled === true,
        success: cachedInstance.success === true,
        usage: cachedInstance.usage ?? null,
        error: cachedInstance.error ?? null,
        lastRefreshedAt: cachedInstance.lastRefreshedAt || cachedInstance.timestamp || cachedInstance.cachedAt || null
    };
}

/**
 * 构建按刷新优先级排序的实例候选列表
 * @param {string} providerType - 提供商类型
 * @param {Array<Object>} providers - 当前提供商池
 * @param {Object|null} cachedProviderData - 提供商缓存
 * @returns {Array<Object>} 候选列表
 */
function createProviderRefreshCandidates(providerType, providers, cachedProviderData = null) {
    const cachedInstanceMap = new Map();
    const cachedInstances = Array.isArray(cachedProviderData?.instances) ? cachedProviderData.instances : [];

    cachedInstances.forEach((instance, index) => {
        const cacheKey = getProviderInstanceCacheKey(instance, index);
        if (!cachedInstanceMap.has(cacheKey)) {
            cachedInstanceMap.set(cacheKey, instance);
        }
    });

    return providers
        .map((provider, originalIndex) => {
            const cacheKey = getProviderInstanceCacheKey(provider, originalIndex);
            const cachedInstance = cachedInstanceMap.get(cacheKey) || null;

            return {
                provider,
                originalIndex,
                cachedInstance,
                priorityMissing: cachedInstance ? 1 : 0,
                priorityTimestampMs: parseTimestampMs(
                    cachedInstance?.lastRefreshedAt || cachedInstance?.timestamp || cachedProviderData?.timestamp
                )
            };
        })
        .sort((left, right) => {
            if (left.priorityMissing !== right.priorityMissing) {
                return left.priorityMissing - right.priorityMissing;
            }
            if (left.priorityTimestampMs !== right.priorityTimestampMs) {
                return left.priorityTimestampMs - right.priorityTimestampMs;
            }
            return left.originalIndex - right.originalIndex;
        });
}

/**
 * 根据当前实例结果构建提供商缓存快照
 * @param {string} providerType - 提供商类型
 * @param {Object} result - 当前聚合结果
 * @returns {Object} 提供商缓存快照
 */
function buildProviderUsageSnapshot(providerType, result) {
    const timestamp = new Date().toISOString();
    const instances = (result.instances || [])
        .filter(Boolean)
        .map((instance) => ({
            ...instance,
            lastRefreshedAt: instance.lastRefreshedAt || timestamp
        }));
    const successCount = instances.filter(instance => instance.success === true).length;
    const errorCount = instances.filter(instance => instance.success !== true).length;

    return {
        providerType,
        instances,
        totalCount: result.totalCount,
        successCount,
        errorCount,
        processedCount: instances.length,
        timestamp
    };
}

/**
 * 持久化提供商用量快照
 * @param {string} providerType - 提供商类型
 * @param {Object} result - 当前聚合结果
 */
async function persistProviderUsageSnapshot(providerType, result) {
    await updateProviderUsageCache(providerType, buildProviderUsageSnapshot(providerType, result));
}

/**
 * 计算提供商类型的刷新优先级
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object|null} usageCache - 全量缓存
 * @returns {Object} 排序优先级
 */
function getProviderTypeRefreshPriority(providerType, currentConfig, providerPoolManager, usageCache = null) {
    const providers = getProvidersForType(providerType, currentConfig, providerPoolManager);
    if (providers.length === 0) {
        return {
            priorityMissing: 1,
            priorityTimestampMs: Number.POSITIVE_INFINITY
        };
    }

    const cachedProviderData = usageCache?.providers?.[providerType] || null;
    const [firstCandidate] = createProviderRefreshCandidates(providerType, providers, cachedProviderData);

    return {
        priorityMissing: firstCandidate?.priorityMissing ?? 1,
        priorityTimestampMs: firstCandidate?.priorityTimestampMs ?? Number.POSITIVE_INFINITY
    };
}

/**
 * 按未刷新和最久未刷新的优先级排序提供商类型
 * @param {Array<string>} providerTypes - 提供商类型列表
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object|null} usageCache - 全量缓存
 * @returns {Array<string>} 排序后的提供商类型列表
 */
function sortProviderTypesByRefreshPriority(providerTypes, currentConfig, providerPoolManager, usageCache = null) {
    return providerTypes
        .map((providerType, originalIndex) => ({
            providerType,
            originalIndex,
            ...getProviderTypeRefreshPriority(providerType, currentConfig, providerPoolManager, usageCache)
        }))
        .sort((left, right) => {
            if (left.priorityMissing !== right.priorityMissing) {
                return left.priorityMissing - right.priorityMissing;
            }
            if (left.priorityTimestampMs !== right.priorityTimestampMs) {
                return left.priorityTimestampMs - right.priorityTimestampMs;
            }
            return left.originalIndex - right.originalIndex;
        })
        .map(item => item.providerType);
}

/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object} [options] - 可选参数
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager, options = {}) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * 查询单个提供商实例的用量
 * @param {string} providerType - 提供商类型
 * @param {Object} provider - 提供商实例配置
 * @returns {Promise<Object>} 单实例查询结果
 */
async function queryUsageForProviderInstance(providerType, provider, options = {}) {
    const instanceResult = {
        uuid: provider?.uuid || 'unknown',
        name: getProviderDisplayName(provider, providerType),
        isHealthy: provider?.isHealthy !== false,
        isDisabled: provider?.isDisabled === true,
        success: false,
        usage: null,
        error: null,
        errorStatus: null
    };

    try {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];

        // First check if disabled, skip initialization for disabled providers
        if (provider.isDisabled) {
            instanceResult.error = 'Provider is disabled';
            return instanceResult;
        }

        if (!adapter) {
            // Service instance not initialized, try auto-initialization
            try {
                logger.debug(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                instanceResult.errorStatus = Number.isFinite(initError?.response?.status) ? initError.response.status : null;
                return instanceResult;
            }
        }

        if (adapter) {
            const usage = await getAdapterUsage(adapter, providerType, options);
            instanceResult.success = true;
            instanceResult.usage = usage;
        }
        return instanceResult;
    } catch (error) {
        logger.error(`[Usage API] Unexpected error while querying ${providerType}:${instanceResult.uuid}:`, error.message);
        instanceResult.error = error.message;
        instanceResult.errorStatus = Number.isFinite(error?.response?.status) ? error.response.status : null;
        return instanceResult;
    }
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object} [options] - 可选参数
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager, options = {}) {
    const startedAt = Date.now();
    const lifecycleLoggingEnabled = shouldEnableUsageLifecycleLogging(currentConfig);
    const providers = getProvidersForType(providerType, currentConfig, providerPoolManager);
    logUsageLifecycle(lifecycleLoggingEnabled, `Preparing provider usage refresh for ${providerType}`, {
        providerCount: providers.length
    });
    const result = {
        providerType,
        instances: new Array(providers.length),
        totalCount: providers.length,
        successCount: 0,
        errorCount: 0
    };
    const hasCachedProviderData = Object.prototype.hasOwnProperty.call(options, 'cachedProviderData');
    const skipCacheRead = options.skipCacheRead === true || hasCachedProviderData;
    let cachedProviderData = hasCachedProviderData ? options.cachedProviderData : null;
    const cacheReadStartedAt = Date.now();
    const cacheReadTimeoutMs = resolveProviderUsageCacheReadTimeout(currentConfig);

    if (!skipCacheRead) {
        cachedProviderData = await withTimeout(
            () => readProviderUsageCache(providerType),
            cacheReadTimeoutMs,
            `Reading usage cache for ${providerType} timed out after ${cacheReadTimeoutMs}ms`,
            {
                providerType,
                stage: 'readProviderUsageCache'
            }
        );
    }

    logUsageLifecycle(lifecycleLoggingEnabled, `Provider usage cache lookup completed for ${providerType}`, {
        providerType,
        hit: Boolean(cachedProviderData),
        skipped: skipCacheRead,
        durationMs: Date.now() - cacheReadStartedAt,
        timeoutMs: skipCacheRead ? null : cacheReadTimeoutMs
    });
    const providerCandidates = createProviderRefreshCandidates(providerType, providers, cachedProviderData);
    logUsageLifecycle(lifecycleLoggingEnabled, `Provider usage refresh candidates prepared for ${providerType}`, {
        providerType,
        candidateCount: providerCandidates.length,
        durationMs: Date.now() - startedAt
    });

    providerCandidates.forEach((candidate) => {
        const cachedInstance = normalizeCachedInstanceResult(providerType, candidate.provider, candidate.cachedInstance);
        if (cachedInstance) {
            result.instances[candidate.originalIndex] = cachedInstance;
        }
    });

    const requestedQueryConcurrency = resolveUsageQueryConcurrency(currentConfig, options.usageConcurrency);
    const queryConcurrency = resolveProviderUsageQueryConcurrency(providerType, currentConfig, options.usageConcurrency);
    if (queryConcurrency !== requestedQueryConcurrency) {
        logUsageLifecycle(lifecycleLoggingEnabled, `Provider usage concurrency limited for ${providerType}`, {
            providerType,
            requestedConcurrency: requestedQueryConcurrency,
            effectiveConcurrency: queryConcurrency
        });
    }
    const groupSize = resolveUsageQueryGroupSize(currentConfig, options.groupSize);
    const groupMinPoolSize = resolveUsageQueryGroupMinPoolSize(currentConfig, options.groupMinPoolSize);
    const shouldUseGrouping = providerCandidates.length >= groupMinPoolSize;
    const providerGroups = [];

    if (shouldUseGrouping) {
        for (let i = 0; i < providerCandidates.length; i += groupSize) {
            providerGroups.push(providerCandidates.slice(i, i + groupSize));
        }
        logger.info(`[Usage API] Querying usage for ${providerType} with ${providerCandidates.length} instances (groupSize=${groupSize}, groups=${providerGroups.length}, concurrency=${queryConcurrency})`);
    } else {
        providerGroups.push(providerCandidates);
        logger.info(`[Usage API] Querying usage for ${providerType} with ${providerCandidates.length} instances (concurrency=${queryConcurrency})`);
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    let processedInstances = 0;
    let successCount = 0;
    let errorCount = 0;
    let lastEmitAt = 0;
    let lastEmitProcessed = 0;
    let lastPersistAt = Date.now();
    let lastPersistProcessed = 0;
    const flushStep = Math.max(groupSize, DEFAULT_USAGE_CACHE_FLUSH_STEP);
    const totalGroups = providerGroups.length;

    const emitProgress = (force = false, currentGroup = 0) => {
        if (!onProgress) {
            return;
        }

        const now = Date.now();
        if (!force) {
            const stepReached = (processedInstances - lastEmitProcessed) >= USAGE_PROGRESS_EMIT_STEP;
            const intervalReached = (now - lastEmitAt) >= USAGE_PROGRESS_EMIT_INTERVAL_MS;
            if (!stepReached && !intervalReached && processedInstances < result.totalCount) {
                return;
            }
        }

        lastEmitAt = now;
        lastEmitProcessed = processedInstances;

        onProgress({
            providerType,
            totalInstances: result.totalCount,
            processedInstances,
            successCount,
            errorCount,
            currentGroup,
            totalGroups,
            percent: calcProgressPercent(processedInstances, result.totalCount)
        });
    };

    const maybePersistSnapshot = async (force = false) => {
        if (processedInstances === 0) {
            return;
        }

        const now = Date.now();
        const stepReached = (processedInstances - lastPersistProcessed) >= flushStep;
        const intervalReached = (now - lastPersistAt) >= DEFAULT_USAGE_CACHE_FLUSH_INTERVAL_MS;
        if (!force && !stepReached && !intervalReached) {
            return;
        }

        await persistProviderUsageSnapshot(providerType, result);
        lastPersistAt = now;
        lastPersistProcessed = processedInstances;
    };

    if (result.totalCount === 0) {
        result.instances = [];
        emitProgress(true, 0);
        return result;
    }

    emitProgress(true, 1);

    for (let groupIndex = 0; groupIndex < providerGroups.length; groupIndex++) {
        const groupCandidates = providerGroups[groupIndex];
        const currentGroup = groupIndex + 1;
        emitProgress(true, currentGroup);

        logUsageLifecycle(lifecycleLoggingEnabled, `Starting provider usage group ${currentGroup}/${totalGroups} for ${providerType}`, {
            providerType,
            groupSize: groupCandidates.length,
            processedInstances,
            totalInstances: result.totalCount
        });

        await mapWithConcurrency(groupCandidates, queryConcurrency, async (candidate) => {
            const instanceTimeoutMs = resolveProviderUsageInstanceTimeout(currentConfig);
            const instanceResult = await withTimeout(
                ({ signal, timeoutMs }) => queryUsageForProviderInstance(providerType, candidate.provider, {
                    signal,
                    timeoutMs
                }),
                instanceTimeoutMs,
                `Usage query timed out for ${providerType}:${candidate.provider?.uuid || 'unknown'} after ${instanceTimeoutMs}ms`,
                {
                    providerType,
                    providerId: candidate.provider?.uuid || null,
                    stage: 'queryUsageForProviderInstance'
                }
            ).catch((error) => ({
                uuid: candidate.provider?.uuid || 'unknown',
                name: getProviderDisplayName(candidate.provider, providerType),
                isHealthy: candidate.provider?.isHealthy !== false,
                isDisabled: candidate.provider?.isDisabled === true,
                success: false,
                usage: null,
                error: error?.message || String(error),
                errorStatus: null
            }));
            syncProviderHealthFromUsageResult(providerPoolManager, providerType, candidate.provider, instanceResult);
            instanceResult.lastRefreshedAt = new Date().toISOString();
            processedInstances += 1;
            if (instanceResult.success) {
                successCount += 1;
            } else {
                errorCount += 1;
            }
            delete instanceResult.errorStatus;
            result.instances[candidate.originalIndex] = instanceResult;
            emitProgress(false, currentGroup);
            return instanceResult;
        });

        logUsageLifecycle(lifecycleLoggingEnabled, `Completed provider usage group ${currentGroup}/${totalGroups} for ${providerType}`, {
            providerType,
            processedInstances,
            totalInstances: result.totalCount,
            successCount,
            errorCount
        });

        emitProgress(true, currentGroup);
        await maybePersistSnapshot(processedInstances >= result.totalCount);
    }

    const snapshot = buildProviderUsageSnapshot(providerType, result);
    result.instances = snapshot.instances;
    result.successCount = snapshot.successCount;
    result.errorCount = snapshot.errorCount;
    result.processedCount = snapshot.processedCount;
    result.timestamp = snapshot.timestamp;
    emitProgress(true, totalGroups);

    logUsageLifecycle(lifecycleLoggingEnabled, `Provider usage refresh finished for ${providerType}`, {
        providerType,
        durationMs: Date.now() - startedAt,
        totalCount: result.totalCount,
        processedCount: result.processedCount,
        successCount: result.successCount,
        errorCount: result.errorCount
    });

    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType, options = {}) {
    if (providerType === 'claude-kiro-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits(options);
            return formatKiroUsage(rawUsage);
        } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.kiroApiService.getUsageLimits(options);
            return formatKiroUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-cli-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits(options);
            return formatGeminiUsage(rawUsage);
        } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.geminiApiService.getUsageLimits(options);
            return formatGeminiUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-antigravity') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits(options);
            return formatAntigravityUsage(rawUsage);
        } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.antigravityApiService.getUsageLimits(options);
            return formatAntigravityUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'openai-codex-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits(options);
            return formatCodexUsage(rawUsage);
        } else if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.codexApiService.getUsageLimits(options);
            return formatCodexUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'grok-custom') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits(options);
            return formatGrokUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    throw new Error(`Unsupported provider type: ${providerType}`);
}

/**
 * 获取提供商显示名称
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    if (!provider || typeof provider !== 'object') {
        return 'Unnamed';
    }

    // 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    if (provider.uuid) {
        return provider.uuid;
    }

    // 尝试从凭据文件路径提取名称
    const credPathKey = {
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-codex-oauth': 'CODEX_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH'
    }[providerType];

    if (credPathKey && provider[credPathKey]) {
        const filePath = provider[credPathKey];
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return 'Unnamed';
}

/**
 * 启动单提供商后台刷新任务
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {string} providerType - 提供商类型
 * @param {Object} options - 刷新参数
 * @returns {Object} 任务对象
 */
function startProviderUsageRefreshTask(currentConfig, providerPoolManager, providerType, options = {}) {
    const lifecycleLoggingEnabled = shouldEnableUsageLifecycleLogging(currentConfig);
    const existingTask = findRunningUsageRefreshTask('provider', providerType);
    if (existingTask) {
        logUsageLifecycle(lifecycleLoggingEnabled, `Provider refresh task reused for ${providerType}`, {
            taskId: existingTask.id
        });
        return existingTask;
    }

    const task = createUsageRefreshTask({
        type: 'provider',
        providerType
    });
    const startedAt = Date.now();

    logUsageLifecycle(lifecycleLoggingEnabled, `Provider refresh task created for ${providerType}`, {
        taskId: task.id,
        usageConcurrency: options.usageConcurrency ?? null,
        groupSize: options.groupSize ?? null,
        groupMinPoolSize: options.groupMinPoolSize ?? null
    });

    void (async () => {
        try {
            logUsageLifecycle(lifecycleLoggingEnabled, `Provider refresh task running for ${providerType}`, {
                taskId: task.id
            });
            const usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                usageConcurrency: options.usageConcurrency,
                groupSize: options.groupSize,
                groupMinPoolSize: options.groupMinPoolSize,
                skipCacheRead: true,
                onProgress: (progress) => {
                    task.progress = {
                        ...task.progress,
                        ...progress,
                        totalProviders: 1,
                        processedProviders: progress.processedInstances >= progress.totalInstances ? 1 : 0,
                        currentProvider: providerType
                    };
                    void persistUsageRefreshTask(task);
                }
            });

            await updateProviderUsageCache(providerType, usageResults);

            task.status = 'completed';
            task.finishedAt = new Date().toISOString();
            task.progress = {
                ...task.progress,
                totalProviders: 1,
                processedProviders: 1,
                currentProvider: providerType,
                percent: 100
            };
            task.result = {
                providerType,
                timestamp: new Date().toISOString(),
                totalCount: usageResults.totalCount || 0,
                successCount: usageResults.successCount || 0,
                errorCount: usageResults.errorCount || 0
            };
            logUsageLifecycle(lifecycleLoggingEnabled, `Provider refresh task completed for ${providerType}`, {
                taskId: task.id,
                durationMs: Date.now() - startedAt,
                totalCount: task.result.totalCount,
                successCount: task.result.successCount,
                errorCount: task.result.errorCount
            });
            await persistUsageRefreshTask(task, { force: true });
            broadcastUsageRefreshTaskUpdate(task);
        } catch (error) {
            task.status = 'failed';
            task.finishedAt = new Date().toISOString();
            task.error = error.message || String(error);
            logger.error(`[Usage API] Provider refresh task failed (${providerType}):`, {
                taskId: task.id,
                durationMs: Date.now() - startedAt,
                message: error?.message || String(error),
                code: error?.code || null,
                timeoutMs: error?.timeoutMs || null
            });
            await persistUsageRefreshTask(task, { force: true });
            broadcastUsageRefreshTaskUpdate(task);
        } finally {
            pruneUsageRefreshTasks();
        }
    })();

    return task;
}

/**
 * 启动全量后台刷新任务
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @param {Object} options - 刷新参数
 * @returns {Object} 任务对象
 */
function startAllProvidersUsageRefreshTask(currentConfig, providerPoolManager, options = {}) {
    const lifecycleLoggingEnabled = shouldEnableUsageLifecycleLogging(currentConfig);
    const existingTask = findRunningUsageRefreshTask('all');
    if (existingTask) {
        logUsageLifecycle(lifecycleLoggingEnabled, 'All providers refresh task reused', {
            taskId: existingTask.id
        });
        return existingTask;
    }

    const task = createUsageRefreshTask({ type: 'all' });

    void (async () => {
        const cachedUsageData = await readUsageCacheSummary({
            runtimeReadTimeoutMs: resolveUsageCacheReadTimeout(currentConfig),
            logLifecycle: lifecycleLoggingEnabled,
            debugLabel: `usage refresh task ${task.id}`
        });
        const sortedProviderTypes = sortProviderTypesByRefreshPriority(
            supportedProviders,
            currentConfig,
            providerPoolManager,
            cachedUsageData
        );
        const providerCount = sortedProviderTypes.length;
        let completedProviders = 0;
        let completedTotalInstances = 0;
        let completedSuccessCount = 0;
        let completedErrorCount = 0;

        try {
            const allResults = {
                timestamp: new Date().toISOString(),
                providers: {}
            };

            for (const providerType of sortedProviderTypes) {
                let providerResult = null;

                try {
                    providerResult = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                        usageConcurrency: options.usageConcurrency,
                        groupSize: options.groupSize,
                        groupMinPoolSize: options.groupMinPoolSize,
                        cachedProviderData: cachedUsageData?.providers?.[providerType] || null,
                        onProgress: (progress) => {
                            const totalInstances = completedTotalInstances + progress.totalInstances;
                            const processedInstances = completedTotalInstances + progress.processedInstances;
                            const successCount = completedSuccessCount + progress.successCount;
                            const errorCount = completedErrorCount + progress.errorCount;
                            const currentProviderPercent = progress.totalInstances > 0
                                ? (progress.processedInstances / progress.totalInstances)
                                : 1;
                            const providerProgressPercent = providerCount > 0
                                ? ((completedProviders + currentProviderPercent) / providerCount) * 100
                                : 100;

                            task.progress = {
                                ...task.progress,
                                totalProviders: providerCount,
                                processedProviders: completedProviders,
                                currentProvider: providerType,
                                totalInstances,
                                processedInstances,
                                successCount,
                                errorCount,
                                currentGroup: progress.currentGroup,
                                totalGroups: progress.totalGroups,
                                percent: Number(providerProgressPercent.toFixed(2))
                            };
                            void persistUsageRefreshTask(task);
                        }
                    });
                } catch (providerError) {
                    logger.error(`[Usage API] Failed to refresh usage for ${providerType}:`, providerError);
                    providerResult = {
                        providerType,
                        instances: [],
                        totalCount: 0,
                        successCount: 0,
                        errorCount: 1,
                        error: providerError.message || String(providerError),
                        timestamp: new Date().toISOString()
                    };
                }

                allResults.providers[providerType] = providerResult;
                completedProviders += 1;
                completedTotalInstances += providerResult.totalCount || 0;
                completedSuccessCount += providerResult.successCount || 0;
                completedErrorCount += providerResult.errorCount || 0;

                task.progress = {
                    ...task.progress,
                    totalProviders: providerCount,
                    processedProviders: completedProviders,
                    currentProvider: providerType,
                    totalInstances: completedTotalInstances,
                    processedInstances: completedTotalInstances,
                    successCount: completedSuccessCount,
                    errorCount: completedErrorCount,
                    currentGroup: task.progress.totalGroups || 0,
                    totalGroups: task.progress.totalGroups || 0,
                    percent: calcProgressPercent(completedProviders, providerCount)
                };
                await persistUsageRefreshTask(task);
            }

            allResults.timestamp = new Date().toISOString();
            await writeUsageCache(allResults);

            task.status = 'completed';
            task.finishedAt = new Date().toISOString();
            task.progress = {
                ...task.progress,
                totalProviders: providerCount,
                processedProviders: providerCount,
                totalInstances: completedTotalInstances,
                processedInstances: completedTotalInstances,
                successCount: completedSuccessCount,
                errorCount: completedErrorCount,
                percent: 100
            };
            task.result = {
                timestamp: allResults.timestamp,
                providerCount,
                totalInstances: completedTotalInstances,
                successCount: completedSuccessCount,
                errorCount: completedErrorCount
            };
            await persistUsageRefreshTask(task, { force: true });
            broadcastUsageRefreshTaskUpdate(task);
        } catch (error) {
            task.status = 'failed';
            task.finishedAt = new Date().toISOString();
            task.error = error.message || String(error);
            logger.error('[Usage API] Full refresh task failed:', error);
            await persistUsageRefreshTask(task, { force: true });
            broadcastUsageRefreshTaskUpdate(task);
        } finally {
            pruneUsageRefreshTasks();
        }
    })();

    return task;
}

/**
 * 获取支持用量查询的提供商列表
 */
export async function handleGetSupportedProviders(req, res) {
    try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(supportedProviders));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get supported providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get supported providers: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    const debugEnabled = isUsageDebugEnabled(req, currentConfig);
    const startedAt = Date.now();

    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const usageConcurrency = parsePositiveInt(url.searchParams.get('concurrency'));
        const useAsyncTask = parseBoolean(url.searchParams.get('async'));
        const groupSize = parsePositiveInt(url.searchParams.get('groupSize'));
        const groupMinPoolSize = parsePositiveInt(url.searchParams.get('groupMinPoolSize'));

        logUsageRequestDebug(debugEnabled, 'GET /api/usage started', {
            refresh,
            useAsyncTask,
            usageConcurrency,
            groupSize,
            groupMinPoolSize
        });

        if (refresh && useAsyncTask) {
            const task = startAllProvidersUsageRefreshTask(currentConfig, providerPoolManager, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
            });
            logUsageRequestDebug(debugEnabled, 'GET /api/usage async task started', {
                taskId: task.id,
                status: task.status,
                pollIntervalMs: USAGE_TASK_DEFAULT_POLL_INTERVAL_MS,
                durationMs: Date.now() - startedAt
            });
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                taskId: task.id,
                status: task.status,
                type: task.type,
                pollIntervalMs: USAGE_TASK_DEFAULT_POLL_INTERVAL_MS,
                progress: task.progress
            }));
            return true;
        }
        
        let usageResults;
        
        if (!refresh) {
            // 优先读取缓存
            const cacheLookupStartedAt = Date.now();
            const cacheReadTimeoutMs = resolveUsageCacheReadTimeout(currentConfig);
            logUsageRequestDebug(debugEnabled, 'GET /api/usage cache lookup started', {
                timeoutMs: cacheReadTimeoutMs
            });
            const cachedData = await readUsageCacheSummary({
                runtimeReadTimeoutMs: cacheReadTimeoutMs,
                logLifecycle: debugEnabled,
                debugLabel: 'GET /api/usage'
            });
            logUsageRequestDebug(debugEnabled, 'GET /api/usage cache lookup completed', {
                hit: Boolean(cachedData),
                durationMs: Date.now() - cacheLookupStartedAt,
                timeoutMs: cacheReadTimeoutMs
            });
            if (cachedData) {
                logger.debug('[Usage API] Returning cached usage data');
                usageResults = { ...cachedData, fromCache: true };
            } else if (shouldBootstrapUsageAsync(currentConfig, providerPoolManager)) {
                const task = startAllProvidersUsageRefreshTask(currentConfig, providerPoolManager, {
                    usageConcurrency,
                    groupSize,
                    groupMinPoolSize
                });
                logUsageRequestDebug(debugEnabled, 'GET /api/usage cache miss switched to async task', {
                    taskId: task.id,
                    providerPoolCount: getUsageProviderPoolCount(currentConfig, providerPoolManager),
                    syncThreshold: resolveUsageSyncQueryMaxProviderCount(currentConfig),
                    durationMs: Date.now() - startedAt
                });
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    taskId: task.id,
                    status: task.status,
                    type: task.type,
                    pollIntervalMs: USAGE_TASK_DEFAULT_POLL_INTERVAL_MS,
                    progress: task.progress
                }));
                return true;
            }
        }
        
        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            logUsageRequestDebug(debugEnabled, 'GET /api/usage fresh query started');
            const freshQueryStartedAt = Date.now();
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
            });
            logUsageRequestDebug(debugEnabled, 'GET /api/usage fresh query completed', {
                durationMs: Date.now() - freshQueryStartedAt,
                ...getUsageSummaryPayload(usageResults)
            });
            // 写入缓存
            const cacheWriteStartedAt = Date.now();
            await writeUsageCache(usageResults);
            logUsageRequestDebug(debugEnabled, 'GET /api/usage cache write completed', {
                durationMs: Date.now() - cacheWriteStartedAt
            });
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };

        logUsageRequestDebug(debugEnabled, 'GET /api/usage completed', {
            durationMs: Date.now() - startedAt,
            ...getUsageSummaryPayload(finalResults)
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logUsageRequestDebug(debugEnabled, 'GET /api/usage failed', {
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error)
        }, 'warn');
        logger.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    const debugEnabled = isUsageDebugEnabled(req, currentConfig);
    const startedAt = Date.now();

    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const usageConcurrency = parsePositiveInt(url.searchParams.get('concurrency'));
        const useAsyncTask = parseBoolean(url.searchParams.get('async'));
        const groupSize = parsePositiveInt(url.searchParams.get('groupSize'));
        const groupMinPoolSize = parsePositiveInt(url.searchParams.get('groupMinPoolSize'));

        logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} started`, {
            providerType,
            refresh,
            useAsyncTask,
            usageConcurrency,
            groupSize,
            groupMinPoolSize
        });

        if (refresh && useAsyncTask) {
            const task = startProviderUsageRefreshTask(currentConfig, providerPoolManager, providerType, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
            });
            logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} async task started`, {
                providerType,
                taskId: task.id,
                status: task.status,
                pollIntervalMs: USAGE_TASK_DEFAULT_POLL_INTERVAL_MS,
                durationMs: Date.now() - startedAt
            });
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                taskId: task.id,
                status: task.status,
                type: task.type,
                providerType,
                pollIntervalMs: USAGE_TASK_DEFAULT_POLL_INTERVAL_MS,
                progress: task.progress
            }));
            return true;
        }
        
        let usageResults;
        
        if (!refresh) {
            // Prefer reading from cache
            const cacheLookupStartedAt = Date.now();
            const cachedData = await readProviderUsageCache(providerType);
            logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} cache lookup completed`, {
                providerType,
                hit: Boolean(cachedData),
                durationMs: Date.now() - cacheLookupStartedAt
            });
            if (cachedData) {
                logger.debug(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} fresh query started`, {
                providerType
            });
            const freshQueryStartedAt = Date.now();
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
            });
            logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} fresh query completed`, {
                providerType,
                durationMs: Date.now() - freshQueryStartedAt,
                instanceCount: getUsageInstanceCount(usageResults),
                totalCount: Number(usageResults?.totalCount || 0),
                successCount: Number(usageResults?.successCount || 0),
                errorCount: Number(usageResults?.errorCount || 0),
                timestamp: usageResults?.timestamp || null,
                fromCache: usageResults?.fromCache === true
            });
            // 更新缓存
            const cacheWriteStartedAt = Date.now();
            await updateProviderUsageCache(providerType, usageResults);
            logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} cache write completed`, {
                providerType,
                durationMs: Date.now() - cacheWriteStartedAt
            });
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };

        logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} completed`, {
            providerType,
            durationMs: Date.now() - startedAt,
            instanceCount: getUsageInstanceCount(finalResults),
            totalCount: Number(finalResults?.totalCount || 0),
            successCount: Number(finalResults?.successCount || 0),
            errorCount: Number(finalResults?.errorCount || 0),
            timestamp: finalResults?.timestamp || null,
            fromCache: finalResults?.fromCache === true
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logUsageRequestDebug(debugEnabled, `GET /api/usage/${providerType} failed`, {
            providerType,
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error)
        }, 'warn');
        logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取后台刷新任务进度
 */
export async function handleGetUsageRefreshTask(req, res, taskId) {
    try {
        pruneUsageRefreshTasks();
        let task = usageRefreshTasks.get(taskId);
        if (!task) {
            task = await loadPersistedUsageRefreshTask(taskId);
            if (task) {
                usageRefreshTasks.set(task.id, task);
            }
        }

        if (!task) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Usage refresh task not found'
                }
            }));
            return true;
        }

        const responsePayload = {
            taskId: task.id,
            type: task.type,
            providerType: task.providerType,
            status: task.status,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            error: task.error,
            progress: task.progress,
            result: task.result,
            pollIntervalMs: USAGE_TASK_DEFAULT_POLL_INTERVAL_MS
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responsePayload));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get usage refresh task status:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage refresh task status: ' + error.message
            }
        }));
        return true;
    }
}
