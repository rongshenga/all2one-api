class StorageDomainFacade {
    constructor(storage) {
        this.storage = storage;
    }
}

class ProviderStorageDomainFacade extends StorageDomainFacade {
    async loadPoolsSnapshot(options = {}) {
        return await this.storage.loadProviderPoolsSnapshot(options);
    }

    async loadProviderTypePage(providerType, options = {}) {
        return await this.storage.loadProviderTypePage(providerType, options);
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

    async upsertPoolEntries(entries = [], options = {}) {
        if (typeof this.storage.upsertProviderPoolEntries !== 'function') {
            return {
                upsertedCount: 0,
                providers: []
            };
        }
        return await this.storage.upsertProviderPoolEntries(entries, options);
    }

    async deletePoolEntries(entries = [], options = {}) {
        if (typeof this.storage.deleteProviderPoolEntries !== 'function') {
            return {
                deletedCount: 0
            };
        }
        return await this.storage.deleteProviderPoolEntries(entries, options);
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

    async getCredentialSecretBlob(credentialAssetId) {
        if (typeof this.storage.getCredentialSecretBlob !== 'function') {
            return null;
        }
        return await this.storage.getCredentialSecretBlob(credentialAssetId);
    }

    async upsertCredentialSecretBlob(credentialAssetId, payload = null, options = {}) {
        if (typeof this.storage.upsertCredentialSecretBlob !== 'function') {
            return null;
        }
        return await this.storage.upsertCredentialSecretBlob(credentialAssetId, payload, options);
    }

    async listCredentialExpiryCandidates(providerType = null, options = {}) {
        if (typeof this.storage.listCredentialExpiryCandidates !== 'function') {
            return [];
        }
        return await this.storage.listCredentialExpiryCandidates(providerType, options);
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

    async updateRoutingUuids(updates = []) {
        if (typeof this.storage.updateProviderRoutingUuids !== 'function') {
            return {
                updatedCount: 0
            };
        }
        return await this.storage.updateProviderRoutingUuids(updates);
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

    async loadProviderSnapshot(providerType, options = {}) {
        return await this.storage.loadProviderUsageSnapshot(providerType, options);
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

    async appendStatisticsEvents(events = []) {
        if (typeof this.storage.appendUsageStatisticsEvents !== 'function') {
            return { insertedCount: 0 };
        }
        return await this.storage.appendUsageStatisticsEvents(events);
    }

    async queryStatisticsOverview(options = {}) {
        if (typeof this.storage.queryUsageStatisticsOverview !== 'function') {
            return null;
        }
        return await this.storage.queryUsageStatisticsOverview(options);
    }

    async queryStatisticsTrends(options = {}) {
        if (typeof this.storage.queryUsageStatisticsTrends !== 'function') {
            return { points: [] };
        }
        return await this.storage.queryUsageStatisticsTrends(options);
    }

    async queryStatisticsHeatmap(options = {}) {
        if (typeof this.storage.queryUsageStatisticsHeatmap !== 'function') {
            return { cells: [] };
        }
        return await this.storage.queryUsageStatisticsHeatmap(options);
    }

    async queryStatisticsDimensions(options = {}) {
        if (typeof this.storage.queryUsageStatisticsDimensions !== 'function') {
            return { items: [] };
        }
        return await this.storage.queryUsageStatisticsDimensions(options);
    }

    async queryStatisticsEvents(options = {}) {
        if (typeof this.storage.queryUsageStatisticsEvents !== 'function') {
            return {
                totalCount: 0,
                page: 1,
                limit: 50,
                totalPages: 1,
                hasPrevPage: false,
                hasNextPage: false,
                items: []
            };
        }
        return await this.storage.queryUsageStatisticsEvents(options);
    }

    async listStatisticsModelPrices() {
        if (typeof this.storage.listUsageStatisticsModelPrices !== 'function') {
            return [];
        }
        return await this.storage.listUsageStatisticsModelPrices();
    }

    async upsertStatisticsModelPrices(prices = []) {
        if (typeof this.storage.upsertUsageStatisticsModelPrices !== 'function') {
            return {
                updatedCount: 0,
                prices: []
            };
        }
        return await this.storage.upsertUsageStatisticsModelPrices(prices);
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

class AuthStorageDomainFacade extends StorageDomainFacade {
    async getAdminPasswordHash() {
        if (typeof this.storage.getAdminPasswordHash !== 'function') {
            return null;
        }
        return await this.storage.getAdminPasswordHash();
    }

    async saveAdminPasswordHash(passwordRecord = {}) {
        if (typeof this.storage.saveAdminPasswordHash !== 'function') {
            return null;
        }
        return await this.storage.saveAdminPasswordHash(passwordRecord);
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
        this.auth = new AuthStorageDomainFacade(storage);
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
            auth: this.auth,
            session: this.session,
            plugin: this.plugin,
            migration: this.migration
        };
    }

    async loadProviderPoolsSnapshot(options = {}) {
        return await this.provider.loadPoolsSnapshot(options);
    }

    async loadProviderTypePage(providerType, options = {}) {
        return await this.provider.loadProviderTypePage(providerType, options);
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

    async upsertProviderPoolEntries(entries = [], options = {}) {
        return await this.provider.upsertPoolEntries(entries, options);
    }

    async deleteProviderPoolEntries(entries = [], options = {}) {
        return await this.provider.deletePoolEntries(entries, options);
    }

    async findCredentialAsset(providerType, match = {}) {
        return await this.provider.findCredentialAsset(providerType, match);
    }

    async listCredentialAssets(providerType, options = {}) {
        return await this.provider.listCredentialAssets(providerType, options);
    }

    async getCredentialSecretBlob(credentialAssetId) {
        return await this.provider.getCredentialSecretBlob(credentialAssetId);
    }

    async upsertCredentialSecretBlob(credentialAssetId, payload = null, options = {}) {
        return await this.provider.upsertCredentialSecretBlob(credentialAssetId, payload, options);
    }

    async listCredentialExpiryCandidates(providerType = null, options = {}) {
        return await this.provider.listCredentialExpiryCandidates(providerType, options);
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

    async updateProviderRoutingUuids(updates = []) {
        return await this.provider.updateRoutingUuids(updates);
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

    async loadProviderUsageSnapshot(providerType, options = {}) {
        return await this.usage.loadProviderSnapshot(providerType, options);
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

    async appendUsageStatisticsEvents(events = []) {
        return await this.usage.appendStatisticsEvents(events);
    }

    async queryUsageStatisticsOverview(options = {}) {
        return await this.usage.queryStatisticsOverview(options);
    }

    async queryUsageStatisticsTrends(options = {}) {
        return await this.usage.queryStatisticsTrends(options);
    }

    async queryUsageStatisticsHeatmap(options = {}) {
        return await this.usage.queryStatisticsHeatmap(options);
    }

    async queryUsageStatisticsDimensions(options = {}) {
        return await this.usage.queryStatisticsDimensions(options);
    }

    async queryUsageStatisticsEvents(options = {}) {
        return await this.usage.queryStatisticsEvents(options);
    }

    async listUsageStatisticsModelPrices() {
        return await this.usage.listStatisticsModelPrices();
    }

    async upsertUsageStatisticsModelPrices(prices = []) {
        return await this.usage.upsertStatisticsModelPrices(prices);
    }

    async getAdminPasswordHash() {
        return await this.auth.getAdminPasswordHash();
    }

    async saveAdminPasswordHash(passwordRecord = {}) {
        return await this.auth.saveAdminPasswordHash(passwordRecord);
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
