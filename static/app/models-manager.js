/**
 * Models Manager - 管理可用模型列表的显示和复制功能
 * Models Manager - Manages the display and copy functionality of available models
 */

import { t } from './i18n.js';

// 模型数据缓存
let modelsCache = null;

// 提供商配置缓存
let currentProviderConfigs = null;

// 模型模拟请求状态缓存
const modelSimulationState = new Map();
let simulationRunning = false;
let requiredApiKeyCache = null;
const PROVIDER_SIMULATION_CONCURRENCY = 3;
let activeSimulationProviderType = null;
let simulationTriggerMode = null; // 'batch' | 'single' | null
const MODEL_REQUEST_TIMEOUT_MS = 45000;

function tt(key, fallback) {
    const value = t(key);
    return value && value !== key ? value : fallback;
}

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
function updateModelsProviderConfigs(configs) {
    currentProviderConfigs = configs;
    // 如果已经加载了模型，重新渲染一次以更新显示名称和图标
    if (modelsCache) {
        renderModelsList(modelsCache);
    }
}

/**
 * 获取所有提供商的可用模型
 * @returns {Promise<Object>} 模型数据
 */
async function fetchProviderModels() {
    if (modelsCache) {
        return modelsCache;
    }
    
    try {
        const response = await fetch('/api/provider-models', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        modelsCache = await response.json();
        return modelsCache;
    } catch (error) {
        console.error('[Models Manager] Failed to fetch provider models:', error);
        throw error;
    }
}

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (error) {
        console.error('[Models Manager] Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * 显示复制成功的 Toast 提示
 * @param {string} modelName - 模型名称
 */
function showCopyToast(modelName) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${t('models.copied') || '已复制'}: ${modelName}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // 自动移除
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2000);
}

function showModelsToast(message, type = 'info') {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;

    const iconMap = {
        info: 'fa-circle-info',
        success: 'fa-check-circle',
        error: 'fa-circle-exclamation',
        warning: 'fa-triangle-exclamation'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <i class="fas ${iconMap[type] || iconMap.info}"></i>
        <span>${escapeHtml(message)}</span>
    `;

    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 2600);
}

/**
 * 渲染模型列表
 * @param {Object} models - 模型数据
 */
function renderModelsList(models) {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    // 检查是否有模型数据
    const providerTypes = Object.keys(models);
    if (providerTypes.length === 0) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-cube"></i>
                <p data-i18n="models.empty">${t('models.empty') || '暂无可用模型'}</p>
            </div>
        `;
        return;
    }
    
    // 渲染每个提供商的模型组
    let html = '';
    
    for (const providerType of providerTypes) {
        const modelList = models[providerType];
        if (!modelList || modelList.length === 0) continue;
        
        // 如果配置了不可见，则跳过
        if (currentProviderConfigs) {
            const config = currentProviderConfigs.find(c => c.id === providerType);
            if (config && config.visible === false) continue;
        }
        
        const providerDisplayName = getProviderDisplayName(providerType);
        const providerIcon = getProviderIcon(providerType);
        
        html += `
            <div class="provider-models-group" data-provider="${providerType}">
                <div class="provider-models-header" onclick="window.toggleProviderModels('${providerType}')">
                    <div class="provider-models-title">
                        <i class="${providerIcon}"></i>
                        <h3>${providerDisplayName}</h3>
                        <span class="provider-models-count">${modelList.length}</span>
                    </div>
                    <div class="provider-models-header-actions">
                        ${canRunSimulationForProvider(providerType) ? `
                            <button
                                class="provider-models-test-btn"
                                data-provider="${escapeHtml(providerType)}"
                                type="button"
                                onclick="window.simulateProviderModelsRequest('${escapeJsString(providerType)}', event)"
                                title="${tt('models.simulateProvider', '校验此分组全部模型')}">
                                <i class="${getProviderSimulationButtonIcon(providerType)}"></i>
                            </button>
                        ` : ''}
                        <div class="provider-models-toggle">
                        <i class="fas fa-chevron-down"></i>
                        </div>
                    </div>
                </div>
                <div class="provider-models-content" id="models-${providerType}">
                    ${modelList.map(model => `
                        <div class="model-item ${getModelStateClass(providerType, model)}"
                            onclick="window.handleModelItemClick('${escapeJsString(providerType)}', '${escapeJsString(model)}', this, event)">
                            <div class="model-item-icon">
                                <i class="fas fa-cube"></i>
                            </div>
                            <span class="model-item-name">${escapeHtml(model)}</span>
                            ${isModelLoading(providerType, model) ? `
                                <span class="model-item-loading">
                                    <i class="fas fa-spinner fa-spin"></i>
                                </span>
                            ` : ''}
                            ${hasModelRequestRecord(providerType, model) ? `
                                <button class="model-item-detail-btn"
                                    type="button"
                                    onclick="window.showModelRequestDetails('${escapeJsString(providerType)}', '${escapeJsString(model)}', event)"
                                    title="${tt('models.requestDetail', '请求详情')}">
                                    <i class="fas fa-circle-info"></i>
                                </button>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
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

    const displayNames = {
        'gemini-cli-oauth': 'Gemini CLI (OAuth)',
        'gemini-antigravity': 'Gemini Antigravity',
        'claude-custom': 'Claude Custom',
        'claude-kiro-oauth': 'Claude Kiro (OAuth)',
        'openai-custom': 'OpenAI Custom',
        'openaiResponses-custom': 'OpenAI Responses Custom',
        'openai-qwen-oauth': 'Qwen (OAuth)',
        'openai-iflow': 'iFlow',
        'openai-codex-oauth': 'OpenAI Codex (OAuth)'
    };

    return displayNames[providerType] || providerType;
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

    if (providerType.includes('gemini')) {
        return 'fas fa-gem';
    } else if (providerType.includes('claude')) {
        return 'fas fa-robot';
    } else if (providerType.includes('openai') || providerType.includes('qwen') || providerType.includes('iflow')) {
        return 'fas fa-brain';
    }
    return 'fas fa-server';
}

/**
 * HTML 转义
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * JS 字符串转义（用于内联事件参数）
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeJsString(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}

function getModelStateKey(providerType, modelName) {
    return `${providerType}::${modelName}`;
}

function getModelState(providerType, modelName) {
    return modelSimulationState.get(getModelStateKey(providerType, modelName)) || null;
}

function hasModelRequestRecord(providerType, modelName) {
    return !!getModelState(providerType, modelName);
}

function setModelState(providerType, modelName, state) {
    modelSimulationState.set(getModelStateKey(providerType, modelName), state);
}

function getModelStateClass(providerType, modelName) {
    const state = getModelState(providerType, modelName);
    if (!state || !state.status) return '';
    if (state.status === 'loading') return 'is-testing';
    if (state.status === 'success') return 'is-success';
    if (state.status === 'failed') return 'is-failed';
    return '';
}

function isModelLoading(providerType, modelName) {
    const state = getModelState(providerType, modelName);
    return !!(state && state.status === 'loading');
}

function getProviderSimulationButtonIcon(providerType) {
    if (simulationRunning && simulationTriggerMode === 'batch' && activeSimulationProviderType === providerType) {
        return 'fas fa-spinner fa-spin';
    }
    return 'fas fa-bolt';
}

function getModelRequestConfig(providerType, modelName) {
    if (providerType === 'openaiResponses-custom') {
        return {
            endpoint: `/${providerType}/v1/responses`,
            method: 'POST',
            body: {
                model: modelName,
                input: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'input_text',
                                text: 'ping'
                            }
                        ]
                    }
                ],
                max_output_tokens: 12
            }
        };
    }

    return {
        endpoint: `/${providerType}/v1/chat/completions`,
        method: 'POST',
        body: {
            model: modelName,
            messages: [
                {
                    role: 'user',
                    content: 'ping'
                }
            ],
            max_tokens: 12,
            temperature: 0,
            stream: false
        }
    };
}

function canRunSimulationForProvider(providerType) {
    if (!providerType || typeof providerType !== 'string') {
        return false;
    }
    return /^(gemini|claude|openai|grok|forward)-/.test(providerType);
}

async function getRequiredApiKey() {
    if (requiredApiKeyCache !== null) {
        return requiredApiKeyCache;
    }

    const config = await window.apiClient.get('/config');
    requiredApiKeyCache = config?.REQUIRED_API_KEY || '';
    return requiredApiKeyCache;
}

async function parseResponseError(response) {
    try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            return data?.error?.message || JSON.stringify(data);
        }
        const text = await response.text();
        return text || `HTTP ${response.status}`;
    } catch (error) {
        return `HTTP ${response.status}`;
    }
}

function normalizeResponseBody(rawBody) {
    if (rawBody === undefined || rawBody === null || rawBody === '') {
        return '';
    }
    try {
        const parsed = JSON.parse(rawBody);
        return JSON.stringify(parsed, null, 2);
    } catch {
        return String(rawBody);
    }
}

function buildDetailText(providerType, modelName, state = null) {
    if (!state) {
        return [
            `Provider: ${providerType}`,
            `Model: ${modelName}`,
            'Status: no request history'
        ].join('\n');
    }

    const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ***'
    };

    const sections = [
        `Provider: ${providerType}`,
        `Model: ${modelName}`,
        `Status: ${state.status || 'unknown'}`,
        state.failureType ? `Failure Type: ${state.failureType}` : null,
        state.httpStatus !== undefined ? `HTTP Status: ${state.httpStatus}` : null,
        state.durationMs !== undefined ? `Duration: ${state.durationMs}ms` : null,
        state.endpoint ? `Endpoint: ${state.endpoint}` : null,
        state.method ? `Method: ${state.method}` : null,
        '',
        '[Request Headers]',
        JSON.stringify(requestHeaders, null, 2),
        '',
        '[Request Body]',
        normalizeResponseBody(state.requestBody),
        '',
        '[Response Body]',
        normalizeResponseBody(state.responseBody),
        state.errorMessage ? '' : null,
        state.errorMessage ? '[Error Message]' : null,
        state.errorMessage || null
    ].filter(item => item !== null);

    return sections.join('\n');
}

function ensureModelDetailModal() {
    let modal = document.getElementById('modelRequestDetailModal');
    if (modal) {
        return modal;
    }

    modal = document.createElement('div');
    modal.id = 'modelRequestDetailModal';
    modal.className = 'model-detail-modal';
    modal.innerHTML = `
        <div class="model-detail-modal__backdrop" onclick="window.closeModelRequestDetails()"></div>
        <div class="model-detail-modal__dialog" role="dialog" aria-modal="true" aria-label="Request Details">
            <div class="model-detail-modal__header">
                <h4>Request Details</h4>
                <div class="model-detail-modal__actions">
                    <button type="button" class="model-detail-modal__copy" onclick="window.copyModelRequestDetails()">Copy</button>
                    <button type="button" class="model-detail-modal__close" onclick="window.closeModelRequestDetails()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
            <pre id="modelRequestDetailContent" class="model-detail-modal__content"></pre>
        </div>
    `;

    document.body.appendChild(modal);
    return modal;
}

function openModelRequestDetails(content) {
    const modal = ensureModelDetailModal();
    const contentEl = modal.querySelector('#modelRequestDetailContent');
    if (contentEl) {
        contentEl.textContent = content;
    }
    modal.classList.add('visible');
}

function closeModelRequestDetails() {
    const modal = document.getElementById('modelRequestDetailModal');
    if (modal) {
        modal.classList.remove('visible');
    }
}

async function copyModelRequestDetails() {
    const contentEl = document.getElementById('modelRequestDetailContent');
    if (!contentEl) return;
    await copyToClipboard(contentEl.textContent || '');
}

function updateSimulationButtonState() {
    const buttons = document.querySelectorAll('.provider-models-test-btn');
    buttons.forEach((btn) => {
        btn.disabled = simulationRunning;
        const providerType = btn.getAttribute('data-provider');
        const isActive = simulationRunning
            && simulationTriggerMode === 'batch'
            && activeSimulationProviderType
            && providerType === activeSimulationProviderType;
        btn.classList.toggle('loading', isActive);
    });
}

async function ensureServerReadyForSimulation() {
    try {
        const response = await fetch('/health');
        const data = await response.json().catch(() => ({}));
        const ready = data?.startup?.ready === true || data?.status === 'healthy';
        if (ready) {
            return true;
        }
        const phase = data?.startup?.phase ? ` (${data.startup.phase})` : '';
        showModelsToast(`系统初始化中，请稍后再试${phase}`, 'warning');
        return false;
    } catch (error) {
        showModelsToast('无法确认系统状态，请稍后再试', 'error');
        return false;
    }
}

async function runProviderSimulation(providerType, fn) {
    simulationRunning = true;
    activeSimulationProviderType = providerType;
    simulationTriggerMode = providerType ? (simulationTriggerMode || 'single') : null;
    updateSimulationButtonState();
    try {
        await fn();
    } finally {
        simulationRunning = false;
        activeSimulationProviderType = null;
        simulationTriggerMode = null;
        updateSimulationButtonState();
    }
}

function parseSimulationResponseStatus(httpStatus, rawBody) {
    let normalizedBody = rawBody || '';
    let isBodyError = false;
    let bodyErrorMessage = '';
    let bodyErrorType = '';
    let bodyErrorCode = '';

    try {
        const data = JSON.parse(rawBody || '{}');
        if (data && typeof data === 'object' && data.error) {
            isBodyError = true;
            bodyErrorMessage = data.error?.message || JSON.stringify(data.error);
            bodyErrorType = String(data.error?.type || '');
            bodyErrorCode = String(data.error?.code || '');
        }
    } catch {
        // ignore json parse errors for non-json response
    }

    const isHttpOk = httpStatus >= 200 && httpStatus < 300;
    const isSuccess = isHttpOk && !isBodyError;

    return {
        isSuccess,
        bodyErrorMessage,
        bodyErrorType,
        bodyErrorCode,
        normalizedBody
    };
}

function classifySimulationFailure({ httpStatus, errorType = '', errorCode = '', errorMessage = '' }) {
    const typeLower = String(errorType || '').toLowerCase();
    const codeLower = String(errorCode || '').toLowerCase();
    const msgLower = String(errorMessage || '').toLowerCase();

    if (httpStatus === 401 || httpStatus === 403) return 'auth_error';
    if (httpStatus === 429 || typeLower.includes('rate_limit') || codeLower.includes('rate_limit') || msgLower.includes('rate limit')) {
        return 'rate_limit_error';
    }
    if (httpStatus >= 500 && httpStatus < 600) return 'server_error';
    if (msgLower.includes('timeout')) return 'timeout_error';
    if (msgLower.includes('network') || msgLower.includes('failed to fetch') || msgLower.includes('econn')) return 'network_error';
    if (httpStatus >= 400 && httpStatus < 500) return 'client_error';
    return 'unknown_error';
}

async function simulateModelRequest(providerType, modelName) {
    const reqConfig = getModelRequestConfig(providerType, modelName);
    setModelState(providerType, modelName, {
        status: 'loading',
        endpoint: reqConfig.endpoint,
        method: reqConfig.method,
        requestBody: JSON.stringify(reqConfig.body)
    });
    if (modelsCache) {
        renderModelsList(modelsCache);
    }

    const startedAt = Date.now();

    try {
        const apiKey = await getRequiredApiKey();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(reqConfig.endpoint, {
                method: reqConfig.method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(reqConfig.body),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timer);
        }

        const durationMs = Date.now() - startedAt;
        const responseBodyRaw = await response.text();
        const parsedStatus = parseSimulationResponseStatus(response.status, responseBodyRaw);

        if (parsedStatus.isSuccess) {
            setModelState(providerType, modelName, {
                status: 'success',
                endpoint: reqConfig.endpoint,
                method: reqConfig.method,
                requestBody: JSON.stringify(reqConfig.body),
                httpStatus: response.status,
                durationMs,
                responseBody: parsedStatus.normalizedBody
            });
        } else {
            let errorMessage = parsedStatus.bodyErrorMessage || `HTTP ${response.status}`;
            if (!parsedStatus.bodyErrorMessage && responseBodyRaw) {
                errorMessage = responseBodyRaw;
            }
            setModelState(providerType, modelName, {
                status: 'failed',
                failureType: classifySimulationFailure({
                    httpStatus: response.status,
                    errorType: parsedStatus.bodyErrorType,
                    errorCode: parsedStatus.bodyErrorCode,
                    errorMessage
                }),
                endpoint: reqConfig.endpoint,
                method: reqConfig.method,
                requestBody: JSON.stringify(reqConfig.body),
                httpStatus: response.status,
                durationMs,
                errorMessage,
                responseBody: parsedStatus.normalizedBody
            });
        }
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        const errorMessage = error.name === 'AbortError'
            ? `Request timeout after ${MODEL_REQUEST_TIMEOUT_MS}ms`
            : (error.message || 'Request failed');
        setModelState(providerType, modelName, {
            status: 'failed',
            failureType: classifySimulationFailure({
                httpStatus: 0,
                errorMessage
            }),
            endpoint: reqConfig.endpoint,
            method: reqConfig.method,
            requestBody: JSON.stringify(reqConfig.body),
            durationMs,
            errorMessage
        });
    }

    if (modelsCache) {
        renderModelsList(modelsCache);
    }
}

async function simulateSingleModelRequest(providerType, modelName, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    if (simulationRunning) {
        return;
    }
    const ready = await ensureServerReadyForSimulation();
    if (!ready) return;
    simulationTriggerMode = 'single';
    await runProviderSimulation(providerType, async () => {
        await simulateModelRequest(providerType, modelName);
    });
}

async function handleModelItemClick(providerType, modelName, element, event) {
    if (event) {
        event.preventDefault();
    }

    await copyModelName(modelName, element);
    await simulateSingleModelRequest(providerType, modelName);
}

function showModelRequestDetails(providerType, modelName, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    const state = getModelState(providerType, modelName);
    const content = buildDetailText(providerType, modelName, state);
    openModelRequestDetails(content);
}

async function simulateProviderModelsRequest(providerType, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    if (simulationRunning) {
        return;
    }

    if (!modelsCache) {
        await initModelsManager();
    }

    if (!modelsCache) {
        return;
    }
    const ready = await ensureServerReadyForSimulation();
    if (!ready) return;
    simulationTriggerMode = 'batch';
    await runProviderSimulation(providerType, async () => {
        const modelList = modelsCache[providerType] || [];
        const concurrency = Math.max(1, Math.min(PROVIDER_SIMULATION_CONCURRENCY, modelList.length || 1));
        const queue = [...modelList];

        const workers = Array.from({ length: concurrency }, async () => {
            while (queue.length > 0) {
                const modelName = queue.shift();
                if (!modelName) {
                    continue;
                }
                await simulateModelRequest(providerType, modelName);
            }
        });

        await Promise.all(workers);
    });
}

/**
 * 切换提供商模型列表的展开/折叠状态
 * @param {string} providerType - 提供商类型
 */
function toggleProviderModels(providerType) {
    const group = document.querySelector(`.provider-models-group[data-provider="${providerType}"]`);
    if (!group) return;
    
    const header = group.querySelector('.provider-models-header');
    const content = group.querySelector('.provider-models-content');
    
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        header.classList.remove('collapsed');
    } else {
        content.classList.add('collapsed');
        header.classList.add('collapsed');
    }
}

/**
 * 复制模型名称
 * @param {string} modelName - 模型名称
 * @param {HTMLElement} element - 点击的元素
 */
async function copyModelName(modelName, element) {
    const success = await copyToClipboard(modelName);
    
    if (success) {
        // 显示 Toast 提示
        showCopyToast(modelName);
    }
}

/**
 * 初始化模型管理器
 */
async function initModelsManager() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    try {
        const models = await fetchProviderModels();
        renderModelsList(models);
    } catch (error) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${t('models.loadError') || '加载模型列表失败'}</p>
            </div>
        `;
    }
}

function bindModelSimulationEvents() {
    updateSimulationButtonState();
}

/**
 * 刷新模型列表
 */
async function refreshModels() {
    modelsCache = null;
    await initModelsManager();
}

// 导出到全局作用域供 HTML 调用
window.toggleProviderModels = toggleProviderModels;
window.copyModelName = copyModelName;
window.handleModelItemClick = handleModelItemClick;
window.refreshModels = refreshModels;
window.simulateSingleModelRequest = simulateSingleModelRequest;
window.simulateProviderModelsRequest = simulateProviderModelsRequest;
window.showModelRequestDetails = showModelRequestDetails;
window.closeModelRequestDetails = closeModelRequestDetails;
window.copyModelRequestDetails = copyModelRequestDetails;

// 监听组件加载完成事件
window.addEventListener('componentsLoaded', () => {
    bindModelSimulationEvents();
    initModelsManager();
});

// 导出函数
export {
    initModelsManager,
    refreshModels,
    fetchProviderModels,
    updateModelsProviderConfigs
};
