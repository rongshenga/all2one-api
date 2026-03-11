import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { broadcastEvent } from './event-broadcast.js';
import {
    exportProviderPoolsCompatSnapshot,
    listCredentialAssetsWithRuntimeStorage
} from '../storage/runtime-storage-registry.js';

function normalizeUiDebugFlag(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isUploadConfigDebugEnabled(req = null, currentConfig = {}) {
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

function logUploadConfigDebug(enabled, message, payload = null, level = 'info') {
    if (!enabled) {
        return;
    }

    const logMethod = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
    if (payload !== null && payload !== undefined) {
        logMethod(`[UI Debug][Upload Config] ${message}`, payload);
        return;
    }

    logMethod(`[UI Debug][Upload Config] ${message}`);
}

function getUploadConfigSource(req) {
    // 上传配置页统一走 runtime storage，禁止全盘扫描
    return 'runtime';
}

function normalizePositiveInt(value, fallback = null) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveUploadConfigListOptions(req) {
    const options = {
        // 固定上限 50，避免页面请求被大号池拖垮
        limit: 50
    };
    try {
        const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
        const offset = normalizePositiveInt(requestUrl.searchParams.get('offset'), 0);
        const sort = requestUrl.searchParams.get('sort');
        const sourceKind = requestUrl.searchParams.get('sourceKind');

        if (Number.isFinite(offset) && offset >= 0) {
            options.offset = offset;
        }

        if (sort === 'asc' || sort === 'desc') {
            options.sort = sort;
        }

        if (typeof sourceKind === 'string' && sourceKind.trim()) {
            options.sourceKind = sourceKind.trim();
        }
    } catch {}

    return options;
}

function mapRuntimeCredentialAssetToConfigItem(asset = {}) {
    const rawPath = String(asset.source_path || '').replace(/\\/g, '/');
    const normalizedPath = rawPath.replace(/^\.\//, '');
    const fileName = normalizedPath ? path.basename(normalizedPath) : String(asset.id || 'credential.json');
    const extension = path.extname(fileName).toLowerCase() || '.json';
    const modifiedAt = asset.last_imported_at || asset.updated_at || new Date().toISOString();

    return {
        name: fileName,
        path: normalizedPath || rawPath || fileName,
        size: 0,
        type: extension === '.json' ? 'oauth' : 'other',
        provider: asset.provider_type || 'unknown',
        extension,
        modified: modifiedAt,
        isValid: true,
        errorMessage: '',
        isUsed: true,
        usageInfo: {
            isUsed: true,
            usageType: 'provider_pool',
            usageDetails: [
                {
                    type: 'Provider Pool',
                    location: 'Runtime credential binding',
                    providerType: asset.provider_type || 'unknown',
                    configKey: asset.source_kind || 'runtime_storage'
                }
            ]
        },
        preview: '',
        sourceKind: asset.source_kind || 'runtime_storage'
    };
}

async function buildRuntimeConfigInventory(currentConfig = {}, options = {}) {
    const assets = await listCredentialAssetsWithRuntimeStorage(currentConfig, null, {
        sort: 'desc',
        ...options
    });

    if (!Array.isArray(assets) || assets.length === 0) {
        return [];
    }

    return assets.map((asset) => mapRuntimeCredentialAssetToConfigItem(asset));
}

/**
 * 获取上传配置文件列表
 */
export async function handleGetUploadConfigs(req, res, currentConfig, providerPoolManager) {
    const debugEnabled = isUploadConfigDebugEnabled(req, currentConfig);
    const startedAt = Date.now();
    const source = getUploadConfigSource(req);
    const listOptions = resolveUploadConfigListOptions(req);

    logUploadConfigDebug(debugEnabled, 'GET /api/upload-configs started', {
        path: req?.url || '/api/upload-configs',
        source,
        listOptions
    });

    try {
        const configFiles = await buildRuntimeConfigInventory(currentConfig, listOptions);
        if (Number.isFinite(listOptions?.limit) && Array.isArray(configFiles)) {
            if (configFiles.length >= listOptions.limit) {
                logger.warn(`[UI API] Upload configs list truncated at ${listOptions.limit} items (adjust UPLOAD_CONFIGS_MAX_RESULTS or query limit/offset).`);
            }
        }
        logUploadConfigDebug(debugEnabled, 'GET /api/upload-configs completed', {
            count: Array.isArray(configFiles) ? configFiles.length : 0,
            durationMs: Date.now() - startedAt,
            source,
            listOptions
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configFiles));
        return true;
    } catch (error) {
        logUploadConfigDebug(debugEnabled, 'GET /api/upload-configs failed', {
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error),
            source
        }, 'warn');
        logger.error('[UI API] Failed to load upload configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to load upload configs: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 查看特定配置文件
 */
export async function handleViewConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only view files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        const content = await fs.readFile(fullPath, 'utf-8');
        const stats = await fs.stat(fullPath);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            path: relativePath,
            content: content,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            name: path.basename(fullPath)
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to view config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to view config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 删除特定配置文件
 */
export async function handleDeleteConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only delete files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        
        await fs.unlink(fullPath);
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: relativePath,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'File deleted successfully',
            filePath: relativePath
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 下载所有配置为 zip
 */
export async function handleDownloadAllConfigs(req, res, currentConfig) {
    try {
        const configsPath = path.join(process.cwd(), 'configs');
        if (!existsSync(configsPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'configs directory does not exist' } }));
            return true;
        }

        const zip = new AdmZip();
        let exportedProviderPools = null;

        if (currentConfig) {
            try {
                exportedProviderPools = await exportProviderPoolsCompatSnapshot(currentConfig);
            } catch (error) {
                logger.warn('[UI API] Failed to export provider pools snapshot for zip backup:', error.message);
            }

            const inMemoryProviderPools = currentConfig.providerPools;
            if ((!exportedProviderPools || Object.keys(exportedProviderPools).length === 0)
                && inMemoryProviderPools
                && Object.keys(inMemoryProviderPools).length > 0) {
                exportedProviderPools = inMemoryProviderPools;
                logger.warn('[UI API] Falling back to in-memory provider pools snapshot for zip backup');
            }
        }
        
        // 递归添加目录函数
        const addDirectoryToZip = async (dirPath, zipPath = '') => {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;
                const normalizedZipPath = itemZipPath.replace(/\\/g, '/');
                
                if (item.isFile()) {
                    if (exportedProviderPools && normalizedZipPath === 'provider_pools.json') {
                        continue;
                    }
                    const content = await fs.readFile(fullPath);
                    zip.addFile(normalizedZipPath, content);
                } else if (item.isDirectory()) {
                    await addDirectoryToZip(fullPath, itemZipPath);
                }
            }
        };

        await addDirectoryToZip(configsPath);

        if (exportedProviderPools) {
            zip.addFile('provider_pools.json', Buffer.from(JSON.stringify(exportedProviderPools, null, 2), 'utf8'));
        }
        
        const zipBuffer = zip.toBuffer();
        const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': zipBuffer.length
        });
        res.end(zipBuffer);
        
        logger.info(`[UI API] All configs downloaded as zip: ${filename}`);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download all configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to download zip: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 批量删除未绑定的配置文件
 * 只删除 configs/xxx/ 子目录下的未绑定配置文件
 */
export async function handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager) {
    try {
        // DB-only 模式下，不再执行全盘扫描 + 文件批量删除
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'DB-only mode: unbound file cleanup by filesystem scan is disabled',
            deletedCount: 0,
            deletedFiles: [],
            failedCount: 0,
            failedFiles: []
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete unbound configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete unbound configs: ' + error.message
            }
        }));
        return true;
    }
}
