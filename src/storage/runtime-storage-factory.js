import { DualWriteRuntimeStorage } from './backends/dual-write-runtime-storage.js';
import { FileRuntimeStorage } from './backends/file-runtime-storage.js';
import { SqliteRuntimeStorage } from './backends/sqlite-runtime-storage.js';
import { wrapRuntimeStorage } from './runtime-storage-facade.js';

export function normalizeRuntimeStorageBackend(value) {
    return String(value || 'file').toLowerCase() === 'db' ? 'db' : 'file';
}

export function getRuntimeStorageDefaults() {
    return {
        RUNTIME_STORAGE_BACKEND: 'file',
        RUNTIME_STORAGE_DUAL_WRITE: false,
        RUNTIME_STORAGE_DB_PATH: 'configs/runtime/runtime-storage.sqlite',
        RUNTIME_STORAGE_FALLBACK_TO_FILE: true,
        RUNTIME_STORAGE_DB_BUSY_TIMEOUT_MS: 5000,
        RUNTIME_STORAGE_DB_RETRY_ATTEMPTS: 2,
        RUNTIME_STORAGE_DB_RETRY_DELAY_MS: 75,
        RUNTIME_STORAGE_SQLITE_BINARY: 'sqlite3'
    };
}

export function createRuntimeStorage(config = {}) {
    const backend = normalizeRuntimeStorageBackend(config.RUNTIME_STORAGE_BACKEND);
    const fileStorage = new FileRuntimeStorage(config);

    if (backend === 'file') {
        return wrapRuntimeStorage(fileStorage, config);
    }

    const dbStorage = new SqliteRuntimeStorage(config);
    if (config.RUNTIME_STORAGE_DUAL_WRITE) {
        return wrapRuntimeStorage(new DualWriteRuntimeStorage(dbStorage, fileStorage), config);
    }

    return wrapRuntimeStorage(dbStorage, config);
}
