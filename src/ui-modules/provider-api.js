import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';
import { getAllProviderModels, getProviderModels } from '../providers/provider-models.js';
import { generateUUID, createProviderConfig, formatSystemPath, detectProviderFromPath } from '../utils/provider-utils.js';
import { broadcastEvent } from './event-broadcast.js';
import { getRegisteredProviders } from '../providers/adapter.js';
import {
    getRuntimeStorage,
    loadProviderPoolsCompatSnapshot,
    replaceProviderPoolsCompatSnapshot
} from '../storage/runtime-storage-registry.js';
import { serializeRuntimeStorageError } from '../storage/runtime-storage-error.js';

function cloneProviderPools(providerPools = {}) {
    try {
        return JSON.parse(JSON.stringify(providerPools || {}));
    } catch (error) {
        logger.warn('[UI API] Failed to clone provider pools snapshot:', error.message);
        return {};
    }
}

async function loadProviderPools(currentConfig, providerPoolManager) {
    const runtimeBackend = currentConfig?.RUNTIME_STORAGE_INFO?.backend;
    const managerProviderPools = providerPoolManager?.providerPools;
    const configProviderPools = currentConfig?.providerPools;

    // 优先复用内存快照，避免在大号池场景下每次请求都触发 runtime storage 全量导出
    if (managerProviderPools && Object.keys(managerProviderPools).length > 0) {
        return managerProviderPools;
    }

    if (configProviderPools && Object.keys(configProviderPools).length > 0) {
        return configProviderPools;
    }

    try {
        const providerPools = await loadProviderPoolsCompatSnapshot(currentConfig);
        if (providerPools && (runtimeBackend === 'db' || Object.keys(providerPools).length > 0)) {
            return providerPools;
        }
    } catch (error) {
        logger.warn('[UI API] Failed to load provider pools from runtime storage:', error.message);
    }

    return {};
}

async function loadProviderPoolSummaries(currentConfig, providerPoolManager) {
    const runtimeBackend = currentConfig?.RUNTIME_STORAGE_INFO?.backend;
    const shouldUseRuntimeSummary = runtimeBackend === 'db' || runtimeBackend === 'dual-write';

    if (shouldUseRuntimeSummary) {
        try {
            const runtimeStorage = getRuntimeStorage();
            const providerDomain = runtimeStorage?.provider || null;
            const summaryLoader = providerDomain?.loadPoolsSummary
                || runtimeStorage?.loadProviderPoolsSummary
                || runtimeStorage?.rawStorage?.loadProviderPoolsSummary;
            if (typeof summaryLoader === 'function') {
                const summaries = await summaryLoader.call(providerDomain || runtimeStorage);
                if (summaries && Object.keys(summaries).length > 0) {
                    return summaries;
                }
            }
        } catch (error) {
            logger.warn('[UI API] Failed to load provider summaries from runtime storage:', error.message);
        }
    }

    const providerPools = await loadProviderPools(currentConfig, providerPoolManager);
    return Object.entries(providerPools).reduce((summaries, [providerType, providers]) => {
        summaries[providerType] = buildProviderSummary(providers);
        return summaries;
    }, {});
}

async function persistProviderPools(currentConfig, providerPoolManager, providerPools, options = {}) {
    const normalizedSnapshot = await replaceProviderPoolsCompatSnapshot(currentConfig, providerPools, {
        sourceKind: options.sourceKind || 'ui_api'
    });

    if (currentConfig) {
        currentConfig.providerPools = normalizedSnapshot;
    }

    if (providerPoolManager) {
        providerPoolManager.providerPools = options.managerProviderPools || normalizedSnapshot;
        if (options.reinitializeManager !== false) {
            providerPoolManager.initializeProviderStatus();
        }
    }

    return normalizedSnapshot;
}

function getProviderPoolsFilePath(currentConfig) {
    return currentConfig?.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
}

function buildProviderSummary(providers = []) {
    const providerList = Array.isArray(providers) ? providers : [];

    return {
        totalCount: providerList.length,
        healthyCount: providerList.filter(provider => provider.isHealthy && !provider.isDisabled).length,
        usageCount: providerList.reduce((sum, provider) => sum + (provider.usageCount || 0), 0),
        errorCount: providerList.reduce((sum, provider) => sum + (provider.errorCount || 0), 0)
    };
}

function summarizeRuntimeStorageInfo(currentConfig) {
    const runtimeStorageInfo = currentConfig?.RUNTIME_STORAGE_INFO;
    if (!runtimeStorageInfo || typeof runtimeStorageInfo !== 'object') {
        return null;
    }

    return {
        backend: runtimeStorageInfo.backend || null,
        requestedBackend: runtimeStorageInfo.requestedBackend || null,
        authoritativeSource: runtimeStorageInfo.authoritativeSource || null,
        dualWriteEnabled: runtimeStorageInfo.dualWriteEnabled === true,
        lastFallback: runtimeStorageInfo.lastFallback || null,
        lastValidation: runtimeStorageInfo.lastValidation || null,
        lastError: runtimeStorageInfo.lastError || null
    };
}

const PROVIDER_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const PROVIDER_NAME_MAX_LENGTH = 255;
const DEFAULT_GROK_BATCH_IMPORT_LIMIT = 1000;
const DEFAULT_PROVIDER_PAGE_LIMIT = 50;
const MAX_PROVIDER_PAGE_LIMIT = 200;
const DELETE_UNHEALTHY_ERROR_TYPES = new Set([
    'all',
    'auth',
    'quota',
    'timeout',
    'network',
    'other',
    'unknown'
]);

function writeJsonError(res, statusCode, message) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message } }));
    return true;
}

function parsePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function parseProviderListQuery(req, totalCount = 0) {
    if (typeof req?.url !== 'string') {
        return null;
    }

    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const rawHealthFilter = requestUrl.searchParams.get('healthFilter');
    const healthFilter = rawHealthFilter === 'healthy' || rawHealthFilter === 'unhealthy' ? rawHealthFilter : 'all';
    const parsedErrorType = normalizeDeleteUnhealthyErrorType(requestUrl.searchParams.get('errorType'));
    const errorType = parsedErrorType || 'all';
    const hasPagingQuery = requestUrl.searchParams.has('page')
        || requestUrl.searchParams.has('limit')
        || requestUrl.searchParams.has('sort')
        || requestUrl.searchParams.has('healthFilter')
        || requestUrl.searchParams.has('errorType');

    if (!hasPagingQuery) {
        return null;
    }

    const limit = parsePositiveInteger(
        requestUrl.searchParams.get('limit'),
        DEFAULT_PROVIDER_PAGE_LIMIT,
        { min: 1, max: MAX_PROVIDER_PAGE_LIMIT }
    );
    const page = parsePositiveInteger(requestUrl.searchParams.get('page'), 1, { min: 1 });
    const rawSort = requestUrl.searchParams.get('sort');
    const sort = rawSort === 'asc' || rawSort === 'desc' ? rawSort : null;
    const totalPages = Math.max(1, Math.ceil(Math.max(totalCount, 0) / limit));
    const normalizedPage = Math.min(page, totalPages);

    return {
        page: normalizedPage,
        limit,
        offset: (normalizedPage - 1) * limit,
        sort,
        totalPages,
        healthFilter,
        errorType
    };
}

function sortProvidersForDisplay(providers = [], sort = 'desc') {
    const sorted = [...providers].sort((left, right) => {
        const leftKey = String(left?.customName || left?.uuid || '').toLowerCase();
        const rightKey = String(right?.customName || right?.uuid || '').toLowerCase();
        if (leftKey === rightKey) {
            return String(left?.uuid || '').localeCompare(String(right?.uuid || ''));
        }
        return leftKey.localeCompare(rightKey);
    });

    return sort === 'asc' ? sorted : sorted.reverse();
}

function filterProvidersByHealth(providers = [], healthFilter = 'all') {
    if (healthFilter === 'healthy') {
        return providers.filter((provider) => provider?.isHealthy === true);
    }

    if (healthFilter === 'unhealthy') {
        return providers.filter((provider) => provider?.isHealthy !== true);
    }

    return providers;
}

function filterProvidersByErrorType(providers = [], errorType = 'all') {
    if (errorType === 'all') {
        return providers;
    }

    return providers.filter((provider) => classifyProviderErrorType(provider) === errorType);
}

function getGrokBatchImportLimit(currentConfig = {}) {
    return parsePositiveInteger(
        currentConfig?.GROK_BATCH_IMPORT_LIMIT,
        DEFAULT_GROK_BATCH_IMPORT_LIMIT,
        { min: 1, max: 100000 }
    );
}

function validateProviderTypeValue(providerType) {
    if (typeof providerType !== 'string' || !PROVIDER_TYPE_PATTERN.test(providerType.trim())) {
        return 'providerType is invalid';
    }

    return null;
}

function normalizeProviderConfigInput(providerConfig) {
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
        return 'providerConfig must be an object';
    }

    if (!Object.prototype.hasOwnProperty.call(providerConfig, 'customName')) {
        return null;
    }

    if (providerConfig.customName === null) {
        return null;
    }

    const normalizedCustomName = String(providerConfig.customName).trim();
    if (!normalizedCustomName) {
        return 'customName must not be empty';
    }
    if (normalizedCustomName.length > PROVIDER_NAME_MAX_LENGTH) {
        return `customName must be at most ${PROVIDER_NAME_MAX_LENGTH} characters`;
    }

    providerConfig.customName = normalizedCustomName;
    return null;
}

function hasProviderUuidConflict(providerPools = {}, uuid, excludeUuid = null) {
    if (!uuid) {
        return false;
    }

    return Object.values(providerPools || {}).some((providers) => Array.isArray(providers)
        && providers.some((provider) => provider?.uuid === uuid && provider.uuid !== excludeUuid));
}

function safeBroadcastEvent(eventType, payload) {
    try {
        broadcastEvent(eventType, payload);
    } catch (error) {
        logger.warn(`[UI API] Failed to broadcast ${eventType}: ${error.message}`);
    }
}

function handleProviderMutationFailure(res, action, error, context = {}, options = {}) {
    const traceId = randomUUID();
    const runtimeStorageError = serializeRuntimeStorageError(error) || {
        message: error?.message || 'Provider mutation failed',
        code: 'provider_mutation_failed',
        phase: null,
        domain: 'provider_api',
        backend: null,
        operation: null,
        retryable: false,
        details: null
    };
    const runtimeStorage = summarizeRuntimeStorageInfo(context.currentConfig);
    const diagnostics = {
        traceId,
        action,
        providerType: context.providerType || null,
        providerUuid: context.providerUuid || null,
        filePath: context.filePath || null,
        runtimeStorage,
        runtimeStorageError
    };

    logger.error(`[UI API] Provider mutation failed [${traceId}] (${action})`, diagnostics);

    res.writeHead(options.statusCode || 500, { 'Content-Type': 'application/json' });
    if (options.legacyShape === 'flat') {
        res.end(JSON.stringify({
            success: false,
            error: `${options.messagePrefix || ''}${runtimeStorageError.message}`,
            diagnostics
        }));
        return true;
    }

    res.end(JSON.stringify({
        error: {
            message: `${options.messagePrefix || ''}${runtimeStorageError.message}`,
            code: runtimeStorageError.code || null,
            phase: runtimeStorageError.phase || null,
            domain: runtimeStorageError.domain || null,
            retryable: runtimeStorageError.retryable === true,
            traceId
        },
        diagnostics
    }));
    return true;
}

/**
 * 获取提供商池完整数据
 */
export async function handleGetProviders(req, res, currentConfig, providerPoolManager) {
    const providerPools = await loadProviderPools(currentConfig, providerPoolManager);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(providerPools));
    return true;
}

/**
 * 获取提供商池摘要
 */
export async function handleGetProvidersSummary(req, res, currentConfig, providerPoolManager) {
    const providerSummaries = await loadProviderPoolSummaries(currentConfig, providerPoolManager);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(providerSummaries));
    return true;
}

function normalizeDeleteUnhealthyErrorType(rawValue = '') {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (!normalized) {
        return 'all';
    }
    return DELETE_UNHEALTHY_ERROR_TYPES.has(normalized) ? normalized : null;
}

function classifyProviderErrorType(provider = {}) {
    const message = String(provider?.lastErrorMessage || '').toLowerCase();
    if (!message) {
        return 'unknown';
    }

    if (/\b(401|403)\b/.test(message)
        || /\b(unauthorized|forbidden|accessdenied|invalidtoken|expiredtoken|invalid[_-\s]?grant)\b/i.test(message)
        || /\b(re-?authenticate|authentication\s+(failed|required)|login\s+required|not\s+authenticated)\b/i.test(message)
        || /\b(refresh\s+token|token\s+refresh)\b/i.test(message)) {
        return 'auth';
    }

    if (/\b(429)\b/.test(message)
        || /\b(too many requests|rate limit|ratelimit|quota|insufficient)\b/i.test(message)) {
        return 'quota';
    }

    if (/\b(timeout|timed out|etimedout|deadline exceeded)\b/i.test(message)) {
        return 'timeout';
    }

    if (/\b(network|econnreset|econnrefused|enotfound|fetch failed|socket hang up)\b/i.test(message)) {
        return 'network';
    }

    return 'other';
}

/**
 * 获取支持的提供商类型（已注册适配器的）
 */
export async function handleGetSupportedProviders(req, res) {
    const supportedProviders = getRegisteredProviders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(supportedProviders));
    return true;
}

/**
 * 获取特定提供商类型的详细信息
 */
export async function handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType) {
    const providerPools = await loadProviderPools(currentConfig, providerPoolManager);

    const allProviders = providerPools[providerType] || [];
    const summary = buildProviderSummary(allProviders);
    const requestedQuery = parseProviderListQuery(req, allProviders.length);
    const healthFilter = requestedQuery?.healthFilter || 'all';
    const errorType = requestedQuery?.errorType || 'all';
    const healthFilteredProviders = filterProvidersByHealth(allProviders, healthFilter);
    const filteredProviders = filterProvidersByErrorType(healthFilteredProviders, errorType);
    const listQuery = parseProviderListQuery(req, filteredProviders.length);
    const sortedProviders = listQuery?.sort
        ? sortProvidersForDisplay(filteredProviders, listQuery.sort)
        : filteredProviders;
    const providers = listQuery
        ? sortedProviders.slice(listQuery.offset, listQuery.offset + listQuery.limit)
        : filteredProviders;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        providers,
        page: listQuery?.page || 1,
        limit: listQuery?.limit || allProviders.length,
        totalPages: listQuery?.totalPages || 1,
        returnedCount: providers.length,
        sort: listQuery?.sort || null,
        healthFilter,
        errorType,
        filteredCount: filteredProviders.length,
        filteredTotalPages: listQuery?.totalPages || 1,
        ...summary
    }));
    return true;
}

/**
 * 获取所有提供商的可用模型
 */
export async function handleGetProviderModels(req, res) {
    const allModels = getAllProviderModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allModels));
    return true;
}

/**
 * 获取特定提供商类型的可用模型
 */
export async function handleGetProviderTypeModels(req, res, providerType) {
    const models = getProviderModels(providerType);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        models
    }));
    return true;
}

/**
 * 添加新的提供商配置
 */
export async function handleAddProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { providerType, providerConfig } = body;

        if (!providerType || !providerConfig) {
            return writeJsonError(res, 400, 'providerType and providerConfig are required');
        }

        const providerTypeError = validateProviderTypeValue(providerType);
        if (providerTypeError) {
            return writeJsonError(res, 400, providerTypeError);
        }

        const providerConfigError = normalizeProviderConfigInput(providerConfig);
        if (providerConfigError) {
            return writeJsonError(res, 400, providerConfigError);
        }

        // Generate UUID if not provided
        if (!providerConfig.uuid) {
            providerConfig.uuid = generateUUID();
        } else {
            providerConfig.uuid = String(providerConfig.uuid).trim();
        }

        // Set default values
        providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
        providerConfig.lastUsed = providerConfig.lastUsed || null;
        providerConfig.usageCount = providerConfig.usageCount || 0;
        providerConfig.errorCount = providerConfig.errorCount || 0;
        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Add new provider to the appropriate type
        if (!providerPools[providerType]) {
            providerPools[providerType] = [];
        }

        if (hasProviderUuidConflict(providerPools, providerConfig.uuid)) {
            return writeJsonError(res, 409, 'Provider UUID already exists');
        }

        providerPools[providerType].push(providerConfig);

        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'add',
            filePath: filePath,
            providerType,
            providerConfig,
            timestamp: new Date().toISOString()
        });

        // 广播提供商更新事件
        safeBroadcastEvent('provider_update', {
            action: 'add',
            providerType,
            providerConfig,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider added successfully',
            provider: providerConfig,
            providerType
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'add_provider', error, {
            currentConfig,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 规范化 Grok SSO Token
 * @param {string} token - 原始 token
 * @returns {string} 规范化后的 token
 */
function normalizeGrokSsoToken(token) {
    if (!token || typeof token !== 'string') {
        return '';
    }
    const trimmed = token.trim();
    if (!trimmed) {
        return '';
    }
    return trimmed.startsWith('sso=') ? trimmed.slice(4).trim() : trimmed;
}

/**
 * 批量导入 Grok SSO Token
 * 支持统一公共配置，仅 token 不同
 */
export async function handleBatchImportGrokTokens(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { ssoTokens, commonConfig = {} } = body || {};

        if (!Array.isArray(ssoTokens) || ssoTokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'ssoTokens array is required and must not be empty'
            }));
            return true;
        }

        const normalizedTokens = ssoTokens
            .map(normalizeGrokSsoToken)
            .filter(Boolean);

        if (normalizedTokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'No valid SSO tokens found after normalization'
            }));
            return true;
        }

        const batchImportLimit = getGrokBatchImportLimit(currentConfig);
        if (normalizedTokens.length > batchImportLimit) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: `ssoTokens exceeds batch import limit (${batchImportLimit})`
            }));
            return true;
        }

        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        if (!providerPools['grok-custom']) {
            providerPools['grok-custom'] = [];
        }

        const existingProviders = providerPools['grok-custom'];
        const existingTokenSet = new Set(
            existingProviders
                .map(provider => normalizeGrokSsoToken(provider.GROK_COOKIE_TOKEN))
                .filter(Boolean)
        );

        const parseLimit = (value) => {
            const parsed = parseInt(value, 10);
            return Number.isFinite(parsed) ? parsed : 0;
        };

        const sharedConfig = {
            customNamePrefix: (commonConfig.customNamePrefix || '').toString().trim(),
            checkModelName: (commonConfig.checkModelName || '').toString().trim(),
            checkHealth: commonConfig.checkHealth === true,
            concurrencyLimit: parseLimit(commonConfig.concurrencyLimit),
            queueLimit: parseLimit(commonConfig.queueLimit),
            GROK_CF_CLEARANCE: (commonConfig.GROK_CF_CLEARANCE || '').toString().trim(),
            GROK_USER_AGENT: (commonConfig.GROK_USER_AGENT || '').toString().trim(),
            GROK_BASE_URL: (commonConfig.GROK_BASE_URL || '').toString().trim() || 'https://grok.com'
        };

        const details = [];
        const addedProviders = [];
        let successCount = 0;
        let failedCount = 0;

        for (let i = 0; i < normalizedTokens.length; i++) {
            const token = normalizedTokens[i];

            if (!token) {
                failedCount++;
                details.push({
                    index: i + 1,
                    success: false,
                    error: 'empty_token'
                });
                continue;
            }

            if (existingTokenSet.has(token)) {
                failedCount++;
                details.push({
                    index: i + 1,
                    success: false,
                    error: 'duplicate_token'
                });
                continue;
            }

            const providerConfig = {
                uuid: generateUUID(),
                customName: sharedConfig.customNamePrefix ? `${sharedConfig.customNamePrefix}-${i + 1}` : '',
                checkModelName: sharedConfig.checkModelName,
                checkHealth: sharedConfig.checkHealth,
                concurrencyLimit: sharedConfig.concurrencyLimit,
                queueLimit: sharedConfig.queueLimit,
                GROK_COOKIE_TOKEN: token,
                GROK_CF_CLEARANCE: sharedConfig.GROK_CF_CLEARANCE,
                GROK_USER_AGENT: sharedConfig.GROK_USER_AGENT,
                GROK_BASE_URL: sharedConfig.GROK_BASE_URL,
                isHealthy: true,
                isDisabled: false,
                lastUsed: null,
                usageCount: 0,
                errorCount: 0,
                lastErrorTime: null
            };

            existingProviders.push(providerConfig);
            existingTokenSet.add(token);
            addedProviders.push(providerConfig);
            successCount++;
            details.push({
                index: i + 1,
                success: true,
                uuid: providerConfig.uuid
            });
        }

        if (successCount > 0) {
            await persistProviderPools(currentConfig, providerPoolManager, providerPools);

            safeBroadcastEvent('config_update', {
                action: 'grok_batch_import',
                filePath,
                providerType: 'grok-custom',
                successCount,
                failedCount,
                timestamp: new Date().toISOString()
            });

            for (const providerConfig of addedProviders) {
                safeBroadcastEvent('provider_update', {
                    action: 'add',
                    providerType: 'grok-custom',
                    providerConfig,
                    timestamp: new Date().toISOString()
                });
            }
        }

        logger.info(`[UI API] Grok batch import completed: ${successCount} success, ${failedCount} failed`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: successCount > 0,
            providerType: 'grok-custom',
            total: normalizedTokens.length,
            successCount,
            failedCount,
            details
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'grok_batch_import', error, {
            currentConfig,
            providerType: 'grok-custom',
            filePath: getProviderPoolsFilePath(currentConfig)
        }, {
            legacyShape: 'flat'
        });
    }
}

/**
 * 更新特定提供商配置
 */
export async function handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const body = await getRequestBody(req);
        const { providerConfig } = body;

        if (!providerConfig) {
            return writeJsonError(res, 400, 'providerConfig is required');
        }

        const providerConfigError = normalizeProviderConfigInput(providerConfig);
        if (providerConfigError) {
            return writeJsonError(res, 400, providerConfigError);
        }

        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Find and update the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Update provider while preserving certain fields
        const existingProvider = providers[providerIndex];
        const updatedProvider = {
            ...existingProvider,
            ...providerConfig,
            uuid: providerUuid, // Ensure UUID doesn't change
            lastUsed: existingProvider.lastUsed, // Preserve usage stats
            usageCount: existingProvider.usageCount,
            errorCount: existingProvider.errorCount,
            lastErrorTime: existingProvider.lastErrorTime
        };

        providerPools[providerType][providerIndex] = updatedProvider;

        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] Updated provider ${providerUuid} in ${providerType}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'update',
            filePath: filePath,
            providerType,
            providerConfig: updatedProvider,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider updated successfully',
            provider: updatedProvider
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'update_provider', error, {
            currentConfig,
            providerType,
            providerUuid,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 删除特定提供商配置
 */
export async function handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Find and remove the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const deletedProvider = providers[providerIndex];
        providers.splice(providerIndex, 1);

        // Remove the entire provider type if no providers left
        if (providers.length === 0) {
            delete providerPools[providerType];
        }

        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'delete',
            filePath: filePath,
            providerType,
            providerConfig: deletedProvider,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider deleted successfully',
            deletedProvider
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'delete_provider', error, {
            currentConfig,
            providerType,
            providerUuid,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 禁用/启用特定提供商配置
 */
export async function handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
    try {
        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Find and update the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Update isDisabled field
        const provider = providers[providerIndex];
        provider.isDisabled = action === 'disable';
        
        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: action,
            filePath: filePath,
            providerType,
            providerConfig: provider,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Provider ${action}d successfully`,
            provider: provider
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, `${action}_provider`, error, {
            currentConfig,
            providerType,
            providerUuid,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 重置特定提供商类型的所有提供商健康状态
 */
export async function handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Reset health status for all providers of this type
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        let resetCount = 0;
        providers.forEach(provider => {
            // 统计 isHealthy 从 false 变为 true 的节点数量
            if (!provider.isHealthy) {
                resetCount++;
            }
            // 重置所有节点的状态
            provider.isHealthy = true;
            provider.errorCount = 0;
            provider.refreshCount = 0;
            provider.needsRefresh = false;
            provider.lastErrorTime = null;
        });

        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] Reset health status for ${resetCount} providers in ${providerType}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'reset_health',
            filePath: filePath,
            providerType,
            resetCount,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully reset health status for ${resetCount} providers`,
            resetCount,
            totalCount: providers.length
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'reset_provider_health', error, {
            currentConfig,
            providerType,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 删除特定提供商类型的所有不健康节点
 */
export async function handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const errorType = normalizeDeleteUnhealthyErrorType(requestUrl.searchParams.get('errorType'));
        if (errorType === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid errorType' } }));
            return true;
        }

        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Find and remove unhealthy providers
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // Filter out unhealthy providers (keep only healthy ones)
        const statusList = providerPoolManager?.providerStatus?.[providerType];
        const unhealthyUuids = new Set();
        if (Array.isArray(statusList)) {
            statusList.forEach((status) => {
                const statusConfig = status?.config;
                const statusUuid = status?.uuid || statusConfig?.uuid;
                if (!statusUuid) {
                    return;
                }
                if (statusConfig?.isHealthy !== true) {
                    unhealthyUuids.add(statusUuid);
                }
            });
        }

        const unhealthyProviders = unhealthyUuids.size > 0
            ? providers.filter((provider) => unhealthyUuids.has(provider?.uuid))
            : providers.filter((provider) => provider?.isHealthy !== true);
        const providersToDelete = errorType !== 'all'
            ? unhealthyProviders.filter((provider) => classifyProviderErrorType(provider) === errorType)
            : unhealthyProviders;

        if (providersToDelete.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to delete',
                deletedCount: 0,
                remainingCount: providers.length,
                appliedErrorType: errorType
            }));
            return true;
        }

        // Update the provider pool with remaining providers
        const deletedUuidSet = new Set(providersToDelete.map((provider) => provider?.uuid).filter(Boolean));
        const remainingProviders = providers.filter((provider) => !deletedUuidSet.has(provider?.uuid));

        if (remainingProviders.length === 0) {
            delete providerPools[providerType];
        } else {
            providerPools[providerType] = remainingProviders;
        }

        await persistProviderPools(currentConfig, providerPoolManager, providerPools, {
            managerProviderPools: providerPools
        });
        logger.info(`[UI API] Deleted ${providersToDelete.length} unhealthy providers from ${providerType} (errorType=${errorType})`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'delete_unhealthy',
            filePath: filePath,
            providerType,
            deletedCount: providersToDelete.length,
            deletedProviders: providersToDelete.map(p => ({ uuid: p.uuid, customName: p.customName })),
            appliedErrorType: errorType,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully deleted ${providersToDelete.length} unhealthy providers`,
            deletedCount: providersToDelete.length,
            remainingCount: remainingProviders.length,
            deletedProviders: providersToDelete.map(p => ({ uuid: p.uuid, customName: p.customName })),
            appliedErrorType: errorType
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'delete_unhealthy_providers', error, {
            currentConfig,
            providerType,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 批量刷新特定提供商类型的所有不健康节点的 UUID
 */
export async function handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Find unhealthy providers
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // Filter unhealthy providers and refresh their UUIDs
        const refreshedProviders = [];
        for (const provider of providers) {
            if (!provider.isHealthy) {
                const oldUuid = provider.uuid;
                const newUuid = generateUUID();
                provider.uuid = newUuid;
                refreshedProviders.push({
                    oldUuid,
                    newUuid,
                    customName: provider.customName
                });
            }
        }

        if (refreshedProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to refresh',
                refreshedCount: 0,
                totalCount: providers.length
            }));
            return true;
        }

        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] Refreshed UUIDs for ${refreshedProviders.length} unhealthy providers in ${providerType}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'refresh_unhealthy_uuids',
            filePath: filePath,
            providerType,
            refreshedCount: refreshedProviders.length,
            refreshedProviders,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully refreshed UUIDs for ${refreshedProviders.length} unhealthy providers`,
            refreshedCount: refreshedProviders.length,
            totalCount: providers.length,
            refreshedProviders
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'refresh_unhealthy_uuids', error, {
            currentConfig,
            providerType,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 对特定提供商类型的所有提供商执行健康检查
 */
export async function handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 只检测不健康的节点
        const unhealthyProviders = providers.filter(ps => !ps.config.isHealthy);
        
        if (unhealthyProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to check',
                successCount: 0,
                failCount: 0,
                totalCount: providers.length,
                results: []
            }));
            return true;
        }

        logger.info(`[UI API] Starting health check for ${unhealthyProviders.length} unhealthy providers in ${providerType} (total: ${providers.length})`);

        // 执行健康检测（强制检查，忽略 checkHealth 配置）
        const results = [];
        for (const providerStatus of unhealthyProviders) {
            const providerConfig = providerStatus.config;
            
            // 跳过已禁用的节点
            if (providerConfig.isDisabled) {
                logger.info(`[UI API] Skipping health check for disabled provider: ${providerConfig.uuid}`);
                continue;
            }

            try {
                // 传递 forceCheck = true 强制执行健康检查，忽略 checkHealth 配置
                const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);
                
                if (healthResult === null) {
                    results.push({
                        uuid: providerConfig.uuid,
                        success: null,
                        message: 'Health check not supported for this provider type'
                    });
                    continue;
                }
                
                if (healthResult.success) {
                    providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
                    results.push({
                        uuid: providerConfig.uuid,
                        success: true,
                        modelName: healthResult.modelName,
                        message: 'Healthy'
                    });
                } else {
                    // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                    const errorMessage = healthResult.errorMessage || 'Check failed';
                    const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                       /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                    
                    if (isAuthError) {
                        providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                        logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                    }
                    
                    providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                    if (healthResult.modelName) {
                        providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                    }
                    results.push({
                        uuid: providerConfig.uuid,
                        success: false,
                        modelName: healthResult.modelName,
                        message: errorMessage,
                        isAuthError: isAuthError
                    });
                }
            } catch (error) {
                const errorMessage = error.message || 'Unknown error';
                // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                   /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                
                if (isAuthError) {
                    providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                    logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                } else {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                }
                
                results.push({
                    uuid: providerConfig.uuid,
                    success: false,
                    message: errorMessage,
                    isAuthError: isAuthError
                });
            }
        }

        // 保存更新后的状态到统一存储
        const filePath = getProviderPoolsFilePath(currentConfig);
        
        // 从 providerStatus 构建 providerPools 对象并持久化
        const providerPools = {};
        for (const pType in providerPoolManager.providerStatus) {
            providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
        }
        await persistProviderPools(currentConfig, providerPoolManager, providerPools, {
            reinitializeManager: false,
            managerProviderPools: providerPools
        });

        const successCount = results.filter(r => r.success === true).length;
        const failCount = results.filter(r => r.success === false).length;

        logger.info(`[UI API] Health check completed for ${providerType}: ${successCount} recovered, ${failCount} still unhealthy (checked ${unhealthyProviders.length} unhealthy nodes)`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'health_check',
            filePath: filePath,
            providerType,
            results,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
            successCount,
            failCount,
            totalCount: providers.length,
            results
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'health_check', error, {
            currentConfig,
            providerType,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 对单个提供商节点执行健康检查
 */
export async function handleSingleProviderHealthCheck(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        const providerStatus = providers.find(ps => ps?.config?.uuid === providerUuid);
        if (!providerStatus?.config) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const providerConfig = providerStatus.config;
        if (providerConfig.isDisabled) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                skipped: true,
                message: 'Provider is disabled, skipped health check',
                result: {
                    uuid: providerUuid,
                    success: null,
                    message: 'Provider is disabled'
                }
            }));
            return true;
        }

        let result;
        try {
            // 强制执行健康检查，忽略 checkHealth 配置
            const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);

            if (healthResult === null) {
                result = {
                    uuid: providerConfig.uuid,
                    success: null,
                    message: 'Health check not supported for this provider type'
                };
            } else if (healthResult.success) {
                providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
                result = {
                    uuid: providerConfig.uuid,
                    success: true,
                    modelName: healthResult.modelName,
                    message: 'Healthy'
                };
            } else {
                const errorMessage = healthResult.errorMessage || 'Check failed';
                const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                    /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);

                if (isAuthError) {
                    providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                    logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                } else {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                }

                providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                if (healthResult.modelName) {
                    providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                }

                result = {
                    uuid: providerConfig.uuid,
                    success: false,
                    modelName: healthResult.modelName,
                    message: errorMessage,
                    isAuthError
                };
            }
        } catch (error) {
            const errorMessage = error.message || 'Unknown error';
            const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);

            if (isAuthError) {
                providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
            } else {
                providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
            }

            result = {
                uuid: providerConfig.uuid,
                success: false,
                message: errorMessage,
                isAuthError
            };
        }

        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = {};
        for (const pType in providerPoolManager.providerStatus) {
            providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
        }
        await persistProviderPools(currentConfig, providerPoolManager, providerPools, {
            reinitializeManager: false,
            managerProviderPools: providerPools
        });

        safeBroadcastEvent('config_update', {
            action: 'single_health_check',
            filePath,
            providerType,
            providerUuid,
            result,
            timestamp: new Date().toISOString()
        });

        const resultMessage = result.success === true
            ? 'Health check completed: healthy'
            : (result.success === false ? `Health check completed: ${result.message}` : result.message);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: resultMessage,
            result
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'single_provider_health_check', error, {
            currentConfig,
            providerType,
            providerUuid,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}

/**
 * 快速链接配置文件到对应的提供商
 * 支持单个文件路径或文件路径数组
 */
export async function handleQuickLinkProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { filePath, filePaths } = body;

        // 支持单个文件路径或文件路径数组
        const pathsToLink = filePaths || (filePath ? [filePath] : []);

        if (!pathsToLink || pathsToLink.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'filePath or filePaths is required' } }));
            return true;
        }

        const poolsFilePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        const results = [];
        const linkedProviders = [];

        // 处理每个文件路径
        for (const currentFilePath of pathsToLink) {
            const normalizedPath = currentFilePath.replace(/\\/g, '/').toLowerCase();
            
            // 根据文件路径自动识别提供商类型
            const providerMapping = detectProviderFromPath(normalizedPath);
            
            if (!providerMapping) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'Unable to identify provider type for config file'
                });
                continue;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName } = providerMapping;

            // Ensure provider type array exists
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }

            // Check if already linked - 使用标准化路径进行比较
            const normalizedForComparison = currentFilePath.replace(/\\/g, '/');
            const isAlreadyLinked = providerPools[providerType].some(p => {
                const existingPath = p[credPathKey];
                if (!existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                       normalizedExistingPath === './' + normalizedForComparison ||
                       './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'This config file is already linked',
                    providerType: providerType
                });
                continue;
            }

            // Create new provider config based on provider type
            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(currentFilePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId
            });

            providerPools[providerType].push(newProvider);
            linkedProviders.push({ providerType, provider: newProvider });

            results.push({
                filePath: currentFilePath,
                success: true,
                providerType: providerType,
                displayName: displayName,
                provider: newProvider
            });

            logger.info(`[UI API] Quick linked config: ${currentFilePath} -> ${providerType}`);
        }

        // Save to file only if there were successful links
        const successCount = results.filter(r => r.success).length;
        if (successCount > 0) {
            await persistProviderPools(currentConfig, providerPoolManager, providerPools);

            // Broadcast update events
            safeBroadcastEvent('config_update', {
                action: 'quick_link_batch',
                filePath: poolsFilePath,
                results: results,
                timestamp: new Date().toISOString()
            });

            for (const { providerType, provider } of linkedProviders) {
                safeBroadcastEvent('provider_update', {
                    action: 'add',
                    providerType,
                    providerConfig: provider,
                    timestamp: new Date().toISOString()
                });
            }
        }

        const failCount = results.filter(r => !r.success).length;
        const message = successCount > 0
            ? `Successfully linked ${successCount} config file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`
            : `Failed to link all ${failCount} config file(s)`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: successCount > 0,
            message: message,
            successCount: successCount,
            failCount: failCount,
            results: results
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'quick_link_provider', error, {
            currentConfig,
            filePath: getProviderPoolsFilePath(currentConfig)
        }, {
            messagePrefix: 'Link failed: '
        });
    }
}

/**
 * 刷新特定提供商的UUID
 */
export async function handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const filePath = getProviderPoolsFilePath(currentConfig);
        const providerPools = cloneProviderPools(await loadProviderPools(currentConfig, providerPoolManager));

        // Find the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Generate new UUID
        const oldUuid = providerUuid;
        let newUuid = generateUUID();
        let retryCount = 0;
        while (hasProviderUuidConflict(providerPools, newUuid, oldUuid) && retryCount < 5) {
            newUuid = generateUUID();
            retryCount++;
        }

        if (hasProviderUuidConflict(providerPools, newUuid, oldUuid)) {
            return writeJsonError(res, 409, 'Generated UUID conflicts with an existing provider');
        }
        
        // Update provider UUID
        providerPools[providerType][providerIndex].uuid = newUuid;

        await persistProviderPools(currentConfig, providerPoolManager, providerPools);
        logger.info(`[UI API] Refreshed UUID for provider in ${providerType}: ${oldUuid} -> ${newUuid}`);

        // 广播更新事件
        safeBroadcastEvent('config_update', {
            action: 'refresh_uuid',
            filePath: filePath,
            providerType,
            oldUuid,
            newUuid,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'UUID refreshed successfully',
            oldUuid,
            newUuid,
            provider: providerPools[providerType][providerIndex]
        }));
        return true;
    } catch (error) {
        return handleProviderMutationFailure(res, 'refresh_provider_uuid', error, {
            currentConfig,
            providerType,
            providerUuid,
            filePath: getProviderPoolsFilePath(currentConfig)
        });
    }
}
