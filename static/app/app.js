// 主应用入口文件 - 模块化版本

// 导入所有模块
import {
    providerStats,
    REFRESH_INTERVALS
} from './constants.js';

import {
    showToast,
    getProviderStats
} from './utils.js';

import { t } from './i18n.js';

import {
    initFileUpload,
    fileUploadHandler
} from './file-upload.js';

import { 
    initNavigation 
} from './navigation.js';

import {
    initEventListeners,
    setDataLoaders,
    setReloadConfig
} from './event-handlers.js';

import {
    initEventStream,
    setProviderLoaders
} from './event-stream.js';

import {
    loadSystemInfo,
    updateTimeDisplay,
    loadProviders,
    openProviderManager,
    showAuthModal,
    executeGenerateAuthUrl,
    handleGenerateAuthUrl
} from './provider-manager.js';

import {
    loadConfiguration,
    saveConfiguration
} from './config-manager.js';

import {
    showProviderManagerModal,
    refreshProviderConfig
} from './modal.js';

import {
    initRoutingExamples
} from './routing-examples.js';

import {
    initUsageManager,
    refreshUsage
} from './usage-manager.js';

import {
    initUsageStatisticsManager,
    refreshUsageStatistics
} from './usage-statistics-manager.js';

import {
    initPluginManager,
    togglePlugin
} from './plugin-manager.js';

import {
    initTutorialManager
} from './tutorial-manager.js';

/**
 * 加载初始数据
 */
function loadInitialData() {
    loadSystemInfo();
    loadProviders({ showLoading: true });
    loadConfiguration();
    // showToast('数据已刷新', 'success');
}

const APP_INIT_STATE = {
    IDLE: 'idle',
    RUNNING: 'running',
    COMPLETED: 'completed'
};

let appInitState = APP_INIT_STATE.IDLE;
let timeDisplayTimer = null;
let providerRefreshTimer = null;

function hasRenderedUiComponents() {
    const sidebarContainer = document.getElementById('sidebar-container');
    const contentContainer = document.getElementById('content-container');
    if (!sidebarContainer || !contentContainer) {
        return false;
    }

    return sidebarContainer.children.length > 0 || contentContainer.children.length > 0;
}

function areUiComponentsReady() {
    return window.__AICLIENT_UI_COMPONENTS_READY === true || hasRenderedUiComponents();
}

function runInitStep(stepName, fn) {
    try {
        fn();
        console.log(`[UI App] ${stepName} initialized`);
    } catch (error) {
        console.error(`[UI App] ${stepName} initialization failed:`, error);
    }
}

/**
 * 初始化应用
 */
function initApp() {
    if (appInitState === APP_INIT_STATE.RUNNING || appInitState === APP_INIT_STATE.COMPLETED) {
        return;
    }

    appInitState = APP_INIT_STATE.RUNNING;
    console.log('[UI App] initApp starting');

    try {
        runInitStep('data loaders', () => setDataLoaders(loadInitialData, saveConfiguration));
        runInitStep('reload config hook', () => setReloadConfig(async () => {
            const result = await window.apiClient.post('/reload-config');
            showToast(t('common.success'), result.message || t('common.success'), 'success');
            return result;
        }));
        runInitStep('provider loaders', () => setProviderLoaders(loadProviders, refreshProviderConfig));

        runInitStep('navigation', initNavigation);
        runInitStep('event listeners', initEventListeners);
        runInitStep('event stream', initEventStream);
        runInitStep('file upload', initFileUpload);
        runInitStep('routing examples', initRoutingExamples);
        runInitStep('usage manager', initUsageManager);
        runInitStep('usage statistics manager', initUsageStatisticsManager);
        runInitStep('plugin manager', initPluginManager);
        runInitStep('tutorial manager', initTutorialManager);
        runInitStep('mobile menu', initMobileMenu);
        runInitStep('initial data', loadInitialData);

        showToast(t('common.success'), t('common.welcome'), 'success');

        if (!timeDisplayTimer) {
            timeDisplayTimer = setInterval(() => {
                updateTimeDisplay();
            }, 5000);
        }

        if (!providerRefreshTimer) {
            providerRefreshTimer = setInterval(() => {
                loadSystemInfo();
                loadProviders({ showLoading: false });

                if (providerStats.activeProviders > 0) {
                    const stats = getProviderStats(providerStats);
                    console.log('=== 提供商统计报告 ===');
                    console.log(`活跃提供商: ${stats.activeProviders}`);
                    console.log(`健康提供商: ${stats.healthyProviders} (${stats.healthRatio})`);
                    console.log(`总账户数: ${stats.totalAccounts}`);
                    console.log(`总请求数: ${stats.totalRequests}`);
                    console.log(`总错误数: ${stats.totalErrors}`);
                    console.log(`成功率: ${stats.successRate}`);
                    console.log(`平均每提供商请求数: ${stats.avgUsagePerProvider}`);
                    console.log('========================');
                }
            }, REFRESH_INTERVALS.SYSTEM_INFO);
        }

        appInitState = APP_INIT_STATE.COMPLETED;
        console.log('[UI App] initApp completed');
    } catch (error) {
        appInitState = APP_INIT_STATE.IDLE;
        console.error('[UI App] initApp failed:', error);
    }
}

function tryInitApp(trigger = 'unknown') {
    if (!areUiComponentsReady()) {
        console.log(`[UI App] skip initApp (${trigger}): components not ready`);
        return;
    }

    console.log(`[UI App] try initApp from ${trigger}`);
    initApp();
}

/**
 * 初始化移动端菜单
 */
function initMobileMenu() {
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const headerControls = document.getElementById('headerControls');
    
    if (!mobileMenuToggle || !headerControls) {
        console.log('Mobile menu elements not found');
        return;
    }
    
    // 默认隐藏header-controls
    headerControls.style.display = 'none';
    
    let isMenuOpen = false;
    
    mobileMenuToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        console.log('Mobile menu toggle clicked, current state:', isMenuOpen);
        
        isMenuOpen = !isMenuOpen;
        
        if (isMenuOpen) {
            headerControls.style.display = 'flex';
            mobileMenuToggle.innerHTML = '<i class="fas fa-times"></i>';
            console.log('Menu opened');
        } else {
            headerControls.style.display = 'none';
            mobileMenuToggle.innerHTML = '<i class="fas fa-bars"></i>';
            console.log('Menu closed');
        }
    });
    
    // 点击页面其他地方关闭菜单
    document.addEventListener('click', (e) => {
        if (isMenuOpen && !mobileMenuToggle.contains(e.target) && !headerControls.contains(e.target)) {
            isMenuOpen = false;
            headerControls.style.display = 'none';
            mobileMenuToggle.innerHTML = '<i class="fas fa-bars"></i>';
            console.log('Menu closed by clicking outside');
        }
    });
}

// 等待组件加载完成后初始化应用
// 组件加载器会在所有组件加载完成后触发 'componentsLoaded' 事件
window.addEventListener('componentsLoaded', () => {
    tryInitApp('componentsLoaded');
});

// 如果组件已经加载完成（例如 app.js 在 componentsLoaded 之后才完成加载），也需要兜底初始化
document.addEventListener('DOMContentLoaded', () => {
    tryInitApp('DOMContentLoaded');
});

tryInitApp('module-load');

// 导出全局函数供其他模块使用
window.loadProviders = loadProviders;
window.openProviderManager = openProviderManager;
window.showProviderManagerModal = showProviderManagerModal;
window.refreshProviderConfig = refreshProviderConfig;
window.fileUploadHandler = fileUploadHandler;
window.showAuthModal = showAuthModal;
window.executeGenerateAuthUrl = executeGenerateAuthUrl;
window.handleGenerateAuthUrl = handleGenerateAuthUrl;

// 用量管理相关全局函数
window.refreshUsage = refreshUsage;
window.refreshUsageStatistics = refreshUsageStatistics;

// 插件管理相关全局函数
window.togglePlugin = togglePlugin;

// 导出调试函数
window.getProviderStats = () => getProviderStats(providerStats);

console.log('All2One API 管理控制台已加载 - 模块化版本');
