import logger from '../utils/logger.js';
import { handleError, getClientIp } from '../utils/common.js';
import { handleUIApiRequests, serveStaticFiles } from '../services/ui-manager.js';
import { handleAPIRequests } from '../services/api-manager.js';
import { getProviderStatus } from '../services/service-manager.js';
import { getProviderPoolManager } from '../services/service-manager.js';
import { MODEL_PROVIDER } from '../utils/common.js';
import { getRegisteredProviders } from '../providers/adapter.js';
import { countTokensAnthropic } from '../utils/token-utils.js';
import { PROMPT_LOG_FILENAME } from '../core/config-manager.js';
import { getPluginManager } from '../core/plugin-manager.js';
import { randomUUID } from 'crypto';
import { handleGrokAssetsProxy } from '../utils/grok-assets-proxy.js';

/**
 * Generate a short unique request ID (8 characters)
 */
function generateRequestId() {
    return randomUUID().slice(0, 8);
}

/**
 * Parse request body as JSON
 */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON in request body'));
            }
        });
        req.on('error', reject);
    });
}


function cloneRequestConfigValue(value) {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

export function createRequestScopedConfig(config = {}) {
    const currentConfig = {
        ...config,
        providerPools: config.providerPools || {}
    };

    if (Array.isArray(config.DEFAULT_MODEL_PROVIDERS)) {
        currentConfig.DEFAULT_MODEL_PROVIDERS = [...config.DEFAULT_MODEL_PROVIDERS];
    }

    if (Array.isArray(config.PROXY_ENABLED_PROVIDERS)) {
        currentConfig.PROXY_ENABLED_PROVIDERS = [...config.PROXY_ENABLED_PROVIDERS];
    }

    if (config.providerFallbackChain && typeof config.providerFallbackChain === 'object') {
        currentConfig.providerFallbackChain = cloneRequestConfigValue(config.providerFallbackChain);
    }

    if (config.modelFallbackMapping && typeof config.modelFallbackMapping === 'object') {
        currentConfig.modelFallbackMapping = cloneRequestConfigValue(config.modelFallbackMapping);
    }

    if (config.RUNTIME_STORAGE_INFO && typeof config.RUNTIME_STORAGE_INFO === 'object') {
        currentConfig.RUNTIME_STORAGE_INFO = cloneRequestConfigValue(config.RUNTIME_STORAGE_INFO);
    }

    return currentConfig;
}


function normalizeUiDebugFlag(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function shouldEnableRequestDebugLogging(req, config = {}) {
    if (process.env.NODE_ENV === 'test' || config?.UI_DEBUG_LOGGING === true) {
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

function logRequestDebug(enabled, message, payload = null) {
    if (!enabled) {
        return;
    }

    if (payload) {
        logger.info(`[UI Debug] ${message}`, payload);
        return;
    }

    logger.info(`[UI Debug] ${message}`);
}

function normalizeStartupStatus(rawStatus) {
    if (!rawStatus || typeof rawStatus !== 'object') {
        return {
            ready: true,
            failed: false,
            phase: 'ready'
        };
    }

    return {
        ready: rawStatus.ready === true,
        failed: rawStatus.failed === true,
        phase: typeof rawStatus.phase === 'string' ? rawStatus.phase : (rawStatus.ready ? 'ready' : 'initializing'),
        startedAt: rawStatus.startedAt || null,
        updatedAt: rawStatus.updatedAt || null,
        readyAt: rawStatus.readyAt || null,
        error: rawStatus.error || null
    };
}

function shouldBlockApiRequestsDuringStartup(method, path, startupStatus) {
    if (method === 'OPTIONS') {
        return false;
    }

    if (!startupStatus || startupStatus.ready) {
        return false;
    }

    return (
        path === '/provider_health' ||
        path === '/v1' ||
        path.startsWith('/v1/') ||
        path === '/v1beta' ||
        path.startsWith('/v1beta/')
    );
}

function shouldBlockUiProviderDetailRequestsDuringStartup(method, path, startupStatus) {
    if (method === 'OPTIONS') {
        return false;
    }

    if (!startupStatus || startupStatus.ready) {
        return false;
    }

    if (method !== 'GET') {
        return false;
    }

    if (path === '/api/providers' || path === '/api/providers/summary' || path === '/api/providers/supported') {
        return false;
    }

    return /^\/api\/providers\/[^/]+$/.test(path);
}

/**
 * Main request handler. It authenticates the request, determines the endpoint type,
 * and delegates to the appropriate specialized handler function.
 * @param {Object} config - The server configuration
 * @param {Object} [options] - handler 扩展选项
 * @param {Function} [options.getStartupStatus] - 返回当前启动状态
 * @returns {Function} - The request handler function
 */
export function createRequestHandler(config, options = {}) {
    const getStartupStatus = typeof options.getStartupStatus === 'function'
        ? options.getStartupStatus
        : () => ({ ready: true, failed: false, phase: 'ready' });

    return async function requestHandler(req, res) {
        const providerPoolManager = getProviderPoolManager();
        const startupStatus = normalizeStartupStatus(getStartupStatus());

        // Generate unique request ID and set it in logger context
        const clientIp = getClientIp(req);
        const requestId = `${clientIp}:${generateRequestId()}`;
        logger.setRequestContext(requestId);

        let contextCleared = false;
        const clearLoggerContext = () => {
            if (contextCleared) return;
            contextCleared = true;
            logger.clearRequestContext(requestId);
        };

        // 为每个请求创建轻量配置副本，避免深拷贝大型 providerPools 快照
        const currentConfig = createRequestScopedConfig(config);
        
        // 计算当前请求的基础 URL
        const protocol = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        const host = req.headers.host;
        currentConfig.requestBaseUrl = `${protocol}://${host}`;
        
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        let path = requestUrl.pathname;
        const method = req.method;
        const requestStartedAt = Date.now();
        const requestDebugEnabled = shouldEnableRequestDebugLogging(req, currentConfig);
        const requestLabel = `${method} ${path}`;
        let requestCompletionLogged = false;
        const logRequestCompletion = (eventName) => {
            if (requestCompletionLogged) {
                return;
            }
            requestCompletionLogged = true;
            logRequestDebug(requestDebugEnabled, `${requestLabel} ${eventName}`, {
                statusCode: res.statusCode || 0,
                durationMs: Date.now() - requestStartedAt,
                requestId
            });
        };

        // 无论走哪条分支，只要响应结束就清理请求上下文
        res.once('finish', () => {
            logRequestCompletion('finished');
            clearLoggerContext();
        });
        res.once('close', () => {
            logRequestCompletion('closed');
            clearLoggerContext();
        });

        logRequestDebug(requestDebugEnabled, `${requestLabel} started`, {
            requestId,
            url: req.url
        });

        // Set CORS headers for all requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key, Model-Provider, X-Requested-With, Accept, Origin');
        res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours cache for preflight

        // Handle CORS preflight requests
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Serve static files for UI (除了登录页面需要认证)
        // 检查是否是插件静态文件
        const pluginManager = getPluginManager();
        const isPluginStatic = pluginManager.isPluginStaticPath(path);
        if (path.startsWith('/static/') || path === '/' || path === '/favicon.ico' || path === '/index.html' || path.startsWith('/app/') || path.startsWith('/components/') || path.startsWith('/vendor/') || path === '/login.html' || isPluginStatic) {
            const served = await serveStaticFiles(path, res, currentConfig);
            if (served) return;
        }

        // 执行插件路由
        const pluginRouteHandled = await pluginManager.executeRoutes(method, path, req, res);
        if (pluginRouteHandled) return;

        if (shouldBlockUiProviderDetailRequestsDuringStartup(method, path, startupStatus)) {
            const startupMessage = startupStatus.failed
                ? 'Server startup failed. Please inspect logs and restart service.'
                : 'Provider details are still warming up in background. Please retry shortly.';
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '5'
            });
            res.end(JSON.stringify({
                error: {
                    message: startupMessage
                },
                startup: startupStatus
            }));
            return;
        }

        const uiHandled = await handleUIApiRequests(method, path, req, res, currentConfig, providerPoolManager);
        if (uiHandled) return;

        // logger.info(`\n${new Date().toLocaleString()}`);
        logger.info(`[Server] Received request: ${req.method} http://${req.headers.host}${req.url}`);

        // Health check endpoint
        if (method === 'GET' && path === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: startupStatus.ready ? 'healthy' : (startupStatus.failed ? 'degraded' : 'initializing'),
                timestamp: new Date().toISOString(),
                provider: currentConfig.MODEL_PROVIDER,
                startup: startupStatus
            }));
            return true;
        }

        // Grok assets proxy endpoint
        if (method === 'GET' && path === '/api/grok/assets') {
            await handleGrokAssetsProxy(req, res, currentConfig, providerPoolManager);
            return true;
        }

        // providers health endpoint
        // url params: provider[string], customName[string], unhealthRatioThreshold[float]
        // 支持provider, customName过滤记录 
        // 支持unhealthRatioThreshold控制不健康比例的阈值, 当unhealthyRatio超过阈值返回summaryHealthy: false
        if (method === 'GET' && path === '/provider_health') {
            try {
                const provider = requestUrl.searchParams.get('provider');
                const customName = requestUrl.searchParams.get('customName');
                let unhealthRatioThreshold = requestUrl.searchParams.get('unhealthRatioThreshold');
                unhealthRatioThreshold = unhealthRatioThreshold === null ? 0.0001 : parseFloat(unhealthRatioThreshold);
                let provideStatus = await getProviderStatus(currentConfig, { provider, customName });
                let summaryHealth = true;
                if (!isNaN(unhealthRatioThreshold)) {
                    summaryHealth = provideStatus.unhealthyRatio <= unhealthRatioThreshold;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    items: provideStatus.providerPoolsSlim,
                    count: provideStatus.count,
                    unhealthyCount: provideStatus.unhealthyCount,
                    unhealthyRatio: provideStatus.unhealthyRatio,
                    unhealthySummeryMessage: provideStatus.unhealthySummeryMessage,
                    summaryHealth
                }));
                return true;
            } catch (error) {
                logger.info(`[Server] req provider_health error: ${error.message}`);
                handleError(res, { statusCode: 500, message: `Failed to get providers health: ${error.message}` }, currentConfig.MODEL_PROVIDER);
                return;
            }
        }


        // Handle API requests
        // Allow overriding MODEL_PROVIDER via request header
        const modelProviderHeader = req.headers['model-provider'];
        if (modelProviderHeader) {
            const registeredProviders = getRegisteredProviders();
            if (registeredProviders.includes(modelProviderHeader)) {
                currentConfig.MODEL_PROVIDER = modelProviderHeader;
                logger.info(`[Config] MODEL_PROVIDER overridden by header to: ${currentConfig.MODEL_PROVIDER}`);
            } else {
                logger.warn(`[Config] Provider ${modelProviderHeader} in header is not available.`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Provider ${modelProviderHeader} is not available.` } }));
                return;
            }
        }
          
        // Check if the first path segment matches a MODEL_PROVIDER and switch if it does
        const pathSegments = path.split('/').filter(segment => segment.length > 0);
        
        if (pathSegments.length > 0) {
            const firstSegment = pathSegments[0];
            const registeredProviders = getRegisteredProviders();
            const isValidProvider = registeredProviders.includes(firstSegment);
            const isAutoMode = firstSegment === MODEL_PROVIDER.AUTO;

            if (firstSegment && (isValidProvider || isAutoMode)) {
                currentConfig.MODEL_PROVIDER = firstSegment;
                logger.info(`[Config] MODEL_PROVIDER overridden by path segment to: ${currentConfig.MODEL_PROVIDER}`);
                pathSegments.shift();
                path = '/' + pathSegments.join('/');
                requestUrl.pathname = path;
            } else if (firstSegment && Object.values(MODEL_PROVIDER).includes(firstSegment)) {
                // 如果在 MODEL_PROVIDER 中但没注册适配器，拦截并报错
                logger.warn(`[Config] Provider ${firstSegment} is recognized but no adapter is registered.`);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Provider ${firstSegment} is not available.` } }));
                return;
            } else if (firstSegment && !isValidProvider) {
                logger.info(`[Config] Ignoring invalid MODEL_PROVIDER in path segment: ${firstSegment}`);
            }
        }

        if (shouldBlockApiRequestsDuringStartup(method, path, startupStatus)) {
            const startupMessage = startupStatus.failed
                ? 'Server startup failed. Please inspect logs and restart service.'
                : 'Server is initializing provider pools in background. Please retry shortly.';
            res.writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '5'
            });
            res.end(JSON.stringify({
                error: {
                    message: startupMessage
                },
                startup: startupStatus
            }));
            return;
        }

        // 1. 执行认证流程（只有 type='auth' 的插件参与）
        const authResult = await pluginManager.executeAuth(req, res, requestUrl, currentConfig);
        if (authResult.handled) {
            // 认证插件已处理请求（如发送了错误响应）
            return;
        }
        if (!authResult.authorized) {
            // 没有认证插件授权，返回 401
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unauthorized: API key is invalid or missing.' } }));
            return;
        }
        
        // 2. 执行普通中间件（type!='auth' 的插件）
        const middlewareResult = await pluginManager.executeMiddleware(req, res, requestUrl, currentConfig);
        if (middlewareResult.handled) {
            // 中间件已处理请求
            return;
        }

        // Handle count_tokens requests (Anthropic API compatible)
        if (path.includes('/count_tokens') && method === 'POST') {
            try {
                const body = await parseRequestBody(req);
                logger.info(`[Server] Handling count_tokens request for model: ${body.model}`);

                // Use common utility method directly
                try {
                    const result = countTokensAnthropic(body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (tokenError) {
                    logger.warn(`[Server] Common countTokens failed, falling back: ${tokenError.message}`);
                    // Last resort: return 0
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ input_tokens: 0 }));
                }
                return true;
            } catch (error) {
                logger.error(`[Server] count_tokens error: ${error.message}`);
                handleError(res, { statusCode: 500, message: `Failed to count tokens: ${error.message}` }, currentConfig.MODEL_PROVIDER);
                return;
            }
        }

        // 获取或选择 API Service 实例
        let apiService;
        // try {
        //     apiService = await getApiService(currentConfig);
        // } catch (error) {
        //     handleError(res, { statusCode: 500, message: `Failed to get API service: ${error.message}` }, currentConfig.MODEL_PROVIDER);
        //     const poolManager = getProviderPoolManager();
        //     if (poolManager) {
        //         poolManager.markProviderUnhealthy(currentConfig.MODEL_PROVIDER, {
        //             uuid: currentConfig.uuid
        //         });
        //     }
        //     return;
        // }

        try {
            // Handle API requests
            const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
            if (apiHandled) return;

            // Fallback for unmatched routes
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not Found' } }));
        } catch (error) {
            handleError(res, error, currentConfig.MODEL_PROVIDER);
        } finally {
            // Clear request context after request is complete
            clearLoggerContext();
        }
    };
}
