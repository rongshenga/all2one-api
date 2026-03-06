// 提供商管理功能模块

import { providerStats, updateProviderStats } from './constants.js';
import { showToast, getProviderConfigs } from './utils.js';
import { fileUploadHandler } from './file-upload.js';
import { t, getCurrentLanguage } from './i18n.js';
import { renderRoutingExamples } from './routing-examples.js';
import { updateModelsProviderConfigs } from './models-manager.js';
import { updateTutorialProviderConfigs } from './tutorial-manager.js';
import { updateUsageProviderConfigs } from './usage-manager.js';
import { updateConfigProviderConfigs } from './config-manager.js';
import { loadConfigList, updateProviderFilterOptions } from './upload-config-manager.js';
import { setServiceMode } from './event-handlers.js';

// 保存初始服务器时间
let initialServerTime = null;
let initialLoadTime = null;
let isStaticProviderConfigsUpdated = false;
let cachedSupportedProviders = null;
const PROVIDERS_LIST_LOADING_DELAY_MS = 160;
const PROVIDER_DETAILS_LOADING_DELAY_MS = 180;
let providersSectionLoadingCount = 0;
let providerDetailsGlobalLoadingCount = 0;
let providerDetailsGlobalLoadingEl = null;

/**
 * 设置提供商池列表区域 loading 状态
 * @param {boolean} isLoading - 是否显示 loading
 * @returns {boolean} 是否成功更新了 loading 视图
 */
function setProvidersSectionLoading(isLoading) {
    const loadingEl = document.getElementById('providersLoading');
    const container = document.querySelector('#providers .providers-container');
    if (!loadingEl || !container) {
        return false;
    }

    loadingEl.classList.toggle('active', isLoading);
    loadingEl.setAttribute('aria-hidden', isLoading ? 'false' : 'true');
    container.setAttribute('aria-busy', isLoading ? 'true' : 'false');
    return true;
}

/**
 * 显示提供商详情加载遮罩
 * @param {string} message - 加载文案
 */
function showProviderGlobalLoading(message = t('providers.loadingDetails')) {
    providerDetailsGlobalLoadingCount += 1;

    if (!providerDetailsGlobalLoadingEl) {
        const overlay = document.createElement('div');
        overlay.className = 'provider-global-loading-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-live', 'polite');

        const card = document.createElement('div');
        card.className = 'provider-global-loading-card';

        const icon = document.createElement('i');
        icon.className = 'fas fa-spinner fa-spin';
        icon.setAttribute('aria-hidden', 'true');

        const text = document.createElement('span');
        text.className = 'provider-global-loading-text';
        text.textContent = message;

        card.appendChild(icon);
        card.appendChild(text);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        providerDetailsGlobalLoadingEl = overlay;
        return;
    }

    const textEl = providerDetailsGlobalLoadingEl.querySelector('.provider-global-loading-text');
    if (textEl) {
        textEl.textContent = message;
    }
}

/**
 * 隐藏提供商详情加载遮罩
 */
function hideProviderGlobalLoading() {
    providerDetailsGlobalLoadingCount = Math.max(0, providerDetailsGlobalLoadingCount - 1);

    if (providerDetailsGlobalLoadingCount > 0) {
        return;
    }

    if (providerDetailsGlobalLoadingEl) {
        providerDetailsGlobalLoadingEl.remove();
        providerDetailsGlobalLoadingEl = null;
    }
}

/**
 * 加载系统信息
 */
async function loadSystemInfo() {
    try {
        const data = await window.apiClient.get('/system');

        const appVersionEl = document.getElementById('appVersion');
        const nodeVersionEl = document.getElementById('nodeVersion');
        const serverTimeEl = document.getElementById('serverTime');
        const memoryUsageEl = document.getElementById('memoryUsage');
        const cpuUsageEl = document.getElementById('cpuUsage');

        if (appVersionEl) appVersionEl.textContent = data.appVersion ? `v${data.appVersion}` : '--';
        
        // 自动检查更新
        if (data.appVersion) {
            checkUpdate(true);
        }

        if (nodeVersionEl) nodeVersionEl.textContent = data.nodeVersion || '--';
        if (memoryUsageEl) memoryUsageEl.textContent = data.memoryUsage || '--';
        if (cpuUsageEl) cpuUsageEl.textContent = data.cpuUsage || '--';
        
        // 保存初始时间用于本地计算
        if (data.serverTime) {
            initialServerTime = new Date(data.serverTime);
            initialLoadTime = Date.now();
        }
        
        // 初始显示
        if (serverTimeEl) serverTimeEl.textContent = data.serverTime || '--';

        // 加载服务模式信息
        await loadServiceModeInfo();

    } catch (error) {
        console.error('Failed to load system info:', error);
    }
}

/**
 * 加载服务运行模式信息
 */
async function loadServiceModeInfo() {
    try {
        const data = await window.apiClient.get('/service-mode');
        
        const serviceModeEl = document.getElementById('serviceMode');
        const processPidEl = document.getElementById('processPid');
        const platformInfoEl = document.getElementById('platformInfo');
        
        // 更新服务模式到 event-handlers
        setServiceMode(data.mode || 'worker');
        
        // 更新重启/重载按钮显示
        updateRestartButton(data.mode);
        
        if (serviceModeEl) {
            const modeText = data.mode === 'worker'
                ? t('dashboard.serviceMode.worker')
                : t('dashboard.serviceMode.standalone');
            const canRestartIcon = data.canAutoRestart
                ? '<i class="fas fa-check-circle" style="color: #10b981; margin-left: 4px;" title="' + t('dashboard.serviceMode.canRestart') + '"></i>'
                : '';
            serviceModeEl.innerHTML = modeText;
        }
        
        if (processPidEl) {
            processPidEl.textContent = data.pid || '--';
        }
        
        if (platformInfoEl) {
            // 格式化平台信息
            const platformMap = {
                'win32': 'Windows',
                'darwin': 'macOS',
                'linux': 'Linux',
                'freebsd': 'FreeBSD'
            };
            platformInfoEl.textContent = platformMap[data.platform] || data.platform || '--';
        }
        
    } catch (error) {
        console.error('Failed to load service mode info:', error);
    }
}

/**
 * 根据服务模式更新重启/重载按钮显示
 * @param {string} mode - 服务模式 ('worker' 或 'standalone')
 */
function updateRestartButton(mode) {
    const restartBtn = document.getElementById('restartBtn');
    const restartBtnIcon = document.getElementById('restartBtnIcon');
    const restartBtnText = document.getElementById('restartBtnText');
    
    if (!restartBtn) return;
    
    if (mode === 'standalone') {
        // 独立模式：显示"重载"按钮
        if (restartBtnIcon) {
            restartBtnIcon.className = 'fas fa-sync-alt';
        }
        if (restartBtnText) {
            restartBtnText.textContent = t('header.reload');
            restartBtnText.setAttribute('data-i18n', 'header.reload');
        }
        restartBtn.setAttribute('aria-label', t('header.reload'));
        restartBtn.setAttribute('data-i18n-aria-label', 'header.reload');
        restartBtn.title = t('header.reload');
    } else {
        // 子进程模式：显示"重启"按钮
        if (restartBtnIcon) {
            restartBtnIcon.className = 'fas fa-redo';
        }
        if (restartBtnText) {
            restartBtnText.textContent = t('header.restart');
            restartBtnText.setAttribute('data-i18n', 'header.restart');
        }
        restartBtn.setAttribute('aria-label', t('header.restart'));
        restartBtn.setAttribute('data-i18n-aria-label', 'header.restart');
        restartBtn.title = t('header.restart');
    }
}

/**
 * 更新服务器时间显示（本地计算）
 */
function updateTimeDisplay() {
    if (!initialServerTime || !initialLoadTime) {
        return;
    }

    const serverTimeEl = document.getElementById('serverTime');

    // 计算经过的秒数
    const elapsedSeconds = Math.floor((Date.now() - initialLoadTime) / 1000);

    // 更新服务器时间
    if (serverTimeEl) {
        const currentServerTime = new Date(initialServerTime.getTime() + elapsedSeconds * 1000);
        serverTimeEl.textContent = currentServerTime.toLocaleString(getCurrentLanguage(), {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

}

/**
 * 加载提供商列表
 */
async function loadProviders() {
    let loadingTimer = null;
    let hasDisplayedSectionLoading = false;

    try {
        loadingTimer = window.setTimeout(() => {
            if (setProvidersSectionLoading(true)) {
                providersSectionLoadingCount += 1;
                hasDisplayedSectionLoading = true;
            }
        }, PROVIDERS_LIST_LOADING_DELAY_MS);

        const providers = await window.apiClient.get('/providers/summary');

        // 动态更新其他模块的提供商信息，只需更新一次
        if (!isStaticProviderConfigsUpdated) {
            cachedSupportedProviders = await window.apiClient.get('/providers/supported');
            const providerConfigs = getProviderConfigs(cachedSupportedProviders);
            
            // 动态更新凭据文件管理的提供商类型筛选项
            updateProviderFilterOptions(providerConfigs);
            
            // 动态更新仪表盘页面的路径路由调用示例
            renderRoutingExamples(providerConfigs);
            
            // 动态更新仪表盘页面的可用模型列表提供商信息
            updateModelsProviderConfigs(providerConfigs);
            
            // 动态更新配置教程页面的提供商信息
            updateTutorialProviderConfigs(providerConfigs);
            
            // 动态更新用量查询页面的提供商信息
            updateUsageProviderConfigs(providerConfigs);
            
            // 动态更新配置管理页面的提供商选择标签
            updateConfigProviderConfigs(providerConfigs);
            
            isStaticProviderConfigsUpdated = true;
        }

        renderProviders(providers, cachedSupportedProviders);
    } catch (error) {
        console.error('Failed to load providers:', error);
    } finally {
        if (loadingTimer) {
            window.clearTimeout(loadingTimer);
        }

        if (hasDisplayedSectionLoading) {
            providersSectionLoadingCount = Math.max(0, providersSectionLoadingCount - 1);
            if (providersSectionLoadingCount === 0) {
                setProvidersSectionLoading(false);
            }
        }
    }
}

/**
 * 归一化提供商摘要数据
 * @param {Object|Array|null} providerData - 提供商摘要或旧版账号数组
 * @returns {{totalCount: number, healthyCount: number, usageCount: number, errorCount: number}}
 */
function normalizeProviderSummary(providerData) {
    if (Array.isArray(providerData)) {
        return {
            totalCount: providerData.length,
            healthyCount: providerData.filter(account => account.isHealthy && !account.isDisabled).length,
            usageCount: providerData.reduce((sum, account) => sum + (account.usageCount || 0), 0),
            errorCount: providerData.reduce((sum, account) => sum + (account.errorCount || 0), 0)
        };
    }

    if (providerData && typeof providerData === 'object') {
        return {
            totalCount: Number(providerData.totalCount) || 0,
            healthyCount: Number(providerData.healthyCount) || 0,
            usageCount: Number(providerData.usageCount) || 0,
            errorCount: Number(providerData.errorCount) || 0
        };
    }

    return {
        totalCount: 0,
        healthyCount: 0,
        usageCount: 0,
        errorCount: 0
    };
}

/**
 * 渲染提供商列表
 * @param {Object} providers - 提供商数据
 * @param {string[]} supportedProviders - 已注册的提供商类型列表
 */
function renderProviders(providers, supportedProviders = []) {
    const container = document.getElementById('providersList');
    if (!container) return;
    
    container.innerHTML = '';

    // 检查是否有提供商池数据
    const hasProviders = Object.keys(providers).length > 0;
    const statsGrid = document.querySelector('#providers .stats-grid');
    
    // 始终显示统计卡片
    if (statsGrid) statsGrid.style.display = 'grid';
    
    const providerConfigs = getProviderConfigs(supportedProviders);
    
    // 提取显示的 ID 顺序
    const providerDisplayOrder = providerConfigs.filter(c => c.visible !== false).map(c => c.id);
    
    // 建立 ID 到配置的映射，方便获取显示名称
    const configMap = providerConfigs.reduce((map, config) => {
        map[config.id] = config;
        return map;
    }, {});
    
    // 获取所有提供商类型并按指定顺序排序
    // 优先显示预定义的所有提供商类型，即使某些提供商没有数据也要显示
    let allProviderTypes;
    if (hasProviders) {
        // 合并预定义类型和实际存在的类型，确保显示所有预定义提供商
        const actualProviderTypes = Object.keys(providers);
        // 只保留配置中标记为 visible 的，或者不在配置中的（默认显示）
        allProviderTypes = [...new Set([...providerDisplayOrder, ...actualProviderTypes])];
    } else {
        allProviderTypes = providerDisplayOrder;
    }

    // 过滤掉明确设置为不显示的提供商
    const sortedProviderTypes = providerDisplayOrder.filter(type => allProviderTypes.includes(type))
        .concat(allProviderTypes.filter(type => !providerDisplayOrder.some(t => t === type) && !configMap[type]?.visible === false));
    
    // 计算总统计
    let totalAccounts = 0;
    let totalHealthy = 0;
    
    // 按照排序后的提供商类型渲染
    sortedProviderTypes.forEach((providerType) => {
        // 如果配置中明确设置为不显示，则跳过
        if (configMap[providerType] && configMap[providerType].visible === false) {
            return;
        }

        const providerData = hasProviders ? providers[providerType] : null;
        const summary = normalizeProviderSummary(providerData);
        const providerDiv = document.createElement('div');
        providerDiv.className = 'provider-item';
        providerDiv.dataset.providerType = providerType;
        providerDiv.style.cursor = 'pointer';

        const { healthyCount, totalCount, usageCount, errorCount } = summary;
        
        totalAccounts += totalCount;
        totalHealthy += healthyCount;

        // 更新全局统计变量
        if (!providerStats.providerTypeStats[providerType]) {
            providerStats.providerTypeStats[providerType] = {
                totalAccounts: 0,
                healthyAccounts: 0,
                totalUsage: 0,
                totalErrors: 0,
                lastUpdate: null
            };
        }
        
        const typeStats = providerStats.providerTypeStats[providerType];
        typeStats.totalAccounts = totalCount;
        typeStats.healthyAccounts = healthyCount;
        typeStats.totalUsage = usageCount;
        typeStats.totalErrors = errorCount;
        typeStats.lastUpdate = new Date().toISOString();

        // 为无数据状态设置特殊样式
        const isEmptyState = !hasProviders || totalCount === 0;
        const statusClass = isEmptyState ? 'status-empty' : (healthyCount === totalCount ? 'status-healthy' : 'status-unhealthy');
        const statusIcon = isEmptyState ? 'fa-info-circle' : (healthyCount === totalCount ? 'fa-check-circle' : 'fa-exclamation-triangle');
        const statusText = isEmptyState ? t('providers.status.empty') : t('providers.status.healthy', { healthy: healthyCount, total: totalCount });

        // 获取显示名称
        const displayName = configMap[providerType]?.name || providerType;

        providerDiv.innerHTML = `
            <div class="provider-header">
                <div class="provider-name">
                    <span class="provider-type-text">${displayName}</span>
                </div>
                <div class="provider-header-right">
                    ${generateAuthButton(providerType)}
                    <div class="provider-status ${statusClass}">
                        <i class="fas fa-${statusIcon}"></i>
                        <span>${statusText}</span>
                    </div>
                </div>
            </div>
            <div class="provider-stats">
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.totalAccounts">${t('providers.stat.totalAccounts')}</span>
                    <span class="provider-stat-value">${totalCount}</span>
                </div>
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.healthyAccounts">${t('providers.stat.healthyAccounts')}</span>
                    <span class="provider-stat-value">${healthyCount}</span>
                </div>
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.usageCount">${t('providers.stat.usageCount')}</span>
                    <span class="provider-stat-value">${usageCount}</span>
                </div>
                <div class="provider-stat">
                    <span class="provider-stat-label" data-i18n="providers.stat.errorCount">${t('providers.stat.errorCount')}</span>
                    <span class="provider-stat-value">${errorCount}</span>
                </div>
            </div>
        `;

        // 如果是空状态，添加特殊样式
        if (isEmptyState) {
            providerDiv.classList.add('empty-provider');
        }

        // 添加点击事件 - 整个提供商组都可以点击
        providerDiv.addEventListener('click', (e) => {
            e.preventDefault();
            openProviderManager(providerType);
        });

        container.appendChild(providerDiv);
        
        // 为授权按钮添加事件监听
        const authBtn = providerDiv.querySelector('.generate-auth-btn');
        if (authBtn) {
            authBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止事件冒泡到父元素
                handleGenerateAuthUrl(providerType);
            });
        }
    });

    // 更新统计卡片数据
    const activeProviders = hasProviders ? Object.keys(providers).length : 0;
    updateProviderStatsDisplay(activeProviders, totalHealthy, totalAccounts);
}

/**
 * 更新提供商统计信息
 * @param {number} activeProviders - 活跃提供商数
 * @param {number} healthyProviders - 健康提供商数
 * @param {number} totalAccounts - 总账户数
 */
function updateProviderStatsDisplay(activeProviders, healthyProviders, totalAccounts) {
    // 更新全局统计变量
    const newStats = {
        activeProviders,
        healthyProviders,
        totalAccounts,
        lastUpdateTime: new Date().toISOString()
    };
    
    updateProviderStats(newStats);
    
    // 计算总请求数和错误数
    let totalUsage = 0;
    let totalErrors = 0;
    Object.values(providerStats.providerTypeStats).forEach(typeStats => {
        totalUsage += typeStats.totalUsage || 0;
        totalErrors += typeStats.totalErrors || 0;
    });
    
    const finalStats = {
        ...newStats,
        totalRequests: totalUsage,
        totalErrors: totalErrors
    };
    
    updateProviderStats(finalStats);
    
    // 修改：根据使用次数统计"活跃提供商"和"活动连接"
    // "活跃提供商"：统计有使用次数(usageCount > 0)的提供商类型数量
    let activeProvidersByUsage = 0;
    Object.entries(providerStats.providerTypeStats).forEach(([providerType, typeStats]) => {
        if (typeStats.totalUsage > 0) {
            activeProvidersByUsage++;
        }
    });
    
    // "活动连接"：统计所有提供商账户的使用次数总和
    const activeConnections = totalUsage;
    
    // 更新页面显示
    const activeProvidersEl = document.getElementById('activeProviders');
    const healthyProvidersEl = document.getElementById('healthyProviders');
    const activeConnectionsEl = document.getElementById('activeConnections');
    
    if (activeProvidersEl) activeProvidersEl.textContent = activeProvidersByUsage;
    if (healthyProvidersEl) healthyProvidersEl.textContent = healthyProviders;
    if (activeConnectionsEl) activeConnectionsEl.textContent = activeConnections;
    
    // 打印调试信息到控制台
    console.log('Provider Stats Updated:', {
        activeProviders,
        activeProvidersByUsage,
        healthyProviders,
        totalAccounts,
        totalUsage,
        totalErrors,
        providerTypeStats: providerStats.providerTypeStats
    });
}

/**
 * 打开提供商管理模态框
 * @param {string} providerType - 提供商类型
 */
async function openProviderManager(providerType) {
    let loadingTimer = null;
    let hasDisplayedGlobalLoading = false;

    try {
        loadingTimer = window.setTimeout(() => {
            showProviderGlobalLoading(t('providers.loadingDetails'));
            hasDisplayedGlobalLoading = true;
        }, PROVIDER_DETAILS_LOADING_DELAY_MS);

        const data = await window.apiClient.get(`/providers/${encodeURIComponent(providerType)}`);
        
        showProviderManagerModal(data);
    } catch (error) {
        console.error('Failed to load provider details:', error);
        showToast(t('common.error'), t('modal.provider.load.failed'), 'error');
    } finally {
        if (loadingTimer) {
            window.clearTimeout(loadingTimer);
        }

        if (hasDisplayedGlobalLoading) {
            hideProviderGlobalLoading();
        }
    }
}

/**
 * 生成授权按钮HTML
 * @param {string} providerType - 提供商类型
 * @returns {string} 授权按钮HTML
 */
function generateAuthButton(providerType) {
    // 只为支持OAuth的提供商显示授权按钮
    const oauthProviders = ['gemini-cli-oauth', 'gemini-antigravity', 'openai-qwen-oauth', 'claude-kiro-oauth', 'openai-iflow', 'openai-codex-oauth'];

    if (!oauthProviders.includes(providerType)) {
        return '';
    }

    // Codex 提供商使用特殊图标
    if (providerType === 'openai-codex-oauth') {
        return `
            <button class="generate-auth-btn" title="生成 Codex OAuth 授权链接">
                <i class="fas fa-key"></i>
                <span data-i18n="providers.auth.generate">${t('providers.auth.generate')}</span>
            </button>
        `;
    }

    return `
        <button class="generate-auth-btn" title="生成OAuth授权链接">
            <i class="fas fa-key"></i>
            <span data-i18n="providers.auth.generate">${t('providers.auth.generate')}</span>
        </button>
    `;
}

/**
 * 处理生成授权链接
 * @param {string} providerType - 提供商类型
 */
async function handleGenerateAuthUrl(providerType) {
    // 如果是 Kiro OAuth，先显示认证方式选择对话框
    if (providerType === 'claude-kiro-oauth') {
        showKiroAuthMethodSelector(providerType);
        return;
    }

    // Codex 支持 OAuth + Batch Import 两种方式
    if (providerType === 'openai-codex-oauth') {
        showCodexAuthMethodSelector(providerType);
        return;
    }

    // 如果是 Gemini OAuth 或 Antigravity，显示认证方式选择对话框
    if (providerType === 'gemini-cli-oauth' || providerType === 'gemini-antigravity') {
        showGeminiAuthMethodSelector(providerType);
        return;
    }

    await executeGenerateAuthUrl(providerType, {});
}

/**
 * 显示 Kiro OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showKiroAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 550px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.kiro.selectMethod">${t('oauth.kiro.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <!-- <button class="auth-method-btn" data-method="google" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-google" style="font-size: 24px; color: #4285f4;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.google">${t('oauth.kiro.google')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.googleDesc">${t('oauth.kiro.googleDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="github" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-github" style="font-size: 24px; color: #333;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.github">${t('oauth.kiro.github')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.githubDesc">${t('oauth.kiro.githubDesc')}</div>
                        </div>
                    </button> -->
                    <button class="auth-method-btn" data-method="builder-id" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-aws" style="font-size: 24px; color: #ff9900;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.awsBuilder">${t('oauth.kiro.awsBuilder')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.awsBuilderDesc">${t('oauth.kiro.awsBuilderDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="aws-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-cloud-upload-alt" style="font-size: 24px; color: #ff9900;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.awsImport">${t('oauth.kiro.awsImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.awsImportDesc">${t('oauth.kiro.awsImportDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.kiro.batchImport">${t('oauth.kiro.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.kiro.batchImportDesc">${t('oauth.kiro.batchImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 认证方式选择按钮事件
    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#00a67e';
            btn.style.background = '#f8fffe';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();
            
            if (method === 'batch-import') {
                showKiroBatchImportModal();
            } else if (method === 'aws-import') {
                showKiroAwsImportModal();
            } else {
                await executeGenerateAuthUrl(providerType, { method });
            }
        });
    });
}

/**
 * 显示 Codex OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showCodexAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 520px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> ${t('oauth.codex.selectMethod')}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="oauth" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-link" style="font-size: 24px; color: #d97706;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;">${t('oauth.codex.oauth')}</div>
                            <div style="font-size: 12px; color: #666;">${t('oauth.codex.oauthDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #0ea5e9;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;">${t('oauth.codex.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;">${t('oauth.codex.batchImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });

    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#d97706';
            btn.style.background = '#fff7ed';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();

            if (method === 'batch-import') {
                showCodexBatchImportModal(providerType);
            } else {
                await executeGenerateAuthUrl(providerType, {});
            }
        });
    });
}

/**
 * 显示 Codex 批量导入模态框
 * @param {string} providerType - 提供商类型
 */
function showCodexBatchImportModal(providerType = 'openai-codex-oauth') {
    const hardwareThreads = Math.max(1, Number(navigator.hardwareConcurrency) || 8);
    const browserMemGB = Number(navigator.deviceMemory);
    const memoryHint = Number.isFinite(browserMemGB) && browserMemGB > 0 ? browserMemGB : null;
    const importByCpu = hardwareThreads * 10;
    const importByMem = memoryHint ? memoryHint * 6 : Number.POSITIVE_INFINITY;
    const baseImportConcurrency = Math.min(256, Math.max(24, Math.min(importByCpu, importByMem)));
    const maxImportConcurrency = Math.min(256, Math.max(baseImportConcurrency, hardwareThreads * 24, 128));
    const baseRefreshConcurrency = Math.min(
        64,
        Math.max(8, Math.floor(baseImportConcurrency * 0.25), hardwareThreads * 2)
    );
    const maxRefreshConcurrency = Math.min(64, Math.max(baseRefreshConcurrency, hardwareThreads * 6, 32));
    const recommendedImportConcurrency = maxImportConcurrency;
    const recommendedRefreshConcurrency = maxRefreshConcurrency;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';

    modal.innerHTML = `
        <div class="modal-content" style="max-width: 680px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> ${t('oauth.codex.batchImportTitle')}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div style="margin-bottom: 16px; padding: 12px; background: #ecfeff; border: 1px solid #bae6fd; border-radius: 8px; color: #0c4a6e; font-size: 13px;">
                    ${t('oauth.codex.batchImportHint')}
                </div>
                <div style="margin-bottom: 12px; padding: 10px 12px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; color: #334155; font-size: 12px;">
                    ${t('oauth.codex.hardwareHint', {
                        threads: hardwareThreads,
                        importConcurrency: recommendedImportConcurrency,
                        refreshConcurrency: recommendedRefreshConcurrency
                    })}
                </div>
                <div style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button class="mode-btn active" data-mode="json" style="flex: 1; padding: 10px 16px; border: 2px solid #0ea5e9; border-radius: 8px; background: #ecfeff; color: #075985; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-code"></i> ${t('oauth.codex.modeJson')}
                    </button>
                    <button class="mode-btn" data-mode="folder" style="flex: 1; padding: 10px 16px; border: 2px solid #d1d5db; border-radius: 8px; background: white; color: #6b7280; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-folder-open"></i> ${t('oauth.codex.modeFolder')}
                    </button>
                </div>

                <div id="codexJsonModeSection">
                    <label for="batchCodexTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">${t('oauth.codex.tokensLabel')}</label>
                    <textarea id="batchCodexTokens" rows="10" style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;" placeholder='${t('oauth.codex.tokensPlaceholder')}'></textarea>
                </div>

                <div id="codexFolderModeSection" style="display: none;">
                    <div class="codex-folder-upload-area" style="border: 2px dashed #d1d5db; border-radius: 8px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s;">
                        <input type="file" id="codexFolderInput" webkitdirectory directory multiple accept=".json,application/json" style="display: none;">
                        <i class="fas fa-folder-open" style="font-size: 36px; color: #9ca3af; margin-bottom: 8px;"></i>
                        <p style="margin: 0; color: #6b7280;">${t('oauth.codex.folderHint')}</p>
                    </div>
                    <div id="codexFilesList" style="display: none; margin-top: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <label style="font-weight: 600; color: #374151;">${t('oauth.codex.selectedFiles')}</label>
                            <button id="codexClearFilesBtn" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px;">
                                <i class="fas fa-trash-alt"></i> ${t('oauth.codex.clearFiles')}
                            </button>
                        </div>
                        <div id="codexFilesContainer" style="background: #f9fafb; border-radius: 8px; padding: 12px; max-height: 180px; overflow-y: auto;"></div>
                    </div>
                </div>

                <div style="margin-top: 16px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb;">
                    <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;">
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #374151;">
                            <input id="codexSkipDuplicateCheck" type="checkbox" checked>
                            ${t('oauth.codex.skipDuplicateCheck')}
                        </label>
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #374151;">
                            <input id="codexRefreshAfterImport" type="checkbox" checked>
                            ${t('oauth.codex.refreshAfterImport')}
                        </label>
                        <label style="font-size: 13px; color: #374151;">
                            ${t('oauth.codex.importConcurrency')}
                            <input id="codexImportConcurrency" type="number" min="1" max="256" value="${recommendedImportConcurrency}" style="margin-top: 4px; width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px;">
                        </label>
                        <label style="font-size: 13px; color: #374151;">
                            ${t('oauth.codex.refreshConcurrency')}
                            <input id="codexRefreshConcurrency" type="number" min="1" max="64" value="${recommendedRefreshConcurrency}" style="margin-top: 4px; width: 100%; padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 6px;">
                        </label>
                    </div>
                </div>

                <div id="codexBatchStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px; color: #1f2937;">
                    <div style="display: flex; justify-content: space-between;">
                        <span style="color: #1f2937;">${t('oauth.codex.tokenCount')}</span>
                        <span id="codexTokenCountValue" style="font-weight: 600; color: #111827;">0</span>
                    </div>
                </div>

                <div id="codexBatchProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #0284c7;"></i>
                        <span id="codexProgressLabel">${t('oauth.codex.importing')}</span>
                    </div>
                    <div style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="codexImportProgressBar" style="height: 100%; width: 0%; background: #0284c7; transition: width 0.25s;"></div>
                    </div>
                </div>

                <div id="codexBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary" id="codexBatchSubmit">
                    <i class="fas fa-upload"></i> ${t('oauth.codex.startImport')}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const submitBtn = modal.querySelector('#codexBatchSubmit');
    const modeBtns = Array.from(modal.querySelectorAll('.mode-btn'));
    const jsonModeSection = modal.querySelector('#codexJsonModeSection');
    const folderModeSection = modal.querySelector('#codexFolderModeSection');
    const textarea = modal.querySelector('#batchCodexTokens');
    const folderUploadArea = modal.querySelector('.codex-folder-upload-area');
    const folderInput = modal.querySelector('#codexFolderInput');
    const filesListDiv = modal.querySelector('#codexFilesList');
    const filesContainer = modal.querySelector('#codexFilesContainer');
    const clearFilesBtn = modal.querySelector('#codexClearFilesBtn');
    const statsDiv = modal.querySelector('#codexBatchStats');
    const tokenCountValue = modal.querySelector('#codexTokenCountValue');
    const progressDiv = modal.querySelector('#codexBatchProgress');
    const progressBar = modal.querySelector('#codexImportProgressBar');
    const progressLabel = modal.querySelector('#codexProgressLabel');
    const resultDiv = modal.querySelector('#codexBatchResult');
    const skipDuplicateCheckInput = modal.querySelector('#codexSkipDuplicateCheck');
    const refreshAfterImportInput = modal.querySelector('#codexRefreshAfterImport');
    const importConcurrencyInput = modal.querySelector('#codexImportConcurrency');
    const refreshConcurrencyInput = modal.querySelector('#codexRefreshConcurrency');

    let currentMode = 'json';
    let folderTokens = [];
    let selectedFiles = [];
    let submitActsAsClose = false;
    const CODEX_PROGRESS_UPDATE_STEP = 20;
    const CODEX_PROGRESS_UPDATE_INTERVAL_MS = 120;
    const CODEX_MAX_RESULT_ROWS = 400;
    const CODEX_LARGE_BATCH_THRESHOLD = 10000;
    const CODEX_HUGE_BATCH_THRESHOLD = 50000;

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const parsePayloadObjects = (data) => {
        if (Array.isArray(data)) {
            return data.filter(item => item && typeof item === 'object' && !Array.isArray(item));
        }
        if (data && typeof data === 'object') {
            return [data];
        }
        return [];
    };

    const updateStats = (count) => {
        if (count > 0) {
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = String(count);
        } else {
            statsDiv.style.display = 'none';
            tokenCountValue.textContent = '0';
        }
    };

    const renderSelectedFiles = () => {
        if (selectedFiles.length === 0) {
            filesListDiv.style.display = 'none';
            filesContainer.innerHTML = '';
            return;
        }
        filesListDiv.style.display = 'block';
        filesContainer.innerHTML = selectedFiles.map(file => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 6px; background: white; margin-bottom: 6px;">
                <span style="font-size: 12px; color: #374151; word-break: break-all;">${escapeHtml(file.path)}</span>
                <span style="font-size: 12px; color: #6b7280; white-space: nowrap; margin-left: 12px;">${file.tokenCount}</span>
            </div>
        `).join('');
    };

    const parseTokensFromTextarea = () => {
        const value = textarea.value.trim();
        if (!value) return [];
        const parsed = JSON.parse(value);
        const objects = parsePayloadObjects(parsed);
        if (objects.length === 0) {
            throw new Error(t('oauth.codex.noValidObjects'));
        }
        return objects;
    };

    const parseFolderFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(file => file.name.toLowerCase().endsWith('.json'));
        if (files.length === 0) {
            folderTokens = [];
            selectedFiles = [];
            renderSelectedFiles();
            if (currentMode === 'folder') updateStats(0);
            showToast(t('common.warning'), t('oauth.codex.folderNoJson'), 'warning');
            return;
        }

        const parsedTokens = [];
        const parsedFiles = [];
        const parseErrors = [];
        const parseConcurrency = 20;

        for (let start = 0; start < files.length; start += parseConcurrency) {
            const batch = files.slice(start, start + parseConcurrency);
            const batchResults = await Promise.all(batch.map(async (file) => {
                try {
                    const fileContent = await file.text();
                    const data = JSON.parse(fileContent);
                    const objects = parsePayloadObjects(data);
                    if (objects.length === 0) {
                        throw new Error(t('oauth.codex.noValidObjects'));
                    }
                    return {
                        success: true,
                        tokens: objects,
                        path: file.webkitRelativePath || file.name
                    };
                } catch (error) {
                    return {
                        success: false,
                        filename: file.name,
                        message: error.message
                    };
                }
            }));

            for (const item of batchResults) {
                if (item.success) {
                    parsedTokens.push(...item.tokens);
                    parsedFiles.push({
                        path: item.path,
                        tokenCount: item.tokens.length
                    });
                } else {
                    parseErrors.push({
                        filename: item.filename,
                        message: item.message
                    });
                }
            }

            // 大批量目录导入时让出主线程，避免浏览器长时间无响应
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        folderTokens = parsedTokens;
        selectedFiles = parsedFiles;
        renderSelectedFiles();
        if (currentMode === 'folder') {
            updateStats(folderTokens.length);
        }

        if (parseErrors.length > 0) {
            const first = parseErrors[0];
            const more = parseErrors.length > 1 ? ` (+${parseErrors.length - 1})` : '';
            showToast(
                t('common.error'),
                t('oauth.codex.fileParseError', { filename: first.filename, message: first.message, extra: more }),
                'error'
            );
        }
    };

    const setMode = (mode) => {
        currentMode = mode;
        modeBtns.forEach(btn => {
            const isActive = btn.dataset.mode === mode;
            btn.classList.toggle('active', isActive);
            if (isActive) {
                btn.style.borderColor = '#0ea5e9';
                btn.style.background = '#ecfeff';
                btn.style.color = '#075985';
            } else {
                btn.style.borderColor = '#d1d5db';
                btn.style.background = 'white';
                btn.style.color = '#6b7280';
            }
        });

        const isJson = mode === 'json';
        jsonModeSection.style.display = isJson ? 'block' : 'none';
        folderModeSection.style.display = isJson ? 'none' : 'block';

        if (isJson) {
            try {
                updateStats(parseTokensFromTextarea().length);
            } catch {
                updateStats(0);
            }
        } else {
            updateStats(folderTokens.length);
        }
    };

    textarea.addEventListener('input', () => {
        if (currentMode !== 'json') return;
        try {
            updateStats(parseTokensFromTextarea().length);
        } catch {
            updateStats(0);
        }
    });

    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    folderUploadArea.addEventListener('click', () => folderInput.click());
    folderInput.addEventListener('change', async () => {
        await parseFolderFiles(folderInput.files);
    });

    folderUploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        folderUploadArea.style.borderColor = '#0ea5e9';
        folderUploadArea.style.background = '#ecfeff';
    });
    folderUploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        folderUploadArea.style.borderColor = '#d1d5db';
        folderUploadArea.style.background = 'transparent';
    });
    folderUploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        folderUploadArea.style.borderColor = '#d1d5db';
        folderUploadArea.style.background = 'transparent';
        await parseFolderFiles(e.dataTransfer.files);
    });

    clearFilesBtn.addEventListener('click', () => {
        folderTokens = [];
        selectedFiles = [];
        folderInput.value = '';
        renderSelectedFiles();
        if (currentMode === 'folder') {
            updateStats(0);
        }
    });

    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            if (!cancelBtn.disabled) {
                modal.remove();
            }
        });
    });

    submitBtn.addEventListener('click', async () => {
        if (submitActsAsClose) {
            modal.remove();
            return;
        }

        let tokens = [];
        try {
            tokens = currentMode === 'folder' ? folderTokens : parseTokensFromTextarea();
        } catch (error) {
            showToast(t('common.error'), error.message, 'error');
            return;
        }

        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.codex.noCredentials'), 'warning');
            return;
        }

        const isLargeBatch = tokens.length >= CODEX_LARGE_BATCH_THRESHOLD;
        const isHugeBatch = tokens.length >= CODEX_HUGE_BATCH_THRESHOLD;
        const requestedImportConcurrency = Number.parseInt(importConcurrencyInput.value, 10) || recommendedImportConcurrency;
        const requestedRefreshConcurrency = Number.parseInt(refreshConcurrencyInput.value, 10) || recommendedRefreshConcurrency;
        const effectiveImportConcurrency = isHugeBatch
            ? Math.min(requestedImportConcurrency, 64)
            : (isLargeBatch ? Math.min(requestedImportConcurrency, 96) : requestedImportConcurrency);
        const effectiveRefreshConcurrency = isHugeBatch
            ? Math.min(requestedRefreshConcurrency, 16)
            : (isLargeBatch ? Math.min(requestedRefreshConcurrency, 24) : requestedRefreshConcurrency);
        const progressEventInterval = isHugeBatch ? 300 : (isLargeBatch ? 150 : 25);
        const progressEventMinIntervalMs = isHugeBatch ? 180 : (isLargeBatch ? 120 : 80);
        const enableDetailedRows = !isLargeBatch;

        textarea.disabled = true;
        folderInput.disabled = true;
        clearFilesBtn.disabled = true;
        submitActsAsClose = false;
        modeBtns.forEach(btn => {
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
        });
        submitBtn.disabled = true;
        cancelBtn.disabled = true;

        progressDiv.style.display = 'block';
        progressBar.style.width = '0%';
        progressLabel.textContent = t('oauth.codex.importingProgress', { current: 0, total: tokens.length });

        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #0284c7;"></i>
                <strong id="codexBatchProgressText">${t('oauth.codex.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="codexBatchResultsOverflow" style="display: none; margin-top: 6px; font-size: 11px; color: #6b7280;"></div>
            <div id="codexBatchResultsList" style="max-height: 220px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;

        const progressText = resultDiv.querySelector('#codexBatchProgressText');
        const overflowText = resultDiv.querySelector('#codexBatchResultsOverflow');
        const resultsList = resultDiv.querySelector('#codexBatchResultsList');
        let importSuccess = false;
        let omittedResultCount = 0;
        let lastProgressUiUpdateAt = 0;
        let lastProgressUiProcessed = 0;

        const updateOverflowText = () => {
            if (!enableDetailedRows) return;
            if (omittedResultCount <= 0) {
                overflowText.style.display = 'none';
                overflowText.textContent = '';
                return;
            }
            overflowText.style.display = 'block';
            overflowText.textContent = `Showing latest ${CODEX_MAX_RESULT_ROWS} entries, omitted ${omittedResultCount}.`;
        };

        if (!enableDetailedRows) {
            overflowText.style.display = 'block';
            overflowText.textContent = 'Large import mode enabled, per-item logs are disabled for UI responsiveness.';
            resultsList.style.display = 'none';
        }

        const appendResultItem = (current) => {
            if (!enableDetailedRows || !current) return;
            const item = document.createElement('div');
            item.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.08);';
            if (current.success) {
                const refreshInfo = current.refresh?.attempted
                    ? (current.refresh.success ? ' (refresh ok)' : ` (refresh failed: ${current.refresh.message || 'unknown'})`)
                    : (current.refresh?.skipped ? ' (refresh skipped)' : '');
                item.innerHTML = `#${current.index}: <span style="color:#166534;">✓ ${escapeHtml(current.path || '')}</span>${refreshInfo}`;
            } else if (current.error === 'duplicate') {
                item.innerHTML = `#${current.index}: <span style="color:#b45309;">⚠ duplicate (${escapeHtml(current.reason || 'matched')})</span>
                    ${current.existingPath ? `<span style="color:#6b7280;">(${escapeHtml(current.existingPath)})</span>` : ''}`;
            } else {
                item.innerHTML = `#${current.index}: <span style="color:#991b1b;">✗ ${escapeHtml(current.error || 'unknown error')}</span>`;
            }
            resultsList.appendChild(item);

            while (resultsList.childElementCount > CODEX_MAX_RESULT_ROWS) {
                resultsList.removeChild(resultsList.firstElementChild);
                omittedResultCount++;
            }
            updateOverflowText();
            resultsList.scrollTop = resultsList.scrollHeight;
        };

        try {
            // 先让浏览器渲染 loading 状态，再执行大对象序列化与网络请求
            await new Promise(resolve => requestAnimationFrame(() => resolve()));

            const response = await fetch('/api/codex/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    providerType,
                    tokens,
                    skipDuplicateCheck: skipDuplicateCheckInput.checked,
                    refreshAfterImport: refreshAfterImportInput.checked,
                    concurrency: effectiveImportConcurrency,
                    refreshConcurrency: effectiveRefreshConcurrency,
                    progressEventInterval,
                    progressEventMinIntervalMs,
                    includeSuccessProgressDetail: enableDetailedRows
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            if (!response.body) {
                throw new Error('ReadableStream is not available in current browser');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finished = false;

            while (!finished) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                let eventType = '';
                let eventData = '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        if (!eventType || !eventData) continue;

                        const data = JSON.parse(eventData);
                        if (eventType === 'progress') {
                            const processed = data.processedCount || data.index || 0;
                            const total = data.total || tokens.length;
                            const now = Date.now();
                            const shouldRefreshProgress =
                                processed >= total
                                || (processed - lastProgressUiProcessed) >= CODEX_PROGRESS_UPDATE_STEP
                                || (now - lastProgressUiUpdateAt) >= CODEX_PROGRESS_UPDATE_INTERVAL_MS;

                            if (shouldRefreshProgress) {
                                const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
                                progressBar.style.width = `${percentage}%`;
                                const label = t('oauth.codex.importingProgress', { current: processed, total });
                                progressText.textContent = label;
                                progressLabel.textContent = label;
                                lastProgressUiProcessed = processed;
                                lastProgressUiUpdateAt = now;
                            }

                            if (enableDetailedRows) {
                                const current = data.current || null;
                                const shouldRenderResult =
                                    (current && current.success === false)
                                    || processed <= 50
                                    || processed >= total
                                    || (processed % CODEX_PROGRESS_UPDATE_STEP === 0);

                                if (shouldRenderResult) {
                                    appendResultItem(current);
                                }
                            }
                        } else if (eventType === 'complete') {
                            finished = true;
                            progressBar.style.width = '100%';
                            progressDiv.style.display = 'none';

                            const successCount = data.successCount || 0;
                            const failedCount = data.failedCount || 0;
                            const allSuccess = failedCount === 0;
                            const allFailed = successCount === 0;
                            let resultClass = '';
                            let icon = '';
                            let message = '';
                            if (allSuccess) {
                                resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                icon = 'fa-check-circle';
                                message = t('oauth.codex.importSuccess', { count: successCount });
                            } else if (allFailed) {
                                resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                icon = 'fa-times-circle';
                                message = t('oauth.codex.importAllFailed', { count: failedCount });
                            } else {
                                resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                icon = 'fa-exclamation-triangle';
                                message = t('oauth.codex.importPartial', { success: successCount, failed: failedCount });
                            }
                            resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                            const header = resultDiv.querySelector('div:first-child');
                            header.innerHTML = `<i class="fas ${icon}"></i> <strong>${message}</strong>`;

                            if (successCount > 0) {
                                importSuccess = true;
                                await loadProviders();
                                await loadConfigList();
                            }
                        } else if (eventType === 'error') {
                            throw new Error(data.error || 'batch import failed');
                        }

                        eventType = '';
                        eventData = '';
                    }
                }
            }
        } catch (error) {
            console.error('[Codex Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.codex.importFailed', { error: escapeHtml(error.message) })}</strong>
                </div>
            `;
        } finally {
            cancelBtn.disabled = false;
            if (!importSuccess) {
                textarea.disabled = false;
                folderInput.disabled = false;
                clearFilesBtn.disabled = false;
                submitActsAsClose = false;
                modeBtns.forEach(btn => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                });
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> ${t('oauth.codex.startImport')}`;
            } else {
                submitActsAsClose = true;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-check-circle"></i> ${t('oauth.codex.done')}`;
            }
        }
    });

    setMode('json');
}

/**
 * 显示 Gemini OAuth 认证方式选择对话框
 * @param {string} providerType - 提供商类型
 */
function showGeminiAuthMethodSelector(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 500px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.gemini.selectMethod">${t('oauth.gemini.selectMethod')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-method-options" style="display: flex; flex-direction: column; gap: 12px;">
                    <button class="auth-method-btn" data-method="oauth" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fab fa-google" style="font-size: 24px; color: #4285f4;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.gemini.oauth">${t('oauth.gemini.oauth')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.gemini.oauthDesc">${t('oauth.gemini.oauthDesc')}</div>
                        </div>
                    </button>
                    <button class="auth-method-btn" data-method="batch-import" style="display: flex; align-items: center; gap: 12px; padding: 16px; border: 2px solid #e0e0e0; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-import" style="font-size: 24px; color: #10b981;"></i>
                        <div style="text-align: left;">
                            <div style="font-weight: 600; color: #333;" data-i18n="oauth.gemini.batchImport">${t('oauth.gemini.batchImport')}</div>
                            <div style="font-size: 12px; color: #666;" data-i18n="oauth.gemini.batchImportDesc">${t('oauth.gemini.batchImportDesc')}</div>
                        </div>
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 认证方式选择按钮事件
    const methodBtns = modal.querySelectorAll('.auth-method-btn');
    methodBtns.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = '#4285f4';
            btn.style.background = '#f8faff';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = '#e0e0e0';
            btn.style.background = 'white';
        });
        btn.addEventListener('click', async () => {
            const method = btn.dataset.method;
            modal.remove();
            
            if (method === 'batch-import') {
                showGeminiBatchImportModal(providerType);
            } else {
                await executeGenerateAuthUrl(providerType, {});
            }
        });
    });
}

/**
 * 显示 Gemini 批量导入模态框
 * @param {string} providerType - 提供商类型
 */
function showGeminiBatchImportModal(providerType) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.gemini.batchImport">${t('oauth.gemini.batchImport')}</span> (${providerType})</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #1e40af;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.gemini.importInstructions">${t('oauth.gemini.importInstructions')}</span>
                    </p>
                </div>
                <div class="input-mode-toggle" style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button class="mode-btn active" data-mode="json" style="flex: 1; padding: 10px 16px; border: 2px solid #4285f4; border-radius: 8px; background: #eff6ff; color: #1e40af; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-code"></i>
                        <span data-i18n="oauth.gemini.modeJson">${t('oauth.gemini.modeJson')}</span>
                    </button>
                    <button class="mode-btn" data-mode="folder" style="flex: 1; padding: 10px 16px; border: 2px solid #d1d5db; border-radius: 8px; background: white; color: #6b7280; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-folder-open"></i>
                        <span data-i18n="oauth.gemini.modeFolder">${t('oauth.gemini.modeFolder')}</span>
                    </button>
                </div>
                <div class="json-mode-section" id="geminiJsonModeSection">
                    <div class="form-group">
                        <label for="batchGeminiTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                            <span data-i18n="oauth.gemini.tokensLabel">${t('oauth.gemini.tokensLabel')}</span>
                        </label>
                        <textarea
                            id="batchGeminiTokens"
                            rows="10"
                            style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                            placeholder='${t('oauth.gemini.tokensPlaceholder')}'
                            data-i18n-placeholder="oauth.gemini.tokensPlaceholder"
                        ></textarea>
                    </div>
                </div>
                <div class="folder-mode-section" id="geminiFolderModeSection" style="display: none;">
                    <div class="form-group" style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                            <span data-i18n="oauth.gemini.uploadFolder">${t('oauth.gemini.uploadFolder')}</span>
                        </label>
                        <div class="gemini-folder-upload-area" style="border: 2px dashed #d1d5db; border-radius: 8px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s;">
                            <input type="file" id="geminiFolderInput" webkitdirectory directory multiple accept=".json,application/json" style="display: none;">
                            <i class="fas fa-folder-open" style="font-size: 36px; color: #9ca3af; margin-bottom: 8px;"></i>
                            <p style="margin: 0; color: #6b7280;" data-i18n="oauth.gemini.folderDragDrop">${t('oauth.gemini.folderDragDrop')}</p>
                            <p style="margin: 4px 0 0 0; font-size: 12px; color: #9ca3af;" data-i18n="oauth.gemini.folderClickUpload">${t('oauth.gemini.folderClickUpload')}</p>
                        </div>
                        <p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">
                            <i class="fas fa-lightbulb" style="color: #f59e0b;"></i>
                            <span data-i18n="oauth.gemini.folderHint">${t('oauth.gemini.folderHint')}</span>
                        </p>
                    </div>
                    <div class="gemini-files-list" id="geminiFilesList" style="display: none; margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <label style="font-weight: 600; color: #374151;" data-i18n="oauth.gemini.selectedFiles">${t('oauth.gemini.selectedFiles')}</label>
                            <button id="geminiClearFilesBtn" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px; transition: all 0.2s;">
                                <i class="fas fa-trash-alt"></i>
                                <span data-i18n="oauth.gemini.clearFiles">${t('oauth.gemini.clearFiles')}</span>
                            </button>
                        </div>
                        <div id="geminiFilesContainer" style="background: #f9fafb; border-radius: 8px; padding: 12px; max-height: 180px; overflow-y: auto;"></div>
                    </div>
                </div>
                <div class="form-group" style="margin-top: 8px; margin-bottom: 16px;">
                    <details style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #4285f4; margin-right: 8px;"></i>
                            <span data-i18n="oauth.gemini.jsonExample">${t('oauth.gemini.jsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <div style="color: #10b981; font-family: monospace; font-size: 12px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 单个凭据导入示例：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">{
  "access_token": "ya29.a0A...",
  "refresh_token": "1//0...",
  "scope": "https://www.googleapis.com/auth/cloud-platform",
  "token_type": "Bearer",
  "expiry_date": 1738590000000
}</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// gemini-cli-oauth 账号文件示例：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">{
  "type": "gemini",
  "email": "user@example.com",
  "token": {
    "access_token": "ya29.a0A...",
    "refresh_token": "1//0...",
    "expiry": "2026-01-27T21:26:40.407713071+08:00"
  },
  "project_id": "my-project-id"
}</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 批量导入示例（JSON数组）：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">[
  {
    "access_token": "ya29.a0A1...",
    "refresh_token": "1//0..."
  },
  {
    "access_token": "ya29.a0A2...",
    "refresh_token": "1//0..."
  }
]</pre>
                            </div>
                        </div>
                    </details>
                </div>
                <div class="batch-import-stats" id="geminiBatchStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.gemini.tokenCount">${t('oauth.gemini.tokenCount')}</span>
                        <span id="geminiTokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="geminiBatchProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                        <span data-i18n="oauth.gemini.importing">${t('oauth.gemini.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="geminiImportProgressBar" style="height: 100%; width: 0%; background: #4285f4; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="geminiBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="geminiBatchSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.gemini.startImport">${t('oauth.gemini.startImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const modeBtns = Array.from(modal.querySelectorAll('.mode-btn'));
    const jsonModeSection = modal.querySelector('#geminiJsonModeSection');
    const folderModeSection = modal.querySelector('#geminiFolderModeSection');
    const textarea = modal.querySelector('#batchGeminiTokens');
    const folderUploadArea = modal.querySelector('.gemini-folder-upload-area');
    const folderInput = modal.querySelector('#geminiFolderInput');
    const filesListDiv = modal.querySelector('#geminiFilesList');
    const filesContainer = modal.querySelector('#geminiFilesContainer');
    const clearFilesBtn = modal.querySelector('#geminiClearFilesBtn');
    const statsDiv = modal.querySelector('#geminiBatchStats');
    const tokenCountValue = modal.querySelector('#geminiTokenCountValue');
    const progressDiv = modal.querySelector('#geminiBatchProgress');
    const progressBar = modal.querySelector('#geminiImportProgressBar');
    const resultDiv = modal.querySelector('#geminiBatchResult');
    const submitBtn = modal.querySelector('#geminiBatchSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    
    let currentMode = 'json';
    let folderTokens = [];
    let selectedFiles = [];
    let submitActsAsClose = false;
    
    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    
    const parseTokenPayload = (data) => {
        if (Array.isArray(data)) {
            return data.filter(item => item && typeof item === 'object' && !Array.isArray(item));
        }
        if (data && typeof data === 'object') {
            return [data];
        }
        return [];
    };
    
    const updateStats = (count) => {
        if (count > 0) {
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = count;
        } else {
            statsDiv.style.display = 'none';
        }
    };
    
    const renderSelectedFiles = () => {
        if (selectedFiles.length === 0) {
            filesListDiv.style.display = 'none';
            filesContainer.innerHTML = '';
            return;
        }
        
        filesListDiv.style.display = 'block';
        filesContainer.innerHTML = selectedFiles.map(file => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-radius: 6px; background: white; margin-bottom: 6px;">
                <span style="font-size: 12px; color: #374151; word-break: break-all;">${escapeHtml(file.path)}</span>
                <span style="font-size: 12px; color: #6b7280; white-space: nowrap; margin-left: 12px;">${t('oauth.gemini.fileTokenCount', { count: file.tokenCount })}</span>
            </div>
        `).join('');
    };
    
    const parseTokensFromTextarea = () => {
        const value = textarea.value.trim();
        if (!value) {
            return [];
        }
        const parsed = JSON.parse(value);
        const parsedTokens = parseTokenPayload(parsed);
        if (parsedTokens.length === 0) {
            throw new Error(t('oauth.gemini.fileNoValidObjects'));
        }
        return parsedTokens;
    };
    
    const parseFolderFiles = async (fileList) => {
        const files = Array.from(fileList || []).filter(file => file.name.toLowerCase().endsWith('.json'));
        
        if (files.length === 0) {
            folderTokens = [];
            selectedFiles = [];
            renderSelectedFiles();
            if (currentMode === 'folder') {
                updateStats(0);
            }
            showToast(t('common.warning'), t('oauth.gemini.folderNoJson'), 'warning');
            return;
        }
        
        const parsedTokens = [];
        const parsedFiles = [];
        const parseErrors = [];
        
        for (const file of files) {
            try {
                const fileContent = await file.text();
                const data = JSON.parse(fileContent);
                const tokensInFile = parseTokenPayload(data);
                
                if (tokensInFile.length === 0) {
                    throw new Error(t('oauth.gemini.fileNoValidObjects'));
                }
                
                parsedTokens.push(...tokensInFile);
                parsedFiles.push({
                    path: file.webkitRelativePath || file.name,
                    tokenCount: tokensInFile.length
                });
            } catch (error) {
                parseErrors.push({
                    filename: file.name,
                    message: error.message
                });
            }
        }
        
        folderTokens = parsedTokens;
        selectedFiles = parsedFiles;
        renderSelectedFiles();
        
        if (currentMode === 'folder') {
            updateStats(folderTokens.length);
        }
        
        if (parseErrors.length > 0) {
            const firstError = parseErrors[0];
            const extraCount = parseErrors.length > 1 ? ` (+${parseErrors.length - 1})` : '';
            showToast(
                t('common.error'),
                `${t('oauth.gemini.fileParseError', { filename: firstError.filename })}: ${firstError.message}${extraCount}`,
                'error'
            );
        }
    };
    
    const setMode = (mode) => {
        currentMode = mode;
        
        modeBtns.forEach(btn => {
            const isActive = btn.dataset.mode === mode;
            btn.classList.toggle('active', isActive);
            if (isActive) {
                btn.style.borderColor = '#4285f4';
                btn.style.background = '#eff6ff';
                btn.style.color = '#1e40af';
            } else {
                btn.style.borderColor = '#d1d5db';
                btn.style.background = 'white';
                btn.style.color = '#6b7280';
            }
        });
        
        const isJsonMode = mode === 'json';
        jsonModeSection.style.display = isJsonMode ? 'block' : 'none';
        folderModeSection.style.display = isJsonMode ? 'none' : 'block';
        
        if (isJsonMode) {
            try {
                const parsedTokens = parseTokensFromTextarea();
                updateStats(parsedTokens.length);
            } catch (e) {
                updateStats(0);
            }
        } else {
            updateStats(folderTokens.length);
        }
    };
    
    // 实时统计 token 数量
    textarea.addEventListener('input', () => {
        if (currentMode !== 'json') {
            return;
        }
        try {
            const parsedTokens = parseTokensFromTextarea();
            updateStats(parsedTokens.length);
        } catch (e) {
            updateStats(0);
        }
    });
    
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            setMode(btn.dataset.mode);
        });
    });
    
    folderUploadArea.addEventListener('click', () => {
        folderInput.click();
    });
    
    folderInput.addEventListener('change', async () => {
        await parseFolderFiles(folderInput.files);
    });
    
    folderUploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        folderUploadArea.style.borderColor = '#4285f4';
        folderUploadArea.style.background = '#eff6ff';
    });
    
    folderUploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        folderUploadArea.style.borderColor = '#d1d5db';
        folderUploadArea.style.background = 'transparent';
    });
    
    folderUploadArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        folderUploadArea.style.borderColor = '#d1d5db';
        folderUploadArea.style.background = 'transparent';
        await parseFolderFiles(e.dataTransfer.files);
    });
    
    clearFilesBtn.addEventListener('click', () => {
        folderTokens = [];
        selectedFiles = [];
        folderInput.value = '';
        renderSelectedFiles();
        
        if (currentMode === 'folder') {
            updateStats(0);
        }
    });
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            if (cancelBtn.disabled) {
                return;
            }
            modal.remove();
        });
    });
    
    // 提交按钮事件
    submitBtn.addEventListener('click', async () => {
        if (submitActsAsClose) {
            modal.remove();
            return;
        }

        let tokens = [];
        try {
            if (currentMode === 'folder') {
                tokens = [...folderTokens];
            } else {
                tokens = parseTokensFromTextarea();
            }
        } catch (e) {
            showToast(t('common.error'), t('oauth.gemini.noTokens'), 'error');
            return;
        }
        
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.gemini.noTokens'), 'warning');
            return;
        }
        
        // 禁用输入和按钮
        textarea.disabled = true;
        folderInput.disabled = true;
        clearFilesBtn.disabled = true;
        submitActsAsClose = false;
        modeBtns.forEach(btn => {
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
        });
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';
        
        // 创建实时结果显示区域
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #4285f4;"></i>
                <strong id="geminiBatchProgressText">${t('oauth.gemini.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="geminiBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;
        
        const progressText = resultDiv.querySelector('#geminiBatchProgressText');
        const resultsList = resultDiv.querySelector('#geminiBatchResultsList');
        
        let importSuccess = false; // 标记是否导入成功

        try {
            const response = await fetch('/api/gemini/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ providerType, tokens })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                
                let eventType = '';
                let eventData = '';
                
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        
                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);
                                
                                if (eventType === 'progress') {
                                    const { index, total, current } = data;
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    progressText.textContent = t('oauth.gemini.importingProgress', { current: index, total: total });
                                    
                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    if (current.success) {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    resultsList.appendChild(resultItem);
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                } else if (eventType === 'complete') {
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';
                                    
                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    let resultClass, resultIcon, resultMessage;
                                    
                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.gemini.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.gemini.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.gemini.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }
                                    
                                    resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                    const headerDiv = resultDiv.querySelector('div:first-child');
                                    headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;
                                    
                                    if (data.successCount > 0) {
                                        importSuccess = true;
                                        loadProviders();
                                        loadConfigList();
                                    }
                                } else if (eventType === 'error') {
                                    throw new Error(data.error);
                                }
                            } catch (parseError) {
                                console.warn('Failed to parse SSE data:', parseError);
                            }
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Gemini Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.gemini.importError')}: ${error.message}</strong>
                </div>
            `;
        } finally {
            cancelBtn.disabled = false;
            
            if (!importSuccess) {
                textarea.disabled = false;
                folderInput.disabled = false;
                clearFilesBtn.disabled = false;
                submitActsAsClose = false;
                modeBtns.forEach(btn => {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                });
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> <span data-i18n="oauth.gemini.startImport">${t('oauth.gemini.startImport')}</span>`;
            } else {
                submitActsAsClose = true;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-check-circle"></i> <span>${t('common.success')}</span>`;
            }
        }
    });
    
    setMode('json');
}

/**
 * 显示 Kiro 批量导入 refreshToken 模态框
 */
function showKiroBatchImportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> <span data-i18n="oauth.kiro.batchImport">${t('oauth.kiro.batchImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="batch-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #166534;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.kiro.batchImportInstructions">${t('oauth.kiro.batchImportInstructions')}</span>
                    </p>
                </div>
                <div class="form-group">
                    <label for="batchRefreshTokens" style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <span data-i18n="oauth.kiro.refreshTokensLabel">${t('oauth.kiro.refreshTokensLabel')}</span>
                    </label>
                    <textarea 
                        id="batchRefreshTokens" 
                        rows="10" 
                        style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                        placeholder="${t('oauth.kiro.refreshTokensPlaceholder')}"
                        data-i18n-placeholder="oauth.kiro.refreshTokensPlaceholder"
                    ></textarea>
                </div>
                <div class="batch-import-stats" id="batchImportStats" style="display: none; margin-top: 12px; padding: 12px; background: #f3f4f6; border-radius: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="oauth.kiro.tokenCount">${t('oauth.kiro.tokenCount')}</span>
                        <span id="tokenCountValue" style="font-weight: 600;">0</span>
                    </div>
                </div>
                <div class="batch-import-progress" id="batchImportProgress" style="display: none; margin-top: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                        <span data-i18n="oauth.kiro.importing">${t('oauth.kiro.importing')}</span>
                    </div>
                    <div class="progress-bar" style="margin-top: 8px; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="importProgressBar" style="height: 100%; width: 0%; background: #10b981; transition: width 0.3s;"></div>
                    </div>
                </div>
                <div class="batch-import-result" id="batchImportResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary batch-import-submit" id="batchImportSubmit">
                    <i class="fas fa-upload"></i>
                    <span data-i18n="oauth.kiro.startImport">${t('oauth.kiro.startImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const textarea = modal.querySelector('#batchRefreshTokens');
    const statsDiv = modal.querySelector('#batchImportStats');
    const tokenCountValue = modal.querySelector('#tokenCountValue');
    const progressDiv = modal.querySelector('#batchImportProgress');
    const progressBar = modal.querySelector('#importProgressBar');
    const resultDiv = modal.querySelector('#batchImportResult');
    const submitBtn = modal.querySelector('#batchImportSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    let submitActsAsClose = false;
    
    // 实时统计 token 数量
    textarea.addEventListener('input', () => {
        const tokens = textarea.value.split('\n').filter(line => line.trim());
        if (tokens.length > 0) {
            statsDiv.style.display = 'block';
            tokenCountValue.textContent = tokens.length;
        } else {
            statsDiv.style.display = 'none';
        }
    });
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 提交按钮事件 - 使用 SSE 流式响应实时显示进度
    submitBtn.addEventListener('click', async () => {
        if (submitActsAsClose) {
            modal.remove();
            return;
        }

        const tokens = textarea.value.split('\n').filter(line => line.trim());
        
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('oauth.kiro.noTokens'), 'warning');
            return;
        }
        
        // 禁用输入和按钮
        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        submitActsAsClose = false;
        progressDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        progressBar.style.width = '0%';
        
        // 创建实时结果显示区域
        resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
        resultDiv.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                <i class="fas fa-spinner fa-spin" style="color: #10b981;"></i>
                <strong id="batchProgressText">${t('oauth.kiro.importingProgress', { current: 0, total: tokens.length })}</strong>
            </div>
            <div id="batchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
        `;
        
        const progressText = resultDiv.querySelector('#batchProgressText');
        const resultsList = resultDiv.querySelector('#batchResultsList');
        
        let successCount = 0;
        let failedCount = 0;
        const details = [];
        let importSuccess = false; // 标记是否导入成功
        
        try {
            // 使用 fetch + SSE 获取流式响应（需要带认证头）
            const response = await fetch('/api/kiro/batch-import-tokens', {
                method: 'POST',
                headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ refreshTokens: tokens })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += decoder.decode(value, { stream: true });
                
                // 解析 SSE 事件
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // 保留最后一个可能不完整的行
                
                let eventType = '';
                let eventData = '';
                
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.substring(7).trim();
                    } else if (line.startsWith('data: ')) {
                        eventData = line.substring(6).trim();
                        
                        if (eventType && eventData) {
                            try {
                                const data = JSON.parse(eventData);
                                
                                if (eventType === 'start') {
                                    // 开始事件
                                    console.log(`[Batch Import] Starting import of ${data.total} tokens`);
                                } else if (eventType === 'progress') {
                                    // 进度更新
                                    const { index, total, current, successCount: sc, failedCount: fc } = data;
                                    successCount = sc;
                                    failedCount = fc;
                                    details.push(current);
                                    
                                    // 更新进度条
                                    const percentage = Math.round((index / total) * 100);
                                    progressBar.style.width = `${percentage}%`;
                                    
                                    // 更新进度文本
                                    progressText.textContent = t('oauth.kiro.importingProgress', { current: index, total: total });
                                    
                                    // 添加结果项
                                    const resultItem = document.createElement('div');
                                    resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                    
                                    if (current.success) {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                    } else if (current.error === 'duplicate') {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateToken')}</span>
                                            ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                    } else {
                                        resultItem.innerHTML = `Token ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                    }
                                    
                                    resultsList.appendChild(resultItem);
                                    // 自动滚动到底部
                                    resultsList.scrollTop = resultsList.scrollHeight;
                                    
                                } else if (eventType === 'complete') {
                                    // 完成事件
                                    progressBar.style.width = '100%';
                                    progressDiv.style.display = 'none';
                                    
                                    const isAllSuccess = data.failedCount === 0;
                                    const isAllFailed = data.successCount === 0;
                                    
                                    let resultClass, resultIcon, resultMessage;
                                    if (isAllSuccess) {
                                        resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                        resultIcon = 'fa-check-circle';
                                        resultMessage = t('oauth.kiro.importSuccess', { count: data.successCount });
                                    } else if (isAllFailed) {
                                        resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                        resultIcon = 'fa-times-circle';
                                        resultMessage = t('oauth.kiro.importAllFailed', { count: data.failedCount });
                                    } else {
                                        resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                        resultIcon = 'fa-exclamation-triangle';
                                        resultMessage = t('oauth.kiro.importPartial', { success: data.successCount, failed: data.failedCount });
                                    }
                                    
                                    // 更新结果区域样式
                                    resultDiv.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                    
                                    // 更新标题
                                    const headerDiv = resultDiv.querySelector('div:first-child');
                                    headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;
                                    
                                    // 如果有成功的，刷新提供商列表
                                    if (data.successCount > 0) {
                                        importSuccess = true;
                                        loadProviders();
                                        loadConfigList();
                                    }
                                    
                                } else if (eventType === 'error') {
                                    throw new Error(data.error);
                                }
                            } catch (parseError) {
                                console.warn('Failed to parse SSE data:', parseError);
                            }
                            
                            eventType = '';
                            eventData = '';
                        }
                    }
                }
            }
            
        } catch (error) {
            console.error('[Kiro Batch Import] Failed:', error);
            progressDiv.style.display = 'none';
            resultDiv.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            resultDiv.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.kiro.importError')}: ${error.message}</strong>
                </div>
            `;
        } finally {
            // 重新启用按钮
            cancelBtn.disabled = false;
            if (!importSuccess) {
                textarea.disabled = false;
                submitActsAsClose = false;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-upload"></i> <span data-i18n="oauth.kiro.startImport">${t('oauth.kiro.startImport')}</span>`;
            } else {
                submitActsAsClose = true;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-check-circle"></i> <span>${t('common.success')}</span>`;
            }
        }
    });
}

/**
 * 显示 Kiro AWS 账号导入模态框
 * 支持从 AWS SSO cache 目录导入凭据文件，或直接粘贴 JSON
 */
function showKiroAwsImportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 700px;">
            <div class="modal-header">
                <h3><i class="fas fa-cloud-upload-alt" style="color: #ff9900;"></i> <span data-i18n="oauth.kiro.awsImport">${t('oauth.kiro.awsImport')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="aws-import-instructions" style="margin-bottom: 16px; padding: 12px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #9a3412;">
                        <i class="fas fa-info-circle"></i>
                        <span data-i18n="oauth.kiro.awsImportInstructions">${t('oauth.kiro.awsImportInstructions')}</span>
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 12px; color: #c2410c;">
                        <i class="fas fa-folder-open"></i>
                        <code style="background: #fed7aa; padding: 2px 6px; border-radius: 4px;">C:\\Users\\{username}\\.aws\\sso\\cache</code>
                    </p>
                </div>
                
                <!-- 输入模式切换 -->
                <div class="input-mode-toggle" style="display: flex; gap: 8px; margin-bottom: 16px;">
                    <button class="mode-btn active" data-mode="file" style="flex: 1; padding: 10px 16px; border: 2px solid #ff9900; border-radius: 8px; background: #fff7ed; color: #9a3412; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-file-upload"></i>
                        <span data-i18n="oauth.kiro.awsModeFile">${t('oauth.kiro.awsModeFile')}</span>
                    </button>
                    <button class="mode-btn" data-mode="json" style="flex: 1; padding: 10px 16px; border: 2px solid #d1d5db; border-radius: 8px; background: white; color: #6b7280; font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        <i class="fas fa-code"></i>
                        <span data-i18n="oauth.kiro.awsModeJson">${t('oauth.kiro.awsModeJson')}</span>
                    </button>
                </div>
                
                <!-- 文件上传模式 -->
                <div class="file-mode-section" id="fileModeSection">
                    <div class="form-group" style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                            <span data-i18n="oauth.kiro.awsUploadFiles">${t('oauth.kiro.awsUploadFiles')}</span>
                        </label>
                        <div class="aws-file-upload-area" style="border: 2px dashed #d1d5db; border-radius: 8px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s;">
                            <input type="file" id="awsFilesInput" multiple accept=".json" style="display: none;">
                            <i class="fas fa-cloud-upload-alt" style="font-size: 36px; color: #9ca3af; margin-bottom: 8px;"></i>
                            <p style="margin: 0; color: #6b7280;" data-i18n="oauth.kiro.awsDragDrop">${t('oauth.kiro.awsDragDrop')}</p>
                            <p style="margin: 4px 0 0 0; font-size: 12px; color: #9ca3af;" data-i18n="oauth.kiro.awsClickUpload">${t('oauth.kiro.awsClickUpload')}</p>
                        </div>
                        <p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">
                            <i class="fas fa-lightbulb" style="color: #f59e0b;"></i>
                            <span data-i18n="oauth.kiro.awsFileHint">${t('oauth.kiro.awsFileHint')}</span>
                        </p>
                    </div>
                    
                    <div class="aws-files-list" id="awsFilesList" style="display: none; margin-bottom: 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <label style="font-weight: 600; color: #374151;" data-i18n="oauth.kiro.awsSelectedFiles">${t('oauth.kiro.awsSelectedFiles')}</label>
                            <button id="clearFilesBtn" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px; transition: all 0.2s;">
                                <i class="fas fa-trash-alt"></i>
                                <span data-i18n="oauth.kiro.awsClearFiles">${t('oauth.kiro.awsClearFiles')}</span>
                            </button>
                        </div>
                        <div id="awsFilesContainer" style="background: #f9fafb; border-radius: 8px; padding: 12px;"></div>
                    </div>
                </div>
                
                <!-- JSON 输入模式 -->
                <div class="json-mode-section" id="jsonModeSection" style="display: none;">
                    <div class="form-group" style="margin-bottom: 16px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                            <span data-i18n="oauth.kiro.awsJsonInput">${t('oauth.kiro.awsJsonInput')}</span>
                        </label>
                        <textarea 
                            id="awsJsonInput" 
                            rows="12" 
                            style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;"
                            placeholder="${t('oauth.kiro.awsJsonPlaceholderSimple')}"
                            data-i18n-placeholder="oauth.kiro.awsJsonPlaceholderSimple"
                        ></textarea>
                        <p style="margin: 8px 0 0 0; font-size: 12px; color: #6b7280;">
                            <i class="fas fa-lightbulb" style="color: #f59e0b;"></i>
                            <span data-i18n="oauth.kiro.awsJsonHint">${t('oauth.kiro.awsJsonHint')}</span>
                        </p>
                    </div>
                    <details style="margin-bottom: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;">
                        <summary style="padding: 12px; cursor: pointer; font-weight: 600; color: #374151; user-select: none;">
                            <i class="fas fa-code" style="color: #ff9900; margin-right: 8px;"></i>
                            <span data-i18n="oauth.kiro.awsJsonExample">${t('oauth.kiro.awsJsonExample')}</span>
                        </summary>
                        <div style="padding: 12px; background: #1f2937; border-radius: 0 0 8px 8px;">
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-bottom: 12px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 单个凭据导入示例：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">{
  "clientId": "VYZBSTx3Q7QEq1W3Wn8c5nVzLWVhc3QtMQ",
  "clientSecret": "eyJraWQi...OAMc",
  "expiresAt": "2026-01-09T04:43:18.079944400+00:00",
  "accessToken": "aoaAAAAAGlgghoSqRgQK...2tfhmdNZDA",
  "authMethod": "IdC",
  "provider": "BuilderId",
  "refreshToken": "aorAAAAAGn...uKw+E3",
  "region": "us-east-1"
}</pre>
                            </div>
                            <div style="color: #10b981; font-family: monospace; font-size: 12px; margin-top: 16px;">
                                <div style="color: #9ca3af; margin-bottom: 8px;">// 批量导入示例（JSON数组）：</div>
                                <pre style="margin: 0; white-space: pre; overflow-x: auto;">[
  {
    "clientId": "VYZBSTx3Q7QEq1W3Wn8c5nVzLWVhc3QtMQ",
    "clientSecret": "eyJraWQi...OAMc",
    "accessToken": "aoaAAAAAGlgghoSqRgQK...2tfhmdNZDA",
    "refreshToken": "aorAAAAAGn...uKw+E3",
    "region": "us-east-1"
  },
  {
    "clientId": "AnotherClientId123",
    "clientSecret": "eyJraWQi...xyz",
    "accessToken": "aoaAAAAAGlgghoSqRgQK...abc",
    "refreshToken": "aorAAAAAGn...def",
    "region": "us-west-2",
    "idcRegion": "us-west-2"
  }
]</pre>
                            </div>
                            <div style="color: #fbbf24; font-size: 11px; margin-top: 12px; padding: 8px; background: rgba(251, 191, 36, 0.1); border-radius: 4px;">
                                <i class="fas fa-info-circle"></i>
                                <strong>注意：</strong>AWS企业用户需要额外添加 <code style="background: rgba(0,0,0,0.3); padding: 2px 4px; border-radius: 2px;">idcRegion</code> 字段
                            </div>
                        </div>
                    </details>
                </div>
                
                <div class="aws-validation-result" id="awsValidationResult" style="display: none; margin-bottom: 16px; padding: 12px; border-radius: 8px;"></div>
                
                <div class="aws-json-preview" id="awsJsonPreview" style="display: none; margin-bottom: 16px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #374151;">
                        <i class="fas fa-eye"></i>
                        <span data-i18n="oauth.kiro.awsPreviewJson">${t('oauth.kiro.awsPreviewJson')}</span>
                    </label>
                    <pre id="awsJsonContent" style="background: #1f2937; color: #10b981; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 12px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all;"></pre>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary aws-import-submit" id="awsImportSubmit" disabled>
                    <i class="fas fa-check"></i>
                    <span data-i18n="oauth.kiro.awsConfirmImport">${t('oauth.kiro.awsConfirmImport')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    const fileInput = modal.querySelector('#awsFilesInput');
    const uploadArea = modal.querySelector('.aws-file-upload-area');
    const filesListDiv = modal.querySelector('#awsFilesList');
    const filesContainer = modal.querySelector('#awsFilesContainer');
    const clearFilesBtn = modal.querySelector('#clearFilesBtn');
    const validationResult = modal.querySelector('#awsValidationResult');
    const jsonPreview = modal.querySelector('#awsJsonPreview');
    const jsonContent = modal.querySelector('#awsJsonContent');
    const submitBtn = modal.querySelector('#awsImportSubmit');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const modeBtns = modal.querySelectorAll('.mode-btn');
    const fileModeSection = modal.querySelector('#fileModeSection');
    const jsonModeSection = modal.querySelector('#jsonModeSection');
    const jsonInputTextarea = modal.querySelector('#awsJsonInput');
    
    let uploadedFiles = [];
    let mergedCredentials = null;
    let currentMode = 'file';
    let submitActsAsClose = false;
    
    // 清空文件按钮事件
    clearFilesBtn.addEventListener('click', () => {
        uploadedFiles = [];
        filesContainer.innerHTML = '';
        filesListDiv.style.display = 'none';
        validationResult.style.display = 'none';
        jsonPreview.style.display = 'none';
        submitBtn.disabled = true;
        mergedCredentials = null;
        // 清空 file input
        fileInput.value = '';
    });
    
    // 清空按钮 hover 效果
    clearFilesBtn.addEventListener('mouseenter', () => {
        clearFilesBtn.style.background = '#fef2f2';
    });
    clearFilesBtn.addEventListener('mouseleave', () => {
        clearFilesBtn.style.background = 'none';
    });
    
    // 模式切换
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === currentMode) return;
            
            currentMode = mode;
            
            // 更新按钮样式
            modeBtns.forEach(b => {
                if (b.dataset.mode === mode) {
                    b.style.borderColor = '#ff9900';
                    b.style.background = '#fff7ed';
                    b.style.color = '#9a3412';
                    b.classList.add('active');
                } else {
                    b.style.borderColor = '#d1d5db';
                    b.style.background = 'white';
                    b.style.color = '#6b7280';
                    b.classList.remove('active');
                }
            });
            
            // 切换显示区域
            if (mode === 'file') {
                fileModeSection.style.display = 'block';
                jsonModeSection.style.display = 'none';
                // 重新验证文件模式的内容
                validateAndPreview();
            } else {
                fileModeSection.style.display = 'none';
                jsonModeSection.style.display = 'block';
                // 验证 JSON 输入
                validateJsonInput();
            }
        });
    });
    
    // JSON 输入实时验证
    jsonInputTextarea.addEventListener('input', () => {
        validateJsonInput();
    });
    
    // 验证 JSON 输入
    function validateJsonInput() {
        const inputValue = jsonInputTextarea.value.trim();
        
        if (!inputValue) {
            validationResult.style.display = 'none';
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            mergedCredentials = null;
            return;
        }
        
        try {
            mergedCredentials = JSON.parse(inputValue);
            validateAndShowResult();
        } catch (error) {
            validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            validationResult.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-exclamation-triangle"></i>
                    <strong data-i18n="oauth.kiro.awsJsonParseError">${t('oauth.kiro.awsJsonParseError')}</strong>
                </div>
                <p style="margin: 8px 0 0 0; font-size: 12px;">${error.message}</p>
            `;
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            mergedCredentials = null;
        }
    }
    
    // 文件上传区域交互
    uploadArea.addEventListener('click', () => fileInput.click());
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#ff9900';
        uploadArea.style.background = '#fffbeb';
    });
    
    uploadArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#d1d5db';
        uploadArea.style.background = 'transparent';
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = '#d1d5db';
        uploadArea.style.background = 'transparent';
        
        const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.json'));
        if (files.length > 0) {
            processFiles(files);
        }
    });
    
    fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files);
        if (files.length > 0) {
            processFiles(files);
        }
    });
    
    // 处理上传的文件（支持追加）
    async function processFiles(files) {
        for (const file of files) {
            // 检查是否已存在同名文件
            const existingIndex = uploadedFiles.findIndex(f => f.name === file.name);
            
            try {
                const content = await readFileAsText(file);
                const json = JSON.parse(content);
                
                if (existingIndex >= 0) {
                    // 替换已存在的同名文件
                    uploadedFiles[existingIndex] = {
                        name: file.name,
                        content: json
                    };
                    showToast(t('common.info'), t('oauth.kiro.awsFileReplaced', { filename: file.name }), 'info');
                } else {
                    // 追加新文件
                    uploadedFiles.push({
                        name: file.name,
                        content: json
                    });
                }
            } catch (error) {
                console.error(`Failed to parse ${file.name}:`, error);
                showToast(t('common.error'), t('oauth.kiro.awsParseError', { filename: file.name }), 'error');
            }
        }
        
        // 重新渲染文件列表
        renderFilesList();
        
        filesListDiv.style.display = uploadedFiles.length > 0 ? 'block' : 'none';
        
        // 清空 file input 以便可以再次选择相同文件
        fileInput.value = '';
        
        validateAndPreview();
    }
    
    // 渲染文件列表
    function renderFilesList() {
        filesContainer.innerHTML = '';
        
        for (const file of uploadedFiles) {
            const fileDiv = document.createElement('div');
            fileDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px; background: white; border-radius: 4px; margin-bottom: 4px;';
            fileDiv.dataset.filename = file.name;
            
            const fields = Object.keys(file.content).slice(0, 5).join(', ');
            const moreFields = Object.keys(file.content).length > 5 ? '...' : '';
            
            fileDiv.innerHTML = `
                <div style="flex: 1; min-width: 0;">
                    <i class="fas fa-file-code" style="color: #ff9900; margin-right: 8px;"></i>
                    <span style="font-weight: 500;">${file.name}</span>
                    <div style="font-size: 11px; color: #6b7280; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fields}${moreFields}</div>
                </div>
                <button class="remove-file-btn" data-filename="${file.name}" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 4px 8px; margin-left: 8px; flex-shrink: 0;">
                    <i class="fas fa-times"></i>
                </button>
            `;
            filesContainer.appendChild(fileDiv);
        }
        
        // 添加删除文件按钮事件
        filesContainer.querySelectorAll('.remove-file-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const filename = e.currentTarget.dataset.filename;
                uploadedFiles = uploadedFiles.filter(f => f.name !== filename);
                renderFilesList();
                filesListDiv.style.display = uploadedFiles.length > 0 ? 'block' : 'none';
                validateAndPreview();
            });
        });
    }
    
    // 验证并预览（文件模式）
    function validateAndPreview() {
        if (currentMode !== 'file') return;
        
        if (uploadedFiles.length === 0) {
            validationResult.style.display = 'none';
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            mergedCredentials = null;
            return;
        }
        
        // 智能合并所有文件的内容
        // 如果多个文件都有 expiresAt，使用包含 refreshToken 的文件中的 expiresAt
        mergedCredentials = {};
        let expiresAtFromRefreshTokenFile = null;
        
        for (const file of uploadedFiles) {
            // 如果这个文件包含 refreshToken，记录它的 expiresAt
            if (file.content.refreshToken && file.content.expiresAt) {
                expiresAtFromRefreshTokenFile = file.content.expiresAt;
            }
            Object.assign(mergedCredentials, file.content);
        }
        
        // 如果找到了包含 refreshToken 的文件的 expiresAt，使用它
        if (expiresAtFromRefreshTokenFile) {
            mergedCredentials.expiresAt = expiresAtFromRefreshTokenFile;
        }
        
        validateAndShowResult();
    }
    
    // 验证并显示结果（通用）
    function validateAndShowResult() {
        if (!mergedCredentials) {
            validationResult.style.display = 'none';
            jsonPreview.style.display = 'none';
            submitBtn.disabled = true;
            return;
        }
        
        // 检查是否为批量导入（数组）
        const isBatchImport = Array.isArray(mergedCredentials);
        
        if (isBatchImport) {
            // 批量导入模式：验证数组中的每个对象
            let allValid = true;
            const credentialsValidation = mergedCredentials.map((cred, index) => {
                const hasClientId = !!cred.clientId;
                const hasClientSecret = !!cred.clientSecret;
                const hasAccessToken = !!cred.accessToken;
                const hasRefreshToken = !!cred.refreshToken;
                const isValid = hasClientId && hasClientSecret && hasAccessToken && hasRefreshToken;
                
                if (!isValid) allValid = false;
                
                return {
                    index: index + 1,
                    isValid,
                    fields: [
                        { key: 'clientId', has: hasClientId },
                        { key: 'clientSecret', has: hasClientSecret },
                        { key: 'accessToken', has: hasAccessToken },
                        { key: 'refreshToken', has: hasRefreshToken }
                    ]
                };
            });
            
            // 构建批量验证结果HTML
            const credentialsHtml = credentialsValidation.map(cv => {
                const statusIcon = cv.isValid ? '✓' : '✗';
                const statusColor = cv.isValid ? '#166534' : '#991b1b';
                const fieldsHtml = cv.fields.map(f => `
                    <span style="margin-right: 8px;">${f.key}: ${f.has
                        ? `<code style="background: #dcfce7; padding: 1px 4px; border-radius: 2px; color: #166534;">✓</code>`
                        : `<code style="background: #fecaca; padding: 1px 4px; border-radius: 2px; color: #991b1b;">✗</code>`
                    }</span>
                `).join('');
                
                return `
                    <div style="padding: 8px; margin-bottom: 4px; background: ${cv.isValid ? '#f0fdf4' : '#fef2f2'}; border: 1px solid ${cv.isValid ? '#bbf7d0' : '#fecaca'}; border-radius: 4px;">
                        <div style="font-weight: 600; color: ${statusColor}; margin-bottom: 4px;">
                            ${statusIcon} 凭据 ${cv.index}
                        </div>
                        <div style="font-size: 12px; color: #6b7280;">
                            ${fieldsHtml}
                        </div>
                    </div>
                `;
            }).join('');
            
            if (allValid) {
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                        <i class="fas fa-check-circle"></i>
                        <strong>批量验证通过 (${mergedCredentials.length} 个凭据)</strong>
                    </div>
                    <div style="max-height: 200px; overflow-y: auto;">
                        ${credentialsHtml}
                    </div>
                `;
                submitBtn.disabled = false;
            } else {
                const validCount = credentialsValidation.filter(cv => cv.isValid).length;
                const invalidCount = credentialsValidation.length - validCount;
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>批量验证失败</strong>
                        <span style="font-weight: normal; font-size: 12px;">(${invalidCount} 个凭据缺少必需字段)</span>
                    </div>
                    <div style="max-height: 200px; overflow-y: auto;">
                        ${credentialsHtml}
                    </div>
                    <p style="margin: 12px 0 0 0; font-size: 12px; padding: 8px; background: #fee2e2; border-radius: 4px;">
                        <i class="fas fa-lightbulb" style="color: #dc2626;"></i>
                        请确保每个凭据都包含所有必需字段：clientId, clientSecret, accessToken, refreshToken
                    </p>
                `;
                submitBtn.disabled = true;
            }
            
            // 显示 JSON 预览（批量模式）
            jsonPreview.style.display = 'block';
            const previewData = mergedCredentials.map(cred => {
                const preview = { ...cred };
                if (preview.clientSecret) {
                    preview.clientSecret = preview.clientSecret.substring(0, 8) + '...' + preview.clientSecret.slice(-4);
                }
                if (preview.accessToken) {
                    preview.accessToken = preview.accessToken.substring(0, 20) + '...' + preview.accessToken.slice(-10);
                }
                if (preview.refreshToken) {
                    preview.refreshToken = preview.refreshToken.substring(0, 10) + '...' + preview.refreshToken.slice(-6);
                }
                return preview;
            });
            jsonContent.textContent = JSON.stringify(previewData, null, 2);
            
        } else {
            // 单个导入模式：原有逻辑
            const hasClientId = !!mergedCredentials.clientId;
            const hasClientSecret = !!mergedCredentials.clientSecret;
            const hasAccessToken = !!mergedCredentials.accessToken;
            const hasRefreshToken = !!mergedCredentials.refreshToken;
            
            // 所有四个字段都必须存在
            const isValid = hasClientId && hasClientSecret && hasAccessToken && hasRefreshToken;
            
            // 构建字段状态列表
            const fieldsList = [
                { key: 'clientId', has: hasClientId },
                { key: 'clientSecret', has: hasClientSecret },
                { key: 'accessToken', has: hasAccessToken },
                { key: 'refreshToken', has: hasRefreshToken }
            ];
            
            const fieldsHtml = fieldsList.map(f => `
                <li>${f.key}: ${f.has
                    ? `<code style="background: #dcfce7; padding: 1px 4px; border-radius: 2px; color: #166534;">✓ ${t('common.found')}</code>`
                    : `<code style="background: #fecaca; padding: 1px 4px; border-radius: 2px; color: #991b1b;">✗ ${t('common.missing')}</code>`
                }</li>
            `).join('');
            
            if (isValid) {
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-check-circle"></i>
                        <strong data-i18n="oauth.kiro.awsValidationSuccess">${t('oauth.kiro.awsValidationSuccess')}</strong>
                    </div>
                    <ul style="margin: 8px 0 0 24px; font-size: 13px; list-style: none; padding: 0;">
                        ${fieldsHtml}
                    </ul>
                `;
                submitBtn.disabled = false;
            } else {
                const missingCount = fieldsList.filter(f => !f.has).length;
                validationResult.style.cssText = 'display: block; margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-exclamation-triangle"></i>
                        <strong>${t('oauth.kiro.awsValidationFailed')}</strong>
                        <span style="font-weight: normal; font-size: 12px;">(${t('oauth.kiro.awsMissingFields', { count: missingCount })})</span>
                    </div>
                    <ul style="margin: 8px 0 0 24px; font-size: 13px; list-style: none; padding: 0;">
                        ${fieldsHtml}
                    </ul>
                    <p style="margin: 12px 0 0 0; font-size: 12px; padding: 8px; background: #fee2e2; border-radius: 4px;">
                        <i class="fas fa-lightbulb" style="color: #dc2626;"></i>
                        <span data-i18n="oauth.kiro.awsUploadMore">${t('oauth.kiro.awsUploadMore')}</span>
                    </p>
                `;
                submitBtn.disabled = true;
            }
            
            // 显示 JSON 预览（单个模式）
            jsonPreview.style.display = 'block';
            
            // 隐藏敏感信息的部分内容
            const previewData = { ...mergedCredentials };
            if (previewData.clientSecret) {
                previewData.clientSecret = previewData.clientSecret.substring(0, 8) + '...' + previewData.clientSecret.slice(-4);
            }
            if (previewData.accessToken) {
                previewData.accessToken = previewData.accessToken.substring(0, 20) + '...' + previewData.accessToken.slice(-10);
            }
            if (previewData.refreshToken) {
                previewData.refreshToken = previewData.refreshToken.substring(0, 10) + '...' + previewData.refreshToken.slice(-6);
            }
            
            jsonContent.textContent = JSON.stringify(previewData, null, 2);
        }
    }
    
    // 读取文件内容
    function readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }
    
    // 关闭按钮事件
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });
    
    // 提交按钮事件
    submitBtn.addEventListener('click', async () => {
        if (submitActsAsClose) {
            modal.remove();
            return;
        }

        if (!mergedCredentials) {
            showToast(t('common.warning'), t('oauth.kiro.awsNoCredentials'), 'warning');
            return;
        }
        
        // 检查是否为批量导入（数组）
        const isBatchImport = Array.isArray(mergedCredentials);
        
        // 禁用按钮和输入
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>${t('oauth.kiro.awsImporting')}</span>`;
        submitActsAsClose = false;
        
        if (currentMode === 'json') {
            jsonInputTextarea.disabled = true;
        }
        
        let importSuccess = false; // 标记是否导入成功
        
        try {
            if (isBatchImport) {
                // 批量导入模式 - 使用 SSE 流式响应
                // 确保每个凭据都有 authMethod
                const credentialsToImport = mergedCredentials.map(cred => ({
                    ...cred,
                    authMethod: cred.authMethod || 'builder-id'
                }));
                
                // 创建进度显示区域
                validationResult.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #f3f4f6; border: 1px solid #d1d5db;';
                validationResult.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <i class="fas fa-spinner fa-spin" style="color: #ff9900;"></i>
                        <strong id="awsBatchProgressText">${t('oauth.kiro.importingProgress', { current: 0, total: credentialsToImport.length })}</strong>
                    </div>
                    <div class="progress-bar" style="margin: 8px 0; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                        <div id="awsImportProgressBar" style="height: 100%; width: 0%; background: #ff9900; transition: width 0.3s;"></div>
                    </div>
                    <div id="awsBatchResultsList" style="max-height: 200px; overflow-y: auto; font-size: 12px; margin-top: 8px;"></div>
                `;
                
                const progressText = validationResult.querySelector('#awsBatchProgressText');
                const progressBar = validationResult.querySelector('#awsImportProgressBar');
                const resultsList = validationResult.querySelector('#awsBatchResultsList');
                
                // 使用 fetch + SSE 获取流式响应
                const response = await fetch('/api/kiro/import-aws-credentials', {
                    method: 'POST',
                    headers: window.apiClient ? window.apiClient.getAuthHeaders() : {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ credentials: credentialsToImport })
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                
                let successCount = 0;
                let failedCount = 0;
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    
                    // 解析 SSE 事件
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    
                    let eventType = '';
                    let eventData = '';
                    
                    for (const line of lines) {
                        if (line.startsWith('event: ')) {
                            eventType = line.substring(7).trim();
                        } else if (line.startsWith('data: ')) {
                            eventData = line.substring(6).trim();
                            
                            if (eventType && eventData) {
                                try {
                                    const data = JSON.parse(eventData);
                                    
                                    if (eventType === 'start') {
                                        console.log(`[AWS Batch Import] Starting import of ${data.total} credentials`);
                                    } else if (eventType === 'progress') {
                                        const { index, total, current, successCount: sc, failedCount: fc } = data;
                                        successCount = sc;
                                        failedCount = fc;
                                        
                                        // 更新进度条
                                        const percentage = Math.round((index / total) * 100);
                                        progressBar.style.width = `${percentage}%`;
                                        
                                        // 更新进度文本
                                        progressText.textContent = t('oauth.kiro.importingProgress', { current: index, total: total });
                                        
                                        // 添加结果项
                                        const resultItem = document.createElement('div');
                                        resultItem.style.cssText = 'padding: 4px 0; border-bottom: 1px solid rgba(0,0,0,0.1);';
                                        
                                        if (current.success) {
                                            resultItem.innerHTML = `凭据 ${current.index}: <span style="color: #166534;">✓ ${current.path}</span>`;
                                        } else if (current.error === 'duplicate') {
                                            resultItem.innerHTML = `凭据 ${current.index}: <span style="color: #d97706;">⚠ ${t('oauth.kiro.duplicateCredentials')}</span>
                                                ${current.existingPath ? `<span style="color: #666; font-size: 11px;">(${current.existingPath})</span>` : ''}`;
                                        } else {
                                            resultItem.innerHTML = `凭据 ${current.index}: <span style="color: #991b1b;">✗ ${current.error}</span>`;
                                        }
                                        
                                        resultsList.appendChild(resultItem);
                                        resultsList.scrollTop = resultsList.scrollHeight;
                                        
                                    } else if (eventType === 'complete') {
                                        progressBar.style.width = '100%';
                                        
                                        const isAllSuccess = data.failedCount === 0;
                                        const isAllFailed = data.successCount === 0;
                                        
                                        let resultClass, resultIcon, resultMessage;
                                        if (isAllSuccess) {
                                            resultClass = 'background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534;';
                                            resultIcon = 'fa-check-circle';
                                            resultMessage = t('oauth.kiro.awsImportSuccess') + ` (${data.successCount})`;
                                        } else if (isAllFailed) {
                                            resultClass = 'background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
                                            resultIcon = 'fa-times-circle';
                                            resultMessage = t('oauth.kiro.awsImportAllFailed', { count: data.failedCount });
                                        } else {
                                            resultClass = 'background: #fffbeb; border: 1px solid #fde68a; color: #92400e;';
                                            resultIcon = 'fa-exclamation-triangle';
                                            resultMessage = t('oauth.kiro.importPartial', { success: data.successCount, failed: data.failedCount });
                                        }
                                        
                                        validationResult.style.cssText = `display: block; margin-top: 16px; padding: 12px; border-radius: 8px; ${resultClass}`;
                                        
                                        const headerDiv = validationResult.querySelector('div:first-child');
                                        headerDiv.innerHTML = `<i class="fas ${resultIcon}"></i> <strong>${resultMessage}</strong>`;
                                        
                                        // 如果有成功的，标记为成功并刷新提供商列表
                                        if (data.successCount > 0) {
                                            importSuccess = true;
                                            loadProviders();
                                            loadConfigList();
                                        }
                                        
                                    } else if (eventType === 'error') {
                                        throw new Error(data.error);
                                    }
                                } catch (parseError) {
                                    console.warn('Failed to parse SSE data:', parseError);
                                }
                                
                                eventType = '';
                                eventData = '';
                            }
                        }
                    }
                }
                
            } else {
                // 单个导入模式
                // 确保 authMethod 为 builder-id（AWS 账号模式）
                if (!mergedCredentials.authMethod) {
                    mergedCredentials.authMethod = 'builder-id';
                }
                
                const response = await window.apiClient.post('/kiro/import-aws-credentials', {
                    credentials: mergedCredentials
                });
                
                if (response.success) {
                    importSuccess = true;
                    showToast(t('common.success'), t('oauth.kiro.awsImportSuccess'), 'success');
                    modal.remove();
                    
                    // 刷新提供商列表和配置列表
                    loadProviders();
                    loadConfigList();
                } else if (response.error === 'duplicate') {
                    // 显示重复凭据警告
                    const existingPath = response.existingPath || '';
                    showToast(t('common.warning'), t('oauth.kiro.duplicateCredentials') + (existingPath ? ` (${existingPath})` : ''), 'warning');
                } else {
                    showToast(t('common.error'), response.error || t('oauth.kiro.awsImportFailed'), 'error');
                }
            }
        } catch (error) {
            console.error('AWS import failed:', error);
            
            // 更新错误显示
            validationResult.style.cssText = 'display: block; margin-top: 16px; padding: 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;';
            validationResult.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fas fa-times-circle"></i>
                    <strong>${t('oauth.kiro.awsImportFailed')}: ${error.message}</strong>
                </div>
            `;
            
            showToast(t('common.error'), t('oauth.kiro.awsImportFailed') + ': ' + error.message, 'error');
        } finally {
            // 取消按钮始终可用
            cancelBtn.disabled = false;
            
            // 只有在导入失败时才重新启用提交按钮
            if (!importSuccess) {
                submitBtn.disabled = false;
                submitActsAsClose = false;
                submitBtn.innerHTML = `<i class="fas fa-check"></i> <span data-i18n="oauth.kiro.awsConfirmImport">${t('oauth.kiro.awsConfirmImport')}</span>`;
                
                if (currentMode === 'json') {
                    jsonInputTextarea.disabled = false;
                }
            } else {
                // 导入成功后，主按钮切换为完成态，再次点击可关闭弹窗
                submitActsAsClose = true;
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fas fa-check-circle"></i> <span>${t('common.success')}</span>`;
            }
        }
    });
}

/**
 * 执行生成授权链接
 * @param {string} providerType - 提供商类型
 * @param {Object} extraOptions - 额外选项
 */
async function executeGenerateAuthUrl(providerType, extraOptions = {}) {
    try {
        showToast(t('common.info'), t('modal.provider.auth.initializing'), 'info');
        
        // 使用 fileUploadHandler 中的 getProviderKey 获取目录名称
        const providerDir = fileUploadHandler.getProviderKey(providerType);

        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/generate-auth-url`,
            {
                saveToConfigs: true,
                providerDir: providerDir,
                ...extraOptions
            }
        );
        
        if (response.success && response.authUrl) {
            // 如果提供了 targetInputId，设置成功监听器
            if (extraOptions.targetInputId) {
                const targetInputId = extraOptions.targetInputId;
                const handleSuccess = (e) => {
                    const data = e.detail;
                    if (data.provider === providerType && data.relativePath) {
                        const input = document.getElementById(targetInputId);
                        if (input) {
                            input.value = data.relativePath;
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            showToast(t('common.success'), t('modal.provider.auth.success'), 'success');
                        }
                        window.removeEventListener('oauth_success_event', handleSuccess);
                    }
                };
                window.addEventListener('oauth_success_event', handleSuccess);
            }

            // 显示授权信息模态框
            showAuthModal(response.authUrl, response.authInfo);
        } else {
            showToast(t('common.error'), t('modal.provider.auth.failed'), 'error');
        }
    } catch (error) {
        console.error('生成授权链接失败:', error);
        showToast(t('common.error'), t('modal.provider.auth.failed') + `: ${error.message}`, 'error');
    }
}

/**
 * 获取提供商的授权文件路径
 * @param {string} provider - 提供商类型
 * @returns {string} 授权文件路径
 */
function getAuthFilePath(provider) {
    const authFilePaths = {
        'gemini-cli-oauth': '~/.gemini/oauth_creds.json',
        'gemini-antigravity': '~/.antigravity/oauth_creds.json',
        'openai-qwen-oauth': '~/.qwen/oauth_creds.json',
        'claude-kiro-oauth': '~/.aws/sso/cache/kiro-auth-token.json',
        'openai-iflow': '~/.iflow/oauth_creds.json'
    };
    return authFilePaths[provider] || (getCurrentLanguage() === 'en-US' ? 'Unknown Path' : '未知路径');
}

/**
 * 显示授权信息模态框
 * @param {string} authUrl - 授权URL
 * @param {Object} authInfo - 授权信息
 */
function showAuthModal(authUrl, authInfo) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    
    // 获取授权文件路径
    const authFilePath = getAuthFilePath(authInfo.provider);
    
    // 获取需要开放的端口号（从 authInfo 或当前页面 URL）
    const requiredPort = authInfo.callbackPort || authInfo.port || window.location.port || '3000';
    const isDeviceFlow = authInfo.provider === 'openai-qwen-oauth' || (authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'builder-id');
    let authCompleted = false;
    let isClosing = false;
    let oauthSuccessListener = null;

    let instructionsHtml = '';
    if (authInfo.provider === 'openai-qwen-oauth') {
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <ol>
                    <li data-i18n="oauth.modal.step1">${t('oauth.modal.step1')}</li>
                    <li data-i18n="oauth.modal.step2.qwen">${t('oauth.modal.step2.qwen')}</li>
                    <li data-i18n="oauth.modal.step3">${t('oauth.modal.step3')}</li>
                    <li data-i18n="oauth.modal.step4.qwen" data-i18n-params='{"min":"${Math.floor(authInfo.expiresIn / 60)}"}'>${t('oauth.modal.step4.qwen', { min: Math.floor(authInfo.expiresIn / 60) })}</li>
                </ol>
            </div>
        `;
    } else if (authInfo.provider === 'claude-kiro-oauth') {
        const methodDisplay = authInfo.authMethod === 'builder-id' ? 'AWS Builder ID' : `Social (${authInfo.socialProvider || 'Google'})`;
        const methodAccount = authInfo.authMethod === 'builder-id' ? 'AWS Builder ID' : authInfo.socialProvider || 'Google';
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <p><strong data-i18n="oauth.kiro.authMethodLabel">${t('oauth.kiro.authMethodLabel')}</strong> ${methodDisplay}</p>
                <ol>
                    <li data-i18n="oauth.kiro.step1">${t('oauth.kiro.step1')}</li>
                    <li data-i18n="oauth.kiro.step2" data-i18n-params='{"method":"${methodAccount}"}'>${t('oauth.kiro.step2', { method: methodAccount })}</li>
                    <li data-i18n="oauth.kiro.step3">${t('oauth.kiro.step3')}</li>
                    <li data-i18n="oauth.kiro.step4">${t('oauth.kiro.step4')}</li>
                </ol>
            </div>
        `;
    } else if (authInfo.provider === 'openai-iflow') {
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <ol>
                    <li data-i18n="oauth.iflow.step1">${t('oauth.iflow.step1')}</li>
                    <li data-i18n="oauth.iflow.step2">${t('oauth.iflow.step2')}</li>
                    <li data-i18n="oauth.iflow.step3">${t('oauth.iflow.step3')}</li>
                    <li data-i18n="oauth.iflow.step4">${t('oauth.iflow.step4')}</li>
                </ol>
            </div>
        `;
    } else {
        instructionsHtml = `
            <div class="auth-instructions">
                <h4 data-i18n="oauth.modal.steps">${t('oauth.modal.steps')}</h4>
                <ol>
                    <li data-i18n="oauth.modal.step1">${t('oauth.modal.step1')}</li>
                    <li data-i18n="oauth.modal.step2.google">${t('oauth.modal.step2.google')}</li>
                    <li data-i18n="oauth.modal.step4.google">${t('oauth.modal.step4.google')}</li>
                    <li data-i18n="oauth.modal.step3">${t('oauth.modal.step3')}</li>
                </ol>
            </div>
        `;
    }
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <div class="modal-header">
                <h3><i class="fas fa-key"></i> <span data-i18n="oauth.modal.title">${t('oauth.modal.title')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div class="auth-info">
                    <p><strong data-i18n="oauth.modal.provider">${t('oauth.modal.provider')}</strong> ${authInfo.provider}</p>
                    <div class="port-info-section" style="margin: 12px 0; padding: 12px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; position: relative;">
                        ${(authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'builder-id') ? `
                        <button class="regenerate-builder-id-btn" title="${t('common.generate')}" style="position: absolute; top: 12px; right: 12px; background: none; border: 1px solid #d97706; border-radius: 4px; cursor: pointer; color: #d97706; padding: 4px 8px;">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                        ` : ''}
                        <div style="margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <i class="fas fa-network-wired" style="color: #d97706;"></i>
                            <strong data-i18n="oauth.modal.requiredPort">${t('oauth.modal.requiredPort')}</strong>
                            ${isDeviceFlow ?
                                `<code style="background: #fff; padding: 2px 8px; border-radius: 4px; font-weight: bold; color: #d97706;">${requiredPort}</code>` :
                                `<div style="display: flex; align-items: center; gap: 4px;">
                                    <input type="number" class="auth-port-input" value="${requiredPort}" style="width: 80px; padding: 2px 8px; border: 1px solid #d97706; border-radius: 4px; font-weight: bold; color: #d97706; background: white;">
                                    <button class="regenerate-port-btn" title="${t('common.generate')}" style="background: none; border: 1px solid #d97706; border-radius: 4px; cursor: pointer; color: #d97706; padding: 2px 6px;">
                                        <i class="fas fa-sync-alt"></i>
                                    </button>
                                </div>`
                            }
                        </div>
                        <p style="margin: 8px 0 0 0; font-size: 0.85rem; color: #92400e;" data-i18n="oauth.modal.portNote">${t('oauth.modal.portNote')}</p>
                        ${(authInfo.provider === 'claude-kiro-oauth' && authInfo.authMethod === 'builder-id') ? `
                        <div class="builder-id-url-section" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #fcd34d;">
                            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #92400e;">
                                <i class="fas fa-link"></i>
                                <span data-i18n="oauth.kiro.builderIDStartURL">${t('oauth.kiro.builderIDStartURL') || 'Builder ID Start URL'}</span>
                                <span style="font-weight: normal; color: #b45309;">(${t('common.optional') || '可选'})</span>
                            </label>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <input type="text" class="builder-id-start-url-input"
                                    value="${authInfo.builderIDStartURL || 'https://view.awsapps.com/start'}"
                                    placeholder="https://view.awsapps.com/start"
                                    style="flex: 1; padding: 6px 10px; border: 1px solid #fcd34d; border-radius: 4px; font-size: 13px; color: #92400e; background: white;"
                                />
                            </div>
                            <p style="margin: 6px 0 0 0; font-size: 0.75rem; color: #b45309;">
                                <i class="fas fa-info-circle"></i>
                                <span data-i18n="oauth.kiro.builderIDStartURLHint">${t('oauth.kiro.builderIDStartURLHint') || '如果您使用 AWS IAM Identity Center，请输入您的 Start URL'}</span>
                            </p>
                        </div>
                        <div class="builder-id-region-section" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #fcd34d;">
                            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #92400e;">
                                <i class="fas fa-globe"></i>
                                <span>AWS Region</span>
                            </label>
                            <div style="display: flex; align-items: center; gap: 4px;">
                                <input type="text" class="builder-id-region-input"
                                    value="${authInfo.region || 'us-east-1'}"
                                    placeholder="us-east-1"
                                    style="flex: 1; padding: 6px 10px; border: 1px solid #fcd34d; border-radius: 4px; font-size: 13px; color: #92400e; background: white;"
                                />
                            </div>
                        </div>
                        ` : ''}
                    </div>
                    ${instructionsHtml}
                    <div class="auth-url-section">
                        <label data-i18n="oauth.modal.urlLabel">${t('oauth.modal.urlLabel')}</label>
                        <div class="auth-url-container">
                            <input type="text" readonly value="${authUrl}" class="auth-url-input">
                            <button class="copy-btn" data-i18n="oauth.modal.copyTitle" title="复制链接">
                                <i class="fas fa-copy"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel" data-i18n="modal.provider.cancel">${t('modal.provider.cancel')}</button>
                <button class="open-auth-btn">
                    <i class="fas fa-external-link-alt"></i>
                    <span data-i18n="oauth.modal.openInBrowser">${t('oauth.modal.openInBrowser')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);

    // 关闭授权弹窗时，同步通知后端取消仍在等待的 OAuth 会话
    async function cancelPendingAuth() {
        if (authInfo.provider !== 'openai-codex-oauth') {
            return;
        }

        try {
            await window.apiClient.post(`/providers/${encodeURIComponent(authInfo.provider)}/cancel-auth`, {
                sessionId: authInfo.sessionId
            });
            console.log('[OAuth] Pending auth session canceled');
        } catch (error) {
            console.error('[OAuth] Failed to cancel pending auth session:', error);
        }
    }

    async function closeAuthModal({ cancelPending = true } = {}) {
        if (isClosing) return;
        isClosing = true;

        if (oauthSuccessListener) {
            window.removeEventListener('oauth_success_event', oauthSuccessListener);
            oauthSuccessListener = null;
        }

        modal.remove();

        if (cancelPending && !authCompleted) {
            await cancelPendingAuth();
        }
    }
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            void closeAuthModal();
        });
    });
    
    // 重新生成按钮事件
    const regenerateBtn = modal.querySelector('.regenerate-port-btn');
    if (regenerateBtn) {
        regenerateBtn.onclick = async () => {
            const newPort = modal.querySelector('.auth-port-input').value;
            if (newPort && newPort !== requiredPort) {
                await closeAuthModal();
                // 构造重新请求的参数
                const options = { ...authInfo, port: newPort };
                // 移除不需要传递回后端的字段
                delete options.provider;
                delete options.redirectUri;
                delete options.callbackPort;
                
                await executeGenerateAuthUrl(authInfo.provider, options);
            }
        };
    }

    // Builder ID Start URL 重新生成按钮事件
    const regenerateBuilderIdBtn = modal.querySelector('.regenerate-builder-id-btn');
    if (regenerateBuilderIdBtn) {
        regenerateBuilderIdBtn.onclick = async () => {
            const builderIdStartUrl = modal.querySelector('.builder-id-start-url-input').value.trim();
            const region = modal.querySelector('.builder-id-region-input').value.trim();
            await closeAuthModal();
            // 构造重新请求的参数
            const options = {
                ...authInfo,
                builderIDStartURL: builderIdStartUrl || 'https://view.awsapps.com/start',
                region: region || 'us-east-1'
            };
            // 移除不需要传递回后端的字段
            delete options.provider;
            delete options.redirectUri;
            delete options.callbackPort;
            
            await executeGenerateAuthUrl(authInfo.provider, options);
        };
    }

    // 复制链接按钮
    const copyBtn = modal.querySelector('.copy-btn');
    copyBtn.addEventListener('click', () => {
        const input = modal.querySelector('.auth-url-input');
        input.select();
        document.execCommand('copy');
        showToast(t('common.success'), t('oauth.success.msg'), 'success');
    });
    
    // 在浏览器中打开按钮
    const openBtn = modal.querySelector('.open-auth-btn');
    openBtn.addEventListener('click', () => {
        // 使用子窗口打开，以便监听 URL 变化
        const width = 600;
        const height = 700;
        const left = (window.screen.width - width) / 2 + 600;
        const top = (window.screen.height - height) / 2;
        
        const authWindow = window.open(
            authUrl,
            'OAuthAuthWindow',
            `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`
        );
        
        // 监听 OAuth 成功事件，自动关闭窗口和模态框
        const handleOAuthSuccess = () => {
            authCompleted = true;
            if (authWindow && !authWindow.closed) {
                authWindow.close();
            }
            void closeAuthModal({ cancelPending: false });
            
            // 授权成功后刷新配置和提供商列表
            loadProviders();
            loadConfigList();
        };
        oauthSuccessListener = handleOAuthSuccess;
        window.addEventListener('oauth_success_event', oauthSuccessListener);
        
        if (authWindow) {
            showToast(t('common.info'), t('oauth.window.opened'), 'info');
            
            // 添加手动输入回调 URL 的 UI
            const urlSection = modal.querySelector('.auth-url-section');
            if (urlSection && !modal.querySelector('.manual-callback-section')) {
            const manualInputHtml = `
                <div class="manual-callback-section" style="margin-top: 20px; padding: 15px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px;">
                    <h4 style="color: #92400e; margin-bottom: 8px;"><i class="fas fa-exclamation-circle"></i> <span data-i18n="oauth.manual.title">${t('oauth.manual.title')}</span></h4>
                    <p style="font-size: 0.875rem; color: #b45309; margin-bottom: 10px;" data-i18n-html="oauth.manual.desc">${t('oauth.manual.desc')}</p>
                    <div class="auth-url-container" style="display: flex; gap: 5px;">
                        <input type="text" class="manual-callback-input" data-i18n="oauth.manual.placeholder" placeholder="粘贴回调 URL (包含 code=...)" style="flex: 1; padding: 8px; border: 1px solid #fcd34d; border-radius: 4px; background: white; color: black;">
                        <button class="btn btn-success apply-callback-btn" style="padding: 8px 15px; white-space: nowrap; background: #059669; color: white; border: none; border-radius: 4px; cursor: pointer;">
                            <i class="fas fa-check"></i> <span data-i18n="oauth.manual.submit">${t('oauth.manual.submit')}</span>
                        </button>
                    </div>
                </div>
            `;
            urlSection.insertAdjacentHTML('afterend', manualInputHtml);
            }

            const manualInput = modal.querySelector('.manual-callback-input');
            const applyBtn = modal.querySelector('.apply-callback-btn');

            // 处理回调 URL 的核心逻辑
            const processCallback = (urlStr, isManualInput = false) => {
                try {
                    // 尝试清理 URL（有些用户可能会复制多余的文字）
                    const cleanUrlStr = urlStr.trim().match(/https?:\/\/[^\s]+/)?.[0] || urlStr.trim();
                    const url = new URL(cleanUrlStr);
                    
                    if (url.searchParams.has('code') || url.searchParams.has('token')) {
                        clearInterval(pollTimer);
                        // 构造本地可处理的 URL，只修改 hostname，保持原始 URL 的端口号不变
                        const localUrl = new URL(url.href);
                        localUrl.hostname = window.location.hostname;
                        localUrl.protocol = window.location.protocol;
                        
                        showToast(t('common.info'), t('oauth.processing'), 'info');
                        
                        // 如果是手动输入，直接通过 fetch 请求处理，然后关闭子窗口
                        if (isManualInput) {
                            // 关闭子窗口
                            if (authWindow && !authWindow.closed) {
                                authWindow.close();
                            }
                            // 通过服务端API处理手动输入的回调URL
                            window.apiClient.post('/oauth/manual-callback', {
                                provider: authInfo.provider,
                                callbackUrl: url.href, //使用localhost访问
                                authMethod: authInfo.authMethod
                            })
                                .then(response => {
                                    if (response.success) {
                                        console.log('OAuth 回调处理成功');
                                        showToast(t('common.success'), t('oauth.success.msg'), 'success');
                                    } else {
                                        console.error('OAuth 回调处理失败:', response.error);
                                        showToast(t('common.error'), response.error || t('oauth.error.process'), 'error');
                                    }
                                })
                                .catch(err => {
                                    console.error('OAuth 回调请求失败:', err);
                                    showToast(t('common.error'), t('oauth.error.process'), 'error');
                                });
                        } else {
                            // 自动监听模式：优先在子窗口中跳转（如果没关）
                            if (authWindow && !authWindow.closed) {
                                authWindow.location.href = localUrl.href;
                            } else {
                                // 备选方案：通过 fetch 请求
                                // 通过 fetch 请求本地服务器处理回调
                                fetch(localUrl.href)
                                    .then(response => {
                                        if (response.ok) {
                                            console.log('OAuth 回调处理成功');
                                        } else {
                                            console.error('OAuth 回调处理失败:', response.status);
                                        }
                                    })
                                    .catch(err => {
                                        console.error('OAuth 回调请求失败:', err);
                                    });
                            }
                        }
                        
                    } else {
                        showToast(t('common.warning'), t('oauth.invalid.url'), 'warning');
                    }
                } catch (err) {
                    console.error('处理回调失败:', err);
                    showToast(t('common.error'), t('oauth.error.format'), 'error');
                }
            };

            applyBtn.addEventListener('click', () => {
                processCallback(manualInput.value, true);
            });

            // 启动定时器轮询子窗口 URL
            const pollTimer = setInterval(() => {
                try {
                    if (authWindow.closed) {
                        clearInterval(pollTimer);
                        return;
                    }
                    // 如果能读到说明回到了同域
                    const currentUrl = authWindow.location.href;
                    if (currentUrl && (currentUrl.includes('code=') || currentUrl.includes('token='))) {
                        processCallback(currentUrl);
                    }
                } catch (e) {
                    // 跨域受限是正常的
                }
            }, 1000);
        } else {
            showToast(t('common.error'), t('oauth.window.blocked'), 'error');
        }
    });
    
}

/**
 * 显示需要重启的提示模态框
 * @param {string} version - 更新到的版本号
 */
function showRestartRequiredModal(version) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay restart-required-modal';
    modal.style.display = 'flex';
    
    modal.innerHTML = `
        <div class="modal-content restart-modal-content" style="max-width: 420px;">
            <div class="modal-header restart-modal-header">
                <h3><i class="fas fa-check-circle" style="color: #10b981;"></i> <span data-i18n="dashboard.update.restartTitle">${t('dashboard.update.restartTitle')}</span></h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body" style="text-align: center; padding: 20px;">
                <p style="font-size: 1rem; color: #374151; margin: 0;" data-i18n="dashboard.update.restartMsg" data-i18n-params='{"version":"${version}"}'>${t('dashboard.update.restartMsg', { version })}</p>
            </div>
            <div class="modal-footer">
                <button class="btn restart-confirm-btn">
                    <i class="fas fa-check"></i>
                    <span data-i18n="common.confirm">${t('common.confirm')}</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 关闭按钮事件
    const closeBtn = modal.querySelector('.modal-close');
    const confirmBtn = modal.querySelector('.restart-confirm-btn');
    
    const closeModal = () => {
        modal.remove();
    };
    
    closeBtn.addEventListener('click', closeModal);
    confirmBtn.addEventListener('click', closeModal);
    
    // 点击遮罩层关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });
}

/**
 * 检查更新
 * @param {boolean} silent - 是否静默检查（不显示 Toast）
 */
async function checkUpdate(silent = false) {
    const checkBtn = document.getElementById('checkUpdateBtn');
    const updateBtn = document.getElementById('performUpdateBtn');
    const updateBadge = document.getElementById('updateBadge');
    const latestVersionText = document.getElementById('latestVersionText');
    const checkBtnIcon = checkBtn?.querySelector('i');
    const checkBtnText = checkBtn?.querySelector('span');

    try {
        if (!silent && checkBtn) {
            checkBtn.disabled = true;
            if (checkBtnIcon) checkBtnIcon.className = 'fas fa-spinner fa-spin';
            if (checkBtnText) checkBtnText.textContent = t('dashboard.update.checking');
        }

        const checkUpdatePath = silent ? '/check-update?silent=true' : '/check-update';
        const data = await window.apiClient.get(checkUpdatePath);

        if (data.hasUpdate) {
            if (updateBtn) updateBtn.style.display = 'inline-flex';
            if (updateBadge) updateBadge.style.display = 'inline-flex';
            if (latestVersionText) latestVersionText.textContent = data.latestVersion;
            
            if (!silent) {
                showToast(t('common.info'), t('dashboard.update.hasUpdate', { version: data.latestVersion }), 'info');
            }
        } else {
            if (updateBtn) updateBtn.style.display = 'none';
            if (updateBadge) updateBadge.style.display = 'none';
            if (!silent) {
                showToast(t('common.info'), t('dashboard.update.upToDate'), 'success');
            }
        }
    } catch (error) {
        console.error('Check update failed:', error);
        if (!silent) {
            showToast(t('common.error'), t('dashboard.update.failed', { error: error.message }), 'error');
        }
    } finally {
        if (checkBtn) {
            checkBtn.disabled = false;
            if (checkBtnIcon) checkBtnIcon.className = 'fas fa-sync-alt';
            if (checkBtnText) checkBtnText.textContent = t('dashboard.update.check');
        }
    }
}

/**
 * 执行更新
 */
async function performUpdate() {
    const updateBtn = document.getElementById('performUpdateBtn');
    const latestVersionText = document.getElementById('latestVersionText');
    const version = latestVersionText?.textContent || '';

    if (!confirm(t('dashboard.update.confirmMsg', { version }))) {
        return;
    }

    const updateBtnIcon = updateBtn?.querySelector('i');
    const updateBtnText = updateBtn?.querySelector('span');

    try {
        if (updateBtn) {
            updateBtn.disabled = true;
            if (updateBtnIcon) updateBtnIcon.className = 'fas fa-spinner fa-spin';
            if (updateBtnText) updateBtnText.textContent = t('dashboard.update.updating');
        }

        showToast(t('common.info'), t('dashboard.update.updating'), 'info');

        const data = await window.apiClient.post('/update');

        if (data.success) {
            if (data.updated) {
                // 代码已更新，直接调用重启服务
                showToast(t('common.success'), t('dashboard.update.success'), 'success');
                
                // 自动重启服务
                await restartServiceAfterUpdate();
            } else {
                // 已是最新版本
                showToast(t('common.info'), t('dashboard.update.upToDate'), 'info');
            }
        }
    } catch (error) {
        console.error('Update failed:', error);
        showToast(t('common.error'), t('dashboard.update.failed', { error: error.message }), 'error');
    } finally {
        if (updateBtn) {
            updateBtn.disabled = false;
            if (updateBtnIcon) updateBtnIcon.className = 'fas fa-download';
            if (updateBtnText) updateBtnText.textContent = t('dashboard.update.perform');
        }
    }
}

/**
 * 更新后自动重启服务
 */
async function restartServiceAfterUpdate() {
    try {
        showToast(t('common.info'), t('header.restart.requesting'), 'info');
        
        const token = localStorage.getItem('authToken');
        const response = await fetch('/api/restart-service', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            }
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showToast(t('common.success'), result.message || t('header.restart.success'), 'success');
            
            // 如果是 worker 模式，服务会自动重启，等待几秒后刷新页面
            if (result.mode === 'worker') {
                setTimeout(() => {
                    showToast(t('common.info'), t('header.restart.reconnecting'), 'info');
                    // 等待服务重启后刷新页面
                    setTimeout(() => {
                        window.location.reload();
                    }, 3000);
                }, 2000);
            }
        } else {
            // 显示错误信息
            const errorMsg = result.message || result.error?.message || t('header.restart.failed');
            showToast(t('common.error'), errorMsg, 'error');
            
            // 如果是独立模式，显示提示
            if (result.mode === 'standalone') {
                showToast(t('common.info'), result.hint, 'warning');
            }
        }
    } catch (error) {
        console.error('Restart after update failed:', error);
        showToast(t('common.error'), t('header.restart.failed') + ': ' + error.message, 'error');
    }
}

export {
    loadSystemInfo,
    updateTimeDisplay,
    loadProviders,
    renderProviders,
    updateProviderStatsDisplay,
    openProviderManager,
    showAuthModal,
    executeGenerateAuthUrl,
    handleGenerateAuthUrl,
    checkUpdate,
    performUpdate
};
