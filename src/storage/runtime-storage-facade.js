class StorageDomainFacade {
    constructor(storage) {
        this.storage = storage;
    }
}

class ProviderStorageDomainFacade extends StorageDomainFacade {
    async loadPoolsSnapshot(options = {}) {
        return await this.storage.loadProviderPoolsSnapshot(options);
    }

    async exportPoolsSnapshot(options = {}) {
        return await this.storage.exportProviderPoolsSnapshot(options);
    }

    async loadPoolsSummary(options = {}) {
        return await this.storage.loadProviderPoolsSummary(options);
    }

    async replacePoolsSnapshot(providerPools = {}, options = {}) {
        return await this.storage.replaceProviderPoolsSnapshot(providerPools, options);
    }

    async hasData() {
        return await this.storage.hasProviderData();
    }

    async findCredentialAsset(providerType, match = {}) {
        return await this.storage.findCredentialAsset(providerType, match);
    }

    async listCredentialAssets(providerType, options = {}) {
        return await this.storage.listCredentialAssets(providerType, options);
    }

    async linkCredentialFiles(credPaths = [], options = {}) {
        return await this.storage.linkCredentialFiles(credPaths, options);
    }

    async flushRuntimeState(records = [], options = {}) {
        return await this.storage.flushProviderRuntimeState(records, options);
    }

    async updateRoutingUuid(update = {}) {
        return await this.storage.updateProviderRoutingUuid(update);
    }
}

class UsageStorageDomainFacade extends StorageDomainFacade {
    async loadCacheSnapshot() {
        return await this.storage.loadUsageCacheSnapshot();
    }

    async loadCacheSummary() {
        return await this.storage.loadUsageCacheSummary();
    }

    async replaceCacheSnapshot(usageCache = null) {
        return await this.storage.replaceUsageCacheSnapshot(usageCache);
    }

    async loadProviderSnapshot(providerType) {
        return await this.storage.loadProviderUsageSnapshot(providerType);
    }

    async upsertProviderSnapshot(providerType, snapshot = {}) {
        return await this.storage.upsertProviderUsageSnapshot(providerType, snapshot);
    }

    async saveRefreshTask(task = {}) {
        return await this.storage.saveUsageRefreshTask(task);
    }

    async loadRefreshTask(taskId) {
        return await this.storage.loadUsageRefreshTask(taskId);
    }

    async markInterruptedRefreshTasks() {
        return await this.storage.markInterruptedUsageRefreshTasks();
    }
}

class SessionStorageDomainFacade extends StorageDomainFacade {
    async getSession(token) {
        return await this.storage.getAdminSession(token);
    }

    async saveSession(token, tokenInfo = {}) {
        return await this.storage.saveAdminSession(token, tokenInfo);
    }

    async deleteSession(token) {
        return await this.storage.deleteAdminSession(token);
    }

    async cleanupExpiredSessions() {
        return await this.storage.cleanupExpiredAdminSessions();
    }
}

class PluginStorageDomainFacade extends StorageDomainFacade {
    async loadPotluckUserData() {
        return await this.storage.loadPotluckUserData();
    }

    async savePotluckUserData(store = {}) {
        return await this.storage.savePotluckUserData(store);
    }

    async loadPotluckKeyStore() {
        return await this.storage.loadPotluckKeyStore();
    }

    async savePotluckKeyStore(store = {}) {
        return await this.storage.savePotluckKeyStore(store);
    }
}

class MigrationStorageDomainFacade {
    constructor(config = {}) {
        this.config = config;
    }

    async #loadMigrationService() {
        return await import('./runtime-storage-migration-service.js');
    }

    async migrateLegacy(options = {}) {
        const service = await this.#loadMigrationService();
        return await service.migrateLegacyRuntimeStorage(this.config, options);
    }

    async verify(options = {}) {
        const service = await this.#loadMigrationService();
        return await service.verifyRuntimeStorageMigration(this.config, options);
    }

    async exportLegacy(options = {}) {
        const service = await this.#loadMigrationService();
        return await service.exportLegacyRuntimeStorage(this.config, options);
    }

    async rollback(options = {}) {
        const service = await this.#loadMigrationService();
        return await service.rollbackRuntimeStorageMigration(this.config, options);
    }

    async listRuns(options = {}) {
        const service = await this.#loadMigrationService();
        return await service.listRuntimeStorageMigrationRuns(this.config, options);
    }

    async getRun(runId, options = {}) {
        const service = await this.#loadMigrationService();
        return await service.getRuntimeStorageMigrationRun(this.config, runId, options);
    }
}

export class RuntimeStorageFacade {
    constructor(storage, config = {}) {
        this.storage = storage;
        this.config = config;
        this.provider = new ProviderStorageDomainFacade(storage);
        this.usage = new UsageStorageDomainFacade(storage);
        this.session = new SessionStorageDomainFacade(storage);
        this.plugin = new PluginStorageDomainFacade(storage);
        this.migration = new MigrationStorageDomainFacade(config);
    }

    get kind() {
        return this.storage.kind;
    }

    get client() {
        return this.storage.client;
    }

    get fileStorage() {
        return this.storage.fileStorage;
    }

    get primaryStorage() {
        return this.storage.primaryStorage;
    }

    get secondaryStorage() {
        return this.storage.secondaryStorage;
    }

    get rawStorage() {
        return this.storage;
    }

    async initialize() {
        await this.storage.initialize();
        return this;
    }

    getInfo() {
        return this.storage.getInfo();
    }

    getDomains() {
        return {
            provider: this.provider,
            usage: this.usage,
            session: this.session,
            plugin: this.plugin,
            migration: this.migration
        };
    }

    async loadProviderPoolsSnapshot(options = {}) {
        return await this.provider.loadPoolsSnapshot(options);
    }

    async exportProviderPoolsSnapshot(options = {}) {
        return await this.provider.exportPoolsSnapshot(options);
    }

    async loadProviderPoolsSummary(options = {}) {
        return await this.provider.loadPoolsSummary(options);
    }

    async replaceProviderPoolsSnapshot(providerPools = {}, options = {}) {
        return await this.provider.replacePoolsSnapshot(providerPools, options);
    }

    async findCredentialAsset(providerType, match = {}) {
        return await this.provider.findCredentialAsset(providerType, match);
    }

    async listCredentialAssets(providerType, options = {}) {
        return await this.provider.listCredentialAssets(providerType, options);
    }

    async linkCredentialFiles(credPaths = [], options = {}) {
        return await this.provider.linkCredentialFiles(credPaths, options);
    }

    async flushProviderRuntimeState(records = [], options = {}) {
        return await this.provider.flushRuntimeState(records, options);
    }

    async updateProviderRoutingUuid(update = {}) {
        return await this.provider.updateRoutingUuid(update);
    }

    async hasProviderData() {
        return await this.provider.hasData();
    }

    async loadUsageCacheSnapshot() {
        return await this.usage.loadCacheSnapshot();
    }

    async loadUsageCacheSummary() {
        return await this.usage.loadCacheSummary();
    }

    async replaceUsageCacheSnapshot(usageCache = null) {
        return await this.usage.replaceCacheSnapshot(usageCache);
    }

    async loadProviderUsageSnapshot(providerType) {
        return await this.usage.loadProviderSnapshot(providerType);
    }

    async upsertProviderUsageSnapshot(providerType, snapshot = {}) {
        return await this.usage.upsertProviderSnapshot(providerType, snapshot);
    }

    async saveUsageRefreshTask(task = {}) {
        return await this.usage.saveRefreshTask(task);
    }

    async loadUsageRefreshTask(taskId) {
        return await this.usage.loadRefreshTask(taskId);
    }

    async markInterruptedUsageRefreshTasks() {
        return await this.usage.markInterruptedRefreshTasks();
    }

    async getAdminSession(token) {
        return await this.session.getSession(token);
    }

    async saveAdminSession(token, tokenInfo = {}) {
        return await this.session.saveSession(token, tokenInfo);
    }

    async deleteAdminSession(token) {
        return await this.session.deleteSession(token);
    }

    async cleanupExpiredAdminSessions() {
        return await this.session.cleanupExpiredSessions();
    }

    async loadPotluckUserData() {
        return await this.plugin.loadPotluckUserData();
    }

    async savePotluckUserData(store = {}) {
        return await this.plugin.savePotluckUserData(store);
    }

    async loadPotluckKeyStore() {
        return await this.plugin.loadPotluckKeyStore();
    }

    async savePotluckKeyStore(store = {}) {
        return await this.plugin.savePotluckKeyStore(store);
    }

    async close() {
        await this.storage.close();
    }
}

export function wrapRuntimeStorage(storage, config = {}) {
    return new RuntimeStorageFacade(storage, config);
}
