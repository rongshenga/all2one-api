// 用量管理模块

import { showToast } from './utils.js';
import { getAuthHeaders } from './auth.js';
import { t, getCurrentLanguage } from './i18n.js';

/**
 * 不支持显示用量数据的提供商列表
 * 这些提供商只显示模型名称和重置时间，不显示用量数字和进度条
 */
const PROVIDERS_WITHOUT_USAGE_DISPLAY = [
    'gemini-antigravity'
];

// 提供商配置缓存
let currentProviderConfigs = null;
// 正在刷新中的提供商，避免重复触发
const refreshingProviders = new Set();
const usageProviderDetailsPromises = new Map();
const usageProviderRefreshStates = new Map();
const usageProviderRefreshWatchers = new Map();
let usageLoadPromise = null;
let usageSectionListenerBound = false;
let usageRefreshEventListenerBound = false;
const DEFAULT_USAGE_TASK_POLL_INTERVAL_MS = 1200;
const UI_DEBUG_SLOW_REQUEST_MS = 3000;
const USAGE_TASK_MAX_POLL_MS = 10 * 60 * 1000;
const USAGE_TASK_STALLED_PROGRESS_TIMEOUT_MS = 60 * 1000;
const DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE = 30;
const USAGE_BACKGROUND_REFRESH_MIN_TOTAL = 2000;
const USAGE_PROVIDER_REFRESH_ESTIMATED_SECONDS_PER_ACCOUNT = 2;

function logUsageUiDebug(message, payload = null, level = 'log') {
    if (typeof window.logUiDebug === 'function') {
        window.logUiDebug(`[usage] ${message}`, payload, level);
    }
}

function startUsageUiDebugPendingTimer(requestName) {
    if (typeof window.isUiDebugModeEnabled === 'function' && !window.isUiDebugModeEnabled()) {
        return null;
    }

    const timerApi = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
        ? window
        : globalThis;

    if (typeof timerApi.setTimeout !== 'function') {
        return null;
    }

    return timerApi.setTimeout(() => {
        logUsageUiDebug(`${requestName} still pending`, {
            thresholdMs: UI_DEBUG_SLOW_REQUEST_MS
        }, 'warn');
    }, UI_DEBUG_SLOW_REQUEST_MS);
}

function clearUsageUiDebugPendingTimer(timerId) {
    const timerApi = typeof window !== 'undefined' && typeof window.clearTimeout === 'function'
        ? window
        : globalThis;

    if (timerId && typeof timerApi.clearTimeout === 'function') {
        timerApi.clearTimeout(timerId);
    }
}

function buildUsageTaskProgressSignature(taskStatus) {
    const progress = taskStatus?.progress || {};
    return JSON.stringify({
        status: taskStatus?.status || 'unknown',
        providerType: taskStatus?.providerType || '',
        currentProvider: progress.currentProvider || '',
        totalInstances: Number(progress.totalInstances || 0),
        processedInstances: Number(progress.processedInstances || 0),
        currentGroup: Number(progress.currentGroup || 0),
        totalGroups: Number(progress.totalGroups || 0),
        percent: Number(progress.percent || 0)
    });
}

function getVisibleUsageProviderEntries(data) {
    const providers = data?.providers && typeof data.providers === 'object' ? data.providers : {};
    const entries = [];

    for (const [providerType, providerData] of Object.entries(providers)) {
        if (currentProviderConfigs) {
            const config = currentProviderConfigs.find(c => c.id === providerType);
            if (config && config.visible === false) {
                continue;
            }
        }

        const normalizedProviderData = providerData && typeof providerData === 'object' ? providerData : {};
        const totalCount = Number(normalizedProviderData.totalCount ?? 0);
        const instances = Array.isArray(normalizedProviderData.instances) ? normalizedProviderData.instances : [];
        if (totalCount <= 0 && instances.length === 0) {
            continue;
        }

        entries.push([providerType, normalizedProviderData]);
    }

    return entries;
}

function getUsageProviderSummary(providerType, providerData = {}) {
    const instances = Array.isArray(providerData.instances) ? providerData.instances : [];
    const availableCount = Number(providerData.availableCount ?? instances.length ?? 0);
    const limit = Number(providerData.limit ?? DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE);
    const totalPages = Number(providerData.totalPages ?? Math.max(1, Math.ceil(Math.max(availableCount, 1) / Math.max(1, limit))));
    const page = Math.min(Math.max(1, Number(providerData.page ?? 1)), totalPages);
    return {
        providerType,
        timestamp: providerData.timestamp || null,
        totalCount: Number(providerData.totalCount ?? instances.length ?? 0),
        successCount: Number(providerData.successCount ?? instances.filter(instance => instance.success).length ?? 0),
        errorCount: Number(providerData.errorCount ?? Math.max(0, instances.length - instances.filter(instance => instance.success).length) ?? 0),
        processedCount: Number(providerData.processedCount ?? instances.length ?? 0),
        availableCount,
        page,
        limit,
        totalPages,
        hasPrevPage: providerData.hasPrevPage === true || page > 1,
        hasNextPage: providerData.hasNextPage === true || page < totalPages,
        instances,
        detailsLoaded: providerData.detailsLoaded === true || instances.length > 0
    };
}

function clearRenderedChildren(element) {
    if (Array.isArray(element?.children)) {
        element.children.length = 0;
    }
}

function findChildByClass(root, className) {
    const children = Array.isArray(root?.children) ? root.children : [];
    for (const child of children) {
        const classNames = String(child?.className || '').split(/\s+/).filter(Boolean);
        if (classNames.includes(className)) {
            return child;
        }
    }
    return null;
}

function createUsageProviderRefreshState(providerType, taskStatus = {}, overrides = {}) {
    const progress = taskStatus?.progress || {};
    const totalGroups = Number(progress.totalGroups || 0);
    const currentGroup = Number(progress.currentGroup || 0);
    const totalInstances = Number(progress.totalInstances || 0);
    const processedInstances = Number(progress.processedInstances || 0);
    const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));

    return {
        providerType,
        taskId: overrides.taskId || taskStatus.taskId || null,
        status: overrides.status || taskStatus.status || 'running',
        scope: overrides.scope || taskStatus.scope || null,
        page: Number(overrides.page || taskStatus.page || 1),
        limit: Number(overrides.limit || taskStatus.limit || DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE),
        currentGroup,
        totalGroups,
        remainingGroups: totalGroups > 0 ? Math.max(totalGroups - currentGroup, 0) : 0,
        totalInstances,
        processedInstances,
        percent
    };
}

function buildUsageGroupTaskMeta(taskState) {
    if (!taskState || Number(taskState.totalGroups || 0) <= 0) {
        return t('usage.group.taskPending');
    }

    return t('usage.group.taskMeta', {
        current: Number(taskState.currentGroup || 0),
        total: Number(taskState.totalGroups || 0),
        processed: Number(taskState.processedInstances || 0),
        count: Number(taskState.totalInstances || 0),
        remaining: Number(taskState.remainingGroups || 0)
    });
}

function buildUsageGroupTaskInlineMeta(taskState) {
    const processed = Number(taskState?.processedInstances || 0);
    const total = Number(taskState?.totalInstances || 0);
    if (total <= 0) {
        return t('usage.group.taskPending');
    }
    return t('usage.group.taskInlineMeta', {
        processed,
        total
    });
}

function setUsageProviderGroupRefreshing(targetGroup, header, refreshing, canceling = false) {
    if (targetGroup?.classList?.toggle) {
        targetGroup.classList.toggle('usage-provider-group-refreshing', refreshing);
    }

    const refreshButtons = typeof header?.querySelectorAll === 'function'
        ? Array.from(header.querySelectorAll('.btn-usage-provider-refresh'))
        : [];
    refreshButtons.forEach((button) => {
        if (!button) {
            return;
        }
        button.disabled = refreshing;
        button.classList?.toggle?.('is-refreshing', refreshing);
        button.setAttribute?.('aria-busy', refreshing ? 'true' : 'false');
    });

    const refreshNameButton = header?.querySelector?.('.provider-name-refresh');
    if (refreshNameButton) {
        refreshNameButton.classList?.toggle?.('is-refreshing', refreshing);
        refreshNameButton.setAttribute?.('aria-busy', refreshing ? 'true' : 'false');
        if (!refreshing) {
            refreshNameButton.title = t('usage.group.refreshPage');
        } else {
            refreshNameButton.title = canceling
                ? t('usage.taskCanceling')
                : t('usage.group.taskRunning');
        }
    }
}

function ensureUsageTaskIndicatorContainer(header) {
    let indicator = findChildByClass(header, 'usage-task-indicator') || header?.querySelector?.('.usage-task-indicator');
    if (indicator) {
        return indicator;
    }

    indicator = document.createElement('div');
    indicator.className = 'usage-task-indicator';
    indicator.hidden = true;
    indicator.style.display = 'none';

    const spinner = document.createElement('i');
    spinner.className = 'fas fa-spinner fa-spin usage-task-indicator-spinner';

    const badge = document.createElement('span');
    badge.className = 'usage-task-indicator-badge';

    const meta = document.createElement('div');
    meta.className = 'usage-task-indicator-meta';

    const percent = document.createElement('span');
    percent.className = 'usage-task-indicator-percent';

    const actions = document.createElement('div');
    actions.className = 'usage-task-indicator-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-usage-task-cancel';
    cancelBtn.textContent = t('usage.taskCancel');
    cancelBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const providerType = indicator?.dataset?.providerType || '';
        const taskId = indicator?.dataset?.taskId || '';
        if (!providerType || !taskId) {
            return;
        }
        await cancelUsageRefreshTask(providerType, taskId);
    });
    actions.appendChild(cancelBtn);

    indicator.appendChild(spinner);
    indicator.appendChild(meta);
    indicator.appendChild(percent);
    indicator.appendChild(badge);
    indicator.appendChild(actions);

    const actionsContainer = header?.querySelector?.('.usage-group-actions')
        || findChildByClass(header, 'usage-group-actions')
        || header;
    actionsContainer.appendChild(indicator);

    indicator.__badge = badge;
    indicator.__percent = percent;
    indicator.__meta = meta;
    indicator.__cancelBtn = cancelBtn;
    return indicator;
}

function updateUsageProviderRefreshIndicator(providerType, groupContainer = null) {
    const targetGroup = groupContainer || findUsageProviderGroup(providerType);
    if (!targetGroup) {
        return;
    }

    const header = findChildByClass(targetGroup, 'usage-group-header') || targetGroup.children?.[0];
    if (!header) {
        return;
    }

    const indicator = ensureUsageTaskIndicatorContainer(header);
    const taskState = usageProviderRefreshStates.get(providerType);
    const isTaskVisible = Boolean(taskState && (taskState.status === 'running' || taskState.status === 'canceling'));
    if (!isTaskVisible) {
        indicator.hidden = true;
        indicator.style.display = 'none';
        setUsageProviderGroupRefreshing(targetGroup, header, false, false);
        return;
    }

    const canceling = taskState.status === 'canceling';
    indicator.hidden = false;
    indicator.style.display = 'flex';
    indicator.dataset.providerType = providerType;
    indicator.dataset.taskId = taskState.taskId || '';
    indicator.__badge.textContent = canceling
        ? t('usage.taskCanceling')
        : t('usage.group.taskRunning');
    indicator.__percent.textContent = `${Number(taskState.percent || 0).toFixed(1)}%`;
    indicator.__meta.textContent = buildUsageGroupTaskInlineMeta(taskState);
    if (indicator.__cancelBtn) {
        indicator.__cancelBtn.disabled = canceling;
        indicator.__cancelBtn.textContent = canceling ? t('usage.taskCanceling') : t('usage.taskCancel');
    }
    setUsageProviderGroupRefreshing(targetGroup, header, true, canceling);
    indicator.title = buildUsageTaskProgressText({
        providerType,
        progress: {
            currentProvider: providerType,
            processedInstances: Number(taskState.processedInstances || 0),
            totalInstances: Number(taskState.totalInstances || 0),
            percent: Number(taskState.percent || 0)
        }
    }, getProviderDisplayName(providerType));
}

function setUsageProviderRefreshState(providerType, taskStatus = {}, overrides = {}) {
    if (!providerType) {
        return null;
    }

    const nextState = createUsageProviderRefreshState(providerType, taskStatus, overrides);
    usageProviderRefreshStates.set(providerType, nextState);
    updateUsageProviderRefreshIndicator(providerType);
    return nextState;
}

function clearUsageProviderRefreshState(providerType, groupContainer = null) {
    if (!providerType) {
        return;
    }

    usageProviderRefreshStates.delete(providerType);
    updateUsageProviderRefreshIndicator(providerType, groupContainer);
}

function ensureBackgroundUsageRefreshPolling(providerType, taskPayload, fallbackProviderName, options = {}) {
    if (!providerType || !taskPayload?.taskId) {
        return Promise.resolve(null);
    }

    const existingWatcher = usageProviderRefreshWatchers.get(providerType);
    if (existingWatcher?.taskId === taskPayload.taskId) {
        return existingWatcher.promise;
    }

    const watchPromise = (async () => {
        try {
            const finalStatus = await pollUsageRefreshTask(taskPayload.taskId, taskPayload.pollIntervalMs, null, fallbackProviderName, {
                debugContext: options.debugContext || taskPayload.taskId,
                onUpdate: (taskStatus) => {
                    setUsageProviderRefreshState(providerType, {
                        ...taskStatus,
                        taskId: taskPayload.taskId
                    }, {
                        taskId: taskPayload.taskId
                    });

                    if (typeof options.onUpdate === 'function') {
                        options.onUpdate(taskStatus);
                    }
                }
            });

            clearUsageProviderRefreshState(providerType);
            if (typeof options.onCompleted === 'function') {
                await options.onCompleted(finalStatus);
            }
            return finalStatus;
        } catch (error) {
            clearUsageProviderRefreshState(providerType);
            if (typeof options.onFailed === 'function') {
                await options.onFailed(error);
            }
            throw error;
        } finally {
            const latestWatcher = usageProviderRefreshWatchers.get(providerType);
            if (latestWatcher?.taskId === taskPayload.taskId) {
                usageProviderRefreshWatchers.delete(providerType);
            }
        }
    })();

    usageProviderRefreshWatchers.set(providerType, {
        taskId: taskPayload.taskId,
        promise: watchPromise
    });

    return watchPromise;
}

function filterRenderableInstances(instances = []) {
    const validInstances = [];
    for (const instance of instances) {
        if (instance.error === '服务实例未初始化' || instance.error === 'Service instance not initialized') {
            continue;
        }
        if (instance.isDisabled) {
            continue;
        }
        validInstances.push(instance);
    }
    return validInstances;
}

function renderUsageGroupCards(gridContainer, providerType, instances = []) {
    if (!gridContainer) return;
    gridContainer.innerHTML = '';
    clearRenderedChildren(gridContainer);

    const validInstances = filterRenderableInstances(instances);
    for (const instance of validInstances) {
        const instanceCard = createInstanceUsageCard(instance, providerType);
        gridContainer.appendChild(instanceCard);
    }
}

function renderUsageGroupPlaceholder(content, providerSummary, state = 'idle') {
    if (!content) return;

    if (state === 'loading') {
        content.innerHTML = `
            <div class="usage-empty">
                <i class="fas fa-spinner fa-spin"></i>
                <p>${t('usage.loading')}</p>
            </div>
        `;
        clearRenderedChildren(content);
        return;
    }

    if (state === 'error') {
        content.innerHTML = `
            <div class="usage-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${t('usage.failedToLoad')}</p>
            </div>
        `;
        clearRenderedChildren(content);
        return;
    }

    const totalCount = Number(providerSummary?.totalCount || 0);
    content.innerHTML = `
        <div class="usage-empty">
            <i class="fas fa-layer-group"></i>
            <p>${totalCount > 0 ? t('usage.group.clickToLoad') : t('usage.noInstances')}</p>
        </div>
    `;
    clearRenderedChildren(content);
}

function ensureUsageGroupGridContainer(groupContainer, content) {
    if (!groupContainer || !content) {
        return null;
    }

    let gridContainer = groupContainer.querySelector('.usage-cards-grid');
    if (gridContainer) {
        return gridContainer;
    }

    gridContainer = document.createElement('div');
    gridContainer.className = 'usage-cards-grid';
    groupContainer.__usageGridContainer = gridContainer;
    return gridContainer;
}

function findUsageProviderGroup(providerType) {
    const usageContent = document.getElementById('usageContent');
    const groups = Array.from(usageContent?.children || []);
    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const group = groups[index];
        if (group?.dataset?.providerType === providerType) {
            return group;
        }
    }
    return null;
}

function invalidateProviderUsageDetailsCache(providerType, groupContainer = null) {
    usageProviderDetailsPromises.delete(providerType);
    const targetGroup = groupContainer || findUsageProviderGroup(providerType);
    if (!targetGroup) {
        return null;
    }

    targetGroup.dataset.detailsLoaded = 'false';
    targetGroup.dataset.detailsLoading = 'false';
    if (targetGroup.__usageProviderData) {
        targetGroup.__usageProviderData = {
            ...targetGroup.__usageProviderData,
            detailsLoaded: false
        };
    }

    return targetGroup;
}

function buildProviderUsageDetailsUrl(providerType, page = 1) {
    const searchParams = new URLSearchParams({
        page: String(Math.max(1, page)),
        limit: String(DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE)
    });
    return `/api/usage/${encodeURIComponent(providerType)}?${searchParams.toString()}`;
}

function renderUsageGroupPagination(groupContainer, providerType, providerSummary) {
    if (!groupContainer || !providerSummary || Number(providerSummary.totalPages || 1) <= 1) {
        return null;
    }

    const pagination = document.createElement('div');
    pagination.className = 'usage-group-pagination';

    const prevButton = document.createElement('button');
    prevButton.className = 'btn-usage-page btn-prev-page';
    prevButton.textContent = t('usage.group.prevPage');
    prevButton.disabled = providerSummary.hasPrevPage !== true;
    prevButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        const latestSummary = groupContainer.__usageProviderData || providerSummary;
        if (latestSummary.hasPrevPage !== true) {
            return;
        }
        await loadProviderUsageDetailsPage(providerType, groupContainer, latestSummary, Number(latestSummary.page || 1) - 1);
    });

    const nextButton = document.createElement('button');
    nextButton.className = 'btn-usage-page btn-next-page';
    nextButton.textContent = t('usage.group.nextPage');
    nextButton.disabled = providerSummary.hasNextPage !== true;
    nextButton.addEventListener('click', async (event) => {
        event.stopPropagation();
        const latestSummary = groupContainer.__usageProviderData || providerSummary;
        if (latestSummary.hasNextPage !== true) {
            return;
        }
        await loadProviderUsageDetailsPage(providerType, groupContainer, latestSummary, Number(latestSummary.page || 1) + 1);
    });

    const pageStatus = document.createElement('span');
    pageStatus.className = 'usage-group-page-status';
    pageStatus.textContent = t('usage.group.pageStatus', {
        page: Number(providerSummary.page || 1),
        totalPages: Number(providerSummary.totalPages || 1),
        count: Number(providerSummary.availableCount || providerSummary.totalCount || 0)
    });

    pagination.appendChild(prevButton);
    pagination.appendChild(pageStatus);
    pagination.appendChild(nextButton);
    return pagination;
}

async function loadProviderUsageDetailsPage(providerType, groupContainer, providerSummary, page = 1) {
    const content = groupContainer.querySelector('.usage-group-content');
    const gridContainer = ensureUsageGroupGridContainer(groupContainer, content);
    renderUsageGroupPlaceholder(content, providerSummary, 'loading');
    groupContainer.dataset.detailsLoading = 'true';

    const requestPromise = (async () => {
        try {
            let response = null;

            for (let attempt = 0; attempt < 2; attempt += 1) {
                response = await fetch(buildProviderUsageDetailsUrl(providerType, page), {
                    method: 'GET',
                    headers: getAuthHeaders()
                });

                if (response.status !== 202) {
                    break;
                }

                const taskPayload = await response.json();
                if (!taskPayload?.taskId) {
                    throw new Error('Invalid usage task response');
                }

                setUsageProviderRefreshState(providerType, {
                    ...taskPayload,
                    providerType,
                    status: taskPayload.status || 'running'
                }, {
                    taskId: taskPayload.taskId,
                    status: taskPayload.status || 'running'
                });

                const earlyTaskStatus = await pollUsageRefreshTask(taskPayload.taskId, taskPayload.pollIntervalMs, null, getProviderDisplayName(providerType), {
                    debugContext: buildProviderUsageDetailsUrl(providerType, page),
                    onUpdate: (taskStatus) => {
                        setUsageProviderRefreshState(providerType, {
                            ...taskStatus,
                            taskId: taskPayload.taskId
                        }, {
                            taskId: taskPayload.taskId
                        });
                    },
                    stopWhen: (taskStatus) => {
                        if (taskStatus?.status !== 'running') {
                            return true;
                        }

                        return Number(taskStatus?.progress?.processedInstances || 0) >= DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE;
                    }
                });

                if (earlyTaskStatus?.status === 'running') {
                    void ensureBackgroundUsageRefreshPolling(providerType, taskPayload, getProviderDisplayName(providerType), {
                        debugContext: buildProviderUsageDetailsUrl(providerType, page)
                    }).catch((error) => {
                        console.error(`后台跟踪提供商 ${providerType} 用量刷新失败:`, error);
                    });
                }
            }

            if (!response?.ok) {
                throw new Error(`HTTP ${response?.status}: ${response?.statusText}`);
            }

            const payload = await response.json();
            const nextSummary = getUsageProviderSummary(providerType, payload);
            renderUsageGroupCards(gridContainer, providerType, nextSummary.instances);
            const pagination = renderUsageGroupPagination(groupContainer, providerType, nextSummary);
            groupContainer.dataset.detailsLoaded = 'true';
            groupContainer.dataset.detailsLoading = 'false';
            groupContainer.__usageProviderData = nextSummary;

            if (filterRenderableInstances(nextSummary.instances).length === 0) {
                renderUsageGroupPlaceholder(content, nextSummary, 'idle');
            } else {
                content.innerHTML = '';
                content.appendChild(gridContainer);
                if (pagination) {
                    content.appendChild(pagination);
                }
            }

            logUsageUiDebug('provider usage details loaded', {
                providerType,
                page: nextSummary.page,
                limit: nextSummary.limit,
                instanceCount: nextSummary.instances.length,
                availableCount: nextSummary.availableCount
            });
            return nextSummary;
        } catch (error) {
            groupContainer.dataset.detailsLoading = 'false';
            renderUsageGroupPlaceholder(content, providerSummary, 'error');
            throw error;
        } finally {
            usageProviderDetailsPromises.delete(providerType);
        }
    })();

    usageProviderDetailsPromises.set(providerType, requestPromise);
    return await requestPromise;
}

async function ensureProviderUsageDetailsLoaded(providerType, groupContainer, providerSummary) {
    if (!groupContainer || !providerType) {
        return null;
    }

    if (groupContainer.dataset.detailsLoaded === 'true') {
        logUsageUiDebug('provider usage details reused from rendered state', {
            providerType
        });
        return groupContainer.__usageProviderData || providerSummary || null;
    }

    if (usageProviderDetailsPromises.has(providerType)) {
        logUsageUiDebug('provider usage details reused in-flight request', {
            providerType
        });
        return await usageProviderDetailsPromises.get(providerType);
    }

    return await loadProviderUsageDetailsPage(providerType, groupContainer, providerSummary, 1);
}

/**
 * Promise 睡眠
 * @param {number} ms - 毫秒
 * @returns {Promise<void>} Promise
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断当前是否位于用量页面
 * @returns {boolean} 是否位于用量页面
 */
function isUsageSectionActive() {
    const usageSection = document.getElementById('usage');
    return Boolean(usageSection && usageSection.classList.contains('active'));
}

/**
 * 设置用量加载文案
 * @param {HTMLElement|null} loadingEl - loading 容器
 * @param {string} text - 文案
 */
function setUsageLoadingText(loadingEl, text) {
    if (!loadingEl) return;
    const textEl = loadingEl.querySelector('span');
    if (!textEl) return;
    textEl.textContent = text || t('usage.loading');
}

/**
 * 构建任务进度文案
 * @param {Object} taskStatus - 任务状态
 * @param {string} fallbackProviderName - 回退提供商名称
 * @returns {string} 进度文案
 */
function buildUsageTaskProgressText(taskStatus, fallbackProviderName) {
    const progress = taskStatus?.progress || {};
    const providerType = progress.currentProvider || taskStatus.providerType || '';
    const providerName = providerType ? getProviderDisplayName(providerType) : fallbackProviderName;
    const processed = Number(progress.processedInstances || 0);
    const total = Number(progress.totalInstances || 0);
    const percent = Number(progress.percent || 0).toFixed(1);

    return t('usage.taskProgress', {
        provider: providerName || fallbackProviderName || t('usage.allProviders'),
        processed,
        total,
        percent
    });
}

function normalizeUsageTaskSummary(summary = null, fallbackResult = null) {
    if (summary && typeof summary === 'object') {
        return {
            normalCount: Math.max(0, Number(summary.normalCount || 0)),
            quotaExhaustedCount: Math.max(0, Number(summary.quotaExhaustedCount || 0)),
            exceptionCount: Math.max(0, Number(summary.exceptionCount || 0))
        };
    }

    const successCount = Math.max(0, Number(fallbackResult?.successCount || 0));
    const errorCount = Math.max(0, Number(fallbackResult?.errorCount || 0));
    return {
        normalCount: successCount,
        quotaExhaustedCount: 0,
        exceptionCount: errorCount
    };
}

function buildUsageRefreshSummaryText(taskStatus) {
    const taskResult = taskStatus?.result || {};
    const summary = normalizeUsageTaskSummary(taskResult.summary, taskResult);
    return t('usage.taskCompletedSummary', {
        normal: summary.normalCount,
        quotaExhausted: summary.quotaExhaustedCount,
        exception: summary.exceptionCount
    });
}

function estimateProviderRefreshDurationSeconds(totalCount) {
    return Math.max(1, Math.ceil(Math.max(0, Number(totalCount || 0)) * USAGE_PROVIDER_REFRESH_ESTIMATED_SECONDS_PER_ACCOUNT));
}

function buildProviderRefreshStartUrl(providerType, options = {}) {
    const scope = options.scope === 'provider_all' ? 'provider_all' : 'page';
    const page = Math.max(1, Number(options.page || 1));
    const searchParams = new URLSearchParams({
        refresh: 'true',
        async: 'true',
        scope
    });
    if (scope === 'page') {
        searchParams.set('page', String(page));
    }
    return `/api/usage/${encodeURIComponent(providerType)}?${searchParams.toString()}`;
}

function resolveProviderRefreshScope(providerType, providerSummary = {}, options = {}) {
    const providerName = getProviderDisplayName(providerType);
    const currentPage = Math.max(1, Number(options.page || providerSummary.page || 1));
    const totalCount = Math.max(0, Number(providerSummary.totalCount || 0));
    const requestedScope = options.scope === 'provider_all' ? 'provider_all' : 'page';

    if (requestedScope === 'page') {
        return {
            scope: 'page',
            page: currentPage
        };
    }

    const estimatedSeconds = estimateProviderRefreshDurationSeconds(totalCount);
    const confirmed = window.confirm(t('usage.refreshEstimateConfirm', {
        provider: providerName,
        count: totalCount,
        seconds: estimatedSeconds
    }));
    if (!confirmed) {
        return null;
    }

    return {
        scope: 'provider_all',
        page: currentPage
    };
}

/**
 * 启动后台刷新任务并轮询完成
 * @param {string} startUrl - 启动任务接口
 * @param {HTMLElement|null} loadingEl - loading 容器
 * @param {string} fallbackProviderName - 回退提供商名称
 * @returns {Promise<Object>} 完成后的任务状态
 */
async function runUsageRefreshTask(startUrl, loadingEl, fallbackProviderName, options = {}) {
    const startPayload = await startUsageRefreshTask(startUrl, loadingEl, options);
    return await pollUsageRefreshTask(startPayload.taskId, startPayload.pollIntervalMs, loadingEl, fallbackProviderName, {
        debugContext: startUrl,
        onUpdate: options.onUpdate,
        stopWhen: options.stopWhen,
        showLoadingText: options.showLoadingText
    });
}

async function startUsageRefreshTask(startUrl, loadingEl = null, options = {}) {
    const startResponse = await fetch(startUrl, {
        method: 'GET',
        headers: getAuthHeaders()
    });

    if (!startResponse.ok) {
        throw new Error(`HTTP ${startResponse.status}: ${startResponse.statusText}`);
    }

    const startPayload = await startResponse.json();
    const taskId = startPayload.taskId;
    if (!taskId) {
        throw new Error('Invalid usage task response');
    }

    if (options.showTaskStartToast !== false) {
        showToast(t('common.info'), t('usage.taskStarted'), 'info');
    }
    if (options.showLoadingText !== false) {
        setUsageLoadingText(loadingEl, t('usage.taskPreparing'));
    }

    return startPayload;
}

async function cancelUsageRefreshTask(providerType, taskId) {
    if (!providerType || !taskId) {
        return null;
    }

    try {
        const response = await fetch(`/api/usage/tasks/${encodeURIComponent(taskId)}`, {
            method: 'POST',
            headers: {
                ...getAuthHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action: 'cancel' })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const payload = await response.json();
        setUsageProviderRefreshState(providerType, {
            ...payload,
            taskId
        }, {
            taskId,
            status: payload.status || 'canceling'
        });
        return payload;
    } catch (error) {
        console.error(`取消提供商 ${providerType} 用量刷新任务失败:`, error);
        if (isUsageSectionActive()) {
            showToast(t('common.error'), `${t('usage.taskFailed')}: ${error.message}`, 'error');
        }
        return null;
    }
}

async function pollUsageRefreshTask(taskId, initialPollIntervalMs, loadingEl, fallbackProviderName, options = {}) {
    const startedAt = Date.now();
    const debugContext = options.debugContext || taskId;
    const shouldUpdateLoadingText = options.showLoadingText !== false;

    let lastProgressSignature = null;
    let lastProgressAt = Date.now();

    logUsageUiDebug('usage refresh task polling started', {
        taskId,
        debugContext,
        fallbackProviderName
    });

    while (true) {
        if (Date.now() - startedAt >= USAGE_TASK_MAX_POLL_MS) {
            throw new Error(`Usage refresh task exceeded ${USAGE_TASK_MAX_POLL_MS}ms: ${taskId}`);
        }

        const statusResponse = await fetch(`/api/usage/tasks/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: getAuthHeaders()
        });

        if (!statusResponse.ok) {
            throw new Error(`HTTP ${statusResponse.status}: ${statusResponse.statusText}`);
        }

        const taskStatus = await statusResponse.json();
        if (typeof options.onUpdate === 'function') {
            try {
                options.onUpdate(taskStatus);
            } catch (error) {
                console.error('处理用量任务进度回调失败:', error);
            }
        }

        if (taskStatus.status === 'running' || taskStatus.status === 'canceling') {
            const progressSignature = buildUsageTaskProgressSignature(taskStatus);
            if (progressSignature !== lastProgressSignature) {
                lastProgressSignature = progressSignature;
                lastProgressAt = Date.now();
                logUsageUiDebug('usage refresh task progress updated', {
                    taskId,
                    progress: taskStatus.progress || {}
                });
            } else if (taskStatus.status === 'running' && Date.now() - lastProgressAt >= USAGE_TASK_STALLED_PROGRESS_TIMEOUT_MS) {
                throw new Error(`Usage refresh task stalled for ${USAGE_TASK_STALLED_PROGRESS_TIMEOUT_MS}ms: ${taskId}`);
            }

            if (shouldUpdateLoadingText) {
                if (taskStatus.status === 'canceling') {
                    setUsageLoadingText(loadingEl, t('usage.taskCanceling'));
                } else {
                    setUsageLoadingText(loadingEl, buildUsageTaskProgressText(taskStatus, fallbackProviderName));
                }
            }

            if (typeof options.stopWhen === 'function' && options.stopWhen(taskStatus) === true) {
                logUsageUiDebug('usage refresh task polling stopped early', {
                    taskId,
                    debugContext,
                    progress: taskStatus.progress || {}
                });
                return taskStatus;
            }

            const pollInterval = Number(taskStatus.pollIntervalMs) || Number(initialPollIntervalMs) || DEFAULT_USAGE_TASK_POLL_INTERVAL_MS;
            await sleep(pollInterval);
            continue;
        }

        if (taskStatus.status === 'completed') {
            logUsageUiDebug('usage refresh task completed', {
                taskId,
                durationMs: Date.now() - startedAt,
                result: taskStatus.result || null
            });
            return taskStatus;
        }

        if (taskStatus.status === 'canceled') {
            logUsageUiDebug('usage refresh task canceled', {
                taskId,
                durationMs: Date.now() - startedAt,
                result: taskStatus.result || null
            });
            return taskStatus;
        }

        throw new Error(taskStatus.error || t('usage.taskFailed'));
    }
}

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
export function updateUsageProviderConfigs(configs) {
    currentProviderConfigs = configs;
    logUsageUiDebug('provider configs updated', {
        configCount: Array.isArray(configs) ? configs.length : 0
    });
    if (isUsageSectionActive()) {
        void loadUsage();
        return;
    }

    logUsageUiDebug('provider configs updated while usage section inactive, deferred usage reload');
}

/**
 * 检查提供商是否支持显示用量
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否支持显示用量
 */
function shouldShowUsage(providerType) {
    return !PROVIDERS_WITHOUT_USAGE_DISPLAY.includes(providerType);
}

/**
 * 初始化用量管理功能
 */
export { setUsageLoadingText, buildUsageTaskProgressText, shouldShowUsage };

export function initUsageManager() {
    if (!usageSectionListenerBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('ui:section-activated', (event) => {
            if (event?.detail?.sectionId !== 'usage') {
                return;
            }

            logUsageUiDebug('usage section activated');
            void loadUsage();
        });
        usageSectionListenerBound = true;
    }

    if (!usageRefreshEventListenerBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('usage_refresh_event', (event) => {
            const providerType = event?.detail?.providerType || null;
            if (!providerType) {
                return;
            }

            clearUsageProviderRefreshState(providerType);
        });
        usageRefreshEventListenerBound = true;
    }

    logUsageUiDebug('initUsageManager invoked', {
        sectionActive: isUsageSectionActive()
    });
    
    if (isUsageSectionActive()) {
        void loadUsage();
    }
}

/**
 * 加载用量数据（优先从缓存读取）
 */
async function loadUsageInternal(options = {}) {
    const loadingEl = document.getElementById('usageLoading');
    const errorEl = document.getElementById('usageError');
    const contentEl = document.getElementById('usageContent');
    const emptyEl = document.getElementById('usageEmpty');
    const lastUpdateEl = document.getElementById('usageLastUpdate');
    const startedAt = Date.now();
    const pendingTimer = startUsageUiDebugPendingTimer('GET /api/usage');

    logUsageUiDebug('GET /api/usage started', {
        sectionActive: isUsageSectionActive()
    });

    // 显示加载状态
    if (loadingEl) loadingEl.style.display = 'block';
    if (errorEl) errorEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';

    try {
        // 不带 refresh 参数，优先读取缓存
        const response = await fetch('/api/usage', {
            method: 'GET',
            headers: getAuthHeaders()
        });
        const responseAt = Date.now();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (response.status === 202) {
            const taskPayload = await response.json();
            logUsageUiDebug('GET /api/usage accepted async bootstrap task', {
                taskId: taskPayload?.taskId || null,
                pollIntervalMs: taskPayload?.pollIntervalMs || null,
                responseDurationMs: responseAt - startedAt
            }, 'warn');

            if (!taskPayload?.taskId) {
                throw new Error('Invalid usage bootstrap task response');
            }

            setUsageLoadingText(loadingEl, t('usage.taskPreparing'));
            await pollUsageRefreshTask(taskPayload.taskId, taskPayload.pollIntervalMs, loadingEl, t('usage.allProviders'), {
                debugContext: 'GET /api/usage'
            });

            if (options.afterAsyncRefresh === true) {
                throw new Error('Usage data is still unavailable after async refresh task completed');
            }

            return await loadUsage({
                bypassInFlight: true,
                afterAsyncRefresh: true
            });
        }

        const data = await response.json();
        const parsedAt = Date.now();
        
        // 隐藏加载状态
        if (loadingEl) loadingEl.style.display = 'none';
        
        // 渲染用量数据
        renderUsageData(data, contentEl);
        const renderedAt = Date.now();
        
        // 更新服务端系统时间
        if (data.serverTime) {
            const serverTimeEl = document.getElementById('serverTimeValue');
            if (serverTimeEl) {
                serverTimeEl.textContent = new Date(data.serverTime).toLocaleString(getCurrentLanguage());
            }
        }
        
        // 更新最后更新时间
        if (lastUpdateEl) {
            const timeStr = new Date(data.timestamp || Date.now()).toLocaleString(getCurrentLanguage());
            if (data.fromCache && data.timestamp) {
                lastUpdateEl.textContent = t('usage.lastUpdateCache', { time: timeStr });
                lastUpdateEl.setAttribute('data-i18n', 'usage.lastUpdateCache');
                lastUpdateEl.setAttribute('data-i18n-params', JSON.stringify({ time: timeStr }));
            } else {
                lastUpdateEl.textContent = t('usage.lastUpdate', { time: timeStr });
                lastUpdateEl.setAttribute('data-i18n', 'usage.lastUpdate');
                lastUpdateEl.setAttribute('data-i18n-params', JSON.stringify({ time: timeStr }));
            }
        }

        logUsageUiDebug('GET /api/usage completed', {
            status: response.status,
            fromCache: data?.fromCache === true,
            providerCount: Object.keys(data?.providers || {}).length,
            totalCount: Number(data?.totalCount || 0),
            responseDurationMs: responseAt - startedAt,
            parseDurationMs: parsedAt - responseAt,
            renderDurationMs: renderedAt - parsedAt,
            totalDurationMs: renderedAt - startedAt
        });
    } catch (error) {
        logUsageUiDebug('GET /api/usage failed', {
            durationMs: Date.now() - startedAt,
            message: error?.message || String(error)
        }, 'error');
        console.error('获取用量数据失败:', error);
        
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            errorEl.style.display = 'block';
            const errorMsgEl = document.getElementById('usageErrorMessage');
            if (errorMsgEl) {
                errorMsgEl.textContent = error.message || (t('usage.title') + t('common.refresh.failed'));
            }
        }
    } finally {
        clearUsageUiDebugPendingTimer(pendingTimer);
    }
}

/**
 * 加载用量数据（优先从缓存读取）
 */
export async function loadUsage(options = {}) {
    if (options.bypassInFlight !== true && usageLoadPromise) {
        logUsageUiDebug('GET /api/usage reused in-flight request');
        return await usageLoadPromise;
    }

    const runner = loadUsageInternal(options);
    if (options.bypassInFlight === true) {
        return await runner;
    }

    usageLoadPromise = runner;
    try {
        return await usageLoadPromise;
    } finally {
        usageLoadPromise = null;
    }
}

/**
 * 刷新用量数据（强制从服务器获取最新数据）
 */
export async function refreshUsage() {
    await loadUsage({ bypassInFlight: true });
}

/**
 * 渲染用量数据
 * @param {Object} data - 用量数据
 * @param {HTMLElement} container - 容器元素
 */
function renderUsageData(data, container) {
    if (!container) return;

    // 清空容器
    container.innerHTML = '';
    clearRenderedChildren(container);

    if (!data || !data.providers || Object.keys(data.providers).length === 0) {
        container.innerHTML = `
            <div class="usage-empty">
                <i class="fas fa-chart-bar"></i>
                <p data-i18n="usage.noData">${t('usage.noData')}</p>
            </div>
        `;
        return;
    }

    const providerEntries = getVisibleUsageProviderEntries(data);

    if (providerEntries.length === 0) {
        container.innerHTML = `
            <div class="usage-empty">
                <i class="fas fa-chart-bar"></i>
                <p data-i18n="usage.noInstances">${t('usage.noInstances')}</p>
            </div>
        `;
        return;
    }

    // 按提供商分组渲染，使用统一的显示顺序
    const providerMap = new Map(providerEntries.map(([providerType, providerData]) => [providerType, getUsageProviderSummary(providerType, providerData)]));
    const displayOrder = currentProviderConfigs 
        ? currentProviderConfigs.map(c => c.id) 
        : Array.from(providerMap.keys());

    displayOrder.forEach(providerType => {
        const providerSummary = providerMap.get(providerType);
        if (providerSummary) {
            const groupContainer = createProviderGroup(providerType, providerSummary);
            container.appendChild(groupContainer);
        }
    });
}

/**
 * 刷新特定提供商类型的用量数据
 * @param {string} providerType - 提供商类型
 */
export async function refreshProviderUsage(providerType, options = {}) {
    let detachedRefresh = false;

    if (refreshingProviders.has(providerType)) {
        showToast(t('common.info'), t('usage.refreshProviderInProgress'), 'info');
        return;
    }

    refreshingProviders.add(providerType);

    try {
        const providerName = getProviderDisplayName(providerType);
        const previousGroup = findUsageProviderGroup(providerType);
        const shouldRestoreExpandedDetails = Boolean(previousGroup && !previousGroup.classList.contains('collapsed'));
        const providerSummary = previousGroup?.__usageProviderData || getUsageProviderSummary(providerType, {});
        const providerTotalCount = Number(providerSummary.totalCount || 0);
        const refreshScope = resolveProviderRefreshScope(providerType, providerSummary, options);
        if (!refreshScope) {
            refreshingProviders.delete(providerType);
            return;
        }
        const refreshStartUrl = buildProviderRefreshStartUrl(providerType, refreshScope);
        const initialTotalInstances = refreshScope.scope === 'page'
            ? Math.max(1, Math.min(
                DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE,
                Number(providerSummary.availableCount || providerSummary.totalCount || DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE)
            ))
            : Math.max(1, Number(providerSummary.totalCount || providerTotalCount || 0));
        invalidateProviderUsageDetailsCache(providerType, previousGroup);

        setUsageProviderRefreshState(providerType, {
            providerType,
            status: 'running',
            scope: refreshScope.scope,
            page: refreshScope.page,
            limit: DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE,
            progress: {
                currentProvider: providerType,
                processedInstances: 0,
                totalInstances: initialTotalInstances,
                percent: 0
            }
        }, {
            status: 'running',
            scope: refreshScope.scope,
            page: refreshScope.page,
            limit: DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE
        });

        logUsageUiDebug('provider usage refresh started', {
            providerType,
            restoreExpandedDetails: shouldRestoreExpandedDetails,
            providerTotalCount,
            scope: refreshScope.scope,
            page: refreshScope.page
        });

        const shouldDetachToBackground = refreshScope.scope === 'provider_all'
            && providerTotalCount >= USAGE_BACKGROUND_REFRESH_MIN_TOTAL;

        if (shouldDetachToBackground) {
            detachedRefresh = true;
            const taskPayload = await startUsageRefreshTask(refreshStartUrl, null, {
                showTaskStartToast: false,
                showLoadingText: false
            });
            logUsageUiDebug('provider usage refresh detached to background task', {
                providerType,
                taskId: taskPayload?.taskId || null,
                providerTotalCount,
                scope: refreshScope.scope
            }, 'warn');

            setUsageProviderRefreshState(providerType, {
                ...taskPayload,
                providerType,
                status: taskPayload.status || 'running'
            }, {
                taskId: taskPayload.taskId,
                status: taskPayload.status || 'running'
            });

            void ensureBackgroundUsageRefreshPolling(providerType, taskPayload, providerName, {
                debugContext: refreshStartUrl,
                onCompleted: async (finalStatus) => {
                    await loadUsage({ bypassInFlight: true });

                    const refreshedGroup = invalidateProviderUsageDetailsCache(providerType);
                    if (shouldRestoreExpandedDetails && refreshedGroup) {
                        refreshedGroup.classList.remove('collapsed');
                        await ensureProviderUsageDetailsLoaded(
                            providerType,
                            refreshedGroup,
                            refreshedGroup.__usageProviderData || getUsageProviderSummary(providerType, {})
                        );
                    }

            if (isUsageSectionActive()) {
                const finishedStatus = finalStatus?.status || 'completed';
                if (finishedStatus === 'canceled') {
                    showToast(t('common.info'), t('usage.taskCanceled'), 'info');
                } else {
                    showToast(t('common.success'), buildUsageRefreshSummaryText(finalStatus), 'success');
                }
            }
            refreshingProviders.delete(providerType);
        },
                onFailed: async (error) => {
                    console.error(`后台刷新提供商 ${providerType} 失败:`, error);
                    if (isUsageSectionActive()) {
                        showToast(t('common.error'), t('usage.taskFailed') + ': ' + error.message, 'error');
                    }
                    refreshingProviders.delete(providerType);
                }
            }).catch(() => {});

            await loadUsage({ bypassInFlight: true });
            return;
        }

        const finalStatus = await runUsageRefreshTask(refreshStartUrl, null, providerName, {
            showTaskStartToast: false,
            showLoadingText: false,
            onUpdate: (taskStatus) => {
                setUsageProviderRefreshState(providerType, {
                    ...taskStatus,
                    taskId: taskStatus.taskId || null
                }, {
                    taskId: taskStatus.taskId || null,
                    scope: taskStatus.scope || refreshScope.scope,
                    page: taskStatus.page || refreshScope.page,
                    limit: taskStatus.limit || DEFAULT_USAGE_PROVIDER_DETAILS_PAGE_SIZE
                });
            }
        });
        clearUsageProviderRefreshState(providerType);
        await loadUsage({ bypassInFlight: true });

        const refreshedGroup = invalidateProviderUsageDetailsCache(providerType);
        if (shouldRestoreExpandedDetails && refreshedGroup) {
            refreshedGroup.classList.remove('collapsed');
            await ensureProviderUsageDetailsLoaded(
                providerType,
                refreshedGroup,
                refreshedGroup.__usageProviderData || getUsageProviderSummary(providerType, {})
            );
            logUsageUiDebug('provider usage refresh reloaded details', {
                providerType
            });
        }

        if (isUsageSectionActive()) {
            if (finalStatus?.status === 'canceled') {
                showToast(t('common.info'), t('usage.taskCanceled'), 'info');
                return;
            }
            showToast(t('common.success'), buildUsageRefreshSummaryText(finalStatus), 'success');
        }
    } catch (error) {
        console.error(`刷新提供商 ${providerType} 失败:`, error);
        if (isUsageSectionActive()) {
            showToast(t('common.error'), t('usage.taskFailed') + ': ' + error.message, 'error');
        }
    } finally {
        if (!detachedRefresh) {
            refreshingProviders.delete(providerType);
            clearUsageProviderRefreshState(providerType);
        }
    }
}

/**
 * 创建提供商分组容器
 * @param {string} providerType - 提供商类型
 * @param {Array} instances - 实例数组
 * @returns {HTMLElement} 分组容器元素
 */
function createProviderGroup(providerType, providerData) {
    const groupContainer = document.createElement('div');
    groupContainer.className = 'usage-provider-group collapsed';
    const providerSummary = getUsageProviderSummary(providerType, providerData);
    groupContainer.dataset.providerType = providerType;
    groupContainer.dataset.detailsLoaded = providerSummary.detailsLoaded ? 'true' : 'false';
    groupContainer.dataset.detailsLoading = 'false';
    groupContainer.__usageProviderData = providerSummary;
    
    const providerDisplayName = getProviderDisplayName(providerType);
    const providerIcon = getProviderIcon(providerType);
    const instanceCount = providerSummary.totalCount;
    const successCount = providerSummary.successCount;
    
    // 分组头部（可点击折叠）
    const header = document.createElement('div');
    header.className = 'usage-group-header';
    header.innerHTML = `
        <div class="usage-group-title">
            <i class="fas fa-chevron-right toggle-icon"></i>
            <i class="${providerIcon} provider-icon"></i>
            <button type="button" class="provider-name provider-name-refresh" title="${t('usage.group.refreshPage')}">${providerDisplayName}</button>
            <span class="instance-count" data-i18n="usage.group.instances" data-i18n-params='{"count":"${instanceCount}"}'>${t('usage.group.instances', { count: instanceCount })}</span>
            <span class="success-count ${successCount === instanceCount ? 'all-success' : ''}" data-i18n="usage.group.success" data-i18n-params='{"count":"${successCount}","total":"${instanceCount}"}'>${t('usage.group.success', { count: successCount, total: instanceCount })}</span>
        </div>
        <div class="usage-group-actions">
            <button type="button" class="btn-usage-provider-refresh btn-usage-provider-refresh-page">${t('usage.group.refreshPage')}</button>
            <button type="button" class="btn-usage-provider-refresh btn-usage-provider-refresh-all">${t('usage.group.refreshAll')}</button>
        </div>
    `;
    
    // 点击头部切换分组折叠状态
    const titleDiv = header.querySelector('.usage-group-title');
    titleDiv.addEventListener('click', async () => {
        groupContainer.classList.toggle('collapsed');
        if (!groupContainer.classList.contains('collapsed')) {
            try {
                await ensureProviderUsageDetailsLoaded(providerType, groupContainer, providerSummary);
            } catch (error) {
                console.error(`加载提供商 ${providerType} 用量详情失败:`, error);
            }
        }
    });

    const refreshNameButton = header.querySelector('.provider-name-refresh');
    refreshNameButton?.addEventListener('click', async (event) => {
        event.stopPropagation();
        await refreshProviderUsage(providerType, {
            scope: 'page',
            page: Number(groupContainer.__usageProviderData?.page || 1)
        });
    });

    const refreshPageButton = header.querySelector('.btn-usage-provider-refresh-page');
    refreshPageButton?.addEventListener('click', async (event) => {
        event.stopPropagation();
        await refreshProviderUsage(providerType, {
            scope: 'page',
            page: Number(groupContainer.__usageProviderData?.page || 1)
        });
    });

    const refreshAllButton = header.querySelector('.btn-usage-provider-refresh-all');
    refreshAllButton?.addEventListener('click', async (event) => {
        event.stopPropagation();
        await refreshProviderUsage(providerType, {
            scope: 'provider_all',
            page: Number(groupContainer.__usageProviderData?.page || 1)
        });
    });
    
    groupContainer.appendChild(header);
    updateUsageProviderRefreshIndicator(providerType, groupContainer);
    
    // 分组内容（卡片网格）
    const content = document.createElement('div');
    content.className = 'usage-group-content';
    
    const gridContainer = ensureUsageGroupGridContainer(groupContainer, content);

    if (providerSummary.detailsLoaded) {
        renderUsageGroupCards(gridContainer, providerType, providerSummary.instances);
        if (filterRenderableInstances(providerSummary.instances).length > 0) {
            content.appendChild(gridContainer);
        } else {
            renderUsageGroupPlaceholder(content, providerSummary, 'idle');
        }
    } else {
        renderUsageGroupPlaceholder(content, providerSummary, 'idle');
    }

    groupContainer.appendChild(content);
    
    return groupContainer;
}

/**
 * 创建实例用量卡片
 * @param {Object} instance - 实例数据
 * @param {string} providerType - 提供商类型
 * @returns {HTMLElement} 卡片元素
 */
function createInstanceUsageCard(instance, providerType) {
    const card = document.createElement('div');
    card.className = `usage-instance-card ${instance.success ? 'success' : 'error'} collapsed`;

    const providerDisplayName = getProviderDisplayName(providerType);
    const providerIcon = getProviderIcon(providerType);

    // 检查是否应该显示用量信息
    const showUsage = shouldShowUsage(providerType);

    // 计算总用量（用于折叠摘要显示）
    const totalUsage = instance.usage ? calculateTotalUsage(instance.usage.usageBreakdown) : { hasData: false, percent: 0 };
    const progressClass = totalUsage.percent >= 90 ? 'danger' : (totalUsage.percent >= 70 ? 'warning' : 'normal');

    // 折叠摘要 - 两行显示
    const collapsedSummary = document.createElement('div');
    collapsedSummary.className = 'usage-card-collapsed-summary';
    
    const statusIcon = instance.success
        ? '<i class="fas fa-check-circle status-success"></i>'
        : '<i class="fas fa-times-circle status-error"></i>';
    
    // 显示名称：优先自定义名称，其次 uuid
    const displayName = instance.name || instance.uuid;

    const displayUsageText = totalUsage.isCodex 
        ? `${totalUsage.percent.toFixed(1)}%`
        : `${formatNumber(totalUsage.used)} / ${formatNumber(totalUsage.limit)}`;
    
    collapsedSummary.innerHTML = `
        <div class="collapsed-summary-row collapsed-summary-name-row">
            <i class="fas fa-chevron-right usage-toggle-icon"></i>
            <span class="collapsed-name" title="${displayName}">${displayName}</span>
            ${statusIcon}
        </div>
        ${showUsage ? `
        <div class="collapsed-summary-row collapsed-summary-usage-row">
            ${totalUsage.hasData ? `
                <div class="collapsed-progress-bar ${progressClass}">
                    <div class="progress-fill" style="width: ${totalUsage.percent}%"></div>
                </div>
                <span class="collapsed-percent">${totalUsage.percent.toFixed(1)}%</span>
                <span class="collapsed-usage-text">${displayUsageText}</span>
            ` : (instance.error ? `<span class="collapsed-error" data-i18n="common.error">${t('common.error')}</span>` : '')}
        </div>
        ` : ''}
    `;
    
    // 点击折叠摘要切换展开状态
    collapsedSummary.addEventListener('click', (e) => {
        e.stopPropagation();
        card.classList.toggle('collapsed');
    });
    
    card.appendChild(collapsedSummary);

    // 展开内容区域
    const expandedContent = document.createElement('div');
    expandedContent.className = 'usage-card-expanded-content';

    // 实例头部 - 整合用户信息
    const header = document.createElement('div');
    header.className = 'usage-instance-header';
    
    const healthBadge = instance.isDisabled
        ? `<span class="badge badge-disabled" data-i18n="usage.card.status.disabled">${t('usage.card.status.disabled')}</span>`
        : (instance.isHealthy
            ? `<span class="badge badge-healthy" data-i18n="usage.card.status.healthy">${t('usage.card.status.healthy')}</span>`
            : `<span class="badge badge-unhealthy" data-i18n="usage.card.status.unhealthy">${t('usage.card.status.unhealthy')}</span>`);

    // 获取用户邮箱和订阅信息
    const userEmail = instance.usage?.user?.email || '';
    const subscriptionTitle = instance.usage?.subscription?.title || '';
    
    // 用户信息行
    const userInfoHTML = userEmail ? `
        <div class="instance-user-info">
            <span class="user-email" title="${userEmail}"><i class="fas fa-envelope"></i> ${userEmail}</span>
            ${subscriptionTitle ? `<span class="user-subscription">${subscriptionTitle}</span>` : ''}
        </div>
    ` : '';

    header.innerHTML = `
        <div class="instance-header-top">
            <div class="instance-provider-type">
                <i class="${providerIcon}"></i>
                <span>${providerDisplayName}</span>
            </div>
            <div class="instance-status-badges">
                ${statusIcon}
                ${healthBadge}
            </div>
        </div>
        <div class="instance-name">
            <span class="instance-name-text" title="${instance.name || instance.uuid}">${instance.name || instance.uuid}</span>
        </div>
        ${userInfoHTML}
    `;
    expandedContent.appendChild(header);

    // 实例内容 - 只显示用量和到期时间
    const content = document.createElement('div');
    content.className = 'usage-instance-content';

    if (instance.error) {
        content.innerHTML = `
            <div class="usage-error-message">
                <i class="fas fa-exclamation-triangle"></i>
                <span>${instance.error}</span>
            </div>
        `;
    } else if (instance.usage) {
        content.appendChild(renderUsageDetails(instance.usage, providerType));
    }

    expandedContent.appendChild(content);
    card.appendChild(expandedContent);
    
    return card;
}

/**
 * 渲染用量详情 - 显示总用量、用量明细和到期时间
 * @param {Object} usage - 用量数据
 * @param {string} providerType - 提供商类型
 * @returns {HTMLElement} 详情元素
 */
function renderUsageDetails(usage, providerType) {
    const container = document.createElement('div');
    container.className = 'usage-details';

    // 检查是否应该显示用量信息
    const showUsage = shouldShowUsage(providerType);
    
    // 计算总用量
    const totalUsage = calculateTotalUsage(usage.usageBreakdown);
    
    // 总用量进度条（不支持显示用量的提供商不显示）
    if (totalUsage.hasData && showUsage) {
        const totalSection = document.createElement('div');
        totalSection.className = 'usage-section total-usage';
        
        const progressClass = totalUsage.percent >= 90 ? 'danger' : (totalUsage.percent >= 70 ? 'warning' : 'normal');
        
        // 提取第一个有重置时间的条目（通常是总配额）
        let resetTimeHTML = '';
        if (totalUsage.isCodex && totalUsage.resetAfterSeconds !== undefined) {
            const resetTimeText = formatTimeRemaining(totalUsage.resetAfterSeconds);
            resetTimeHTML = `
                <div class="total-reset-info" data-i18n="usage.resetInfo" data-i18n-params='{"time":"${resetTimeText}"}'>
                    <i class="fas fa-history"></i> ${t('usage.resetInfo', { time: resetTimeText })}
                </div>
            `;
        } else {
            const resetTimeEntry = usage.usageBreakdown.find(b => b.resetTime && b.resetTime !== '--');
            if (resetTimeEntry) {
                const formattedResetTime = formatDate(resetTimeEntry.resetTime);
                resetTimeHTML = `
                    <div class="total-reset-info" data-i18n="usage.card.resetAt" data-i18n-params='{"time":"${formattedResetTime}"}'>
                        <i class="fas fa-history"></i> ${t('usage.card.resetAt', { time: formattedResetTime })}
                    </div>
                `;
            }
        }

        const displayValue = totalUsage.isCodex 
            ? `${totalUsage.percent.toFixed(1)}%`
            : `${formatNumber(totalUsage.used)} / ${formatNumber(totalUsage.limit)}`;

        totalSection.innerHTML = `
            <div class="total-usage-header">
                <span class="total-label">
                    <i class="fas fa-chart-pie"></i>
                    <span data-i18n="usage.card.totalUsage">${t('usage.card.totalUsage')}</span>
                </span>
                <span class="total-value">${displayValue}</span>
            </div>
            <div class="progress-bar ${progressClass}">
                <div class="progress-fill" style="width: ${totalUsage.percent}%"></div>
            </div>
            <div class="total-footer">
                <div class="total-percent">${totalUsage.percent.toFixed(2)}%</div>
                ${resetTimeHTML}
            </div>
        `;
        
        container.appendChild(totalSection);
    }

    // 用量明细（包含免费试用和奖励信息）
    if (usage.usageBreakdown && usage.usageBreakdown.length > 0) {
        const breakdownSection = document.createElement('div');
        breakdownSection.className = 'usage-section usage-breakdown-compact';
        
        let breakdownHTML = '';
        
        for (const breakdown of usage.usageBreakdown) {
            breakdownHTML += createUsageBreakdownHTML(breakdown, providerType);
        }
        
        breakdownSection.innerHTML = breakdownHTML;
        container.appendChild(breakdownSection);
    }

    return container;
}

/**
 * 创建用量明细 HTML（紧凑版）
 * @param {Object} breakdown - 用量明细数据
 * @param {string} providerType - 提供商类型
 * @returns {string} HTML 字符串
 */
function createUsageBreakdownHTML(breakdown, providerType) {
    // 特殊处理 Codex
    if (breakdown.rateLimit && breakdown.rateLimit.primary_window) {
        return createCodexUsageBreakdownHTML(breakdown);
    }

    // 检查是否应该显示用量信息
    const showUsage = shouldShowUsage(providerType);

    const usagePercent = breakdown.usageLimit > 0
        ? Math.min(100, (breakdown.currentUsage / breakdown.usageLimit) * 100)
        : 0;
    
    const progressClass = usagePercent >= 90 ? 'danger' : (usagePercent >= 70 ? 'warning' : 'normal');

    let html = `
        <div class="breakdown-item-compact">
            <div class="breakdown-header-compact">
                <span class="breakdown-name">${breakdown.displayName || breakdown.resourceType}</span>
                ${showUsage ? `<span class="breakdown-usage">${formatNumber(breakdown.currentUsage)} / ${formatNumber(breakdown.usageLimit)}</span>` : ''}
            </div>
            ${showUsage ? `
            <div class="progress-bar-small ${progressClass}">
                <div class="progress-fill" style="width: ${usagePercent}%"></div>
            </div>
            ` : ''}
    `;

    // 如果有重置时间，则显示
    if (breakdown.resetTime && breakdown.resetTime !== '--') {
        const formattedResetTime = formatDate(breakdown.resetTime);
        const resetText = t('usage.card.resetAt', { time: formattedResetTime });
        html += `
            <div class="extra-usage-info reset-time">
                <span class="extra-label">
                    <i class="fas fa-history"></i> 
                    <span data-i18n="usage.card.resetAt" data-i18n-params='${JSON.stringify({ time: formattedResetTime })}'>${resetText}</span>
                </span>
            </div>
        `;
    }

    // 免费试用信息
    if (breakdown.freeTrial && breakdown.freeTrial.status === 'ACTIVE') {
        html += `
            <div class="extra-usage-info free-trial">
                <span class="extra-label"><i class="fas fa-gift"></i> <span data-i18n="usage.card.freeTrial">${t('usage.card.freeTrial')}</span></span>
                <span class="extra-value">${formatNumber(breakdown.freeTrial.currentUsage)} / ${formatNumber(breakdown.freeTrial.usageLimit)}</span>
                <span class="extra-expires" data-i18n="usage.card.expires" data-i18n-params='{"time":"${formatDate(breakdown.freeTrial.expiresAt)}"}'>${t('usage.card.expires', { time: formatDate(breakdown.freeTrial.expiresAt) })}</span>
            </div>
        `;
    }

    // 奖励信息
    if (breakdown.bonuses && breakdown.bonuses.length > 0) {
        for (const bonus of breakdown.bonuses) {
            if (bonus.status === 'ACTIVE') {
                html += `
                    <div class="extra-usage-info bonus">
                        <span class="extra-label"><i class="fas fa-star"></i> ${bonus.displayName || bonus.code}</span>
                        <span class="extra-value">${formatNumber(bonus.currentUsage)} / ${formatNumber(bonus.usageLimit)}</span>
                        <span class="extra-expires" data-i18n="usage.card.expires" data-i18n-params='{"time":"${formatDate(bonus.expiresAt)}"}'>${t('usage.card.expires', { time: formatDate(bonus.expiresAt) })}</span>
                    </div>
                `;
            }
        }
    }

    html += '</div>';
    return html;
}

/**
 * 创建 Codex 专用的用量明细 HTML
 * @param {Object} breakdown - 包含 rateLimit 的用量明细
 * @returns {string} HTML 字符串
 */
function createCodexUsageBreakdownHTML(breakdown) {
    const rl = breakdown.rateLimit;
    const secondary = rl.secondary_window;
    
    if (!secondary) return '';

    const secondaryPercent = secondary.used_percent || 0;
    const secondaryProgressClass = secondaryPercent >= 90 ? 'danger' : (secondaryPercent >= 70 ? 'warning' : 'normal');
    const secondaryResetText = formatTimeRemaining(secondary.reset_after_seconds);

    return `
        <div class="breakdown-item-compact codex-usage-item">
            <div class="breakdown-header-compact">
                <span class="breakdown-name" data-i18n="usage.weeklyLimit"><i class="fas fa-calendar-alt"></i> ${t('usage.weeklyLimit')}</span>
                <span class="breakdown-usage">${secondaryPercent}%</span>
            </div>
            <div class="progress-bar-small ${secondaryProgressClass}">
                <div class="progress-fill" style="width: ${secondaryPercent}%"></div>
            </div>
            <div class="codex-reset-info" data-i18n="usage.resetInfo" data-i18n-params='{"time":"${secondaryResetText}"}'>
                <i class="fas fa-history"></i> ${t('usage.resetInfo', { time: secondaryResetText })}
            </div>
        </div>
    `;
}

/**
 * 格式化剩余时间
 * @param {number} seconds - 秒数
 * @returns {string} 格式化后的时间
 */
function formatTimeRemaining(seconds) {
    if (seconds <= 0) return t('usage.time.soon');
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return t('usage.time.days', { days, hours });
    if (hours > 0) return t('usage.time.hours', { hours, minutes });
    return t('usage.time.minutes', { minutes });
}

/**
 * 计算总用量（包含基础用量、免费试用和奖励）
 * @param {Array} usageBreakdown - 用量明细数组
 * @returns {Object} 总用量信息
 */
function calculateTotalUsage(usageBreakdown) {
    if (!usageBreakdown || usageBreakdown.length === 0) {
        return { hasData: false, used: 0, limit: 0, percent: 0 };
    }

    // 特殊处理 Codex
    const codexEntry = usageBreakdown.find(b => b.rateLimit && b.rateLimit.secondary_window);
    if (codexEntry) {
        const secondary = codexEntry.rateLimit.secondary_window;
        const secondaryPercent = secondary.used_percent || 0;
        
        // 只有当周限制达到 100% 时，总用量才显示 100%
        // 否则按正常逻辑计算（或者这里可以理解为非 100% 时不改变原有的总用量逻辑，
        // 但根据用户反馈，Codex 应该主要关注周限制）
        // 重新审视需求：达到周限制时，总用量直接100%，重置时间设置为周限制时间
        
        if (secondaryPercent >= 100) {
            return {
                hasData: true,
                used: 100,
                limit: 100,
                percent: 100,
                isCodex: true,
                resetAfterSeconds: secondary.reset_after_seconds
            };
        }
        // 如果未达到 100%，则继续执行下面的常规计算逻辑
    }

    let totalUsed = 0;
    let totalLimit = 0;

    for (const breakdown of usageBreakdown) {
        // 基础用量
        totalUsed += breakdown.currentUsage || 0;
        totalLimit += breakdown.usageLimit || 0;
        
        // 免费试用用量
        if (breakdown.freeTrial && breakdown.freeTrial.status === 'ACTIVE') {
            totalUsed += breakdown.freeTrial.currentUsage || 0;
            totalLimit += breakdown.freeTrial.usageLimit || 0;
        }
        
        // 奖励用量
        if (breakdown.bonuses && breakdown.bonuses.length > 0) {
            for (const bonus of breakdown.bonuses) {
                if (bonus.status === 'ACTIVE') {
                    totalUsed += bonus.currentUsage || 0;
                    totalLimit += bonus.usageLimit || 0;
                }
            }
        }
    }

    const percent = totalLimit > 0 ? Math.min(100, (totalUsed / totalLimit) * 100) : 0;

    return {
        hasData: true,
        used: totalUsed,
        limit: totalLimit,
        percent: percent
    };
}

/**
 * 获取提供商显示名称
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(providerType) {
    // 优先从外部传入的配置中获取名称
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.name) {
            return config.name;
        }
    }

    const names = {
        'claude-kiro-oauth': 'Claude Kiro OAuth',
        'gemini-cli-oauth': 'Gemini CLI OAuth',
        'gemini-antigravity': 'Gemini Antigravity',
        'openai-codex-oauth': 'Codex OAuth',
        'openai-qwen-oauth': 'Qwen OAuth',
        'grok-custom': 'Grok Reverse'
    };
    return names[providerType] || providerType;
}

/**
 * 获取提供商图标
 * @param {string} providerType - 提供商类型
 * @returns {string} 图标类名
 */
function getProviderIcon(providerType) {
    // 优先从外部传入的配置中获取图标
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.icon) {
            // 如果 icon 已经包含 fa- 则直接使用，否则加上 fas
            return config.icon.startsWith('fa-') ? `fas ${config.icon}` : config.icon;
        }
    }

    const icons = {
        'claude-kiro-oauth': 'fas fa-robot',
        'gemini-cli-oauth': 'fas fa-gem',
        'gemini-antigravity': 'fas fa-rocket',
        'openai-codex-oauth': 'fas fa-terminal',
        'openai-qwen-oauth': 'fas fa-code',
        'grok-custom': 'fas fa-brain'
    };
    return icons[providerType] || 'fas fa-server';
}


/**
 * 格式化数字（向上取整保留两位小数）
 * @param {number} num - 数字
 * @returns {string} 格式化后的数字
 */
function formatNumber(num) {
    if (num === null || num === undefined) return '0.00';
    // 向上取整到两位小数
    const rounded = Math.ceil(num * 100) / 100;
    return rounded.toFixed(2);
}

/**
 * 格式化日期
 * @param {string} dateStr - ISO 日期字符串
 * @returns {string} 格式化后的日期
 */
function formatDate(dateStr) {
    if (!dateStr) return '--';
    try {
        const date = new Date(dateStr);
        return date.toLocaleString(getCurrentLanguage(), {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}
