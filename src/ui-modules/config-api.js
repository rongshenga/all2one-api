import { existsSync, readFileSync, writeFileSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import { CONFIG } from '../core/config-manager.js';
import { serviceInstances } from '../providers/adapter.js';
import { initApiService } from '../services/service-manager.js';
import { getRequestBody } from '../utils/common.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { rollbackRuntimeStorageMigration } from '../storage/runtime-storage-migration-service.js';

const CONFIG_RESPONSE_KEYS = [
    'REQUIRED_API_KEY',
    'SERVER_PORT',
    'HOST',
    'MODEL_PROVIDER',
    'DEFAULT_MODEL_PROVIDERS',
    'SYSTEM_PROMPT_FILE_PATH',
    'SYSTEM_PROMPT_MODE',
    'PROMPT_LOG_BASE_NAME',
    'PROMPT_LOG_MODE',
    'REQUEST_MAX_RETRIES',
    'REQUEST_BASE_DELAY',
    'CREDENTIAL_SWITCH_MAX_RETRIES',
    'CRON_NEAR_MINUTES',
    'CRON_REFRESH_TOKEN',
    'LOGIN_EXPIRY',
    'PROVIDER_POOLS_FILE_PATH',
    'MAX_ERROR_COUNT',
    'POOL_GROUP_SELECTION_ENABLED',
    'POOL_GROUP_SIZE',
    'POOL_GROUP_MIN_POOL_SIZE',
    'POOL_GROUP_UNHEALTHY_RATIO_THRESHOLD',
    'POOL_GROUP_MIN_HEALTHY',
    'POOL_GROUP_ROTATE_ON_SELECT',
    'PERSIST_SELECTION_STATE',
    'RUNTIME_STORAGE_BACKEND',
    'RUNTIME_STORAGE_DB_PATH',
    'RUNTIME_STORAGE_DUAL_WRITE',
    'RUNTIME_STORAGE_FALLBACK_TO_FILE',
    'RUNTIME_STORAGE_SQLITE_BINARY',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_RETRY_DELAY_MS',
    'RUNTIME_STORAGE_LARGE_POOL_THRESHOLD',
    'RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE',
    'RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE',
    'WARMUP_TARGET',
    'REFRESH_CONCURRENCY_PER_PROVIDER',
    'USAGE_QUERY_CONCURRENCY_PER_PROVIDER',
    'providerFallbackChain',
    'modelFallbackMapping',
    'PROXY_URL',
    'PROXY_ENABLED_PROVIDERS',
    'LOG_ENABLED',
    'LOG_OUTPUT_MODE',
    'LOG_LEVEL',
    'LOG_DIR',
    'LOG_INCLUDE_REQUEST_ID',
    'LOG_INCLUDE_TIMESTAMP',
    'LOG_MAX_FILE_SIZE',
    'LOG_MAX_FILES',
    'UI_DEBUG_LOGGING',
    'TLS_SIDECAR_ENABLED',
    'TLS_SIDECAR_PORT',
    'TLS_SIDECAR_BINARY_PATH'
];

const CONFIG_PERSIST_KEYS = [
    'REQUIRED_API_KEY',
    'SERVER_PORT',
    'HOST',
    'MODEL_PROVIDER',
    'SYSTEM_PROMPT_FILE_PATH',
    'SYSTEM_PROMPT_MODE',
    'PROMPT_LOG_BASE_NAME',
    'PROMPT_LOG_MODE',
    'REQUEST_MAX_RETRIES',
    'REQUEST_BASE_DELAY',
    'CREDENTIAL_SWITCH_MAX_RETRIES',
    'CRON_NEAR_MINUTES',
    'CRON_REFRESH_TOKEN',
    'LOGIN_EXPIRY',
    'PROVIDER_POOLS_FILE_PATH',
    'MAX_ERROR_COUNT',
    'POOL_GROUP_SELECTION_ENABLED',
    'POOL_GROUP_SIZE',
    'POOL_GROUP_MIN_POOL_SIZE',
    'POOL_GROUP_UNHEALTHY_RATIO_THRESHOLD',
    'POOL_GROUP_MIN_HEALTHY',
    'POOL_GROUP_ROTATE_ON_SELECT',
    'PERSIST_SELECTION_STATE',
    'RUNTIME_STORAGE_BACKEND',
    'RUNTIME_STORAGE_DB_PATH',
    'RUNTIME_STORAGE_DUAL_WRITE',
    'RUNTIME_STORAGE_FALLBACK_TO_FILE',
    'RUNTIME_STORAGE_SQLITE_BINARY',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE',
    'RUNTIME_STORAGE_PROVIDER_FLUSH_RETRY_DELAY_MS',
    'RUNTIME_STORAGE_LARGE_POOL_THRESHOLD',
    'RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE',
    'RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE',
    'WARMUP_TARGET',
    'REFRESH_CONCURRENCY_PER_PROVIDER',
    'USAGE_QUERY_CONCURRENCY_PER_PROVIDER',
    'providerFallbackChain',
    'modelFallbackMapping',
    'PROXY_URL',
    'PROXY_ENABLED_PROVIDERS',
    'LOG_ENABLED',
    'LOG_OUTPUT_MODE',
    'LOG_LEVEL',
    'LOG_DIR',
    'LOG_INCLUDE_REQUEST_ID',
    'LOG_INCLUDE_TIMESTAMP',
    'LOG_MAX_FILE_SIZE',
    'LOG_MAX_FILES',
    'UI_DEBUG_LOGGING',
    'TLS_SIDECAR_ENABLED',
    'TLS_SIDECAR_PORT',
    'TLS_SIDECAR_BINARY_PATH'
];

const RUNTIME_ONLY_CONFIG_KEYS = [
    'providerPools',
    'SYSTEM_PROMPT_CONTENT',
    'RUNTIME_STORAGE_INFO'
];

function pickConfigFields(source = {}, keys = []) {
    return keys.reduce((result, key) => {
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
            result[key] = source[key];
        }
        return result;
    }, {});
}

function buildUiConfigPayload(currentConfig = {}, options = {}) {
    return {
        ...pickConfigFields(currentConfig, CONFIG_RESPONSE_KEYS),
        systemPrompt: options.systemPrompt || ''
    };
}

function buildPersistedConfigPayload(currentConfig = {}, existingConfig = {}) {
    const configToSave = {
        ...existingConfig,
        ...pickConfigFields(currentConfig, CONFIG_PERSIST_KEYS)
    };

    for (const key of RUNTIME_ONLY_CONFIG_KEYS) {
        delete configToSave[key];
    }

    return configToSave;
}

/**
 * 重载配置文件
 * 动态导入config-manager并重新初始化配置
 * @returns {Promise<Object>} 返回重载后的配置对象
 */
export async function reloadConfig(providerPoolManager) {
    try {
        // Import config manager dynamically
        const { initializeConfig } = await import('../core/config-manager.js');

        if (providerPoolManager && typeof providerPoolManager.flushRuntimeState === 'function') {
            await providerPoolManager.flushRuntimeState({
                reason: 'reload',
                requestedBy: 'config-api'
            });
        }
        
        // Reload main config
        const newConfig = await initializeConfig(process.argv.slice(2), 'configs/config.json');
        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = newConfig.providerPools;
            providerPoolManager.initializeProviderStatus();
        }
        
        // Update global CONFIG
        Object.assign(CONFIG, newConfig);
        logger.info('[UI API] Configuration reloaded:');

        // Update initApiService - 清空并重新初始化服务实例
        Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
        initApiService(CONFIG);
        
        logger.info('[UI API] Configuration reloaded successfully');
        
        return newConfig;
    } catch (error) {
        logger.error('[UI API] Failed to reload configuration:', error);
        throw error;
    }
}

/**
 * 获取配置
 */
export async function handleGetConfig(req, res, currentConfig) {
    let systemPrompt = '';

    if (currentConfig.SYSTEM_PROMPT_FILE_PATH && existsSync(currentConfig.SYSTEM_PROMPT_FILE_PATH)) {
        try {
            systemPrompt = readFileSync(currentConfig.SYSTEM_PROMPT_FILE_PATH, 'utf-8');
        } catch (e) {
            logger.warn('[UI API] Failed to read system prompt file:', e.message);
        }
    }

    const payload = buildUiConfigPayload(currentConfig, { systemPrompt });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
}

/**
 * 更新配置
 */
export async function handleUpdateConfig(req, res, currentConfig) {
    try {
        const body = await getRequestBody(req);
        const newConfig = body;

        // Update config values in memory
        if (newConfig.REQUIRED_API_KEY !== undefined) currentConfig.REQUIRED_API_KEY = newConfig.REQUIRED_API_KEY;
        if (newConfig.HOST !== undefined) currentConfig.HOST = newConfig.HOST;
        if (newConfig.SERVER_PORT !== undefined) currentConfig.SERVER_PORT = newConfig.SERVER_PORT;
        if (newConfig.MODEL_PROVIDER !== undefined) currentConfig.MODEL_PROVIDER = newConfig.MODEL_PROVIDER;
        if (newConfig.SYSTEM_PROMPT_FILE_PATH !== undefined) currentConfig.SYSTEM_PROMPT_FILE_PATH = newConfig.SYSTEM_PROMPT_FILE_PATH;
        if (newConfig.SYSTEM_PROMPT_MODE !== undefined) currentConfig.SYSTEM_PROMPT_MODE = newConfig.SYSTEM_PROMPT_MODE;
        if (newConfig.PROMPT_LOG_BASE_NAME !== undefined) currentConfig.PROMPT_LOG_BASE_NAME = newConfig.PROMPT_LOG_BASE_NAME;
        if (newConfig.PROMPT_LOG_MODE !== undefined) currentConfig.PROMPT_LOG_MODE = newConfig.PROMPT_LOG_MODE;
        if (newConfig.REQUEST_MAX_RETRIES !== undefined) currentConfig.REQUEST_MAX_RETRIES = newConfig.REQUEST_MAX_RETRIES;
        if (newConfig.REQUEST_BASE_DELAY !== undefined) currentConfig.REQUEST_BASE_DELAY = newConfig.REQUEST_BASE_DELAY;
        if (newConfig.CREDENTIAL_SWITCH_MAX_RETRIES !== undefined) currentConfig.CREDENTIAL_SWITCH_MAX_RETRIES = newConfig.CREDENTIAL_SWITCH_MAX_RETRIES;
        if (newConfig.CRON_NEAR_MINUTES !== undefined) currentConfig.CRON_NEAR_MINUTES = newConfig.CRON_NEAR_MINUTES;
        if (newConfig.CRON_REFRESH_TOKEN !== undefined) currentConfig.CRON_REFRESH_TOKEN = newConfig.CRON_REFRESH_TOKEN;
        if (newConfig.LOGIN_EXPIRY !== undefined) currentConfig.LOGIN_EXPIRY = newConfig.LOGIN_EXPIRY;
        if (newConfig.PROVIDER_POOLS_FILE_PATH !== undefined) currentConfig.PROVIDER_POOLS_FILE_PATH = newConfig.PROVIDER_POOLS_FILE_PATH;
        if (newConfig.MAX_ERROR_COUNT !== undefined) currentConfig.MAX_ERROR_COUNT = newConfig.MAX_ERROR_COUNT;
        if (newConfig.POOL_GROUP_SELECTION_ENABLED !== undefined) currentConfig.POOL_GROUP_SELECTION_ENABLED = newConfig.POOL_GROUP_SELECTION_ENABLED;
        if (newConfig.POOL_GROUP_SIZE !== undefined) currentConfig.POOL_GROUP_SIZE = newConfig.POOL_GROUP_SIZE;
        if (newConfig.POOL_GROUP_MIN_POOL_SIZE !== undefined) currentConfig.POOL_GROUP_MIN_POOL_SIZE = newConfig.POOL_GROUP_MIN_POOL_SIZE;
        if (newConfig.POOL_GROUP_UNHEALTHY_RATIO_THRESHOLD !== undefined) currentConfig.POOL_GROUP_UNHEALTHY_RATIO_THRESHOLD = newConfig.POOL_GROUP_UNHEALTHY_RATIO_THRESHOLD;
        if (newConfig.POOL_GROUP_MIN_HEALTHY !== undefined) currentConfig.POOL_GROUP_MIN_HEALTHY = newConfig.POOL_GROUP_MIN_HEALTHY;
        if (newConfig.POOL_GROUP_ROTATE_ON_SELECT !== undefined) currentConfig.POOL_GROUP_ROTATE_ON_SELECT = newConfig.POOL_GROUP_ROTATE_ON_SELECT;
        if (newConfig.PERSIST_SELECTION_STATE !== undefined) currentConfig.PERSIST_SELECTION_STATE = newConfig.PERSIST_SELECTION_STATE;
        if (newConfig.RUNTIME_STORAGE_BACKEND !== undefined) currentConfig.RUNTIME_STORAGE_BACKEND = newConfig.RUNTIME_STORAGE_BACKEND;
        if (newConfig.RUNTIME_STORAGE_DB_PATH !== undefined) currentConfig.RUNTIME_STORAGE_DB_PATH = newConfig.RUNTIME_STORAGE_DB_PATH;
        if (newConfig.RUNTIME_STORAGE_DUAL_WRITE !== undefined) currentConfig.RUNTIME_STORAGE_DUAL_WRITE = newConfig.RUNTIME_STORAGE_DUAL_WRITE;
        if (newConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE !== undefined) currentConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE = newConfig.RUNTIME_STORAGE_FALLBACK_TO_FILE;
        if (newConfig.RUNTIME_STORAGE_SQLITE_BINARY !== undefined) currentConfig.RUNTIME_STORAGE_SQLITE_BINARY = newConfig.RUNTIME_STORAGE_SQLITE_BINARY;
        if (newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS !== undefined) currentConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS = newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_DEBOUNCE_MS;
        if (newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD !== undefined) currentConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD = newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_DIRTY_THRESHOLD;
        if (newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE !== undefined) currentConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE = newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_BATCH_SIZE;
        if (newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_RETRY_DELAY_MS !== undefined) currentConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_RETRY_DELAY_MS = newConfig.RUNTIME_STORAGE_PROVIDER_FLUSH_RETRY_DELAY_MS;
        if (newConfig.RUNTIME_STORAGE_LARGE_POOL_THRESHOLD !== undefined) currentConfig.RUNTIME_STORAGE_LARGE_POOL_THRESHOLD = newConfig.RUNTIME_STORAGE_LARGE_POOL_THRESHOLD;
        if (newConfig.RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE !== undefined) currentConfig.RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE = newConfig.RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE;
        if (newConfig.RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE !== undefined) currentConfig.RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE = newConfig.RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE;
        if (newConfig.WARMUP_TARGET !== undefined) currentConfig.WARMUP_TARGET = newConfig.WARMUP_TARGET;
        if (newConfig.REFRESH_CONCURRENCY_PER_PROVIDER !== undefined) currentConfig.REFRESH_CONCURRENCY_PER_PROVIDER = newConfig.REFRESH_CONCURRENCY_PER_PROVIDER;
        if (newConfig.USAGE_QUERY_CONCURRENCY_PER_PROVIDER !== undefined) currentConfig.USAGE_QUERY_CONCURRENCY_PER_PROVIDER = newConfig.USAGE_QUERY_CONCURRENCY_PER_PROVIDER;
        if (newConfig.providerFallbackChain !== undefined) currentConfig.providerFallbackChain = newConfig.providerFallbackChain;
        if (newConfig.modelFallbackMapping !== undefined) currentConfig.modelFallbackMapping = newConfig.modelFallbackMapping;
        
        // Proxy settings
        if (newConfig.PROXY_URL !== undefined) currentConfig.PROXY_URL = newConfig.PROXY_URL;
        if (newConfig.PROXY_ENABLED_PROVIDERS !== undefined) currentConfig.PROXY_ENABLED_PROVIDERS = newConfig.PROXY_ENABLED_PROVIDERS;

        // TLS Sidecar settings
        if (newConfig.TLS_SIDECAR_ENABLED !== undefined) currentConfig.TLS_SIDECAR_ENABLED = newConfig.TLS_SIDECAR_ENABLED;
        if (newConfig.TLS_SIDECAR_PORT !== undefined) currentConfig.TLS_SIDECAR_PORT = newConfig.TLS_SIDECAR_PORT;

        // Log settings
        if (newConfig.LOG_ENABLED !== undefined) currentConfig.LOG_ENABLED = newConfig.LOG_ENABLED;
        if (newConfig.LOG_OUTPUT_MODE !== undefined) currentConfig.LOG_OUTPUT_MODE = newConfig.LOG_OUTPUT_MODE;
        if (newConfig.LOG_LEVEL !== undefined) currentConfig.LOG_LEVEL = newConfig.LOG_LEVEL;
        if (newConfig.LOG_DIR !== undefined) currentConfig.LOG_DIR = newConfig.LOG_DIR;
        if (newConfig.LOG_INCLUDE_REQUEST_ID !== undefined) currentConfig.LOG_INCLUDE_REQUEST_ID = newConfig.LOG_INCLUDE_REQUEST_ID;
        if (newConfig.LOG_INCLUDE_TIMESTAMP !== undefined) currentConfig.LOG_INCLUDE_TIMESTAMP = newConfig.LOG_INCLUDE_TIMESTAMP;
        if (newConfig.LOG_MAX_FILE_SIZE !== undefined) currentConfig.LOG_MAX_FILE_SIZE = newConfig.LOG_MAX_FILE_SIZE;
        if (newConfig.LOG_MAX_FILES !== undefined) currentConfig.LOG_MAX_FILES = newConfig.LOG_MAX_FILES;
        if (newConfig.UI_DEBUG_LOGGING !== undefined) currentConfig.UI_DEBUG_LOGGING = newConfig.UI_DEBUG_LOGGING;

        // Handle system prompt update
        if (newConfig.systemPrompt !== undefined) {
            const promptPath = currentConfig.SYSTEM_PROMPT_FILE_PATH || 'configs/input_system_prompt.txt';
            try {
                const relativePath = path.relative(process.cwd(), promptPath);
                writeFileSync(promptPath, newConfig.systemPrompt, 'utf-8');

                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'update',
                    filePath: relativePath,
                    type: 'system_prompt',
                    timestamp: new Date().toISOString()
                });
                
                logger.info('[UI API] System prompt updated');
            } catch (e) {
                logger.warn('[UI API] Failed to write system prompt:', e.message);
            }
        }

        // Update config.json file
        try {
            const configPath = 'configs/config.json';
            
            // 基于现有 config.json 合并保存，避免把未在 UI 展示的持久化配置误删
            const existingConfig = existsSync(configPath)
                ? JSON.parse(readFileSync(configPath, 'utf-8'))
                : {};
            const configToSave = buildPersistedConfigPayload(currentConfig, existingConfig);

            writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
            logger.info('[UI API] Configuration saved to configs/config.json');
            
            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'update',
                filePath: 'configs/config.json',
                type: 'main_config',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('[UI API] Failed to save configuration to file:', error.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to save configuration to file: ' + error.message,
                    partial: true  // Indicate that memory config was updated but not saved
                }
            }));
            return true;
        }

        // Update the global CONFIG object to reflect changes immediately
        Object.assign(CONFIG, currentConfig);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration updated successfully',
            details: 'Configuration has been updated in both memory and config.json file'
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 重载配置文件
 */
export async function handleReloadConfig(req, res, providerPoolManager) {
    try {
        // 调用重载配置函数
        const newConfig = await reloadConfig(providerPoolManager);
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'reload',
            filePath: 'configs/config.json',
            providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration files reloaded successfully',
            details: {
                configReloaded: true,
                configPath: 'configs/config.json',
                providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null
            }
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to reload config files:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to reload configuration files: ' + error.message
            }
        }));
        return true;
    }
}


/**
 * 执行 Runtime Storage 回滚并重载配置
 */
export async function handleRollbackRuntimeStorage(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const runId = body?.runId ? String(body.runId).trim() : '';

        if (!runId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Runtime storage rollback requires runId'
                }
            }));
            return true;
        }

        const rollbackResult = await rollbackRuntimeStorageMigration(currentConfig || CONFIG, {
            runId,
            restoreLegacyFiles: body?.restoreLegacyFiles !== false
        });
        const newConfig = await reloadConfig(providerPoolManager);

        broadcastEvent('config_update', {
            action: 'runtime_storage_rollback',
            runId,
            filePath: 'configs/config.json',
            providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Runtime storage rollback completed successfully',
            details: {
                runId,
                rollbackResult,
                configReloaded: true,
                providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
                runtimeStorage: newConfig.RUNTIME_STORAGE_INFO || null
            }
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to rollback runtime storage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to rollback runtime storage: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 更新管理员密码
 */
export async function handleUpdateAdminPassword(req, res) {
    try {
        const body = await getRequestBody(req);
        const { password } = body;

        if (!password || password.trim() === '') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Password cannot be empty'
                }
            }));
            return true;
        }

        // 写入密码到 pwd 文件
        const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
        await fs.writeFile(pwdFilePath, password.trim(), 'utf-8');
        
        logger.info('[UI API] Admin password updated successfully');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Admin password updated successfully'
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to update admin password:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to update password: ' + error.message
            }
        }));
        return true;
    }
}
