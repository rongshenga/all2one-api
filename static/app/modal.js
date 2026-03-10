// 模态框管理模块

import { showToast, getFieldLabel, getProviderTypeFields } from './utils.js';
import { handleProviderPasswordToggle } from './event-handlers.js';
import { t } from './i18n.js';

// 分页配置
const PROVIDERS_PER_PAGE = 5;
const PROVIDER_ERROR_TYPE_FILTERS = ['all', 'auth', 'quota', 'timeout', 'network', 'other', 'unknown'];
let currentPage = 1;
let allProviders = [];
let currentProviders = [];
let currentProviderType = '';
let currentTotalCount = 0;
let currentHealthyCount = 0;
let currentFilteredCount = 0;
let currentTotalPages = 1;
let currentSort = null;
let cachedModels = []; // 缓存模型列表
let currentHealthFilter = 'all';
let currentErrorTypeFilter = 'all';

function normalizePage(value, fallback = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function normalizeErrorTypeFilter(value, fallback = 'all') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    return PROVIDER_ERROR_TYPE_FILTERS.includes(normalized) ? normalized : fallback;
}

function buildProviderPageUrl(providerType, page = 1) {
    const params = new URLSearchParams({
        page: String(normalizePage(page, 1)),
        limit: String(PROVIDERS_PER_PAGE)
    });

    if (currentSort === 'asc' || currentSort === 'desc') {
        params.set('sort', currentSort);
    }
    params.set('healthFilter', currentHealthFilter);
    params.set('errorType', currentErrorTypeFilter);

    return `/providers/${encodeURIComponent(providerType)}?${params.toString()}`;
}

async function fetchProviderPage(providerType, page = 1) {
    const data = await window.apiClient.get(buildProviderPageUrl(providerType, page));
    if (data?.error) {
        throw new Error(data.error.message || t('modal.provider.load.failed'));
    }
    if (!data || typeof data !== 'object' || typeof data.providerType !== 'string') {
        throw new Error(t('modal.provider.load.failed'));
    }
    return data;
}

function applyProviderModalPayload(data = {}, { resetFilter = false } = {}) {
    const validFilters = ['all', 'healthy', 'unhealthy'];
    const payloadHealthFilter = validFilters.includes(data.healthFilter) ? data.healthFilter : 'all';
    const payloadErrorType = normalizeErrorTypeFilter(data.errorType, 'all');
    if (resetFilter) {
        currentHealthFilter = 'all';
        currentErrorTypeFilter = 'all';
    } else {
        currentHealthFilter = payloadHealthFilter;
        currentErrorTypeFilter = payloadErrorType;
    }

    allProviders = Array.isArray(data.providers) ? data.providers : [];
    currentProviderType = data.providerType || currentProviderType;
    currentPage = normalizePage(data.page, currentPage);
    currentTotalCount = Number(data.totalCount) || allProviders.length;
    currentHealthyCount = Number(data.healthyCount) || 0;
    currentFilteredCount = Number(data.filteredCount);
    if (!Number.isFinite(currentFilteredCount) || currentFilteredCount < 0) {
        currentFilteredCount = allProviders.length;
    }
    currentTotalPages = Math.max(
        1,
        Number(data.filteredTotalPages) || Number(data.totalPages) || Math.ceil(Math.max(currentFilteredCount, 1) / PROVIDERS_PER_PAGE)
    );
    if (data.sort === 'asc' || data.sort === 'desc') {
        currentSort = data.sort;
    } else if (data.sort === null) {
        currentSort = null;
    }
    currentProviders = [...allProviders];
}

function getUnhealthyCountEstimate() {
    const unhealthyBySummary = Math.max(0, currentTotalCount - currentHealthyCount);
    if (unhealthyBySummary > 0) {
        return unhealthyBySummary;
    }

    return allProviders.filter(provider => !provider.isHealthy).length;
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

function getDeleteUnhealthyErrorTypeLabel(errorType = 'all') {
    const normalized = String(errorType || 'all').toLowerCase();
    const keyMap = {
        all: 'modal.provider.deleteUnhealthy.errorType.all',
        auth: 'modal.provider.deleteUnhealthy.errorType.auth',
        quota: 'modal.provider.deleteUnhealthy.errorType.quota',
        timeout: 'modal.provider.deleteUnhealthy.errorType.timeout',
        network: 'modal.provider.deleteUnhealthy.errorType.network',
        other: 'modal.provider.deleteUnhealthy.errorType.other',
        unknown: 'modal.provider.deleteUnhealthy.errorType.unknown'
    };
    return t(keyMap[normalized] || keyMap.all);
}

function getUnhealthyCountEstimateByErrorType(errorType = 'all') {
    const normalized = String(errorType || 'all').toLowerCase();
    if (normalized === 'all') {
        return getUnhealthyCountEstimate();
    }

    return allProviders.filter(provider => !provider.isHealthy && classifyProviderErrorType(provider) === normalized).length;
}

/**
 * 按健康状态筛选提供商
 * @param {Array} providers - 提供商数组
 * @param {string} healthFilter - 筛选类型 (all/healthy/unhealthy)
 * @returns {Array} 筛选后的提供商数组
 */
function filterProvidersByHealth(providers, healthFilter = 'all') {
    if (!Array.isArray(providers)) {
        return [];
    }

    if (healthFilter === 'healthy') {
        return providers.filter(provider => provider.isHealthy);
    }

    if (healthFilter === 'unhealthy') {
        return providers.filter(provider => !provider.isHealthy);
    }

    return [...providers];
}

/**
 * 更新筛选按钮激活状态
 * @param {HTMLElement} modal - 模态框元素
 */
function updateProviderFilterButtonsState(modal) {
    if (!modal) return;

    const filterButtons = modal.querySelectorAll('.provider-filter-btn');
    filterButtons.forEach(button => {
        const buttonFilter = button.getAttribute('data-filter');
        button.classList.toggle('active', buttonFilter === currentHealthFilter);
    });
}

function updateProviderErrorTypeFilterState(modal) {
    if (!modal) return;

    const errorTypeFilterSelect = modal.querySelector('#providerErrorTypeFilter');
    if (!errorTypeFilterSelect) {
        return;
    }

    errorTypeFilterSelect.value = normalizeErrorTypeFilter(currentErrorTypeFilter, 'all');
}

/**
 * 渲染当前筛选结果对应的列表和分页
 * @param {HTMLElement} modal - 模态框元素
 * @param {Object} options - 渲染选项
 * @param {boolean} options.scrollToTop - 是否滚动到顶部
 */
function renderProviderListWithPagination(modal, { scrollToTop = false } = {}) {
    if (!modal) return;

    const totalPages = Math.max(1, currentTotalPages);
    if (currentPage < 1) currentPage = 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const summaryValues = modal.querySelectorAll('.provider-summary-item .value');
    if (summaryValues[0]) {
        summaryValues[0].textContent = currentTotalCount;
    }
    if (summaryValues[1]) {
        summaryValues[1].textContent = currentHealthyCount;
    }

    const providerList = modal.querySelector('.provider-list');
    if (providerList) {
        providerList.innerHTML = renderProviderList(currentProviders);
    }

    const shouldShowPagination = totalPages > 1;
    const paginationContainers = modal.querySelectorAll('.pagination-container');
    if (shouldShowPagination) {
        paginationContainers.forEach(container => {
            const position = container.getAttribute('data-position');
            container.outerHTML = renderPagination(currentPage, totalPages, currentFilteredCount, position);
        });

        if (paginationContainers.length === 0) {
            const providerListEl = modal.querySelector('.provider-list');
            if (providerListEl) {
                providerListEl.insertAdjacentHTML('beforebegin', renderPagination(currentPage, totalPages, currentFilteredCount, 'top'));
                providerListEl.insertAdjacentHTML('afterend', renderPagination(currentPage, totalPages, currentFilteredCount, 'bottom'));
            }
        }
    } else {
        paginationContainers.forEach(container => container.remove());
    }

    if (scrollToTop) {
        const modalBody = modal.querySelector('.provider-modal-body');
        if (modalBody) {
            modalBody.scrollTop = 0;
        }
    }

    const pageProviders = currentProviders;

    if (pageProviders.length === 0) {
        return;
    }

    if (cachedModels.length > 0) {
        pageProviders.forEach(provider => {
            renderNotSupportedModelsSelector(provider.uuid, cachedModels, provider.notSupportedModels || []);
        });
    } else {
        loadModelsForProviderType(currentProviderType, pageProviders);
    }
}

/**
 * 应用健康状态筛选并刷新列表
 * @param {string} healthFilter - 筛选类型 (all/healthy/unhealthy)
 * @param {boolean} resetPage - 是否重置到第一页
 * @param {boolean} scrollToTop - 是否滚动到顶部
 */
function applyProviderHealthFilter(healthFilter = 'all', resetPage = true, scrollToTop = true) {
    const validFilters = ['all', 'healthy', 'unhealthy'];
    currentHealthFilter = validFilters.includes(healthFilter) ? healthFilter : 'all';

    const modal = document.querySelector('.provider-modal');
    if (!modal) return;

    updateProviderFilterButtonsState(modal);
    updateProviderErrorTypeFilterState(modal);
    void goToProviderPage(resetPage ? 1 : currentPage, scrollToTop, true);
}

function applyProviderErrorTypeFilter(errorType = 'all', resetPage = true, scrollToTop = true) {
    currentErrorTypeFilter = normalizeErrorTypeFilter(errorType, 'all');

    const modal = document.querySelector('.provider-modal');
    if (!modal) return;

    updateProviderErrorTypeFilterState(modal);
    void goToProviderPage(resetPage ? 1 : currentPage, scrollToTop, true);
}

/**
 * 显示提供商管理模态框
 * @param {Object} data - 提供商数据
 */
function showProviderManagerModal(data) {
    if (data?.error) {
        showToast(t('common.error'), data.error.message || t('modal.provider.load.failed'), 'error');
        return;
    }
    if (!data || typeof data !== 'object' || typeof data.providerType !== 'string') {
        showToast(t('common.error'), t('modal.provider.load.failed'), 'error');
        return;
    }

    const providerType = data?.providerType || '';
    applyProviderModalPayload(data, { resetFilter: true });
    cachedModels = [];
    
    // 移除已存在的模态框
    const existingModal = document.querySelector('.provider-modal');
    if (existingModal) {
        // 清理事件监听器
        if (existingModal.cleanup) {
            existingModal.cleanup();
        }
        existingModal.remove();
    }
    
    const totalPages = Math.max(1, currentTotalPages);
    
    // 创建模态框
    const modal = document.createElement('div');
    modal.className = 'provider-modal';
    modal.setAttribute('data-provider-type', providerType);
    modal.innerHTML = `
        <div class="provider-modal-content">
            <div class="provider-modal-header">
                <h3 data-i18n="modal.provider.manage" data-i18n-params='{"type":"${providerType}"}'><i class="fas fa-cogs"></i> 管理 ${providerType} 提供商配置</h3>
                <button class="modal-close" onclick="window.closeProviderModal(this)">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="provider-modal-body">
                <div class="provider-summary">
                    <div class="provider-summary-item">
                        <span class="label" data-i18n="modal.provider.totalAccounts">总账户数:</span>
                        <span class="value">${currentTotalCount}</span>
                    </div>
                    <div class="provider-summary-item">
                        <span class="label" data-i18n="modal.provider.healthyAccounts">健康账户:</span>
                        <span class="value">${currentHealthyCount}</span>
                    </div>
                    <div class="provider-summary-actions">
                        <button class="btn btn-success" onclick="window.showAddProviderForm('${providerType}')">
                            <i class="fas fa-plus"></i> <span data-i18n="modal.provider.add">添加新提供商</span>
                        </button>
                        ${providerType === 'grok-custom' ? `
                        <button class="btn btn-primary" onclick="window.showGrokBatchImportModal('${providerType}')">
                            <i class="fas fa-file-import"></i> <span data-i18n="modal.provider.grokBatchImport">${t('modal.provider.grokBatchImport')}</span>
                        </button>
                        ` : ''}
                        <button class="btn btn-warning" onclick="window.resetAllProvidersHealth('${providerType}')" data-i18n="modal.provider.resetHealth" title="将所有节点的健康状态重置为健康">
                            <i class="fas fa-heartbeat"></i> 重置为健康
                        </button>
                        <button class="btn btn-info" onclick="window.performHealthCheck('${providerType}')" data-i18n="modal.provider.healthCheck" title="对不健康节点执行健康检测">
                            <i class="fas fa-stethoscope"></i> 检测不健康
                        </button>
                        <button class="btn btn-secondary btn-refresh-unhealthy-uuids" onclick="window.refreshUnhealthyUuids('${providerType}')" data-i18n="modal.provider.refreshUnhealthyUuids" title="刷新不健康节点的UUID">
                            <i class="fas fa-sync-alt"></i> <span data-i18n="modal.provider.refreshUnhealthyUuidsBtn">刷新UUID</span>
                        </button>
                        <button class="btn btn-danger" onclick="window.deleteUnhealthyProviders('${providerType}')" data-i18n="modal.provider.deleteUnhealthy" title="删除不健康节点">
                            <i class="fas fa-trash-alt"></i> <span data-i18n="modal.provider.deleteUnhealthyBtn">删除不健康</span>
                        </button>
                    </div>
                </div>

                <div class="provider-filter-bar">
                    <span class="provider-filter-label" data-i18n="modal.provider.filter.label">${t('modal.provider.filter.label')}</span>
                    <div class="provider-filter-actions">
                        <label class="provider-filter-select">
                            <span data-i18n="modal.provider.filter.errorType">${t('modal.provider.filter.errorType')}</span>
                            <select id="providerErrorTypeFilter" class="form-control" onchange="window.applyProviderErrorTypeFilter(this.value)">
                                <option value="all" data-i18n="modal.provider.deleteUnhealthy.errorType.all">${t('modal.provider.deleteUnhealthy.errorType.all')}</option>
                                <option value="auth" data-i18n="modal.provider.deleteUnhealthy.errorType.auth">${t('modal.provider.deleteUnhealthy.errorType.auth')}</option>
                                <option value="quota" data-i18n="modal.provider.deleteUnhealthy.errorType.quota">${t('modal.provider.deleteUnhealthy.errorType.quota')}</option>
                                <option value="timeout" data-i18n="modal.provider.deleteUnhealthy.errorType.timeout">${t('modal.provider.deleteUnhealthy.errorType.timeout')}</option>
                                <option value="network" data-i18n="modal.provider.deleteUnhealthy.errorType.network">${t('modal.provider.deleteUnhealthy.errorType.network')}</option>
                                <option value="other" data-i18n="modal.provider.deleteUnhealthy.errorType.other">${t('modal.provider.deleteUnhealthy.errorType.other')}</option>
                                <option value="unknown" data-i18n="modal.provider.deleteUnhealthy.errorType.unknown">${t('modal.provider.deleteUnhealthy.errorType.unknown')}</option>
                            </select>
                        </label>
                        <button class="provider-filter-btn active" data-filter="all" data-i18n="modal.provider.filter.all" onclick="window.applyProviderHealthFilter('all')">
                            ${t('modal.provider.filter.all')}
                        </button>
                        <button class="provider-filter-btn" data-filter="healthy" data-i18n="modal.provider.filter.healthy" onclick="window.applyProviderHealthFilter('healthy')">
                            ${t('modal.provider.filter.healthy')}
                        </button>
                        <button class="provider-filter-btn" data-filter="unhealthy" data-i18n="modal.provider.filter.unhealthy" onclick="window.applyProviderHealthFilter('unhealthy')">
                            ${t('modal.provider.filter.unhealthy')}
                        </button>
                    </div>
                </div>
                
                ${totalPages > 1 ? renderPagination(currentPage, totalPages, currentFilteredCount) : ''}
                
                <div class="provider-list" id="providerList">
                    ${renderProviderList(currentProviders)}
                </div>
                
                ${totalPages > 1 ? renderPagination(currentPage, totalPages, currentFilteredCount, 'bottom') : ''}
            </div>
        </div>
    `;
    
    // 添加到页面
    document.body.appendChild(modal);
    
    // 添加模态框事件监听
    addModalEventListeners(modal);
    updateProviderFilterButtonsState(modal);
    updateProviderErrorTypeFilterState(modal);
    
    // 先获取该提供商类型的模型列表（只调用一次API）
    const pageProviders = currentProviders;
    if (pageProviders.length > 0) {
        loadModelsForProviderType(providerType, pageProviders);
    }
}

/**
 * 渲染分页控件
 * @param {number} currentPage - 当前页码
 * @param {number} totalPages - 总页数
 * @param {number} totalItems - 总条目数
 * @param {string} position - 位置标识 (top/bottom)
 * @returns {string} HTML字符串
 */
function renderPagination(page, totalPages, totalItems, position = 'top') {
    const startItem = (page - 1) * PROVIDERS_PER_PAGE + 1;
    const endItem = Math.min(page * PROVIDERS_PER_PAGE, totalItems);
    
    // 生成页码按钮
    let pageButtons = '';
    const maxVisiblePages = 5;
    let startPage = Math.max(1, page - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    
    if (startPage > 1) {
        pageButtons += `<button class="page-btn" onclick="window.goToProviderPage(1)">1</button>`;
        if (startPage > 2) {
            pageButtons += `<span class="page-ellipsis">...</span>`;
        }
    }
    
    for (let i = startPage; i <= endPage; i++) {
        pageButtons += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="window.goToProviderPage(${i})">${i}</button>`;
    }
    
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            pageButtons += `<span class="page-ellipsis">...</span>`;
        }
        pageButtons += `<button class="page-btn" onclick="window.goToProviderPage(${totalPages})">${totalPages}</button>`;
    }
    
    return `
        <div class="pagination-container ${position}" data-position="${position}">
            <div class="pagination-info">
                <span data-i18n="pagination.showing" data-i18n-params='{"start":"${startItem}","end":"${endItem}","total":"${totalItems}"}'>显示 ${startItem}-${endItem} / 共 ${totalItems} 条</span>
            </div>
            <div class="pagination-controls">
                <button class="page-btn nav-btn" onclick="window.goToProviderPage(${page - 1})" ${page <= 1 ? 'disabled' : ''}>
                    <i class="fas fa-chevron-left"></i>
                </button>
                ${pageButtons}
                <button class="page-btn nav-btn" onclick="window.goToProviderPage(${page + 1})" ${page >= totalPages ? 'disabled' : ''}>
                    <i class="fas fa-chevron-right"></i>
                </button>
            </div>
            <div class="pagination-jump">
                <span data-i18n="pagination.jumpTo">跳转到</span>
                <input type="number" min="1" max="${totalPages}" value="${page}"
                       onkeypress="if(event.key==='Enter')window.goToProviderPage(parseInt(this.value))"
                       class="page-jump-input">
                <span data-i18n="pagination.page">页</span>
            </div>
        </div>
    `;
}

/**
 * 跳转到指定页
 * @param {number} page - 目标页码
 */
async function goToProviderPage(page, scrollToTop = true, forceReload = false) {
    const totalPages = Math.max(1, currentTotalPages);
    let targetPage = normalizePage(page, currentPage);
    if (targetPage < 1) targetPage = 1;
    if (targetPage > totalPages) targetPage = totalPages;

    const modal = document.querySelector('.provider-modal');
    if (!modal) return;

    if (!forceReload && targetPage === currentPage) {
        renderProviderListWithPagination(modal, { scrollToTop });
        return;
    }

    try {
        const data = await fetchProviderPage(currentProviderType, targetPage);
        applyProviderModalPayload(data);
        updateProviderFilterButtonsState(modal);
        updateProviderErrorTypeFilterState(modal);
        renderProviderListWithPagination(modal, { scrollToTop });
    } catch (error) {
        console.error('Failed to load provider page:', error);
        showToast(t('common.error'), `${t('modal.provider.load.failed')}: ${error.message}`, 'error');
    }
}

/**
 * 渲染分页后的提供商列表
 * @param {Array} providers - 提供商数组
 * @param {number} page - 当前页码
 * @returns {string} HTML字符串
 */
function renderProviderListPaginated(providers, page) {
    if (!Array.isArray(providers) || providers.length === 0) {
        return `
            <div class="provider-empty-state">
                <i class="fas fa-filter"></i>
                <span data-i18n="modal.provider.filter.empty">${t('modal.provider.filter.empty')}</span>
            </div>
        `;
    }

    const startIndex = (page - 1) * PROVIDERS_PER_PAGE;
    const endIndex = Math.min(startIndex + PROVIDERS_PER_PAGE, providers.length);
    const pageProviders = providers.slice(startIndex, endIndex);
    
    return renderProviderList(pageProviders);
}

/**
 * 为提供商类型加载模型列表（优化：只调用一次API，并缓存结果）
 * @param {string} providerType - 提供商类型
 * @param {Array} providers - 提供商列表
 */
async function loadModelsForProviderType(providerType, providers) {
    try {
        // 如果已有缓存，直接使用
        if (cachedModels.length > 0) {
            providers.forEach(provider => {
                renderNotSupportedModelsSelector(provider.uuid, cachedModels, provider.notSupportedModels || []);
            });
            return;
        }
        
        // 只调用一次API获取模型列表
        const response = await window.apiClient.get(`/provider-models/${encodeURIComponent(providerType)}`);
        const models = response.models || [];
        
        // 缓存模型列表
        cachedModels = models;
        
        // 为每个提供商渲染模型选择器
        providers.forEach(provider => {
            renderNotSupportedModelsSelector(provider.uuid, models, provider.notSupportedModels || []);
        });
    } catch (error) {
        console.error('Failed to load models for provider type:', error);
        // 如果加载失败，为每个提供商显示错误信息
        providers.forEach(provider => {
            const container = document.querySelector(`.not-supported-models-container[data-uuid="${provider.uuid}"]`);
            if (container) {
                container.innerHTML = `<div class="error-message">${t('common.error')}: 加载模型列表失败</div>`;
            }
        });
    }
}

/**
 * 为模态框添加事件监听器
 * @param {HTMLElement} modal - 模态框元素
 */
function addModalEventListeners(modal) {
    // ESC键关闭模态框
    const handleEscKey = (event) => {
        if (event.key === 'Escape') {
            modal.remove();
            document.removeEventListener('keydown', handleEscKey);
        }
    };
    
    // 点击背景关闭模态框
    const handleBackgroundClick = (event) => {
        if (event.target === modal) {
            modal.remove();
            document.removeEventListener('keydown', handleEscKey);
        }
    };
    
    // 防止模态框内容区域点击时关闭模态框
    const modalContent = modal.querySelector('.provider-modal-content');
    const handleContentClick = (event) => {
        event.stopPropagation();
    };
    
    // 密码切换按钮事件处理
    const handlePasswordToggleClick = (event) => {
        const button = event.target.closest('.password-toggle');
        if (button) {
            event.preventDefault();
            event.stopPropagation();
            handleProviderPasswordToggle(button);
        }
    };
    
    // 上传按钮事件处理
    const handleUploadButtonClick = (event) => {
        const button = event.target.closest('.upload-btn');
        if (button) {
            event.preventDefault();
            event.stopPropagation();
            const targetInputId = button.getAttribute('data-target');
            const providerType = modal.getAttribute('data-provider-type');
            if (targetInputId && window.fileUploadHandler) {
                window.fileUploadHandler.handleFileUpload(button, targetInputId, providerType);
            }
        }
    };
    
    // 添加事件监听器
    document.addEventListener('keydown', handleEscKey);
    modal.addEventListener('click', handleBackgroundClick);
    if (modalContent) {
        modalContent.addEventListener('click', handleContentClick);
        modalContent.addEventListener('click', handlePasswordToggleClick);
        modalContent.addEventListener('click', handleUploadButtonClick);
    }
    
    // 清理函数，在模态框关闭时调用
    modal.cleanup = () => {
        document.removeEventListener('keydown', handleEscKey);
        modal.removeEventListener('click', handleBackgroundClick);
        if (modalContent) {
            modalContent.removeEventListener('click', handleContentClick);
            modalContent.removeEventListener('click', handlePasswordToggleClick);
            modalContent.removeEventListener('click', handleUploadButtonClick);
        }
    };
}

/**
 * 关闭模态框并清理事件监听器
 * @param {HTMLElement} button - 关闭按钮
 */
function closeProviderModal(button) {
    const modal = button.closest('.provider-modal');
    if (modal) {
        if (modal.cleanup) {
            modal.cleanup();
        }
        modal.remove();
    }
}

/**
 * 渲染提供商列表
 * @param {Array} providers - 提供商数组
 * @returns {string} HTML字符串
 */
function renderProviderList(providers) {
    return providers.map(provider => {
        const isHealthy = provider.isHealthy;
        const isDisabled = provider.isDisabled || false;
        const lastUsed = provider.lastUsed ? new Date(provider.lastUsed).toLocaleString() : t('modal.provider.neverUsed');
        const lastHealthCheckTime = provider.lastHealthCheckTime ? new Date(provider.lastHealthCheckTime).toLocaleString() : t('modal.provider.neverChecked');
        const lastHealthCheckModel = provider.lastHealthCheckModel || '-';
        const healthClass = isHealthy ? 'healthy' : 'unhealthy';
        const disabledClass = isDisabled ? 'disabled' : '';
        const healthIcon = isHealthy ? 'fas fa-check-circle text-success' : 'fas fa-exclamation-triangle text-warning';
        const healthText = isHealthy ? t('modal.provider.status.healthy') : t('modal.provider.status.unhealthy');
        const disabledText = isDisabled ? t('modal.provider.status.disabled') : t('modal.provider.status.enabled');
        const disabledIcon = isDisabled ? 'fas fa-ban text-muted' : 'fas fa-play text-success';
        const toggleButtonText = isDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled');
        const toggleButtonIcon = isDisabled ? 'fas fa-play' : 'fas fa-ban';
        const toggleButtonClass = isDisabled ? 'btn-success' : 'btn-warning';
        
        // 构建错误信息显示
        let errorInfoHtml = '';
        if (!isHealthy && provider.lastErrorMessage) {
            const escapedErrorMsg = provider.lastErrorMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            errorInfoHtml = `
                <div class="provider-error-info">
                    <i class="fas fa-exclamation-circle text-danger"></i>
                    <span class="error-label" data-i18n="modal.provider.lastError">最后错误:</span>
                    <span class="error-message" title="${escapedErrorMsg}">${escapedErrorMsg}</span>
                </div>
            `;
        }
        
        return `
            <div class="provider-item-detail ${healthClass} ${disabledClass}" data-uuid="${provider.uuid}">
                <div class="provider-item-header" onclick="window.toggleProviderDetails('${provider.uuid}')">
                    <div class="provider-info">
                        <div class="provider-name">${provider.customName || provider.uuid}</div>
                        <div class="provider-meta">
                            <span class="health-status">
                                <i class="${healthIcon}"></i>
                                <span data-i18n="modal.provider.healthCheckLabel">健康状态</span>: <span data-i18n="${isHealthy ? 'modal.provider.status.healthy' : 'modal.provider.status.unhealthy'}">${healthText}</span>
                            </span> |
                            <span class="disabled-status">
                                <i class="${disabledIcon}"></i>
                                <span data-i18n="upload.detail.status">状态</span>: <span data-i18n="${isDisabled ? 'modal.provider.status.disabled' : 'modal.provider.status.enabled'}">${disabledText}</span>
                            </span> |
                            <span data-i18n="modal.provider.usageCount">使用次数</span>: ${provider.usageCount || 0} |
                            <span data-i18n="modal.provider.errorCount">失败次数</span>: ${provider.errorCount || 0} |
                            <span data-i18n="modal.provider.lastUsed">最后使用</span>: ${lastUsed}
                        </div>
                        <div class="provider-health-meta">
                            <span class="health-check-time">
                                <i class="fas fa-clock"></i>
                                <span data-i18n="modal.provider.lastCheck">最后检测</span>: ${lastHealthCheckTime}
                            </span> |
                            <span class="health-check-model">
                                <i class="fas fa-cube"></i>
                                <span data-i18n="modal.provider.checkModel">检测模型</span>: ${lastHealthCheckModel}
                            </span>
                        </div>
                        ${errorInfoHtml}
                    </div>
                    <div class="provider-actions-group">
                        <button class="btn-small ${toggleButtonClass}" onclick="window.toggleProviderStatus('${provider.uuid}', event)" title="${toggleButtonText}此提供商">
                            <i class="${toggleButtonIcon}"></i> ${toggleButtonText}
                        </button>
                        <button class="btn-small btn-edit" onclick="window.editProvider('${provider.uuid}', event)">
                            <i class="fas fa-edit"></i> <span data-i18n="modal.provider.edit">编辑</span>
                        </button>
                        <button class="btn-small btn-delete" onclick="window.deleteProvider('${provider.uuid}', event)">
                            <i class="fas fa-trash"></i> <span data-i18n="modal.provider.delete">删除</span>
                        </button>
                        <button class="btn-small btn-info" onclick="window.refreshProviderHealthStatus('${provider.uuid}', event)" title="${t('modal.provider.refreshHealth')}">
                            <i class="fas fa-stethoscope"></i>
                        </button>
                        <button class="btn-small btn-refresh-uuid" onclick="window.refreshProviderUuid('${provider.uuid}', event)" title="${t('modal.provider.refreshUuid')}">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                </div>
                <div class="provider-item-content" id="content-${provider.uuid}">
                    <div class="">
                        ${renderProviderConfig(provider)}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 渲染提供商配置
 * @param {Object} provider - 提供商对象
 * @returns {string} HTML字符串
 */
function renderProviderConfig(provider) {
    // 获取该提供商类型的所有字段定义（从 utils.js）
    const fieldConfigs = getProviderTypeFields(currentProviderType);
    
    // 获取字段显示顺序
    const fieldOrder = getFieldOrder(provider);
    
    // 先渲染基础配置字段（customName、checkModelName 和 checkHealth）
    let html = '<div class="form-grid">';
    const baseFields = ['customName', 'checkModelName', 'checkHealth', 'concurrencyLimit', 'queueLimit'];
    
    baseFields.forEach(fieldKey => {
        const displayLabel = getFieldLabel(fieldKey);
        const value = provider[fieldKey];
        const displayValue = (value !== undefined && value !== null) ? value : '';
        
        // 查找字段定义以获取 placeholder
        const fieldDef = fieldConfigs.find(f => f.id === fieldKey) || fieldConfigs.find(f => f.id.toUpperCase() === fieldKey.toUpperCase()) || {};
        const placeholder = fieldDef.placeholder || (fieldKey === 'customName' ? '节点自定义名称' : (fieldKey === 'checkModelName' ? '例如: gpt-3.5-turbo' : (fieldKey === 'concurrencyLimit' ? '最大并发, 默认0不限制' : (fieldKey === 'queueLimit' ? '最大队列, 默认0不限制' : ''))));
        
        // 如果是 customName 字段，使用普通文本输入框
        if (fieldKey === 'customName') {
            html += `
                <div class="config-item">
                    <label>${displayLabel}</label>
                    <input type="text"
                           value="${displayValue}"
                           readonly
                           data-config-key="${fieldKey}"
                           data-config-value="${(value !== undefined && value !== null) ? value : ''}"
                           placeholder="${placeholder}">
                </div>
            `;
        } else if (fieldKey === 'checkHealth') {
            // 如果没有值，默认为 false
            const actualValue = value !== undefined ? value : false;
            const isEnabled = actualValue === true || actualValue === 'true';
            html += `
                <div class="config-item">
                    <label>${displayLabel}</label>
                    <select class="form-control"
                            data-config-key="${fieldKey}"
                            data-config-value="${actualValue}"
                            disabled>
                        <option value="true" ${isEnabled ? 'selected' : ''} data-i18n="modal.provider.enabled">启用</option>
                        <option value="false" ${!isEnabled ? 'selected' : ''} data-i18n="modal.provider.disabled">禁用</option>
                    </select>
                </div>
            `;
        } else {
            // checkModelName 字段始终显示
            html += `
                <div class="config-item">
                    <label>${displayLabel}</label>
                    <input type="text"
                           value="${displayValue}"
                           readonly
                           data-config-key="${fieldKey}"
                           data-config-value="${(value !== undefined && value !== null) ? value : ''}"
                           placeholder="${placeholder}">
                </div>
            `;
        }
    });
    html += '</div>';
    
    // 渲染其他配置字段，每行2列
    const otherFields = fieldOrder.filter(key => !baseFields.includes(key));
    
    for (let i = 0; i < otherFields.length; i += 2) {
        html += '<div class="form-grid">';
        
        const field1Key = otherFields[i];
        const field1Label = getFieldLabel(field1Key);
        const field1Value = provider[field1Key];
        const field1IsPassword = field1Key.toLowerCase().includes('key') || field1Key.toLowerCase().includes('password');
        const field1IsOAuthFilePath = field1Key.includes('OAUTH_CREDS_FILE_PATH');
        const field1DisplayValue = field1IsPassword && field1Value ? '••••••••' : ((field1Value !== undefined && field1Value !== null) ? field1Value : '');
        const field1Def = fieldConfigs.find(f => f.id === field1Key) || fieldConfigs.find(f => f.id.toUpperCase() === field1Key.toUpperCase()) || {};
        
        if (field1IsPassword) {
            html += `
                <div class="config-item">
                    <label>${field1Label}</label>
                    <div class="password-input-wrapper">
                        <input type="password"
                               value="${field1DisplayValue}"
                               readonly
                               data-config-key="${field1Key}"
                               data-config-value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                               placeholder="${field1Def.placeholder || ''}">
                       <button type="button" class="password-toggle" data-target="${field1Key}">
                            <i class="fas fa-eye"></i>
                        </button>
                    </div>
                </div>
            `;
        } else if (field1IsOAuthFilePath) {
            // OAuth凭据文件路径字段，添加上传按钮
            const field1IsKiro = field1Key.includes('KIRO');
            html += `
                <div class="config-item">
                    <label>${field1Label}</label>
                    <div class="file-input-group">
                        <input type="text"
                               id="edit-${provider.uuid}-${field1Key}"
                               value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                               readonly
                               data-config-key="${field1Key}"
                               data-config-value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                               placeholder="${field1Def.placeholder || ''}">
                       <button type="button" class="btn btn-outline upload-btn" data-target="edit-${provider.uuid}-${field1Key}" aria-label="上传文件" disabled>
                            <i class="fas fa-upload"></i>
                        </button>
                    </div>
                    ${field1IsKiro ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
                </div>
            `;
        } else {
            html += `
                <div class="config-item">
                    <label>${field1Label}</label>
                    <input type="text"
                           value="${field1DisplayValue}"
                           readonly
                           data-config-key="${field1Key}"
                           data-config-value="${(field1Value !== undefined && field1Value !== null) ? field1Value : ''}"
                           placeholder="${field1Def.placeholder || ''}">
                </div>
            `;
        }
        
        // 如果有第二个字段
        if (i + 1 < otherFields.length) {
            const field2Key = otherFields[i + 1];
            const field2Label = getFieldLabel(field2Key);
            const field2Value = provider[field2Key];
            const field2IsPassword = field2Key.toLowerCase().includes('key') || field2Key.toLowerCase().includes('password');
            const field2IsOAuthFilePath = field2Key.includes('OAUTH_CREDS_FILE_PATH');
            const field2DisplayValue = field2IsPassword && field2Value ? '••••••••' : ((field2Value !== undefined && field2Value !== null) ? field2Value : '');
            const field2Def = fieldConfigs.find(f => f.id === field2Key) || fieldConfigs.find(f => f.id.toUpperCase() === field2Key.toUpperCase()) || {};
            
            if (field2IsPassword) {
                html += `
                    <div class="config-item">
                        <label>${field2Label}</label>
                        <div class="password-input-wrapper">
                            <input type="password"
                                   value="${field2DisplayValue}"
                                   readonly
                                   data-config-key="${field2Key}"
                                   data-config-value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                                   placeholder="${field2Def.placeholder || ''}">
                            <button type="button" class="password-toggle" data-target="${field2Key}">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                `;
            } else if (field2IsOAuthFilePath) {
                // OAuth凭据文件路径字段，添加上传按钮
                const field2IsKiro = field2Key.includes('KIRO');
                html += `
                    <div class="config-item">
                        <label>${field2Label}</label>
                        <div class="file-input-group">
                            <input type="text"
                                   id="edit-${provider.uuid}-${field2Key}"
                                   value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                                   readonly
                                   data-config-key="${field2Key}"
                                   data-config-value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                                   placeholder="${field2Def.placeholder || ''}">
                            <button type="button" class="btn btn-outline upload-btn" data-target="edit-${provider.uuid}-${field2Key}" aria-label="上传文件" disabled>
                                <i class="fas fa-upload"></i>
                            </button>
                        </div>
                        ${field2IsKiro ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
                    </div>
                `;
            } else {
                html += `
                    <div class="config-item">
                        <label>${field2Label}</label>
                        <input type="text"
                               value="${field2DisplayValue}"
                               readonly
                               data-config-key="${field2Key}"
                               data-config-value="${(field2Value !== undefined && field2Value !== null) ? field2Value : ''}"
                               placeholder="${field2Def.placeholder || ''}">
                    </div>
                `;
            }
        }
        
        html += '</div>';
    }
    
    // 添加 notSupportedModels 配置区域
    html += '<div class="form-grid full-width">';
    html += `
        <div class="config-item not-supported-models-section">
            <label>
                <i class="fas fa-ban"></i> <span data-i18n="modal.provider.unsupportedModels">不支持的模型</span>
                <span class="help-text" data-i18n="modal.provider.unsupportedModelsHelp">选择此提供商不支持的模型，系统会自动排除这些模型</span>
            </label>
            <div class="not-supported-models-container" data-uuid="${provider.uuid}">
                <div class="models-loading">
                    <i class="fas fa-spinner fa-spin"></i> <span data-i18n="modal.provider.loadingModels">加载模型列表...</span>
                </div>
            </div>
        </div>
    `;
    html += '</div>';
    
    return html;
}

/**
 * 获取字段显示顺序
 * @param {Object} provider - 提供商对象
 * @returns {Array} 字段键数组
 */
function getFieldOrder(provider) {
    const orderedFields = ['customName', 'checkModelName', 'checkHealth'];
    
    // 需要排除的内部状态字段
    const excludedFields = [
        'isHealthy', 'lastUsed', 'usageCount', 'errorCount', 'lastErrorTime',
        'uuid', 'isDisabled', 'lastHealthCheckTime', 'lastHealthCheckModel', 'lastErrorMessage',
        'notSupportedModels', 'refreshCount', 'needsRefresh', '_lastSelectionSeq'
    ];
    
    // 从 getProviderTypeFields 获取字段顺序映射
    const fieldOrderMap = {
        'openai-custom': ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
        'openaiResponses-custom': ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
        'claude-custom': ['CLAUDE_API_KEY', 'CLAUDE_BASE_URL'],
        'gemini-cli-oauth': ['PROJECT_ID', 'GEMINI_OAUTH_CREDS_FILE_PATH', 'GEMINI_BASE_URL'],
        'claude-kiro-oauth': ['KIRO_OAUTH_CREDS_FILE_PATH', 'KIRO_BASE_URL', 'KIRO_REFRESH_URL', 'KIRO_REFRESH_IDC_URL'],
        'openai-qwen-oauth': ['QWEN_OAUTH_CREDS_FILE_PATH', 'QWEN_BASE_URL', 'QWEN_OAUTH_BASE_URL'],
        'gemini-antigravity': ['PROJECT_ID', 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', 'ANTIGRAVITY_BASE_URL_DAILY', 'ANTIGRAVITY_BASE_URL_AUTOPUSH'],
        'openai-iflow': ['IFLOW_OAUTH_CREDS_FILE_PATH', 'IFLOW_BASE_URL'],
        'openai-codex-oauth': ['CODEX_OAUTH_CREDS_FILE_PATH', 'CODEX_EMAIL', 'CODEX_BASE_URL'],
        'grok-custom': ['GROK_COOKIE_TOKEN', 'GROK_CF_CLEARANCE', 'GROK_USER_AGENT', 'GROK_BASE_URL'],
        'forward-api': ['FORWARD_API_KEY', 'FORWARD_BASE_URL', 'FORWARD_HEADER_NAME', 'FORWARD_HEADER_VALUE_PREFIX']
    };
    
    // 尝试从全局或当前模态框上下文中推断提供商类型
    let providerType = currentProviderType;
    if (!providerType) {
        if (provider.OPENAI_API_KEY && provider.OPENAI_BASE_URL) {
            providerType = 'openai-custom';
        } else if (provider.CLAUDE_API_KEY && provider.CLAUDE_BASE_URL) {
            providerType = 'claude-custom';
        } else if (provider.GEMINI_OAUTH_CREDS_FILE_PATH) {
            providerType = 'gemini-cli-oauth';
        } else if (provider.KIRO_OAUTH_CREDS_FILE_PATH) {
            providerType = 'claude-kiro-oauth';
        } else if (provider.QWEN_OAUTH_CREDS_FILE_PATH) {
            providerType = 'openai-qwen-oauth';
        } else if (provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH) {
            providerType = 'gemini-antigravity';
        } else if (provider.IFLOW_OAUTH_CREDS_FILE_PATH) {
            providerType = 'openai-iflow';
        } else if (provider.CODEX_OAUTH_CREDS_FILE_PATH) {
            providerType = 'openai-codex-oauth';
        } else if (provider.GROK_COOKIE_TOKEN) {
            providerType = 'grok-custom';
        } else if (provider.FORWARD_API_KEY) {
            providerType = 'forward-api';
        }
    }

    // 获取该类型应该具有的所有字段（预定义顺序）
    const predefinedOrder = providerType ? (fieldOrderMap[providerType] || []) : [];
    
    // 获取当前对象中存在且不在预定义列表中的其他字段
    const otherFields = Object.keys(provider).filter(key =>
        !excludedFields.includes(key) &&
        !orderedFields.includes(key) &&
        !predefinedOrder.includes(key)
    );
    otherFields.sort();

    // 合并所有要显示的字段
    const allExpectedFields = [...orderedFields, ...predefinedOrder, ...otherFields];
    
    // 只有在字段确实存在于 provider 中，或者它是该提供商类型的预定义字段时才显示
    return allExpectedFields.filter(key =>
        provider.hasOwnProperty(key) || predefinedOrder.includes(key)
    );
    
    // 如果无法识别提供商类型，按字母顺序排序
    otherFields.sort();
    return [...orderedFields, ...otherFields].filter(key => provider.hasOwnProperty(key));
}

/**
 * 切换提供商详情显示
 * @param {string} uuid - 提供商UUID
 */
function toggleProviderDetails(uuid) {
    const content = document.getElementById(`content-${uuid}`);
    if (content) {
        content.classList.toggle('expanded');
    }
}

/**
 * 编辑提供商
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
function editProvider(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail');
    const configInputs = providerDetail.querySelectorAll('input[data-config-key]');
    const configSelects = providerDetail.querySelectorAll('select[data-config-key]');
    const content = providerDetail.querySelector(`#content-${uuid}`);
    
    // 如果还没有展开，则自动展开编辑框
    if (content && !content.classList.contains('expanded')) {
        toggleProviderDetails(uuid);
    }
    
    // 等待一小段时间让展开动画完成，然后切换输入框为可编辑状态
    setTimeout(() => {
        // 切换输入框为可编辑状态
        configInputs.forEach(input => {
            input.readOnly = false;
            if (input.type === 'password') {
                const actualValue = input.dataset.configValue;
                input.value = actualValue;
            }
        });
        
        // 启用文件上传按钮
        const uploadButtons = providerDetail.querySelectorAll('.upload-btn');
        uploadButtons.forEach(button => {
            button.disabled = false;
        });
        
        // 启用下拉选择框
        configSelects.forEach(select => {
            select.disabled = false;
        });
        
        // 启用模型复选框
        const modelCheckboxes = providerDetail.querySelectorAll('.model-checkbox');
        modelCheckboxes.forEach(checkbox => {
            checkbox.disabled = false;
        });
        
        // 添加编辑状态类
        providerDetail.classList.add('editing');
        
        // 替换编辑按钮为保存和取消按钮，不显示禁用/启用按钮
        const actionsGroup = providerDetail.querySelector('.provider-actions-group');
        
        actionsGroup.innerHTML = `
            <button class="btn-small btn-save" onclick="window.saveProvider('${uuid}', event)">
                <i class="fas fa-save"></i> <span data-i18n="modal.provider.save">保存</span>
            </button>
            <button class="btn-small btn-cancel" onclick="window.cancelEdit('${uuid}', event)">
                <i class="fas fa-times"></i> <span data-i18n="modal.provider.cancel">取消</span>
            </button>
        `;
    }, 100);
}

/**
 * 取消编辑
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
function cancelEdit(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail');
    const configInputs = providerDetail.querySelectorAll('input[data-config-key]');
    const configSelects = providerDetail.querySelectorAll('select[data-config-key]');
    
    // 恢复输入框为只读状态
    configInputs.forEach(input => {
        input.readOnly = true;
        const originalValue = input.dataset.configValue;
        // 恢复原始值
        if (input.type === 'password') {
            input.value = originalValue ? '••••••••' : '';
        } else {
            input.value = originalValue || '';
        }
    });
    
    // 禁用模型复选框
    const modelCheckboxes = providerDetail.querySelectorAll('.model-checkbox');
    modelCheckboxes.forEach(checkbox => {
        checkbox.disabled = true;
    });
    
    // 移除编辑状态类
    providerDetail.classList.remove('editing');
    
    // 禁用文件上传按钮
    const uploadButtons = providerDetail.querySelectorAll('.upload-btn');
    uploadButtons.forEach(button => {
        button.disabled = true;
    });
    
    // 禁用下拉选择框
    configSelects.forEach(select => {
        select.disabled = true;
        // 恢复原始值
        const originalValue = select.dataset.configValue;
        select.value = originalValue || '';
    });
    
    // 恢复原来的按钮布局
    const actionsGroup = providerDetail.querySelector('.provider-actions-group');
    const currentProvider = providerDetail.closest('.provider-modal').querySelector(`[data-uuid="${uuid}"]`);
    const isCurrentlyDisabled = currentProvider.classList.contains('disabled');
    const toggleButtonText = isCurrentlyDisabled ? t('modal.provider.enabled') : t('modal.provider.disabled');
    const toggleButtonIcon = isCurrentlyDisabled ? 'fas fa-play' : 'fas fa-ban';
    const toggleButtonClass = isCurrentlyDisabled ? 'btn-success' : 'btn-warning';
    
    actionsGroup.innerHTML = `
        <button class="btn-small ${toggleButtonClass}" onclick="window.toggleProviderStatus('${uuid}', event)" title="${toggleButtonText}此提供商">
            <i class="${toggleButtonIcon}"></i> ${toggleButtonText}
        </button>
        <button class="btn-small btn-edit" onclick="window.editProvider('${uuid}', event)">
            <i class="fas fa-edit"></i> <span data-i18n="modal.provider.edit">${t('modal.provider.edit')}</span>
        </button>
        <button class="btn-small btn-delete" onclick="window.deleteProvider('${uuid}', event)">
            <i class="fas fa-trash"></i> <span data-i18n="modal.provider.delete">${t('modal.provider.delete')}</span>
        </button>
        <button class="btn-small btn-info" onclick="window.refreshProviderHealthStatus('${uuid}', event)" title="${t('modal.provider.refreshHealth')}">
            <i class="fas fa-stethoscope"></i>
        </button>
        <button class="btn-small btn-refresh-uuid" onclick="window.refreshProviderUuid('${uuid}', event)" title="${t('modal.provider.refreshUuid')}">
            <i class="fas fa-sync-alt"></i>
        </button>
    `;
}

/**
 * 保存提供商
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function saveProvider(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    
    const configInputs = providerDetail.querySelectorAll('input[data-config-key]');
    const configSelects = providerDetail.querySelectorAll('select[data-config-key]');
    const providerConfig = {};
    
    configInputs.forEach(input => {
        const key = input.dataset.configKey;
        let value = input.value;
        if (key === 'concurrencyLimit' || key === 'queueLimit') {
            value = parseInt(value || '0');
        }
        providerConfig[key] = value;
    });
    
    configSelects.forEach(select => {
        const key = select.dataset.configKey;
        const value = select.value === 'true';
        providerConfig[key] = value;
    });
    
    // 收集不支持的模型列表
    const modelCheckboxes = providerDetail.querySelectorAll(`.model-checkbox[data-uuid="${uuid}"]:checked`);
    const notSupportedModels = Array.from(modelCheckboxes).map(checkbox => checkbox.value);
    providerConfig.notSupportedModels = notSupportedModels;
    
    try {
        await window.apiClient.put(`/providers/${encodeURIComponent(providerType)}/${uuid}`, { providerConfig });
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('modal.provider.save.success'), 'success');
        // 重新获取该提供商类型的最新配置
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to update provider:', error);
        showToast(t('common.error'), t('modal.provider.save.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 删除提供商
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function deleteProvider(uuid, event) {
    event.stopPropagation();
    
    if (!confirm(t('modal.provider.deleteConfirm'))) {
        return;
    }
    
    const providerDetail = event.target.closest('.provider-item-detail');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    
    try {
        await window.apiClient.delete(`/providers/${encodeURIComponent(providerType)}/${uuid}`);
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('modal.provider.delete.success'), 'success');
        // 重新获取最新配置
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to delete provider:', error);
        showToast(t('common.error'), t('modal.provider.delete.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 重新获取并刷新提供商配置
 * @param {string} providerType - 提供商类型
 */
async function refreshProviderConfig(providerType) {
    try {
        const targetPage = currentProviderType === providerType ? currentPage : 1;
        const data = await fetchProviderPage(providerType, targetPage);
        
        // 如果当前显示的是该提供商类型的模态框，则更新模态框
        const modal = document.querySelector('.provider-modal');
        if (modal && modal.getAttribute('data-provider-type') === providerType) {
            applyProviderModalPayload(data);
            updateProviderFilterButtonsState(modal);
            updateProviderErrorTypeFilterState(modal);
            renderProviderListWithPagination(modal, { scrollToTop: false });
        }
        
        // 同时更新主界面的提供商统计数据
        if (typeof window.loadProviders === 'function') {
            await window.loadProviders({ showLoading: false });
        }
        
    } catch (error) {
        console.error('Failed to refresh provider config:', error);
    }
}

/**
 * 显示添加提供商表单
 * @param {string} providerType - 提供商类型
 */
function showAddProviderForm(providerType) {
    const modal = document.querySelector('.provider-modal');
    const existingForm = modal.querySelector('.add-provider-form');
    
    if (existingForm) {
        existingForm.remove();
        return;
    }
    
    // Codex OAuth 只支持授权添加，不支持手动添加
    if (providerType === 'openai-codex-oauth') {
        const form = document.createElement('div');
        form.className = 'add-provider-form';
        form.innerHTML = `
            <h4 data-i18n="modal.provider.addTitle"><i class="fas fa-plus"></i> 添加新提供商配置</h4>
            <div class="oauth-only-notice" style="padding: 20px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; margin: 15px 0;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                    <i class="fas fa-info-circle" style="color: #d97706; font-size: 24px;"></i>
                    <strong style="color: #92400e;">Codex 仅支持 OAuth 授权添加</strong>
                </div>
                <p style="color: #b45309; margin: 0 0 15px 0;">
                    OpenAI Codex 需要通过 OAuth 授权获取访问令牌，无法手动填写凭据。请点击下方按钮进行授权。
                </p>
                <button class="btn btn-primary" onclick="window.handleGenerateAuthUrl && window.handleGenerateAuthUrl('openai-codex-oauth'); this.closest('.add-provider-form').remove();">
                    <i class="fas fa-key"></i> 开始 OAuth 授权
                </button>
                <button class="btn btn-secondary" style="margin-left: 10px;" onclick="this.closest('.add-provider-form').remove()">
                    <i class="fas fa-times"></i> <span data-i18n="modal.provider.cancel">取消</span>
                </button>
            </div>
        `;
        
        const providerList = modal.querySelector('.provider-list');
        providerList.parentNode.insertBefore(form, providerList);
        return;
    }
    
    const form = document.createElement('div');
    form.className = 'add-provider-form';
    form.innerHTML = `
        <h4 data-i18n="modal.provider.addTitle"><i class="fas fa-plus"></i> 添加新提供商配置</h4>
        <div class="form-grid">
            <div class="form-group">
                <label><span data-i18n="modal.provider.customName">自定义名称</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="text" id="newCustomName" data-i18n="modal.provider.customName" placeholder="例如: 我的节点1">
            </div>
            <div class="form-group">
                <label><span data-i18n="modal.provider.checkModelName">检查模型名称</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="text" id="newCheckModelName" data-i18n="modal.provider.checkModelName" placeholder="例如: gpt-3.5-turbo">
            </div>
            <div class="form-group">
                <label data-i18n="modal.provider.healthCheckLabel">健康检查</label>
                <select id="newCheckHealth">
                    <option value="false" data-i18n="modal.provider.disabled">禁用</option>
                    <option value="true" data-i18n="modal.provider.enabled">启用</option>
                </select>
            </div>
            <div class="form-group">
                <label><span data-i18n="modal.provider.concurrencyLimit">并发限制</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="number" id="newConcurrencyLimit" placeholder="默认0不限制">
            </div>
            <div class="form-group">
                <label><span data-i18n="modal.provider.queueLimit">队列限制</span> <span class="optional-mark" data-i18n="config.optional">(选填)</span></label>
                <input type="number" id="newQueueLimit" placeholder="默认0不限制">
            </div>
        </div>
        <div id="dynamicConfigFields">
            <!-- 动态配置字段将在这里显示 -->
        </div>
        <div class="form-actions" style="margin-top: 15px;">
            <button class="btn btn-success" onclick="window.addProvider('${providerType}')">
                <i class="fas fa-save"></i> <span data-i18n="modal.provider.save">保存</span>
            </button>
            <button class="btn btn-secondary" onclick="this.closest('.add-provider-form').remove()">
                <i class="fas fa-times"></i> <span data-i18n="modal.provider.cancel">取消</span>
            </button>
        </div>
    `;
    
    // 添加动态配置字段
    addDynamicConfigFields(form, providerType);
    
    // 为添加表单中的密码切换按钮绑定事件监听器
    bindAddFormPasswordToggleListeners(form);
    
    // 插入到提供商列表前面
    const providerList = modal.querySelector('.provider-list');
    providerList.parentNode.insertBefore(form, providerList);
}

/**
 * 显示 Grok SSO Token 批量导入对话框
 * @param {string} providerType - 提供商类型
 */
function showGrokBatchImportModal(providerType = 'grok-custom') {
    const existingModal = document.querySelector('.grok-batch-import-modal');
    if (existingModal) {
        existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay grok-batch-import-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 760px;">
            <div class="modal-header">
                <h3><i class="fas fa-file-import"></i> ${t('modal.provider.grokBatchImportTitle')}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <div style="margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af;">
                    <i class="fas fa-info-circle"></i> ${t('modal.provider.grokBatchImportDesc')}
                </div>

                <div class="form-group">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600;">${t('modal.provider.grokBatchImportTokensLabel')}</label>
                    <textarea id="grokBatchTokens" rows="8" style="width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-family: monospace; font-size: 13px; resize: vertical;" placeholder="${t('modal.provider.grokBatchImportTokensPlaceholder')}"></textarea>
                </div>
                <div style="margin-top: 8px; font-size: 12px; color: #64748b;">
                    ${t('modal.provider.grokBatchImportCount')} <strong id="grokBatchTokenCount">0</strong>
                </div>

                <div class="form-grid" style="margin-top: 16px;">
                    <div class="form-group">
                        <label>${t('modal.provider.grokBatchImportCustomPrefix')}</label>
                        <input type="text" id="grokBatchCustomPrefix" placeholder="${t('modal.provider.grokBatchImportCustomPrefixPlaceholder')}">
                    </div>
                    <div class="form-group">
                        <label>${t('modal.provider.checkModelName')} <span class="optional-mark">${t('config.optional')}</span></label>
                        <input type="text" id="grokBatchCheckModelName" placeholder="例如: grok-4">
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label>${t('modal.provider.healthCheckLabel')}</label>
                        <select id="grokBatchCheckHealth">
                            <option value="false">${t('modal.provider.disabled')}</option>
                            <option value="true">${t('modal.provider.enabled')}</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>${t('modal.provider.field.grokBaseUrl')} <span class="optional-mark">${t('config.optional')}</span></label>
                        <input type="text" id="grokBatchBaseUrl" placeholder="https://grok.com" value="https://grok.com">
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label>${t('modal.provider.field.cfClearance')} <span class="optional-mark">${t('config.optional')}</span></label>
                        <input type="text" id="grokBatchCfClearance" placeholder="cf_clearance cookie value">
                    </div>
                    <div class="form-group">
                        <label>${t('modal.provider.field.userAgent')} <span class="optional-mark">${t('config.optional')}</span></label>
                        <input type="text" id="grokBatchUserAgent" placeholder="Mozilla/5.0 ...">
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label>${t('modal.provider.concurrencyLimit')} <span class="optional-mark">${t('config.optional')}</span></label>
                        <input type="number" id="grokBatchConcurrencyLimit" value="0" min="0">
                    </div>
                    <div class="form-group">
                        <label>${t('modal.provider.queueLimit')} <span class="optional-mark">${t('config.optional')}</span></label>
                        <input type="number" id="grokBatchQueueLimit" value="0" min="0">
                    </div>
                </div>

                <div id="grokBatchResult" style="display: none; margin-top: 16px; padding: 12px; border-radius: 8px;"></div>
            </div>
            <div class="modal-footer">
                <button class="modal-cancel">${t('modal.provider.cancel')}</button>
                <button class="btn btn-primary" id="grokBatchSubmit">
                    <i class="fas fa-upload"></i> ${t('modal.provider.grokBatchImportStart')}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('.modal-cancel');
    const submitBtn = modal.querySelector('#grokBatchSubmit');
    const textarea = modal.querySelector('#grokBatchTokens');
    const tokenCountEl = modal.querySelector('#grokBatchTokenCount');
    const resultEl = modal.querySelector('#grokBatchResult');

    const normalizeToken = (token) => {
        const trimmed = token.trim();
        return trimmed.startsWith('sso=') ? trimmed.slice(4).trim() : trimmed;
    };

    const getTokens = () => {
        return textarea.value
            .split(/\r?\n/)
            .map(line => normalizeToken(line))
            .filter(Boolean);
    };

    const updateTokenCount = () => {
        tokenCountEl.textContent = String(getTokens().length);
    };

    textarea.addEventListener('input', updateTokenCount);
    updateTokenCount();

    [closeBtn, cancelBtn].forEach(btn => {
        btn.addEventListener('click', () => {
            modal.remove();
        });
    });

    submitBtn.addEventListener('click', async () => {
        const tokens = getTokens();
        if (tokens.length === 0) {
            showToast(t('common.warning'), t('modal.provider.grokBatchImportNoTokens'), 'warning');
            return;
        }

        const commonConfig = {
            customNamePrefix: modal.querySelector('#grokBatchCustomPrefix')?.value?.trim() || '',
            checkModelName: modal.querySelector('#grokBatchCheckModelName')?.value?.trim() || '',
            checkHealth: modal.querySelector('#grokBatchCheckHealth')?.value === 'true',
            GROK_BASE_URL: modal.querySelector('#grokBatchBaseUrl')?.value?.trim() || 'https://grok.com',
            GROK_CF_CLEARANCE: modal.querySelector('#grokBatchCfClearance')?.value?.trim() || '',
            GROK_USER_AGENT: modal.querySelector('#grokBatchUserAgent')?.value?.trim() || '',
            concurrencyLimit: parseInt(modal.querySelector('#grokBatchConcurrencyLimit')?.value || '0', 10),
            queueLimit: parseInt(modal.querySelector('#grokBatchQueueLimit')?.value || '0', 10)
        };

        textarea.disabled = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('modal.provider.grokBatchImporting')}`;

        try {
            const response = await window.apiClient.post('/grok/batch-import-tokens', {
                ssoTokens: tokens,
                commonConfig
            });

            const successCount = response.successCount || 0;
            const failedCount = response.failedCount || 0;

            if (successCount > 0) {
                await window.apiClient.post('/reload-config');
                await refreshProviderConfig(providerType);
            }

            resultEl.style.display = 'block';
            const failedDetails = (response.details || []).filter(item => !item.success);
            const failedText = failedDetails
                .slice(0, 8)
                .map(item => `#${item.index}: ${item.error}`)
                .join('<br>');

            if (successCount > 0 && failedCount === 0) {
                resultEl.style.cssText = 'display:block; margin-top:16px; padding:12px; border-radius:8px; background:#f0fdf4; border:1px solid #bbf7d0; color:#166534;';
                resultEl.innerHTML = `<i class="fas fa-check-circle"></i> ${t('modal.provider.grokBatchImportSuccess', { count: successCount })}`;
                showToast(t('common.success'), t('modal.provider.grokBatchImportSuccess', { count: successCount }), 'success');
            } else if (successCount > 0 && failedCount > 0) {
                resultEl.style.cssText = 'display:block; margin-top:16px; padding:12px; border-radius:8px; background:#fffbeb; border:1px solid #fde68a; color:#92400e;';
                resultEl.innerHTML = `
                    <i class="fas fa-exclamation-triangle"></i> ${t('modal.provider.grokBatchImportPartial', { success: successCount, failed: failedCount })}
                    ${failedText ? `<div style="margin-top:8px; font-size:12px; line-height:1.6;">${failedText}</div>` : ''}
                `;
                showToast(t('common.warning'), t('modal.provider.grokBatchImportPartial', { success: successCount, failed: failedCount }), 'warning');
            } else {
                resultEl.style.cssText = 'display:block; margin-top:16px; padding:12px; border-radius:8px; background:#fef2f2; border:1px solid #fecaca; color:#991b1b;';
                resultEl.innerHTML = `
                    <i class="fas fa-times-circle"></i> ${t('modal.provider.grokBatchImportFailed', { count: failedCount })}
                    ${failedText ? `<div style="margin-top:8px; font-size:12px; line-height:1.6;">${failedText}</div>` : ''}
                `;
                showToast(t('common.error'), t('modal.provider.grokBatchImportFailed', { count: failedCount }), 'error');
            }
        } catch (error) {
            console.error('Grok 批量导入失败:', error);
            resultEl.style.display = 'block';
            resultEl.style.cssText = 'display:block; margin-top:16px; padding:12px; border-radius:8px; background:#fef2f2; border:1px solid #fecaca; color:#991b1b;';
            resultEl.innerHTML = `<i class="fas fa-times-circle"></i> ${t('modal.provider.grokBatchImportFailed', { count: 0 })}: ${error.message}`;
            showToast(t('common.error'), t('modal.provider.grokBatchImportFailed', { count: 0 }) + `: ${error.message}`, 'error');
        } finally {
            textarea.disabled = false;
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fas fa-upload"></i> ${t('modal.provider.grokBatchImportStart')}`;
        }
    });
}

/**
 * 添加动态配置字段
 * @param {HTMLElement} form - 表单元素
 * @param {string} providerType - 提供商类型
 */
function addDynamicConfigFields(form, providerType) {
    const configFields = form.querySelector('#dynamicConfigFields');
    
    // 获取该提供商类型的字段配置（已经在 utils.js 中包含了 URL 字段）
    const allFields = getProviderTypeFields(providerType);
    
    // 过滤掉已经在 form-grid 中硬编码显示的五个基础字段，避免重复
    const baseFields = ['customName', 'checkModelName', 'checkHealth', 'concurrencyLimit', 'queueLimit'];
    const filteredFields = allFields.filter(f => !baseFields.some(bf => f.id.toLowerCase().includes(bf.toLowerCase())));

    let fields = '';
    
    if (filteredFields.length > 0) {
        // 分组显示，每行两个字段
        for (let i = 0; i < filteredFields.length; i += 2) {
            fields += '<div class="form-grid">';
            
            const field1 = filteredFields[i];
            // 检查是否为密码类型字段
            const isPassword1 = field1.type === 'password';
            // 检查是否为OAuth凭据文件路径字段（兼容两种命名方式）
            const isOAuthFilePath1 = field1.id.includes('OAUTH_CREDS_FILE_PATH') || field1.id.includes('OauthCredsFilePath');
            
            if (isPassword1) {
                fields += `
                    <div class="form-group">
                        <label>${field1.label}</label>
                        <div class="password-input-wrapper">
                            <input type="password" id="new${field1.id}" placeholder="${field1.placeholder || ''}" value="${field1.value || ''}">
                            <button type="button" class="password-toggle" data-target="new${field1.id}">
                                <i class="fas fa-eye"></i>
                            </button>
                        </div>
                    </div>
                `;
            } else if (isOAuthFilePath1) {
                // OAuth凭据文件路径字段，添加上传按钮
                const isKiroField = field1.id.includes('KIRO');
    fields += `
        <div class="form-group">
            <label>${field1.label}</label>
            <div class="file-input-group">
                <input type="text" id="new${field1.id}" class="form-control" placeholder="${field1.placeholder || ''}" value="${field1.value || ''}">
                <button type="button" class="btn btn-outline upload-btn" data-target="new${field1.id}" aria-label="上传文件">
                    <i class="fas fa-upload"></i>
                </button>
            </div>
            ${isKiroField ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
        </div>
    `;
            } else {
                fields += `
                    <div class="form-group">
                        <label>${field1.label}</label>
                        <input type="${field1.type}" id="new${field1.id}" placeholder="${field1.placeholder || ''}" value="${field1.value || ''}">
                    </div>
                `;
            }
            
            const field2 = filteredFields[i + 1];
            if (field2) {
                // 检查是否为密码类型字段
                const isPassword2 = field2.type === 'password';
                // 检查是否为OAuth凭据文件路径字段（兼容两种命名方式）
                const isOAuthFilePath2 = field2.id.includes('OAUTH_CREDS_FILE_PATH') || field2.id.includes('OauthCredsFilePath');
                
                if (isPassword2) {
                    fields += `
                        <div class="form-group">
                            <label>${field2.label}</label>
                            <div class="password-input-wrapper">
                                <input type="password" id="new${field2.id}" placeholder="${field2.placeholder || ''}" value="${field2.value || ''}">
                                <button type="button" class="password-toggle" data-target="new${field2.id}">
                                    <i class="fas fa-eye"></i>
                                </button>
                            </div>
                        </div>
                    `;
                } else if (isOAuthFilePath2) {
                    // OAuth凭据文件路径字段，添加上传按钮
                    const isKiroField = field2.id.includes('KIRO');
    fields += `
        <div class="form-group">
            <label>${field2.label}</label>
            <div class="file-input-group">
                <input type="text" id="new${field2.id}" class="form-control" placeholder="${field2.placeholder || ''}" value="${field2.value || ''}">
                <button type="button" class="btn btn-outline upload-btn" data-target="new${field2.id}" aria-label="上传文件">
                    <i class="fas fa-upload"></i>
                </button>
            </div>
            ${isKiroField ? '<small class="form-text"><i class="fas fa-info-circle"></i> ' + t('modal.provider.kiroAuthHint') + '</small>' : ''}
        </div>
    `;
                } else {
                    fields += `
                        <div class="form-group">
                            <label>${field2.label}</label>
                            <input type="${field2.type}" id="new${field2.id}" placeholder="${field2.placeholder || ''}" value="${field2.value || ''}">
                        </div>
                    `;
                }
            }
            
            fields += '</div>';
        }
    } else {
        fields = `<p data-i18n="modal.provider.noProviderType">${t('modal.provider.noProviderType')}</p>`;
    }
    
    configFields.innerHTML = fields;
}

/**
 * 为添加新提供商表单中的密码切换按钮绑定事件监听器
 * @param {HTMLElement} form - 表单元素
 */
function bindAddFormPasswordToggleListeners(form) {
    const passwordToggles = form.querySelectorAll('.password-toggle');
    passwordToggles.forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            const input = document.getElementById(targetId);
            const icon = this.querySelector('i');
            
            if (!input || !icon) return;
            
            if (input.type === 'password') {
                input.type = 'text';
                icon.className = 'fas fa-eye-slash';
            } else {
                input.type = 'password';
                icon.className = 'fas fa-eye';
            }
        });
    });
}

/**
 * 添加新提供商
 * @param {string} providerType - 提供商类型
 */
async function addProvider(providerType) {
    const customName = document.getElementById('newCustomName')?.value;
    const checkModelName = document.getElementById('newCheckModelName')?.value;
    const checkHealth = document.getElementById('newCheckHealth')?.value === 'true';
    const concurrencyLimit = parseInt(document.getElementById('newConcurrencyLimit')?.value || '0');
    const queueLimit = parseInt(document.getElementById('newQueueLimit')?.value || '0');
    
    const providerConfig = {
        customName: customName || '', // 允许为空
        checkModelName: checkModelName || '', // 允许为空
        checkHealth,
        concurrencyLimit,
        queueLimit
    };
    
    // 根据提供商类型动态收集配置字段（自动匹配 utils.js 中的定义）
    const allFields = getProviderTypeFields(providerType);
    allFields.forEach(field => {
        const element = document.getElementById(`new${field.id}`);
        if (element) {
            providerConfig[field.id] = element.value || '';
        }
    });
    
    try {
        await window.apiClient.post('/providers', {
            providerType,
            providerConfig
        });
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('modal.provider.add.success'), 'success');
        // 移除添加表单
        const form = document.querySelector('.add-provider-form');
        if (form) {
            form.remove();
        }
        // 重新获取最新配置数据
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to add provider:', error);
        showToast(t('common.error'), t('modal.provider.add.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 切换提供商禁用/启用状态
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function toggleProviderStatus(uuid, event) {
    event.stopPropagation();
    
    const providerDetail = event.target.closest('.provider-item-detail');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');
    const currentProvider = providerDetail.closest('.provider-modal').querySelector(`[data-uuid="${uuid}"]`);
    
    // 获取当前提供商信息
    const isCurrentlyDisabled = currentProvider.classList.contains('disabled');
    const action = isCurrentlyDisabled ? 'enable' : 'disable';
    const confirmMessage = isCurrentlyDisabled ?
        t('modal.provider.enableConfirm') :
        t('modal.provider.disableConfirm');
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    try {
        await window.apiClient.post(`/providers/${encodeURIComponent(providerType)}/${uuid}/${action}`, { action });
        await window.apiClient.post('/reload-config');
        showToast(t('common.success'), t('common.success'), 'success');
        // 重新获取该提供商类型的最新配置
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('Failed to toggle provider status:', error);
        showToast(t('common.error'), t('common.error') + ': ' + error.message, 'error');
    }
}

/**
 * 重置所有提供商的健康状态
 * @param {string} providerType - 提供商类型
 */
async function resetAllProvidersHealth(providerType) {
    if (!confirm(t('modal.provider.resetHealthConfirm', {type: providerType}))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.resetHealth') + '...', 'info');
        
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/reset-health`,
            {}
        );
        
        if (response.success) {
            showToast(t('common.success'), t('modal.provider.resetHealth.success', { count: response.resetCount }), 'success');
            
            // 重新加载配置
            await window.apiClient.post('/reload-config');
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.resetHealth.failed'), 'error');
        }
    } catch (error) {
        console.error('重置健康状态失败:', error);
        showToast(t('common.error'), t('modal.provider.resetHealth.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 执行健康检测
 * @param {string} providerType - 提供商类型
 */
async function performHealthCheck(providerType) {
    if (!confirm(t('modal.provider.healthCheckConfirm', {type: providerType}))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.healthCheck') + '...', 'info');
        
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/health-check`,
            {}
        );
        
        if (response.success) {
            const { successCount, failCount, totalCount, results } = response;
            
            // 统计跳过的数量（checkHealth 未启用的）
            const skippedCount = results ? results.filter(r => r.success === null).length : 0;
            
            let message = `${t('modal.provider.healthCheck.complete', { success: successCount })}`;
            if (failCount > 0) message += t('modal.provider.healthCheck.abnormal', { fail: failCount });
            if (skippedCount > 0) message += t('modal.provider.healthCheck.skipped', { skipped: skippedCount });
            
            showToast(t('common.info'), message, failCount > 0 ? 'warning' : 'success');
            
            // 重新加载配置
            await window.apiClient.post('/reload-config');
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.healthCheck') + ' ' + t('common.error'), 'error');
        }
    } catch (error) {
        console.error('健康检测失败:', error);
        showToast(t('common.error'), t('modal.provider.healthCheck') + ' ' + t('common.error') + ': ' + error.message, 'error');
    }
}

/**
 * 刷新提供商UUID
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function executeRefreshProviderUuidAction({
    uuid,
    providerType,
    apiClient = window.apiClient,
    confirmFn = (message) => confirm(message),
    notify = showToast,
    translate = t,
    reloadConfigFn = async () => await apiClient.post('/reload-config'),
    refreshProviderConfigFn = refreshProviderConfig
} = {}) {
    if (!uuid || !providerType) {
        throw new Error('providerType and uuid are required');
    }

    if (!confirmFn(translate('modal.provider.refreshUuidConfirm', { oldUuid: uuid }))) {
        return { skipped: true };
    }

    const response = await apiClient.post(
        `/providers/${encodeURIComponent(providerType)}/${uuid}/refresh-uuid`,
        {}
    );

    if (response.success) {
        notify(translate('common.success'), translate('modal.provider.refreshUuid.success', { oldUuid: response.oldUuid, newUuid: response.newUuid }), 'success');
        await reloadConfigFn();
        await refreshProviderConfigFn(providerType);
        return response;
    }

    notify(translate('common.error'), translate('modal.provider.refreshUuid.failed'), 'error');
    return response;
}

/**
 * 刷新提供商UUID
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function refreshProviderUuid(uuid, event) {
    event.stopPropagation();

    const providerDetail = event.target.closest('.provider-item-detail');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');

    try {
        await executeRefreshProviderUuidAction({
            uuid,
            providerType
        });
    } catch (error) {
        console.error('刷新uuid失败:', error);
        showToast(t('common.error'), t('modal.provider.refreshUuid.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 刷新单个提供商健康状态
 * @param {string} uuid - 提供商UUID
 * @param {Event} event - 事件对象
 */
async function refreshProviderHealthStatus(uuid, event) {
    event.stopPropagation();

    const providerDetail = event.target.closest('.provider-item-detail');
    const providerType = providerDetail.closest('.provider-modal').getAttribute('data-provider-type');

    if (!confirm(t('modal.provider.refreshHealthConfirm', { uuid }))) {
        return;
    }

    try {
        showToast(t('common.info'), t('modal.provider.refreshHealth.running'), 'info');

        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/${uuid}/health-check`,
            {}
        );

        const result = response?.result || null;
        if (!response?.success) {
            showToast(t('common.error'), t('modal.provider.refreshHealth.failed'), 'error');
            return;
        }

        if (result?.success === true) {
            showToast(t('common.success'), t('modal.provider.refreshHealth.success'), 'success');
        } else if (result?.success === false) {
            const errorMessage = result.message || t('common.error');
            showToast(t('common.warning'), t('modal.provider.refreshHealth.unhealthy') + `: ${errorMessage}`, 'warning');
        } else {
            showToast(t('common.info'), result?.message || t('modal.provider.refreshHealth.notSupported'), 'info');
        }

        await window.apiClient.post('/reload-config');
        await refreshProviderConfig(providerType);
    } catch (error) {
        console.error('刷新健康状态失败:', error);
        showToast(t('common.error'), t('modal.provider.refreshHealth.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 删除所有不健康的提供商节点
 * @param {string} providerType - 提供商类型
 */
async function deleteUnhealthyProviders(providerType) {
    // 先获取不健康节点数量
    const selectedErrorType = normalizeErrorTypeFilter(currentErrorTypeFilter, 'all');
    const unhealthyCount = getUnhealthyCountEstimateByErrorType(selectedErrorType);
    
    if (unhealthyCount === 0) {
        showToast(t('common.info'), t('modal.provider.deleteUnhealthy.noUnhealthy'), 'info');
        return;
    }
    
    const errorTypeLabel = getDeleteUnhealthyErrorTypeLabel(selectedErrorType);
    const confirmKey = selectedErrorType !== 'all'
        ? 'modal.provider.deleteUnhealthyConfirmByError'
        : 'modal.provider.deleteUnhealthyConfirm';
    const confirmPayload = selectedErrorType !== 'all'
        ? { type: providerType, count: unhealthyCount, errorType: errorTypeLabel }
        : { type: providerType, count: unhealthyCount };
    if (!confirm(t(confirmKey, confirmPayload))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.deleteUnhealthy.deleting'), 'info');
        
        const response = await window.apiClient.delete(
            `/providers/${encodeURIComponent(providerType)}/delete-unhealthy${selectedErrorType !== 'all' ? `?errorType=${encodeURIComponent(selectedErrorType)}` : ''}`
        );
        
        if (response.success) {
            showToast(
                t('common.success'),
                t('modal.provider.deleteUnhealthy.success', { count: response.deletedCount }),
                'success'
            );
            
            const deletedCount = Number(response.deletedCount) || 0;

            if (deletedCount > 0) {
                // 立即从弹窗列表中移除已删除节点，避免必须关闭再打开
                const deletedUuids = new Set((response.deletedProviders || []).map((item) => item?.uuid).filter(Boolean));

                if (deletedUuids.size > 0) {
                    allProviders = allProviders.filter((provider) => !deletedUuids.has(provider?.uuid));
                } else {
                    if (selectedErrorType === 'all') {
                        allProviders = allProviders.filter((provider) => provider?.isHealthy === true);
                    } else {
                        allProviders = allProviders.filter((provider) => {
                            if (provider?.isHealthy === true) {
                                return true;
                            }
                            return classifyProviderErrorType(provider) !== selectedErrorType;
                        });
                    }
                }

                currentTotalCount = Math.max(0, currentTotalCount - deletedCount);
                currentHealthyCount = allProviders.filter((provider) => provider?.isHealthy === true && !provider?.isDisabled).length;
                currentFilteredCount = allProviders.length;
            }

            // 刷新主列表和弹窗内分页
            await refreshProviderConfig(providerType);

            if (deletedCount > 0) {
                // 删除后自动切到全部视图，避免筛选导致“空页但实际还有数据”
                applyProviderHealthFilter('all', true, false);
            }
        } else {
            showToast(t('common.error'), t('modal.provider.deleteUnhealthy.failed'), 'error');
        }
    } catch (error) {
        console.error('删除不健康节点失败:', error);
        showToast(t('common.error'), t('modal.provider.deleteUnhealthy.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 批量刷新不健康节点的UUID
 * @param {string} providerType - 提供商类型
 */
async function refreshUnhealthyUuids(providerType) {
    // 先获取不健康节点数量
    const unhealthyCount = getUnhealthyCountEstimate();
    
    if (unhealthyCount === 0) {
        showToast(t('common.info'), t('modal.provider.refreshUnhealthyUuids.noUnhealthy'), 'info');
        return;
    }
    
    if (!confirm(t('modal.provider.refreshUnhealthyUuidsConfirm', { type: providerType, count: unhealthyCount }))) {
        return;
    }
    
    try {
        showToast(t('common.info'), t('modal.provider.refreshUnhealthyUuids.refreshing'), 'info');
        
        const response = await window.apiClient.post(
            `/providers/${encodeURIComponent(providerType)}/refresh-unhealthy-uuids`
        );
        
        if (response.success) {
            showToast(
                t('common.success'),
                t('modal.provider.refreshUnhealthyUuids.success', { count: response.refreshedCount }),
                'success'
            );
            
            // 重新加载配置
            await window.apiClient.post('/reload-config');
            
            // 刷新提供商配置显示
            await refreshProviderConfig(providerType);
        } else {
            showToast(t('common.error'), t('modal.provider.refreshUnhealthyUuids.failed'), 'error');
        }
    } catch (error) {
        console.error('刷新不健康节点UUID失败:', error);
        showToast(t('common.error'), t('modal.provider.refreshUnhealthyUuids.failed') + ': ' + error.message, 'error');
    }
}

/**
 * 渲染不支持的模型选择器（不调用API，直接使用传入的模型列表）
 * @param {string} uuid - 提供商UUID
 * @param {Array} models - 模型列表
 * @param {Array} notSupportedModels - 当前不支持的模型列表
 */
function renderNotSupportedModelsSelector(uuid, models, notSupportedModels = []) {
    const container = document.querySelector(`.not-supported-models-container[data-uuid="${uuid}"]`);
    if (!container) return;
    
    if (models.length === 0) {
        container.innerHTML = `<div class="no-models" data-i18n="modal.provider.noModels">${t('modal.provider.noModels')}</div>`;
        return;
    }
    
    // 渲染模型复选框列表
    let html = '<div class="models-checkbox-grid">';
    models.forEach(model => {
        const isChecked = notSupportedModels.includes(model);
        html += `
            <label class="model-checkbox-label">
                <input type="checkbox"
                       class="model-checkbox"
                       value="${model}"
                       data-uuid="${uuid}"
                       ${isChecked ? 'checked' : ''}
                       disabled>
                <span class="model-name">${model}</span>
            </label>
        `;
    });
    html += '</div>';
    
    container.innerHTML = html;
}

// 导出所有函数，并挂载到window对象供HTML调用
export {
    showProviderManagerModal,
    closeProviderModal,
    toggleProviderDetails,
    editProvider,
    cancelEdit,
    saveProvider,
    deleteProvider,
    refreshProviderConfig,
    showAddProviderForm,
    addProvider,
    toggleProviderStatus,
    resetAllProvidersHealth,
    performHealthCheck,
    deleteUnhealthyProviders,
    refreshUnhealthyUuids,
    showGrokBatchImportModal,
    loadModelsForProviderType,
    renderNotSupportedModelsSelector,
    renderPagination,
    renderProviderListPaginated,
    renderProviderList,
    goToProviderPage,
    applyProviderHealthFilter,
    applyProviderErrorTypeFilter,
    executeRefreshProviderUuidAction,
    refreshProviderUuid,
    refreshProviderHealthStatus
};

// 将函数挂载到window对象
window.closeProviderModal = closeProviderModal;
window.toggleProviderDetails = toggleProviderDetails;
window.editProvider = editProvider;
window.cancelEdit = cancelEdit;
window.saveProvider = saveProvider;
window.deleteProvider = deleteProvider;
window.showAddProviderForm = showAddProviderForm;
window.addProvider = addProvider;
window.toggleProviderStatus = toggleProviderStatus;
window.resetAllProvidersHealth = resetAllProvidersHealth;
window.performHealthCheck = performHealthCheck;
window.deleteUnhealthyProviders = deleteUnhealthyProviders;
window.refreshUnhealthyUuids = refreshUnhealthyUuids;
window.showGrokBatchImportModal = showGrokBatchImportModal;
window.goToProviderPage = goToProviderPage;
window.applyProviderHealthFilter = applyProviderHealthFilter;
window.applyProviderErrorTypeFilter = applyProviderErrorTypeFilter;
window.refreshProviderUuid = refreshProviderUuid;
window.refreshProviderHealthStatus = refreshProviderHealthStatus;
