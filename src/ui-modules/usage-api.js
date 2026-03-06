import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { formatKiroUsage, formatGeminiUsage, formatAntigravityUsage, formatCodexUsage, formatGrokUsage } from '../services/usage-service.js';
import { readUsageCache, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import { broadcastEvent } from './event-broadcast.js';
import path from 'path';
import { randomUUID } from 'crypto';

const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'openai-codex-oauth', 'grok-custom'];
const DEFAULT_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 8;
const MAX_USAGE_QUERY_CONCURRENCY_PER_PROVIDER = 64;
const DEFAULT_USAGE_QUERY_GROUP_SIZE = 100;
const MAX_USAGE_QUERY_GROUP_SIZE = 500;
const DEFAULT_USAGE_QUERY_GROUP_MIN_POOL_SIZE = 2000;
const USAGE_PROGRESS_EMIT_STEP = 20;
const USAGE_PROGRESS_EMIT_INTERVAL_MS = 400;
const USAGE_TASK_RETENTION_MS = 10 * 60 * 1000;
const MAX_USAGE_TASK_RECORDS = 200;
const USAGE_TASK_DEFAULT_POLL_INTERVAL_MS = 1200;
const usageRefreshTasks = new Map();

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
    return task;
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
            continue;
        }

        if ((task.status === 'completed' || task.status === 'failed') && task.finishedAt) {
            const finishedMs = new Date(task.finishedAt).getTime();
            if (Number.isFinite(finishedMs) && now - finishedMs > USAGE_TASK_RETENTION_MS) {
                usageRefreshTasks.delete(taskId);
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
async function queryUsageForProviderInstance(providerType, provider) {
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
            const usage = await getAdapterUsage(adapter, providerType);
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
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例
    let providers = [];
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        providers = providerPoolManager.providerPools[providerType];
    } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        providers = currentConfig.providerPools[providerType];
    }

    result.totalCount = providers.length;

    const queryConcurrency = resolveUsageQueryConcurrency(currentConfig, options.usageConcurrency);
    const groupSize = resolveUsageQueryGroupSize(currentConfig, options.groupSize);
    const groupMinPoolSize = resolveUsageQueryGroupMinPoolSize(currentConfig, options.groupMinPoolSize);
    const shouldUseGrouping = providers.length >= groupMinPoolSize;
    const providerGroups = [];

    if (shouldUseGrouping) {
        for (let i = 0; i < providers.length; i += groupSize) {
            providerGroups.push(providers.slice(i, i + groupSize));
        }
        logger.info(`[Usage API] Querying usage for ${providerType} with ${providers.length} instances (groupSize=${groupSize}, groups=${providerGroups.length}, concurrency=${queryConcurrency})`);
    } else {
        providerGroups.push(providers);
        logger.info(`[Usage API] Querying usage for ${providerType} with ${providers.length} instances (concurrency=${queryConcurrency})`);
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    let processedInstances = 0;
    let successCount = 0;
    let errorCount = 0;
    let writeOffset = 0;
    let lastEmitAt = 0;
    let lastEmitProcessed = 0;
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

    if (result.totalCount === 0) {
        emitProgress(true, 0);
        return result;
    }

    emitProgress(true, 1);

    for (let groupIndex = 0; groupIndex < providerGroups.length; groupIndex++) {
        const groupProviders = providerGroups[groupIndex];
        const currentGroup = groupIndex + 1;
        emitProgress(true, currentGroup);

        const groupResults = await mapWithConcurrency(groupProviders, queryConcurrency, async (provider) => {
            const instanceResult = await queryUsageForProviderInstance(providerType, provider);
            syncProviderHealthFromUsageResult(providerPoolManager, providerType, provider, instanceResult);
            processedInstances += 1;
            if (instanceResult.success) {
                successCount += 1;
            } else {
                errorCount += 1;
            }
            delete instanceResult.errorStatus;
            emitProgress(false, currentGroup);
            return instanceResult;
        });

        for (let i = 0; i < groupResults.length; i++) {
            result.instances[writeOffset + i] = groupResults[i];
        }
        writeOffset += groupResults.length;
        emitProgress(true, currentGroup);
    }

    result.successCount = successCount;
    result.errorCount = errorCount;
    emitProgress(true, totalGroups);

    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType) {
    if (providerType === 'claude-kiro-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatKiroUsage(rawUsage);
        } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.kiroApiService.getUsageLimits();
            return formatKiroUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-cli-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.geminiApiService.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-antigravity') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.antigravityApiService.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'openai-codex-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatCodexUsage(rawUsage);
        } else if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.codexApiService.getUsageLimits();
            return formatCodexUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'grok-custom') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
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
    const task = createUsageRefreshTask({
        type: 'provider',
        providerType
    });

    void (async () => {
        try {
            const usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                usageConcurrency: options.usageConcurrency,
                groupSize: options.groupSize,
                groupMinPoolSize: options.groupMinPoolSize,
                onProgress: (progress) => {
                    task.progress = {
                        ...task.progress,
                        ...progress,
                        totalProviders: 1,
                        processedProviders: progress.processedInstances >= progress.totalInstances ? 1 : 0,
                        currentProvider: providerType
                    };
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
            broadcastUsageRefreshTaskUpdate(task);
        } catch (error) {
            task.status = 'failed';
            task.finishedAt = new Date().toISOString();
            task.error = error.message || String(error);
            logger.error(`[Usage API] Provider refresh task failed (${providerType}):`, error);
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
    const task = createUsageRefreshTask({ type: 'all' });
    const providerCount = supportedProviders.length;
    let completedProviders = 0;
    let completedTotalInstances = 0;
    let completedSuccessCount = 0;
    let completedErrorCount = 0;

    void (async () => {
        try {
            const allResults = {
                timestamp: new Date().toISOString(),
                providers: {}
            };

            for (const providerType of supportedProviders) {
                let providerResult = null;

                try {
                    providerResult = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                        usageConcurrency: options.usageConcurrency,
                        groupSize: options.groupSize,
                        groupMinPoolSize: options.groupMinPoolSize,
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
                        error: providerError.message || String(providerError)
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
            broadcastUsageRefreshTaskUpdate(task);
        } catch (error) {
            task.status = 'failed';
            task.finishedAt = new Date().toISOString();
            task.error = error.message || String(error);
            logger.error('[Usage API] Full refresh task failed:', error);
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
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const usageConcurrency = parsePositiveInt(url.searchParams.get('concurrency'));
        const useAsyncTask = parseBoolean(url.searchParams.get('async'));
        const groupSize = parsePositiveInt(url.searchParams.get('groupSize'));
        const groupMinPoolSize = parsePositiveInt(url.searchParams.get('groupMinPoolSize'));

        if (refresh && useAsyncTask) {
            const task = startAllProvidersUsageRefreshTask(currentConfig, providerPoolManager, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
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
            const cachedData = await readUsageCache();
            if (cachedData) {
                logger.debug('[Usage API] Returning cached usage data');
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
            });
            // 写入缓存
            await writeUsageCache(usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
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
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        const usageConcurrency = parsePositiveInt(url.searchParams.get('concurrency'));
        const useAsyncTask = parseBoolean(url.searchParams.get('async'));
        const groupSize = parsePositiveInt(url.searchParams.get('groupSize'));
        const groupMinPoolSize = parsePositiveInt(url.searchParams.get('groupMinPoolSize'));

        if (refresh && useAsyncTask) {
            const task = startProviderUsageRefreshTask(currentConfig, providerPoolManager, providerType, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
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
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                logger.debug(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager, {
                usageConcurrency,
                groupSize,
                groupMinPoolSize
            });
            // 更新缓存
            await updateProviderUsageCache(providerType, usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
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
        const task = usageRefreshTasks.get(taskId);

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
