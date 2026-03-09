import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from '../core/config-manager.js';
import { getRuntimeStorage } from '../storage/runtime-storage-registry.js';

const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');
const DEFAULT_PASSWORD = 'admin123';
const tokenCache = new Map();
const tokenVerificationInflight = new Map();
const UI_DEBUG_QUERY_KEY = 'ui_debug';

function normalizeUiDebugFlag(value) {
    if (typeof value !== 'string') {
        return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function buildTokenDebugId(token) {
    if (!token) {
        return 'unknown';
    }

    return crypto.createHash('sha1').update(String(token)).digest('hex').slice(0, 8);
}

function isUiDebugLoggingEnabled(req = null) {
    if (process.env.NODE_ENV === 'test' || CONFIG?.UI_DEBUG_LOGGING === true) {
        return true;
    }

    const headerValue = req?.headers?.['x-ui-debug'];
    if (Array.isArray(headerValue)) {
        if (headerValue.some((item) => normalizeUiDebugFlag(item))) {
            return true;
        }
    } else if (normalizeUiDebugFlag(headerValue)) {
        return true;
    }

    try {
        const requestUrl = new URL(req?.url || '/', 'http://127.0.0.1');
        return normalizeUiDebugFlag(requestUrl.searchParams.get(UI_DEBUG_QUERY_KEY));
    } catch {
        return false;
    }
}

function logAuthDebug(enabled, message, payload = null) {
    if (!enabled) {
        return;
    }

    if (payload) {
        logger.info(`[Auth Debug] ${message}`, payload);
        return;
    }

    logger.info(`[Auth Debug] ${message}`);
}

function getSessionStorage() {
    const runtimeStorage = getRuntimeStorage();
    if (!runtimeStorage || typeof runtimeStorage.getAdminSession !== 'function') {
        return null;
    }
    return runtimeStorage;
}

function getRuntimeStorageBackend(runtimeStorage = null) {
    const storage = runtimeStorage || getRuntimeStorage();
    if (!storage) {
        return null;
    }

    try {
        const info = typeof storage.getInfo === 'function' ? storage.getInfo() : null;
        if (info?.backend && typeof info.backend === 'string') {
            return info.backend.toLowerCase();
        }
    } catch {
        // ignore
    }

    if (storage.kind && typeof storage.kind === 'string') {
        return storage.kind.toLowerCase();
    }

    return null;
}

function shouldDisableTokenStoreFallback(runtimeStorage = null) {
    const backend = getRuntimeStorageBackend(runtimeStorage);
    return backend === 'db' || backend === 'dual-write';
}

export async function readPasswordFile() {
    const pwdFilePath = path.join(process.cwd(), 'configs', 'pwd');
    try {
        const password = await fs.readFile(pwdFilePath, 'utf8');
        const trimmedPassword = password.trim();
        if (!trimmedPassword) {
            logger.info('[Auth] Password file is empty, using default password: ' + DEFAULT_PASSWORD);
            return DEFAULT_PASSWORD;
        }
        logger.info('[Auth] Successfully read password file');
        return trimmedPassword;
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.info('[Auth] Password file does not exist, using default password: ' + DEFAULT_PASSWORD);
        } else {
            logger.error('[Auth] Failed to read password file:', error.code || error.message);
            logger.info('[Auth] Using default password: ' + DEFAULT_PASSWORD);
        }
        return DEFAULT_PASSWORD;
    }
}

export async function validateCredentials(password) {
    const storedPassword = await readPasswordFile();
    logger.info('[Auth] Validating password, stored password length:', storedPassword ? storedPassword.length : 0, ', input password length:', password ? password.length : 0);
    const isValid = storedPassword && password === storedPassword;
    logger.info('[Auth] Password validation result:', isValid);
    return isValid;
}

function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                if (!body.trim()) {
                    resolve({});
                } else {
                    resolve(JSON.parse(body));
                }
            } catch (error) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function getExpiryTime() {
    const now = Date.now();
    const expiry = (CONFIG.LOGIN_EXPIRY || 3600) * 1000;
    return now + expiry;
}

async function readTokenStore() {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            return JSON.parse(content);
        }
        await writeTokenStore({ tokens: {} });
        return { tokens: {} };
    } catch (error) {
        logger.error('[Token Store] Failed to read token store file:', error);
        return { tokens: {} };
    }
}

async function writeTokenStore(tokenStore) {
    try {
        await fs.writeFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), 'utf8');
    } catch (error) {
        logger.error('[Token Store] Failed to write token store file:', error);
    }
}

function cloneTokenInfo(tokenInfo) {
    if (!tokenInfo || typeof tokenInfo !== 'object') {
        return tokenInfo || null;
    }

    return { ...tokenInfo };
}

function removeCachedToken(token) {
    if (!token) {
        return;
    }

    tokenCache.delete(token);
}

function removeExpiredCachedToken(token, tokenInfo = null) {
    const currentTokenInfo = tokenInfo || tokenCache.get(token);
    if (!currentTokenInfo) {
        return true;
    }

    const expiryTime = Number(currentTokenInfo.expiryTime || 0);
    if (!expiryTime || Date.now() <= expiryTime) {
        return false;
    }

    removeCachedToken(token);
    return true;
}

function cacheTokenInfo(token, tokenInfo) {
    if (!token || !tokenInfo || typeof tokenInfo !== 'object') {
        return tokenInfo || null;
    }

    const cachedTokenInfo = cloneTokenInfo(tokenInfo);
    tokenCache.set(token, cachedTokenInfo);
    return cloneTokenInfo(cachedTokenInfo);
}

function getCachedTokenInfo(token) {
    if (!tokenCache.has(token)) {
        return null;
    }

    const tokenInfo = tokenCache.get(token);
    if (removeExpiredCachedToken(token, tokenInfo)) {
        return null;
    }

    return cloneTokenInfo(tokenInfo);
}

export async function verifyToken(token, options = {}) {
    if (!token) {
        return null;
    }

    const debugEnabled = options.debugEnabled === true;
    const startedAt = Date.now();
    const tokenDebugId = buildTokenDebugId(token);

    const cachedTokenInfo = getCachedTokenInfo(token);
    if (cachedTokenInfo) {
        logAuthDebug(debugEnabled, 'verifyToken cache hit', {
            tokenId: tokenDebugId,
            durationMs: Date.now() - startedAt,
            source: 'memory_cache'
        });
        return cachedTokenInfo;
    }

    if (tokenVerificationInflight.has(token)) {
        logAuthDebug(debugEnabled, 'verifyToken waiting for inflight request', {
            tokenId: tokenDebugId
        });
        return await tokenVerificationInflight.get(token);
    }

    const verificationTask = (async () => {
        const sessionStorage = getSessionStorage();
        if (sessionStorage) {
            try {
                const tokenInfo = await sessionStorage.getAdminSession(token);
                if (!tokenInfo) {
                    removeCachedToken(token);
                    logAuthDebug(debugEnabled, 'verifyToken runtime storage miss', {
                        tokenId: tokenDebugId,
                        durationMs: Date.now() - startedAt,
                        source: 'runtime_storage'
                    });
                    return null;
                }

                if (removeExpiredCachedToken(token, tokenInfo)) {
                    logAuthDebug(debugEnabled, 'verifyToken expired runtime storage session', {
                        tokenId: tokenDebugId,
                        durationMs: Date.now() - startedAt,
                        source: 'runtime_storage'
                    });
                    return null;
                }

                const cachedToken = cacheTokenInfo(token, tokenInfo);
                logAuthDebug(debugEnabled, 'verifyToken runtime storage hit', {
                    tokenId: tokenDebugId,
                    durationMs: Date.now() - startedAt,
                    source: 'runtime_storage'
                });
                return cachedToken;
            } catch (error) {
                logger.error('[Auth] Failed to verify token via runtime storage:', error.message);
                if (shouldDisableTokenStoreFallback(sessionStorage)) {
                    removeCachedToken(token);
                    logAuthDebug(debugEnabled, 'verifyToken runtime storage failure without token store fallback', {
                        tokenId: tokenDebugId,
                        durationMs: Date.now() - startedAt,
                        source: 'runtime_storage',
                        fallback: 'disabled'
                    });
                    return null;
                }
            }
        }

        const tokenStore = await readTokenStore();
        const tokenInfo = tokenStore.tokens[token];
        if (!tokenInfo) {
            removeCachedToken(token);
            logAuthDebug(debugEnabled, 'verifyToken token store miss', {
                tokenId: tokenDebugId,
                durationMs: Date.now() - startedAt,
                source: 'token_store'
            });
            return null;
        }

        if (Date.now() > tokenInfo.expiryTime) {
            await deleteToken(token);
            logAuthDebug(debugEnabled, 'verifyToken token store expired', {
                tokenId: tokenDebugId,
                durationMs: Date.now() - startedAt,
                source: 'token_store'
            });
            return null;
        }

        const cachedToken = cacheTokenInfo(token, tokenInfo);
        logAuthDebug(debugEnabled, 'verifyToken token store hit', {
            tokenId: tokenDebugId,
            durationMs: Date.now() - startedAt,
            source: 'token_store'
        });
        return cachedToken;
    })();

    tokenVerificationInflight.set(token, verificationTask);
    try {
        return await verificationTask;
    } finally {
        tokenVerificationInflight.delete(token);
    }
}

async function saveToken(token, tokenInfo) {
    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        await sessionStorage.saveAdminSession(token, tokenInfo);
        cacheTokenInfo(token, tokenInfo);
        return;
    }

    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
    cacheTokenInfo(token, tokenInfo);
}

async function deleteToken(token) {
    removeCachedToken(token);

    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        await sessionStorage.deleteAdminSession(token);
        return;
    }

    const tokenStore = await readTokenStore();
    if (tokenStore.tokens[token]) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
    }
}

export async function cleanupExpiredTokens() {
    for (const [token, tokenInfo] of tokenCache.entries()) {
        removeExpiredCachedToken(token, tokenInfo);
    }

    const sessionStorage = getSessionStorage();
    if (sessionStorage) {
        await sessionStorage.cleanupExpiredAdminSessions();
        return;
    }

    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;

    for (const token in tokenStore.tokens) {
        if (now > tokenStore.tokens[token].expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        await writeTokenStore(tokenStore);
    }
}

export async function checkAuth(req, options = {}) {
    const debugEnabled = options.debugEnabled === true || isUiDebugLoggingEnabled(req);
    const requestLabel = options.requestLabel || req?.url || 'unknown';
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logAuthDebug(debugEnabled, 'checkAuth missing bearer token', {
            requestLabel
        });
        return false;
    }

    const token = authHeader.substring(7);
    const startedAt = Date.now();
    const tokenInfo = await verifyToken(token, {
        debugEnabled,
        requestLabel
    });
    logAuthDebug(debugEnabled, `checkAuth ${tokenInfo ? 'passed' : 'failed'}`, {
        requestLabel,
        durationMs: Date.now() - startedAt
    });
    return tokenInfo !== null;
}

export async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Only POST requests are supported' }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;

        if (!password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Password cannot be empty' }));
            return true;
        }

        const isValid = await validateCredentials(password);
        if (isValid) {
            const token = generateToken();
            const expiryTime = getExpiryTime();
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime,
                sourceIp: req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Login successful',
                token,
                expiresIn: `${CONFIG.LOGIN_EXPIRY || 3600} seconds`
            }));
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Incorrect password, please try again'
            }));
        }
    } catch (error) {
        logger.error('[Auth] Login processing error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: error.message || 'Server error'
        }));
    }
    return true;
}

const cleanupExpiredTokenTimer = setInterval(cleanupExpiredTokens, 5 * 60 * 1000);
if (typeof cleanupExpiredTokenTimer.unref === 'function') {
    cleanupExpiredTokenTimer.unref();
}
