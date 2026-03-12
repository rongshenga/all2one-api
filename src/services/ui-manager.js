import { existsSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

// Import UI modules
import * as auth from '../ui-modules/auth.js';
import * as configApi from '../ui-modules/config-api.js';
import * as providerApi from '../ui-modules/provider-api.js';
import * as usageApi from '../ui-modules/usage-api.js';
import * as usageStatisticsApi from '../ui-modules/usage-statistics-api.js';
import * as pluginApi from '../ui-modules/plugin-api.js';
import * as systemApi from '../ui-modules/system-api.js';
import * as oauthApi from '../ui-modules/oauth-api.js';
import * as eventBroadcast from '../ui-modules/event-broadcast.js';

// Re-export from event-broadcast module
export { broadcastEvent, initializeUIManagement, handleUploadOAuthCredentials, upload } from '../ui-modules/event-broadcast.js';

function normalizeUiDebugFlag(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function shouldEnableUiDebugLogging(req, currentConfig = {}) {
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

function logUiDebug(enabled, message, payload = null) {
    if (!enabled) {
        return;
    }

    if (payload) {
        logger.info(`[UI Debug] ${message}`, payload);
        return;
    }

    logger.info(`[UI Debug] ${message}`);
}

async function traceUiHandler(enabled, requestLabel, handlerName, executor) {
    const startedAt = Date.now();
    logUiDebug(enabled, `${requestLabel} -> ${handlerName} started`);

    try {
        const result = await executor();
        logUiDebug(enabled, `${requestLabel} -> ${handlerName} completed`, {
            durationMs: Date.now() - startedAt
        });
        return result;
    } catch (error) {
        logger.error(`[UI Debug] ${requestLabel} -> ${handlerName} failed`, {
            durationMs: Date.now() - startedAt,
            error: error.message
        });
        throw error;
    }
}

function injectUiRuntimeFlags(content, currentConfig = {}) {
    const uiDebugEnabled = currentConfig?.UI_DEBUG_LOGGING === true ? 'true' : 'false';
    return content.replaceAll('__AICLIENT_UI_DEBUG_FLAG__', uiDebugEnabled);
}

/**
 * Serve static files for the UI
 * @param {string} path - The request path
 * @param {http.ServerResponse} res - The HTTP response object
 */
export async function serveStaticFiles(pathParam, res, currentConfig = {}) {
    const filePath = path.join(process.cwd(), 'static', pathParam === '/' || pathParam === '/index.html' ? 'index.html' : pathParam.replace('/static/', ''));

    if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.ico': 'image/x-icon'
        }[ext] || 'text/plain';

        let responseBody = readFileSync(filePath);
        if (ext === '.html') {
            responseBody = injectUiRuntimeFlags(readFileSync(filePath, 'utf8'), currentConfig);
        }

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(responseBody);
        return true;
    }
    return false;
}

/**
 * Handle UI management API requests
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Promise<boolean>} - True if the request was handled by UI API
 */
export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
    const uiDebugEnabled = shouldEnableUiDebugLogging(req, currentConfig);
    const requestLabel = `${method} ${pathParam}`;

    // 处理登录接口
    if (method === 'POST' && pathParam === '/api/login') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'login', async () => await auth.handleLoginRequest(req, res));
    }

    // 健康检查接口（用于前端token验证）
    if (method === 'GET' && pathParam === '/api/health') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'health', async () => await systemApi.handleHealthCheck(req, res));
    }
    
    // Handle UI management API requests (需要token验证，除了登录接口、健康检查和Events接口)
    if (pathParam.startsWith('/api/') && pathParam !== '/api/login' && pathParam !== '/api/health' && pathParam !== '/api/events' && pathParam !== '/api/grok/assets') {
        const authStartedAt = Date.now();
        logUiDebug(uiDebugEnabled, `${requestLabel} -> auth started`);

        // 检查token验证
        const isAuth = await auth.checkAuth(req, {
            debugEnabled: uiDebugEnabled,
            requestLabel
        });
        logUiDebug(uiDebugEnabled, `${requestLabel} -> auth ${isAuth ? 'passed' : 'failed'}`, {
            durationMs: Date.now() - authStartedAt
        });
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: 'Unauthorized access, please login first',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // 文件上传API
    if (method === 'POST' && pathParam === '/api/upload-oauth-credentials') {
        return await eventBroadcast.handleUploadOAuthCredentials(req, res, {
            currentConfig
        });
    }

    // Update admin password
    if (method === 'POST' && pathParam === '/api/admin-password') {
        return await configApi.handleUpdateAdminPassword(req, res);
    }

    // Get configuration
    if (method === 'GET' && pathParam === '/api/config') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'config.get', async () => await configApi.handleGetConfig(req, res, currentConfig));
    }

    // Update configuration
    if (method === 'POST' && pathParam === '/api/config') {
        return await configApi.handleUpdateConfig(req, res, currentConfig);
    }

    // Get system information
    if (method === 'GET' && pathParam === '/api/system') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'system', async () => await systemApi.handleGetSystem(req, res));
    }

    // Download today's log file
    if (method === 'GET' && pathParam === '/api/system/download-log') {
        return await systemApi.handleDownloadTodayLog(req, res);
    }

    // Clear today's log file
    if (method === 'POST' && pathParam === '/api/system/clear-log') {
        return await systemApi.handleClearTodayLog(req, res);
    }

    // Get provider pools summary
    if (method === 'GET' && pathParam === '/api/providers') {
        return await providerApi.handleGetProviders(req, res, currentConfig, providerPoolManager);
    }

    // Get compact provider pools summary for list page
    if (method === 'GET' && pathParam === '/api/providers/summary') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'providers.summary', async () => await providerApi.handleGetProvidersSummary(req, res, currentConfig, providerPoolManager));
    }

    // Get supported provider types based on registered adapters
    if (method === 'GET' && pathParam === '/api/providers/supported') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'providers.supported', async () => await providerApi.handleGetSupportedProviders(req, res));
    }

    // Get specific provider type details
    const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
    if (method === 'GET' && providerTypeMatch) {
        const providerType = decodeURIComponent(providerTypeMatch[1]);
        return await providerApi.handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Get available models for all providers or specific provider type
    if (method === 'GET' && pathParam === '/api/provider-models') {
        return await providerApi.handleGetProviderModels(req, res);
    }

    // Get available models for a specific provider type
    const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
    if (method === 'GET' && providerModelsMatch) {
        const providerType = decodeURIComponent(providerModelsMatch[1]);
        return await providerApi.handleGetProviderTypeModels(req, res, providerType);
    }

    // Add new provider configuration
    if (method === 'POST' && pathParam === '/api/providers') {
        return await providerApi.handleAddProvider(req, res, currentConfig, providerPoolManager);
    }

    // Reset all providers health status for a specific provider type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'reset-health' as UUID
    const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetHealthMatch) {
        const providerType = decodeURIComponent(resetHealthMatch[1]);
        return await providerApi.handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Perform health check for all providers of a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'health-check' as UUID
    const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
    if (method === 'POST' && healthCheckMatch) {
        const providerType = decodeURIComponent(healthCheckMatch[1]);
        return await providerApi.handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Delete all unhealthy providers for a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'delete-unhealthy' as UUID
    const deleteUnhealthyMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/delete-unhealthy$/);
    if (method === 'DELETE' && deleteUnhealthyMatch) {
        const providerType = decodeURIComponent(deleteUnhealthyMatch[1]);
        return await providerApi.handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Refresh UUIDs for all unhealthy providers of a specific type
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'refresh-unhealthy-uuids' as UUID
    const refreshUnhealthyUuidsMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/refresh-unhealthy-uuids$/);
    if (method === 'POST' && refreshUnhealthyUuidsMatch) {
        const providerType = decodeURIComponent(refreshUnhealthyUuidsMatch[1]);
        return await providerApi.handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Perform health check for a specific provider
    // NOTE: This must be before the generic /{providerType}/{uuid} route to avoid matching 'health-check' as UUID
    const singleProviderHealthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/health-check$/);
    if (method === 'POST' && singleProviderHealthCheckMatch) {
        const providerType = decodeURIComponent(singleProviderHealthCheckMatch[1]);
        const providerUuid = singleProviderHealthCheckMatch[2];
        return await providerApi.handleSingleProviderHealthCheck(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Disable/Enable specific provider configuration
    const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
    if (disableEnableProviderMatch) {
        const providerType = decodeURIComponent(disableEnableProviderMatch[1]);
        const providerUuid = disableEnableProviderMatch[2];
        const action = disableEnableProviderMatch[3];
        return await providerApi.handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action);
    }

    // Refresh UUID for specific provider configuration
    const refreshUuidMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/refresh-uuid$/);
    if (method === 'POST' && refreshUuidMatch) {
        const providerType = decodeURIComponent(refreshUuidMatch[1]);
        const providerUuid = refreshUuidMatch[2];
        return await providerApi.handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Update specific provider configuration
    // NOTE: This generic route must be after all specific routes like /reset-health, /health-check, /delete-unhealthy
    const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
    if (method === 'PUT' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];
        return await providerApi.handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Delete specific provider configuration
    if (method === 'DELETE' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];
        return await providerApi.handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid);
    }

    // Generate OAuth authorization URL for providers
    const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
    if (method === 'POST' && generateAuthUrlMatch) {
        const providerType = decodeURIComponent(generateAuthUrlMatch[1]);
        return await oauthApi.handleGenerateAuthUrl(req, res, currentConfig, providerType);
    }

    // Cancel OAuth authorization flow for providers
    const cancelAuthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/cancel-auth$/);
    if (method === 'POST' && cancelAuthMatch) {
        const providerType = decodeURIComponent(cancelAuthMatch[1]);
        return await oauthApi.handleCancelAuth(req, res, providerType);
    }

    // Handle manual OAuth callback
    if (method === 'POST' && pathParam === '/api/oauth/manual-callback') {
        return await oauthApi.handleManualOAuthCallback(req, res);
    }

    // Server-Sent Events for real-time updates
    if (method === 'GET' && pathParam === '/api/events') {
        return await eventBroadcast.handleEvents(req, res);
    }


    // Get usage limits for all providers
    if (method === 'GET' && pathParam === '/api/usage') {
        return await usageApi.handleGetUsage(req, res, currentConfig, providerPoolManager);
    }

    // Get supported providers for usage query
    if (method === 'GET' && pathParam === '/api/usage/supported-providers') {
        return await usageApi.handleGetSupportedProviders(req, res);
    }

    // Get usage refresh task status
    const usageTaskMatch = pathParam.match(/^\/api\/usage\/tasks\/([^\/]+)$/);
    if (method === 'GET' && usageTaskMatch) {
        const taskId = decodeURIComponent(usageTaskMatch[1]);
        return await usageApi.handleGetUsageRefreshTask(req, res, taskId);
    }
    if (method === 'POST' && usageTaskMatch) {
        const taskId = decodeURIComponent(usageTaskMatch[1]);
        return await usageApi.handlePostUsageRefreshTask(req, res, taskId);
    }

    // Get usage limits for a specific provider type
    const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
    if (method === 'GET' && usageProviderMatch) {
        const providerType = decodeURIComponent(usageProviderMatch[1]);
        return await usageApi.handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType);
    }

    // Usage statistics overview
    if (method === 'GET' && pathParam === '/api/usage-statistics/overview') {
        return await usageStatisticsApi.handleGetUsageStatisticsOverview(req, res);
    }

    // Usage statistics trends
    if (method === 'GET' && pathParam === '/api/usage-statistics/trends') {
        return await usageStatisticsApi.handleGetUsageStatisticsTrends(req, res);
    }

    // Usage statistics heatmap
    if (method === 'GET' && pathParam === '/api/usage-statistics/heatmap') {
        return await usageStatisticsApi.handleGetUsageStatisticsHeatmap(req, res);
    }

    // Usage statistics dimensions
    if (method === 'GET' && pathParam === '/api/usage-statistics/dimensions/models') {
        return await usageStatisticsApi.handleGetUsageStatisticsModelDimensions(req, res);
    }
    if (method === 'GET' && pathParam === '/api/usage-statistics/dimensions/credentials') {
        return await usageStatisticsApi.handleGetUsageStatisticsCredentialDimensions(req, res);
    }

    // Usage statistics events and export
    if (method === 'GET' && pathParam === '/api/usage-statistics/events') {
        return await usageStatisticsApi.handleGetUsageStatisticsEvents(req, res);
    }
    if (method === 'GET' && pathParam === '/api/usage-statistics/export') {
        return await usageStatisticsApi.handleExportUsageStatistics(req, res);
    }

    // Usage statistics model prices
    if (method === 'GET' && pathParam === '/api/usage-statistics/prices') {
        return await usageStatisticsApi.handleGetUsageStatisticsPrices(req, res);
    }
    if (method === 'PUT' && pathParam === '/api/usage-statistics/prices') {
        return await usageStatisticsApi.handlePutUsageStatisticsPrices(req, res);
    }

    // Reload configuration files
    if (method === 'POST' && pathParam === '/api/reload-config') {
        return await configApi.handleReloadConfig(req, res, providerPoolManager);
    }

    // Roll back runtime storage migration and rebuild compat snapshot caches
    if (method === 'POST' && pathParam === '/api/runtime-storage/rollback') {
        return await configApi.handleRollbackRuntimeStorage(req, res, currentConfig, providerPoolManager);
    }

    // Restart service (worker process)
    if (method === 'POST' && pathParam === '/api/restart-service') {
        return await systemApi.handleRestartService(req, res);
    }

    // Get service mode information
    if (method === 'GET' && pathParam === '/api/service-mode') {
        return await traceUiHandler(uiDebugEnabled, requestLabel, 'service-mode', async () => await systemApi.handleGetServiceMode(req, res));
    }

    // Batch import Kiro refresh tokens with SSE (real-time progress)
    if (method === 'POST' && pathParam === '/api/kiro/batch-import-tokens') {
        return await oauthApi.handleBatchImportKiroTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/gemini/batch-import-tokens') {
        return await oauthApi.handleBatchImportGeminiTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/codex/batch-import-tokens') {
        return await oauthApi.handleBatchImportCodexTokens(req, res);
    }

    if (method === 'POST' && pathParam === '/api/grok/batch-import-tokens') {
        return await providerApi.handleBatchImportGrokTokens(req, res, currentConfig, providerPoolManager);
    }

    // Import AWS SSO credentials for Kiro
    if (method === 'POST' && pathParam === '/api/kiro/import-aws-credentials') {
        return await oauthApi.handleImportAwsCredentials(req, res);
    }

    // Get plugins list
    if (method === 'GET' && pathParam === '/api/plugins') {
        return await pluginApi.handleGetPlugins(req, res);
    }

    // Toggle plugin status
    const togglePluginMatch = pathParam.match(/^\/api\/plugins\/(.+)\/toggle$/);
    if (method === 'POST' && togglePluginMatch) {
        const pluginName = decodeURIComponent(togglePluginMatch[1]);
        return await pluginApi.handleTogglePlugin(req, res, pluginName);
    }

    return false;
}
