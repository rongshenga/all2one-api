import { jest } from '@jest/globals';

function createClassList(initial = []) {
    const classes = new Set(initial);
    return {
        add(name) {
            classes.add(name);
        },
        remove(name) {
            classes.delete(name);
        },
        toggle(name, force) {
            if (force === undefined) {
                if (classes.has(name)) {
                    classes.delete(name);
                    return false;
                }
                classes.add(name);
                return true;
            }
            if (force) {
                classes.add(name);
                return true;
            }
            classes.delete(name);
            return false;
        },
        contains(name) {
            return classes.has(name);
        }
    };
}

function createMockElement(initial = {}) {
    const listeners = new Map();
    const attributes = new Map();
    return {
        className: initial.className || '',
        classList: initial.classList || createClassList(initial.classes || []),
        style: initial.style || {},
        dataset: initial.dataset || {},
        hidden: initial.hidden ?? false,
        disabled: initial.disabled ?? false,
        textContent: initial.textContent || '',
        innerHTML: initial.innerHTML || '',
        title: initial.title || '',
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        querySelector: initial.querySelector || jest.fn(() => null),
        setAttribute(name, value) {
            attributes.set(name, String(value));
            if (name.startsWith('data-')) {
                const datasetKey = name.slice(5).replace(/-([a-z])/g, (_, part) => part.toUpperCase());
                this.dataset[datasetKey] = String(value);
            }
            this[name] = String(value);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        trigger(type, event = {}) {
            const handler = listeners.get(type);
            if (handler) {
                return handler(event);
            }
            return undefined;
        }
    };
}

function createDiagnosticsContainer() {
    const nodes = {
        '#runtimeStorageMode': createMockElement(),
        '#runtimeStorageSource': createMockElement(),
        '#runtimeStorageProviderSummary': createMockElement(),
        '#runtimeStorageValidation': createMockElement(),
        '#runtimeStorageError': createMockElement(),
        '#runtimeStorageAlert': createMockElement({ hidden: true, dataset: {} }),
        '#runtimeStorageReloadBtn': createMockElement(),
        '#runtimeStorageExportBtn': createMockElement(),
        '#runtimeStorageRollbackBtn': createMockElement()
    };

    const container = createMockElement({ dataset: {} });
    container.querySelector = jest.fn((selector) => nodes[selector] || null);
    return {
        container,
        nodes
    };
}

function matchesClassSelector(element, selector) {
    if (!element || typeof selector !== 'string' || !selector.startsWith('.')) {
        return false;
    }

    const targetClass = selector.slice(1);
    const classNames = String(element.className || '').split(/\s+/).filter(Boolean);
    return classNames.includes(targetClass);
}

function findFirstClassMatch(root, selector) {
    const children = Array.isArray(root?.children) ? root.children : [];
    for (const child of children) {
        if (matchesClassSelector(child, selector)) {
            return child;
        }
        const nested = findFirstClassMatch(child, selector);
        if (nested) {
            return nested;
        }
    }
    return null;
}

function createTreeElement(initial = {}) {
    const element = createMockElement(initial);
    const virtualNodes = new Map();

    element.querySelector = jest.fn((selector) => {
        const actualMatch = findFirstClassMatch(element, selector);
        if (actualMatch) {
            return actualMatch;
        }

        if (virtualNodes.has(selector)) {
            return virtualNodes.get(selector);
        }

        if (selector === '.usage-group-title' && String(element.innerHTML || '').includes('usage-group-title')) {
            const node = createTreeElement({ className: 'usage-group-title' });
            virtualNodes.set(selector, node);
            return node;
        }

        if (selector === 'i' && String(element.innerHTML || '').includes('<i')) {
            const iconNode = createTreeElement();
            virtualNodes.set(selector, iconNode);
            return iconNode;
        }

        return null;
    });

    element.querySelectorAll = jest.fn((selector) => {
        const matches = [];
        const walk = (node) => {
            const children = Array.isArray(node?.children) ? node.children : [];
            for (const child of children) {
                if (matchesClassSelector(child, selector)) {
                    matches.push(child);
                }
                walk(child);
            }
        };
        walk(element);
        return matches;
    });

    return element;
}

describe('frontend event stream and usage manager', () => {
    let showToast;
    let loadProviders;
    let refreshProviderConfig;
    let dispatchEvent;
    let eventStreamModule;
    let usageManagerModule;
    let usageSection;
    let usageLoadingText;
    let usageLoading;
    let usageError;
    let usageErrorMessage;
    let usageEmpty;
    let usageContent;
    let usageLastUpdate;
    let fetchCalls;
    let serverTimeValue;

    beforeEach(async () => {
        jest.resetModules();
        showToast = jest.fn();
        loadProviders = jest.fn();
        refreshProviderConfig = jest.fn();
        dispatchEvent = jest.fn();
        fetchCalls = [];

        usageSection = createMockElement({ classList: createClassList([]) });
        usageLoadingText = createMockElement();
        usageLoading = createMockElement({
            style: { display: 'none' },
            querySelector: jest.fn((selector) => selector === 'span' ? usageLoadingText : null)
        });
        usageError = createMockElement({ style: { display: 'none' } });
        usageErrorMessage = createMockElement();
        usageEmpty = createMockElement({ style: { display: 'none' } });
        usageContent = createMockElement();
        usageLastUpdate = createMockElement({ dataset: {} });
        serverTimeValue = createMockElement();

        global.CustomEvent = class CustomEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.detail = init.detail;
            }
        };

        global.window = {
            dispatchEvent,
            confirm: jest.fn(() => true)
        };

        global.document = {
            getElementById: jest.fn((id) => {
                const mapping = {
                    usage: usageSection,
                    usageLoading: usageLoading,
                    usageError: usageError,
                    usageErrorMessage: usageErrorMessage,
                    usageEmpty: usageEmpty,
                    usageContent: usageContent,
                    usageLastUpdate: usageLastUpdate,
                    serverTimeValue: serverTimeValue
                };
                return mapping[id] || null;
            }),
            querySelector: jest.fn(() => null),
            createElement: jest.fn(() => createMockElement())
        };

        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage') {
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    json: async () => ({})
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        jest.doMock('../static/app/i18n.js', () => ({
            t: (key, params = {}) => {
                if (key === 'usage.taskCompleted') return '刷新完成';
                if (key === 'usage.taskCompletedSummary') return `汇总 正常${params.normal} 用光${params.quotaExhausted} 异常${params.exception}`;
                if (key === 'usage.taskFailed') return '刷新失败';
                if (key === 'usage.taskCanceled') return '刷新已取消';
                if (key === 'usage.taskCancel') return '取消刷新';
                if (key === 'usage.taskCanceling') return '取消中...';
                if (key === 'usage.group.taskInlineMeta') return `${params.processed}/${params.total}`;
                if (key === 'usage.allProviders') return '全部提供商';
                if (key === 'usage.refreshScope.page') return '当前页';
                if (key === 'usage.refreshScope.providerAll') return '该提供商全部账号';
                if (key === 'usage.refreshEstimateConfirm') return `${params.provider}:${params.count}:${params.seconds}`;
                if (key === 'usage.taskProgress') return `${params.provider}|${params.processed}/${params.total}|${params.percent}`;
                if (key === 'usage.loading') return '加载中';
                if (key === 'usage.taskStarted') return '任务已开始';
                if (key === 'usage.taskPreparing') return '任务准备中';
                if (key === 'usage.lastUpdateCache') return `缓存更新 ${params.time}`;
                if (key === 'usage.lastUpdate') return `实时更新 ${params.time}`;
                if (key === 'common.success') return '成功';
                if (key === 'common.error') return '错误';
                if (key === 'common.info') return '提示';
                return key;
            },
            getCurrentLanguage: () => 'zh-CN'
        }));

        jest.doMock('../static/app/utils.js', () => ({
            escapeHtml: (value) => String(value),
            showToast,
            getProviderConfigs: () => ([
                { id: 'grok-custom', name: 'Grok Reverse' },
                { id: 'openai-codex-oauth', name: 'Codex OAuth' }
            ])
        }));

        jest.doMock('../static/app/constants.js', () => {
            const serverStatus = createMockElement({
                classList: createClassList([]),
                querySelector: jest.fn((selector) => {
                    if (selector === 'i') {
                        return { style: {} };
                    }
                    if (selector === 'span') {
                        return { textContent: '' };
                    }
                    return null;
                })
            });
            return {
                eventSource: null,
                autoScroll: true,
                elements: {
                    serverStatus,
                    logsContainer: null
                },
                addLog: jest.fn(),
                setEventSource: jest.fn()
            };
        });

        jest.doMock('../static/app/auth.js', () => ({
            getAuthHeaders: () => ({ Authorization: 'Bearer test' })
        }));

        eventStreamModule = await import('../static/app/event-stream.js');
        usageManagerModule = await import('../static/app/usage-manager.js');

        eventStreamModule.setProviderLoaders(loadProviders, refreshProviderConfig);
    });

    test('should render connected and disconnected server status states', async () => {
        const { elements } = await import('../static/app/constants.js');
        eventStreamModule.updateServerStatus(true);
        expect(elements.serverStatus.classList.contains('error')).toBe(false);
        expect(elements.serverStatus.innerHTML).toContain('header.status.connected');

        eventStreamModule.updateServerStatus(false);
        expect(elements.serverStatus.classList.contains('error')).toBe(true);
        expect(elements.serverStatus.innerHTML).toContain('header.status.disconnected');
    });

    test('should route provider updates to the correct loaders', () => {
        const modal = {
            getAttribute: jest.fn(() => 'grok-custom')
        };
        global.document.querySelector.mockReturnValueOnce(modal);
        eventStreamModule.handleProviderUpdate({ action: 'update', providerType: 'grok-custom' });
        expect(refreshProviderConfig).toHaveBeenCalledWith('grok-custom');

        global.document.querySelector.mockReturnValueOnce(null);
        eventStreamModule.handleProviderUpdate({ action: 'delete', providerType: 'openai-codex-oauth' });
        expect(loadProviders).toHaveBeenCalledWith(expect.objectContaining({
            showLoading: false
        }));

    });

    test('should dispatch usage refresh events and suppress toast when usage section is active', () => {
        eventStreamModule.handleUsageRefresh({
            providerType: 'grok-custom',
            status: 'completed'
        });
        expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'usage_refresh_event'
        }));
        expect(showToast).toHaveBeenCalledWith('成功', 'Grok Reverse 刷新完成', 'success');

        showToast.mockClear();
        usageSection.classList.add('active');
        eventStreamModule.handleUsageRefresh({
            providerType: 'grok-custom',
            status: 'failed',
            error: 'network down'
        });
        expect(showToast).not.toHaveBeenCalled();
    });

    test('should hide provider groups with zero instances from the usage list', async () => {
        const originalCreateElement = global.document.createElement;
        global.document.createElement = jest.fn(() => createTreeElement());
        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        providers: {
                            'claude-kiro-oauth': {
                                totalCount: 0,
                                successCount: 0,
                                errorCount: 0,
                                processedCount: 0,
                                instances: []
                            },
                            'gemini-cli-oauth': {
                                totalCount: 1,
                                successCount: 1,
                                errorCount: 0,
                                processedCount: 1,
                                instances: [
                                    {
                                        uuid: 'gemini-1',
                                        name: 'Gemini One',
                                        success: true,
                                        usage: { usageBreakdown: [] }
                                    }
                                ]
                            }
                        },
                        timestamp: '2026-03-06T10:00:00.000Z',
                        serverTime: '2026-03-06T10:00:01.000Z'
                    })
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await usageManagerModule.loadUsage();

        expect(usageContent.children).toHaveLength(1);
        expect(usageContent.children[0].dataset.providerType).toBe('gemini-cli-oauth');
        global.document.createElement = originalCreateElement;
    });

    test('should expose loading helpers and show usage fetch errors in the UI', async () => {
        usageManagerModule.setUsageLoadingText(usageLoading, '刷新中');
        expect(usageLoadingText.textContent).toBe('刷新中');
        expect(usageManagerModule.buildUsageTaskProgressText({
            providerType: 'grok-custom',
            progress: {
                currentProvider: 'openai-codex-oauth',
                processedInstances: 3,
                totalInstances: 7,
                percent: 42.857
            }
        }, 'Fallback')).toBe('Codex OAuth|3/7|42.9');
        expect(usageManagerModule.shouldShowUsage('gemini-antigravity')).toBe(false);
        expect(usageManagerModule.shouldShowUsage('grok-custom')).toBe(true);

        await usageManagerModule.loadUsage();
        expect(fetchCalls).toContain('/api/usage');
        expect(usageError.style.display).toBe('block');
        expect(usageErrorMessage.textContent).toBe('HTTP 503: Service Unavailable');
    });

    test('should lazy load provider usage details without appendChild errors when summary has no prebuilt grid', async () => {
        const originalCreateElement = global.document.createElement;
        global.document.createElement = jest.fn(() => createTreeElement());
        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        providers: {
                            'gemini-cli-oauth': {
                                totalCount: 1,
                                successCount: 1,
                                errorCount: 0,
                                processedCount: 1,
                                timestamp: '2026-03-06T10:00:00.000Z',
                                instances: []
                            }
                        },
                        timestamp: '2026-03-06T10:00:00.000Z',
                        serverTime: '2026-03-06T10:00:01.000Z'
                    })
                };
            }
            if (String(url) === '/api/usage/gemini-cli-oauth?page=1&limit=30') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        totalCount: 31,
                        availableCount: 31,
                        page: 1,
                        limit: 30,
                        totalPages: 2,
                        hasPrevPage: false,
                        hasNextPage: true,
                        successCount: 1,
                        errorCount: 0,
                        processedCount: 1,
                        timestamp: '2026-03-06T10:00:00.000Z',
                        instances: [
                            {
                                uuid: 'gemini-1',
                                name: 'Gemini Account 1',
                                success: true,
                                isHealthy: true,
                                isDisabled: false,
                                usage: {
                                    usageBreakdown: [],
                                    user: {},
                                    subscription: {}
                                }
                            }
                        ]
                    })
                };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        await usageManagerModule.loadUsage();

        const groupContainer = usageContent.children[0];
        groupContainer.classList.add('collapsed');
        const header = groupContainer.children[0];
        const titleDiv = header.querySelector('.usage-group-title');
        await titleDiv.trigger('click');

        expect(fetchCalls).toContain('/api/usage/gemini-cli-oauth?page=1&limit=30');
        expect(groupContainer.dataset.detailsLoaded).toBe('true');

        const content = groupContainer.querySelector('.usage-group-content');
        expect(content.children.some((child) => String(child.className || '').includes('usage-cards-grid'))).toBe(true);
        const pagination = content.querySelector('.usage-group-pagination');
        expect(pagination).toBeTruthy();
        expect(Array.isArray(pagination.children)).toBe(true);
        expect(pagination.children).toHaveLength(3);
        expect(pagination.children.some((child) => String(child.className || '').includes('usage-group-page-status'))).toBe(true);
        expect(pagination.children.some((child) => String(child.className || '').includes('usage-page-info'))).toBe(false);

        global.document.createElement = originalCreateElement;
    });

    test('should toggle loading state during successful usage refresh', async () => {
        usageSection.classList.add('active');
        let resolveFetchUsage;
        global.fetch = jest.fn((url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage') {
                return new Promise((resolve) => {
                    resolveFetchUsage = () => resolve({
                        ok: true,
                        json: async () => ({
                            providers: {},
                            fromCache: true,
                            timestamp: '2026-03-06T10:00:00.000Z',
                            serverTime: '2026-03-06T10:00:01.000Z'
                        })
                    });
                });
            }
            throw new Error(`Unexpected fetch: ${url}`);
        });

        const refreshPromise = usageManagerModule.refreshUsage();
        expect(usageLoading.style.display).toBe('block');
        resolveFetchUsage();
        await refreshPromise;

        expect(fetchCalls).toEqual(['/api/usage']);
        expect(usageLoading.style.display).toBe('none');
        expect(usageLoadingText.textContent).toBe('');
        expect(showToast).not.toHaveBeenCalled();
        expect(serverTimeValue.textContent).toBeTruthy();
    });

    test('should poll bootstrap task when initial usage request returns 202', async () => {
        usageSection.classList.add('active');
        let usageFetchCount = 0;
        let taskStatusPollCount = 0;

        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));
            if (String(url) === '/api/usage') {
                usageFetchCount += 1;
                if (usageFetchCount === 1) {
                    return {
                        ok: true,
                        status: 202,
                        statusText: 'Accepted',
                        json: async () => ({
                            taskId: 'bootstrap-task-1',
                            pollIntervalMs: 1
                        })
                    };
                }

                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        providers: {},
                        totalCount: 0,
                        successCount: 0,
                        errorCount: 0,
                        timestamp: '2026-03-06T10:00:00.000Z',
                        serverTime: '2026-03-06T10:00:01.000Z'
                    })
                };
            }

            if (String(url) === '/api/usage/tasks/bootstrap-task-1') {
                taskStatusPollCount += 1;
                return {
                    ok: true,
                    json: async () => taskStatusPollCount === 1
                        ? {
                            status: 'running',
                            providerType: 'grok-custom',
                            pollIntervalMs: 1,
                            progress: {
                                currentProvider: 'grok-custom',
                                processedInstances: 1,
                                totalInstances: 2,
                                percent: 50
                            }
                        }
                        : {
                            status: 'completed',
                            providerType: 'grok-custom'
                        }
                };
            }

            throw new Error(`Unexpected fetch: ${url}`);
        });

        await usageManagerModule.loadUsage();

        expect(fetchCalls.filter((url) => url === '/api/usage')).toHaveLength(2);
        expect(fetchCalls).toContain('/api/usage/tasks/bootstrap-task-1');
        expect(usageLoading.style.display).toBe('none');
        expect(serverTimeValue.textContent).toBeTruthy();
    });

    test('should invalidate and reload expanded provider details after provider refresh', async () => {
        const originalCreateElement = global.document.createElement;
        global.document.createElement = jest.fn(() => createTreeElement());
        usageSection.classList.add('active');

        let usageFetchCount = 0;
        let taskStatusPollCount = 0;
        global.fetch = jest.fn(async (url) => {
            fetchCalls.push(String(url));

            if (String(url) === '/api/usage') {
                usageFetchCount += 1;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        providers: {
                            'gemini-cli-oauth': {
                                totalCount: 1,
                                successCount: 1,
                                errorCount: 0,
                                processedCount: 1,
                                instances: []
                            }
                        },
                        timestamp: `2026-03-06T10:00:0${usageFetchCount}.000Z`,
                        serverTime: '2026-03-06T10:00:10.000Z'
                    })
                };
            }

            if (String(url) === '/api/usage/gemini-cli-oauth?refresh=true&async=true&scope=page&page=1') {
                return {
                    ok: true,
                    status: 202,
                    statusText: 'Accepted',
                    json: async () => ({
                        taskId: 'provider-task-1',
                        pollIntervalMs: 1
                    })
                };
            }

            if (String(url) === '/api/usage/tasks/provider-task-1') {
                taskStatusPollCount += 1;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => taskStatusPollCount === 1
                        ? {
                            status: 'running',
                            providerType: 'gemini-cli-oauth',
                            pollIntervalMs: 1,
                            progress: {
                                currentProvider: 'gemini-cli-oauth',
                                processedInstances: 1,
                                totalInstances: 1,
                                percent: 100
                            }
                        }
                        : {
                            status: 'completed',
                            providerType: 'gemini-cli-oauth',
                            result: {
                                summary: {
                                    normalCount: 1,
                                    quotaExhaustedCount: 0,
                                    exceptionCount: 0
                                }
                            }
                        }
                };
            }

            if (String(url) === '/api/usage/gemini-cli-oauth?page=1&limit=30') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        totalCount: 1,
                        successCount: 1,
                        errorCount: 0,
                        processedCount: 1,
                        timestamp: '2026-03-06T10:00:20.000Z',
                        instances: [
                            {
                                uuid: 'gemini-1',
                                name: 'Gemini Account 1',
                                success: true,
                                isHealthy: true,
                                isDisabled: false,
                                usage: {
                                    usageBreakdown: [],
                                    user: {},
                                    subscription: {}
                                }
                            }
                        ]
                    })
                };
            }

            throw new Error(`Unexpected fetch: ${url}`);
        });

        await usageManagerModule.loadUsage();

        const initialGroup = usageContent.children[0];
        initialGroup.classList.remove('collapsed');
        initialGroup.dataset.detailsLoaded = 'true';
        initialGroup.__usageProviderData = {
            providerType: 'gemini-cli-oauth',
            totalCount: 1,
            successCount: 1,
            errorCount: 0,
            processedCount: 1,
            detailsLoaded: true,
            instances: [
                {
                    uuid: 'stale-gemini-1',
                    name: 'Stale Gemini Account',
                    success: true,
                    usage: {
                        usageBreakdown: []
                    }
                }
            ]
        };

        await usageManagerModule.refreshProviderUsage('gemini-cli-oauth');

        expect(fetchCalls).toContain('/api/usage/gemini-cli-oauth?refresh=true&async=true&scope=page&page=1');
        expect(fetchCalls).toContain('/api/usage/gemini-cli-oauth?page=1&limit=30');
        expect(fetchCalls.filter((url) => url === '/api/usage')).toHaveLength(2);
        expect(usageLoading.style.display).toBe('none');
        expect(showToast).toHaveBeenCalledWith('成功', '汇总 正常1 用光0 异常0', 'success');

        const refreshedGroup = usageContent.children[0];
        expect(refreshedGroup.classList.contains('collapsed')).toBe(false);
        expect(refreshedGroup.dataset.detailsLoaded).toBe('true');

        global.document.createElement = originalCreateElement;
    });

    test('should send cancel request for provider task and show canceled toast', async () => {
        const originalCreateElement = global.document.createElement;
        global.document.createElement = jest.fn(() => createTreeElement());
        usageSection.classList.add('active');
        global.window.confirm = jest.fn(() => true);

        let taskStatusPollCount = 0;
        let cancelRequested = false;
        global.fetch = jest.fn(async (url, options = {}) => {
            fetchCalls.push(String(url));

            if (String(url) === '/api/usage') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        providers: {
                            'gemini-cli-oauth': {
                                totalCount: 2500,
                                successCount: 2500,
                                errorCount: 0,
                                processedCount: 2500,
                                instances: []
                            }
                        },
                        timestamp: '2026-03-06T10:00:00.000Z',
                        serverTime: '2026-03-06T10:00:10.000Z'
                    })
                };
            }

            if (String(url) === '/api/usage/gemini-cli-oauth?refresh=true&async=true&scope=provider_all') {
                return {
                    ok: true,
                    status: 202,
                    statusText: 'Accepted',
                    json: async () => ({
                        taskId: 'provider-task-cancel-1',
                        status: 'running',
                        providerType: 'gemini-cli-oauth',
                        scope: 'provider_all',
                        limit: 30,
                        pollIntervalMs: 1
                    })
                };
            }

            if (String(url) === '/api/usage/tasks/provider-task-cancel-1' && String(options.method || 'GET').toUpperCase() === 'POST') {
                cancelRequested = true;
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        taskId: 'provider-task-cancel-1',
                        status: 'canceling',
                        providerType: 'gemini-cli-oauth',
                        cancelRequestedAt: '2026-03-06T10:00:11.000Z'
                    })
                };
            }

            if (String(url) === '/api/usage/tasks/provider-task-cancel-1') {
                taskStatusPollCount += 1;
                const status = cancelRequested
                    ? (taskStatusPollCount > 2 ? 'canceled' : 'canceling')
                    : 'running';
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        status,
                        providerType: 'gemini-cli-oauth',
                        pollIntervalMs: 1,
                        progress: {
                            currentProvider: 'gemini-cli-oauth',
                            processedInstances: 2,
                            totalInstances: 10,
                            percent: 20
                        }
                    })
                };
            }

            if (String(url) === '/api/usage/gemini-cli-oauth?page=1&limit=30') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    json: async () => ({
                        totalCount: 2500,
                        successCount: 2500,
                        errorCount: 0,
                        processedCount: 2500,
                        timestamp: '2026-03-06T10:00:20.000Z',
                        instances: []
                    })
                };
            }

            throw new Error(`Unexpected fetch: ${url}`);
        });

        await usageManagerModule.loadUsage();
        await usageManagerModule.refreshProviderUsage('gemini-cli-oauth', { scope: 'provider_all' });

        const group = usageContent.children[0];
        const indicator = group.querySelector('.usage-task-indicator');
        const cancelBtn = indicator?.querySelector('.btn-usage-task-cancel');
        expect(cancelBtn).toBeTruthy();
        await cancelBtn.trigger('click', { stopPropagation: jest.fn() });

        await new Promise((resolve) => setTimeout(resolve, 60));

        const cancelCall = global.fetch.mock.calls.find(([requestUrl, requestOptions]) => (
            String(requestUrl) === '/api/usage/tasks/provider-task-cancel-1'
            && String(requestOptions?.method || 'GET').toUpperCase() === 'POST'
        ));
        expect(cancelCall).toBeTruthy();
        expect(showToast).toHaveBeenCalledWith('提示', '刷新已取消', 'info');

        global.document.createElement = originalCreateElement;
    });
});

describe('frontend runtime storage diagnostics panel', () => {
    let providerManagerModule;
    let showToast;

    beforeEach(async () => {
        jest.resetModules();
        showToast = jest.fn();
        global.window = {
            apiClient: {
                post: jest.fn()
            }
        };
        global.localStorage = {
            getItem: jest.fn(() => 'token')
        };

        jest.doMock('../static/app/constants.js', () => ({
            providerStats: {},
            updateProviderStats: jest.fn()
        }));
        jest.doMock('../static/app/utils.js', () => ({
            showToast,
            getProviderConfigs: jest.fn(() => [])
        }));
        jest.doMock('../static/app/file-upload.js', () => ({
            fileUploadHandler: {}
        }));
        jest.doMock('../static/app/i18n.js', () => ({
            t: (key) => key,
            getCurrentLanguage: () => 'zh-CN'
        }));
        jest.doMock('../static/app/routing-examples.js', () => ({
            renderRoutingExamples: jest.fn()
        }));
        jest.doMock('../static/app/models-manager.js', () => ({
            updateModelsProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/tutorial-manager.js', () => ({
            updateTutorialProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/usage-manager.js', () => ({
            updateUsageProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/config-manager.js', () => ({
            updateConfigProviderConfigs: jest.fn()
        }));
        jest.doMock('../static/app/event-handlers.js', () => ({
            setServiceMode: jest.fn()
        }));

        providerManagerModule = await import('../static/app/provider-manager.js');
    });

    test('should build storage diagnostics view models with alerts permissions and suggested run id', () => {
        const viewModel = providerManagerModule.buildRuntimeStorageDiagnosticsViewModel({
            runtimeStorage: {
                backend: 'db',
                requestedBackend: 'db',
                authoritativeSource: 'database',
                lastValidation: {
                    overallStatus: 'warn',
                    runId: 'run-validate-1'
                }
            },
            providerSummary: {
                providerTypeCount: 2,
                providerCount: 5
            }
        }, {
            hasAdminAccess: false
        });

        expect(viewModel.storageMode).toBe('db');
        expect(viewModel.storageModeLabel).toBe('数据库');
        expect(viewModel.sourceOfTruthLabel).toBe('数据库');
        expect(viewModel.readOnly).toBe(true);
        expect(viewModel.alert).toMatchObject({
            type: 'warning',
            message: '校验状态：warn · run-validate-1'
        });
        expect(viewModel.diagnostics).toMatchObject({
            validation: 'warn · run-validate-1',
            lastErrorMessage: '--'
        });
        expect(viewModel.suggestedRunId).toBe('run-validate-1');
        expect(viewModel.actions.rollback.disabled).toBe(true);

        const errorViewModel = providerManagerModule.buildRuntimeStorageDiagnosticsViewModel({}, {
            hasAdminAccess: true,
            error: new Error('boom')
        });
        expect(errorViewModel.alert).toMatchObject({
            type: 'error',
            message: '加载运行时存储诊断信息失败：boom'
        });
    });

    test('should render diagnostics text alerts and disabled states into the panel container', () => {
        const { container, nodes } = createDiagnosticsContainer();
        const viewModel = providerManagerModule.buildRuntimeStorageDiagnosticsViewModel({
            runtimeStorage: {
                backend: 'db',
                authoritativeSource: 'database',
                lastValidation: {
                    overallStatus: 'fail',
                    runId: 'run-1'
                },
                lastError: {
                    error: {
                        message: 'database is locked'
                    }
                }
            },
            providerSummary: {
                providerTypeCount: 3,
                providerCount: 8
            }
        }, {
            hasAdminAccess: true,
            isLoading: true
        });

        providerManagerModule.renderRuntimeStorageDiagnostics(viewModel, container);

        expect(nodes['#runtimeStorageMode'].textContent).toBe('加载中…');
        expect(nodes['#runtimeStorageSource'].textContent).toBe('数据库');
        expect(nodes['#runtimeStorageProviderSummary'].textContent).toBe('3 种类型 / 8 个提供商');
        expect(nodes['#runtimeStorageValidation'].textContent).toBe('失败 · run-1');
        expect(nodes['#runtimeStorageError'].textContent).toBe('database is locked');
        expect(nodes['#runtimeStorageAlert'].hidden).toBe(false);
        expect(nodes['#runtimeStorageAlert'].textContent).toBe('最近一次运行时存储错误：database is locked');
        expect(nodes['#runtimeStorageAlert'].dataset.level).toBe('error');
        expect(nodes['#runtimeStorageReloadBtn'].disabled).toBe(true);
        expect(nodes['#runtimeStorageReloadBtn']['aria-disabled']).toBe('true');
        expect(container.dataset.loading).toBe('true');
        expect(container.dataset.readOnly).toBe('false');
    });

    test('should execute reload export and rollback actions with loading toggles and refresh callbacks', async () => {
        const loadingStates = [];
        const reloadConfigFn = jest.fn(async () => ({ reloaded: true }));
        const exportFn = jest.fn(async () => ({ exported: true }));
        const refreshProvidersFn = jest.fn(async () => undefined);
        const refreshSystemInfoFn = jest.fn(async () => undefined);
        const refreshConfigListFn = jest.fn(async () => undefined);
        const apiClient = {
            post: jest.fn(async () => ({ success: true }))
        };

        await expect(providerManagerModule.executeRuntimeStorageReloadAction({
            reloadConfigFn,
            refreshProvidersFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(`reload:${value}`)
        })).resolves.toEqual({ reloaded: true });

        await expect(providerManagerModule.executeRuntimeStorageExportAction({
            exportFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(`export:${value}`)
        })).resolves.toEqual({ exported: true });

        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            apiClient,
            runId: '',
            promptRunIdFn: () => 'run-42',
            confirmFn: () => true,
            notify: showToast,
            refreshConfigListFn,
            refreshProvidersFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(`rollback:${value}`)
        })).resolves.toEqual({ success: true });

        expect(reloadConfigFn).toHaveBeenCalled();
        expect(exportFn).toHaveBeenCalled();
        expect(apiClient.post).toHaveBeenCalledWith('/runtime-storage/rollback', {
            runId: 'run-42'
        });
        expect(showToast).toHaveBeenCalledWith('成功', '运行时存储回滚已完成（run-42）', 'success');
        expect(loadingStates).toEqual([
            'reload:true',
            'reload:false',
            'export:true',
            'export:false',
            'rollback:true',
            'rollback:false'
        ]);
    });

    test('should skip or surface rollback errors with matching toast feedback', async () => {
        const notify = jest.fn();
        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            runId: '',
            promptRunIdFn: () => '',
            confirmFn: () => true,
            notify,
            setLoading: jest.fn()
        })).resolves.toEqual({ skipped: true });

        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            runId: 'run-cancelled',
            confirmFn: () => false,
            notify,
            setLoading: jest.fn()
        })).resolves.toEqual({
            skipped: true,
            runId: 'run-cancelled'
        });

        const apiClient = {
            post: jest.fn(async () => {
                throw new Error('rollback failed');
            })
        };
        await expect(providerManagerModule.executeRuntimeStorageRollbackAction({
            apiClient,
            runId: 'run-failed',
            confirmFn: () => true,
            notify,
            setLoading: jest.fn()
        })).rejects.toThrow('rollback failed');
        expect(notify).toHaveBeenCalledWith('错误', '运行时存储回滚失败：rollback failed', 'error');
    });
});
