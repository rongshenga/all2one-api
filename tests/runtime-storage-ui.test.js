import { jest } from '@jest/globals';

const mockShowToast = jest.fn();
const mockReloadConfig = jest.fn();
const mockDownloadAllConfigs = jest.fn();
const mockSetServiceMode = jest.fn();
const mockUpdateProviderStats = jest.fn();
const mockGetProviderConfigs = jest.fn(() => []);
const mockGetProviderTypeFields = jest.fn(() => []);
const mockGetFieldLabel = jest.fn((key) => key);
const providerStats = { providerTypeStats: {} };

function translate(key, params = {}) {
    const map = {
        'modal.provider.neverUsed': 'Never used',
        'modal.provider.neverChecked': 'Never checked',
        'modal.provider.status.healthy': 'Healthy',
        'modal.provider.status.unhealthy': 'Unhealthy',
        'modal.provider.status.disabled': 'Disabled',
        'modal.provider.status.enabled': 'Enabled',
        'modal.provider.enabled': 'Enable',
        'modal.provider.disabled': 'Disable',
        'modal.provider.edit': 'Edit',
        'modal.provider.refreshUuid': 'Refresh UUID',
        'modal.provider.refreshUuid.failed': 'Refresh UUID failed',
        'modal.provider.refreshUuid.success': `Refreshed ${params.oldUuid || ''} -> ${params.newUuid || ''}`,
        'modal.provider.refreshUuidConfirm': `Refresh ${params.oldUuid || ''}?`,
        'modal.provider.lastError': '最近错误',
        'modal.provider.healthCheckLabel': 'Health',
        'modal.provider.usageCount': 'Usage',
        'modal.provider.errorCount': 'Errors',
        'modal.provider.lastUsed': 'Last Used',
        'modal.provider.lastCheck': 'Last Check',
        'modal.provider.checkModel': 'Check Model',
        'modal.provider.statusLabel': 'Status',
        'common.success': '成功',
        'common.error': '错误'
    };
    return map[key] || key;
}

function createFakeClassList() {
    const classes = new Set();
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

function createFakeElement() {
    return {
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        dataset: {},
        attributes: {},
        style: {},
        className: '',
        classList: createFakeClassList(),
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener() {},
        querySelector() {
            return null;
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return this.attributes[name] || null;
        }
    };
}

function createDiagnosticsContainer() {
    const selectors = [
        '#runtimeStorageMode',
        '#runtimeStorageSource',
        '#runtimeStorageProviderSummary',
        '#runtimeStorageValidation',
        '#runtimeStorageFallback',
        '#runtimeStorageError',
        '#runtimeStorageAlert',
        '#runtimeStorageReloadBtn',
        '#runtimeStorageExportBtn',
        '#runtimeStorageRollbackBtn'
    ];
    const elements = Object.fromEntries(selectors.map((selector) => [selector, createFakeElement()]));

    return {
        dataset: {},
        querySelector(selector) {
            return elements[selector] || null;
        },
        elements
    };
}

async function importProviderManagerModule() {
    jest.resetModules();
    global.localStorage = {
        getItem: jest.fn(() => 'auth-token')
    };
    global.window = {
        apiClient: {
            post: jest.fn(),
            get: jest.fn()
        }
    };

    jest.doMock('../static/app/constants.js', () => ({
        providerStats,
        updateProviderStats: mockUpdateProviderStats
    }));
    jest.doMock('../static/app/utils.js', () => ({
        showToast: mockShowToast,
        getProviderConfigs: mockGetProviderConfigs
    }));
    jest.doMock('../static/app/file-upload.js', () => ({
        fileUploadHandler: jest.fn()
    }));
    jest.doMock('../static/app/i18n.js', () => ({
        t: translate,
        getCurrentLanguage: jest.fn(() => 'en-US')
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
        setServiceMode: mockSetServiceMode
    }));

    return await import('../static/app/provider-manager.js');
}

async function importModalModule() {
    jest.resetModules();
    global.window = {};

    jest.doMock('../static/app/utils.js', () => ({
        showToast: mockShowToast,
        getFieldLabel: mockGetFieldLabel,
        getProviderTypeFields: mockGetProviderTypeFields
    }));
    jest.doMock('../static/app/event-handlers.js', () => ({
        handleProviderPasswordToggle: jest.fn()
    }));
    jest.doMock('../static/app/i18n.js', () => ({
        t: translate
    }));

    return await import('../static/app/modal.js');
}

describe('Runtime storage dashboard diagnostics UI', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        providerStats.providerTypeStats = {};
    });

    test('should reuse in-flight providers summary requests', async () => {
        const providerManagerModule = await importProviderManagerModule();
        const providersLoading = createFakeElement();
        const providersList = createFakeElement();
        const providersContainer = createFakeElement();
        const statsGrid = createFakeElement();
        const activeProviders = createFakeElement();
        const healthyProviders = createFakeElement();
        const activeConnections = createFakeElement();

        global.document = {
            getElementById: jest.fn((id) => ({
                providersLoading,
                providersList,
                activeProviders,
                healthyProviders,
                activeConnections
            }[id] || null)),
            querySelector: jest.fn((selector) => {
                if (selector === '#providers .providers-container') return providersContainer;
                if (selector === '#providers .stats-grid') return statsGrid;
                return null;
            }),
            createElement: jest.fn(() => createFakeElement())
        };

        global.window.setTimeout = setTimeout;
        global.window.clearTimeout = clearTimeout;
        mockGetProviderConfigs.mockReturnValue([{
            id: 'grok-custom',
            name: 'Grok Reverse',
            visible: true
        }]);

        let resolveSummary;
        const summaryPromise = new Promise((resolve) => {
            resolveSummary = resolve;
        });
        global.window.apiClient.get.mockImplementation((url) => {
            if (url === '/providers/summary') {
                return summaryPromise;
            }
            if (url === '/providers/supported') {
                return Promise.resolve(['grok-custom']);
            }
            return Promise.reject(new Error(`Unexpected url: ${url}`));
        });

        const firstLoad = providerManagerModule.loadProviders();
        const secondLoad = providerManagerModule.loadProviders();
        await Promise.resolve();

        expect(global.window.apiClient.get.mock.calls.filter(([url]) => url === '/providers/summary')).toHaveLength(1);

        resolveSummary({
            'grok-custom': {
                totalCount: 1,
                healthyCount: 1,
                usageCount: 2,
                errorCount: 0
            }
        });

        await Promise.all([firstLoad, secondLoad]);

        expect(global.window.apiClient.get.mock.calls.filter(([url]) => url === '/providers/summary')).toHaveLength(1);
        expect(global.window.apiClient.get.mock.calls.filter(([url]) => url === '/providers/supported')).toHaveLength(1);
    });

    test('should keep providers loading overlay hidden for silent refresh', async () => {
        const providerManagerModule = await importProviderManagerModule();
        const providersLoading = createFakeElement();
        const providersList = createFakeElement();
        const providersContainer = createFakeElement();
        const statsGrid = createFakeElement();
        const activeProviders = createFakeElement();
        const healthyProviders = createFakeElement();
        const activeConnections = createFakeElement();

        global.document = {
            getElementById: jest.fn((id) => ({
                providersLoading,
                providersList,
                activeProviders,
                healthyProviders,
                activeConnections
            }[id] || null)),
            querySelector: jest.fn((selector) => {
                if (selector === '#providers .providers-container') return providersContainer;
                if (selector === '#providers .stats-grid') return statsGrid;
                return null;
            }),
            createElement: jest.fn(() => createFakeElement())
        };

        global.window.setTimeout = setTimeout;
        global.window.clearTimeout = clearTimeout;
        mockGetProviderConfigs.mockReturnValue([{
            id: 'grok-custom',
            name: 'Grok Reverse',
            visible: true
        }]);

        let resolveSummary;
        const summaryPromise = new Promise((resolve) => {
            resolveSummary = resolve;
        });
        global.window.apiClient.get.mockImplementation((url) => {
            if (url === '/providers/summary') {
                return summaryPromise;
            }
            if (url === '/providers/supported') {
                return Promise.resolve(['grok-custom']);
            }
            return Promise.reject(new Error(`Unexpected url: ${url}`));
        });

        const loadPromise = providerManagerModule.loadProviders({ showLoading: false });
        await Promise.resolve();

        expect(providersLoading.classList.contains('active')).toBe(false);
        expect(providersContainer.attributes['aria-busy']).not.toBe('true');

        resolveSummary({
            'grok-custom': {
                totalCount: 1,
                healthyCount: 1,
                usageCount: 1,
                errorCount: 0
            }
        });
        await loadPromise;

        expect(providersLoading.classList.contains('active')).toBe(false);
    });

    test('should build diagnostics view model in db-only mode with readonly actions', async () => {
        const { buildRuntimeStorageDiagnosticsViewModel } = await importProviderManagerModule();

        const viewModel = buildRuntimeStorageDiagnosticsViewModel({
            runtimeStorage: {
                backend: 'db',
                requestedBackend: 'db',
                authoritativeSource: 'database',
                lastValidation: {
                    overallStatus: 'fail',
                    runId: 'run-42'
                }
            },
            providerSummary: {
                providerTypeCount: 3,
                providerCount: 9
            }
        }, {
            hasAdminAccess: false
        });

        expect(viewModel.storageModeLabel).toBe('数据库');
        expect(viewModel.sourceOfTruthLabel).toBe('数据库');
        expect(viewModel.providerTypeCount).toBe(3);
        expect(viewModel.providerCount).toBe(9);
        expect(viewModel.readOnly).toBe(true);
        expect(viewModel.actions.reload.disabled).toBe(true);
        expect(viewModel.alert.message).toContain('校验状态');
        expect(viewModel.diagnostics.validation).toContain('run-42');
    });

    test('should render diagnostics panel fields, loading state, and disabled buttons', async () => {
        const {
            buildRuntimeStorageDiagnosticsViewModel,
            renderRuntimeStorageDiagnostics
        } = await importProviderManagerModule();
        const container = createDiagnosticsContainer();
        const viewModel = buildRuntimeStorageDiagnosticsViewModel({
            runtimeStorage: {
                backend: 'db',
                authoritativeSource: 'database',
                lastValidation: {
                    overallStatus: 'pass',
                    runId: 'run-100'
                },
                lastError: {
                    error: {
                        message: 'database is locked'
                    }
                }
            },
            providerSummary: {
                providerTypeCount: 1,
                providerCount: 2
            }
        }, {
            isLoading: true,
            hasAdminAccess: true,
            readOnly: true
        });

        renderRuntimeStorageDiagnostics(viewModel, container);

        expect(container.elements['#runtimeStorageMode'].textContent).toBe('加载中…');
        expect(container.elements['#runtimeStorageSource'].textContent).toBe('数据库');
        expect(container.elements['#runtimeStorageProviderSummary'].textContent).toBe('1 种类型 / 2 个提供商');
        expect(container.elements['#runtimeStorageValidation'].textContent).toContain('run-100');
        expect(container.elements['#runtimeStorageError'].textContent).toBe('database is locked');
        expect(container.elements['#runtimeStorageReloadBtn'].disabled).toBe(true);
        expect(container.elements['#runtimeStorageAlert'].hidden).toBe(false);
        expect(container.dataset.loading).toBe('true');
        expect(container.dataset.readOnly).toBe('true');
    });

    test('should execute reload/export/rollback actions and refresh dependent stores', async () => {
        const {
            executeRuntimeStorageReloadAction,
            executeRuntimeStorageExportAction,
            executeRuntimeStorageRollbackAction
        } = await importProviderManagerModule();
        const loadingStates = [];
        const refreshProvidersFn = jest.fn();
        const refreshSystemInfoFn = jest.fn();
        const apiClient = {
            post: jest.fn().mockResolvedValue({ success: true })
        };

        mockReloadConfig.mockResolvedValue({ success: true });
        mockDownloadAllConfigs.mockResolvedValue({ success: true });

        await executeRuntimeStorageReloadAction({
            reloadConfigFn: mockReloadConfig,
            refreshProvidersFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(value)
        });
        await executeRuntimeStorageExportAction({
            exportFn: mockDownloadAllConfigs,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(value)
        });
        await executeRuntimeStorageRollbackAction({
            apiClient,
            runId: 'run-88',
            confirmFn: () => true,
            notify: mockShowToast,
            refreshProvidersFn,
            refreshSystemInfoFn,
            setLoading: (value) => loadingStates.push(value)
        });

        expect(mockReloadConfig).toHaveBeenCalledTimes(1);
        expect(mockDownloadAllConfigs).toHaveBeenCalledTimes(1);
        expect(apiClient.post).toHaveBeenCalledWith('/runtime-storage/rollback', { runId: 'run-88' });
        expect(refreshProvidersFn).toHaveBeenCalledTimes(2);
        expect(refreshSystemInfoFn).toHaveBeenCalledTimes(3);
        expect(loadingStates).toEqual([true, false, true, false, true, false]);
        expect(mockShowToast).toHaveBeenCalledWith('成功', '运行时存储回滚已完成（run-88）', 'success');
    });

    test('should skip rollback when runId prompt is empty or confirmation is rejected', async () => {
        const { executeRuntimeStorageRollbackAction } = await importProviderManagerModule();
        const apiClient = {
            post: jest.fn()
        };

        const emptyRunResult = await executeRuntimeStorageRollbackAction({
            apiClient,
            promptRunIdFn: () => ''
        });
        const deniedResult = await executeRuntimeStorageRollbackAction({
            apiClient,
            runId: 'run-91',
            confirmFn: () => false
        });

        expect(emptyRunResult).toEqual({ skipped: true });
        expect(deniedResult).toEqual({ skipped: true, runId: 'run-91' });
        expect(apiClient.post).not.toHaveBeenCalled();
    });

    test('should request first provider details page with fixed limit when opening modal', async () => {
        const providerManagerModule = await importProviderManagerModule();
        const modalPayload = {
            providerType: 'grok-custom',
            providers: [{ uuid: 'grok-1' }],
            page: 1,
            limit: 5,
            totalPages: 10,
            totalCount: 50,
            healthyCount: 40
        };

        global.window.apiClient.get.mockResolvedValue(modalPayload);
        global.window.setTimeout = setTimeout;
        global.window.clearTimeout = clearTimeout;
        global.showProviderManagerModal = jest.fn();

        await providerManagerModule.openProviderManager('grok-custom');

        expect(global.window.apiClient.get).toHaveBeenCalledWith('/providers/grok-custom?page=1&limit=5');
        expect(global.showProviderManagerModal).toHaveBeenCalledWith(modalPayload);

        delete global.showProviderManagerModal;
    });
});

describe('Provider modal runtime storage interactions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should refresh uuid and reload compat snapshot consumers on success', async () => {
        const { executeRefreshProviderUuidAction } = await importModalModule();
        const apiClient = {
            post: jest.fn().mockResolvedValue({
                success: true,
                oldUuid: 'old-uuid',
                newUuid: 'new-uuid'
            })
        };
        const reloadConfigFn = jest.fn();
        const refreshProviderConfigFn = jest.fn();

        const result = await executeRefreshProviderUuidAction({
            uuid: 'old-uuid',
            providerType: 'grok-custom',
            apiClient,
            confirmFn: () => true,
            notify: mockShowToast,
            translate,
            reloadConfigFn,
            refreshProviderConfigFn
        });

        expect(result.newUuid).toBe('new-uuid');
        expect(apiClient.post).toHaveBeenCalledWith('/providers/grok-custom/old-uuid/refresh-uuid', {});
        expect(reloadConfigFn).toHaveBeenCalledTimes(1);
        expect(refreshProviderConfigFn).toHaveBeenCalledWith('grok-custom');
        expect(mockShowToast).toHaveBeenCalledWith('成功', 'Refreshed old-uuid -> new-uuid', 'success');
    });

    test('should skip or surface error toast when refresh uuid is not confirmed or fails', async () => {
        const { executeRefreshProviderUuidAction } = await importModalModule();
        const apiClient = {
            post: jest.fn().mockResolvedValue({ success: false })
        };

        const skipped = await executeRefreshProviderUuidAction({
            uuid: 'old-uuid',
            providerType: 'grok-custom',
            apiClient,
            confirmFn: () => false,
            notify: mockShowToast,
            translate
        });

        expect(skipped).toEqual({ skipped: true });
        expect(apiClient.post).not.toHaveBeenCalled();

        await executeRefreshProviderUuidAction({
            uuid: 'old-uuid',
            providerType: 'grok-custom',
            apiClient,
            confirmFn: () => true,
            notify: mockShowToast,
            translate
        });

        expect(mockShowToast).toHaveBeenCalledWith('错误', 'Refresh UUID failed', 'error');
    });

    test('should render pagination and paginated provider list without undefined fields', async () => {
        const {
            renderPagination,
            renderProviderListPaginated,
            renderProviderList
        } = await importModalModule();

        const providers = Array.from({ length: 6 }, (_, index) => ({
            uuid: `provider-${index + 1}`,
            customName: index === 0 ? 'Primary Node' : '',
            isHealthy: index % 2 === 0,
            isDisabled: index === 1,
            usageCount: index,
            errorCount: index + 1,
            lastErrorMessage: index === 1 ? 'bad <token>' : '',
            lastHealthCheckModel: index === 2 ? 'grok-3' : undefined
        }));

        const firstPageHtml = renderProviderListPaginated(providers, 1);
        const rawListHtml = renderProviderList([providers[1]]);
        const firstPagePagination = renderPagination(1, 2, 6, 'top');
        const lastPagePagination = renderPagination(2, 2, 6, 'bottom');

        expect(firstPageHtml).toContain('provider-1');
        expect(firstPageHtml).not.toContain('provider-6');
        expect(rawListHtml).toContain('Never used');
        expect(rawListHtml).toContain('Never checked');
        expect(rawListHtml).toContain('Disabled');
        expect(rawListHtml).toContain('&lt;token&gt;');
        expect(rawListHtml).not.toContain('undefined');
        expect(firstPagePagination).toContain('disabled');
        expect(lastPagePagination).toContain('disabled');
        expect(firstPagePagination).toContain('显示 1-5 / 共 6 条');
        expect(lastPagePagination).toContain('显示 6-6 / 共 6 条');
    });
});
