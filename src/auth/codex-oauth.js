import http from 'http';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import open from 'open';
import axios from 'axios';
import os from 'os';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { getProxyConfigForProvider } from '../utils/proxy-utils.js';

/**
 * Codex OAuth 配置
 */
const CODEX_OAUTH_CONFIG = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    port: 1455,
    scopes: 'openid email profile offline_access',
    logPrefix: '[Codex Auth]'
};

/**
 * 根据当前机器资源计算 Codex 导入并发配置
 * 目标：默认尽可能高并发，同时给出合理上限防止资源过载
 */
function getCodexConcurrencyProfile() {
    const logicalCpus = Math.max(1, os.cpus()?.length || 4);
    const totalMemGB = Math.max(1, Math.floor(os.totalmem() / (1024 ** 3)));

    // 导入阶段偏 I/O + 轻计算，可放宽并发（先计算保守基础值）
    const cpuBasedImport = logicalCpus * 10;
    const memoryBasedImport = totalMemGB * 2;
    const baseImportConcurrency = Math.min(
        256,
        Math.max(24, Math.min(cpuBasedImport, memoryBasedImport))
    );

    const maxImportConcurrency = Math.min(
        512,
        Math.max(baseImportConcurrency, logicalCpus * 24, 128)
    );

    // 刷新阶段涉及上游鉴权接口，控制得更保守
    const baseRefreshConcurrency = Math.min(
        64,
        Math.max(8, Math.floor(baseImportConcurrency * 0.25), logicalCpus * 2)
    );

    const maxRefreshConcurrency = Math.min(
        128,
        Math.max(baseRefreshConcurrency, logicalCpus * 6, 32)
    );

    // 最大化并发配置：默认直接使用当前机器上限档
    const defaultImportConcurrency = maxImportConcurrency;
    const defaultRefreshConcurrency = maxRefreshConcurrency;

    return {
        defaultImportConcurrency,
        maxImportConcurrency,
        defaultRefreshConcurrency,
        maxRefreshConcurrency
    };
}

const CODEX_CONCURRENCY_PROFILE = getCodexConcurrencyProfile();
const DEFAULT_CODEX_IMPORT_CONCURRENCY = CODEX_CONCURRENCY_PROFILE.defaultImportConcurrency;
const MAX_CODEX_IMPORT_CONCURRENCY = CODEX_CONCURRENCY_PROFILE.maxImportConcurrency;
const DEFAULT_CODEX_REFRESH_CONCURRENCY = CODEX_CONCURRENCY_PROFILE.defaultRefreshConcurrency;
const MAX_CODEX_REFRESH_CONCURRENCY = CODEX_CONCURRENCY_PROFILE.maxRefreshConcurrency;

/**
 * 活动的服务器实例管理（与 gemini-oauth 一致）
 */
const activeServers = new Map();

/**
 * 关闭指定端口的活动服务器
 */
async function closeActiveServer(provider, port = null) {
    const existing = activeServers.get(provider);
    if (existing) {
        await new Promise((resolve) => {
            existing.server.close(() => {
                activeServers.delete(provider);
                logger.info(`[Codex Auth] 已关闭提供商 ${provider} 在端口 ${existing.port} 上的旧服务器`);
                resolve();
            });
        });
    }

    if (port) {
        for (const [p, info] of activeServers.entries()) {
            if (info.port === port) {
                await new Promise((resolve) => {
                    info.server.close(() => {
                        activeServers.delete(p);
                        logger.info(`[Codex Auth] 已关闭端口 ${port} 上被占用（提供商: ${p}）的旧服务器`);
                        resolve();
                    });
                });
            }
        }
    }
}

/**
 * 安全关闭指定 server，并从 activeServers 中移除映射
 * @param {http.Server|null} server
 * @param {string} provider
 */
async function closeServerSafely(server, provider = 'openai-codex-oauth') {
    if (!server) return;

    await new Promise((resolve) => {
        try {
            // 已关闭或未监听时，直接继续
            if (!server.listening) {
                resolve();
                return;
            }
            server.close(() => resolve());
        } catch {
            resolve();
        }
    });

    const active = activeServers.get(provider);
    if (active && active.server === server) {
        activeServers.delete(provider);
    }
}

/**
 * 清理 Codex OAuth 会话（定时器 + 回调服务器 + 会话映射）
 * @param {string} sessionId
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
async function cleanupCodexSession(sessionId, reason = '') {
    if (!global.codexOAuthSessions || !global.codexOAuthSessions.has(sessionId)) {
        return false;
    }

    const session = global.codexOAuthSessions.get(sessionId);
    if (session?.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
    }

    await closeServerSafely(session?.server, 'openai-codex-oauth');
    global.codexOAuthSessions.delete(sessionId);

    if (reason) {
        logger.info(`[Codex Auth] Session cleaned: ${sessionId} (${reason})`);
    }
    return true;
}

/**
 * Codex OAuth 认证类
 * 实现 OAuth2 + PKCE 流程
 */
class CodexAuth {
    constructor(config) {
        this.config = config;
        
        // 配置代理支持
        const axiosConfig = { timeout: 30000 };
        const proxyConfig = getProxyConfigForProvider(config, 'openai-codex-oauth');
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            logger.info('[Codex Auth] Proxy enabled for OAuth requests');
        }
        
        this.httpClient = axios.create(axiosConfig);
        this.server = null; // 存储服务器实例
    }

    /**
     * 生成 PKCE 代码
     * @returns {{verifier: string, challenge: string}}
     */
    generatePKCECodes() {
        // 生成 code verifier (96 随机字节 → 128 base64url 字符)
        const verifier = crypto.randomBytes(96)
            .toString('base64url');

        // 生成 code challenge (SHA256 of verifier)
        const challenge = crypto.createHash('sha256')
            .update(verifier)
            .digest('base64url');

        return { verifier, challenge };
    }

    /**
     * 生成授权 URL（不启动完整流程）
     * @returns {{authUrl: string, state: string, pkce: Object, server: Object}}
     */
    async generateAuthUrl() {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Generating auth URL...`);

        // 启动本地回调服务器
        const server = await this.startCallbackServer();
        this.server = server;

        // 构建授权 URL
        const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
        authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', CODEX_OAUTH_CONFIG.redirectUri);
        authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('prompt', 'login');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

        return {
            authUrl: authUrl.toString(),
            state,
            pkce,
            server
        };
    }

    /**
     * 完成 OAuth 流程（在收到回调后调用）
     * @param {string} code - 授权码
     * @param {string} state - 状态参数
     * @param {string} expectedState - 期望的状态参数
     * @param {Object} pkce - PKCE 代码
     * @returns {Promise<Object>} tokens 和凭据路径
     */
    async completeOAuthFlow(code, state, expectedState, pkce) {
        // 验证 state
        if (state !== expectedState) {
            throw new Error('State mismatch - possible CSRF attack');
        }

        // 用 code 换取 tokens
        const tokens = await this.exchangeCodeForTokens(code, pkce.verifier);

        // 解析 JWT 提取账户信息
        const claims = this.parseJWT(tokens.id_token);

        // 保存凭据（遵循 CLIProxyAPI 格式）
        const credentials = {
            id_token: tokens.id_token,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub,
            last_refresh: new Date().toISOString(),
            email: claims.email,
            type: 'codex',
            expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
        };

        // 保存凭据并获取路径
        const saveResult = await this.saveCredentials(credentials);
        const credPath = saveResult.credsPath;
        const relativePath = saveResult.relativePath;

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);

        // 关闭服务器并清理活动映射
        if (this.server) {
            await closeServerSafely(this.server, 'openai-codex-oauth');
            this.server = null;
        }

        return {
            ...credentials,
            credPath,
            relativePath
        };
    }

    /**
     * 启动 OAuth 流程
     * @returns {Promise<Object>} 返回 tokens
     */
    async startOAuthFlow() {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Starting OAuth flow...`);

        // 启动本地回调服务器
        const server = await this.startCallbackServer();

        // 构建授权 URL
        const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
        authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', CODEX_OAUTH_CONFIG.redirectUri);
        authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('prompt', 'login');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Opening browser for authentication...`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} If browser doesn't open, visit: ${authUrl.toString()}`);

        try {
            await open(authUrl.toString());
        } catch (error) {
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to open browser automatically:`, error.message);
        }

        // 等待回调
        const result = await this.waitForCallback(server, state);

        // 用 code 换取 tokens
        const tokens = await this.exchangeCodeForTokens(result.code, pkce.verifier);

        // 解析 JWT 提取账户信息
        const claims = this.parseJWT(tokens.id_token);

        // 保存凭据（遵循 CLIProxyAPI 格式）
        const credentials = {
            id_token: tokens.id_token,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub,
            last_refresh: new Date().toISOString(),
            email: claims.email,
            type: 'codex',
            expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
        };

        await this.saveCredentials(credentials);

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);

        return credentials;
    }

    /**
     * 启动回调服务器
     * @returns {Promise<http.Server>}
     */
    async startCallbackServer() {
        // 先清理该提供商或该端口的旧服务器
        await closeActiveServer('openai-codex-oauth', CODEX_OAUTH_CONFIG.port);

        return new Promise((resolve, reject) => {
            const server = http.createServer();

            server.on('request', (req, res) => {
                if (req.url.startsWith('/auth/callback')) {
                    const url = new URL(req.url, `http://localhost:${CODEX_OAUTH_CONFIG.port}`);
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const error = url.searchParams.get('error');
                    const errorDescription = url.searchParams.get('error_description');

                    if (error) {
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Authentication Failed</title>
                                <style>
                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                                    h1 { color: #d32f2f; }
                                    p { color: #666; }
                                </style>
                            </head>
                            <body>
                                <h1>❌ Authentication Failed</h1>
                                <p>${errorDescription || error}</p>
                                <p>You can close this window and try again.</p>
                            </body>
                            </html>
                        `);
                        server.emit('auth-error', new Error(errorDescription || error));
                    } else if (code && state) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Authentication Successful</title>
                                <style>
                                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                                    h1 { color: #4caf50; }
                                    p { color: #666; }
                                    .countdown { font-size: 24px; font-weight: bold; color: #2196f3; }
                                </style>
                                <script>
                                    let countdown = 10;
                                    setInterval(() => {
                                        countdown--;
                                        document.getElementById('countdown').textContent = countdown;
                                        if (countdown <= 0) {
                                            window.close();
                                        }
                                    }, 1000);
                                </script>
                            </head>
                            <body>
                                <h1>✅ Authentication Successful!</h1>
                                <p>You can now close this window and return to the application.</p>
                                <p>This window will close automatically in <span id="countdown" class="countdown">10</span> seconds.</p>
                            </body>
                            </html>
                        `);
                        server.emit('auth-success', { code, state });
                    }
                } else if (req.url === '/success') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Success!</h1>');
                }
            });

            server.listen(CODEX_OAUTH_CONFIG.port, () => {
                logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Callback server listening on port ${CODEX_OAUTH_CONFIG.port}`);
                activeServers.set('openai-codex-oauth', { server, port: CODEX_OAUTH_CONFIG.port });
                resolve(server);
            });

            server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${CODEX_OAUTH_CONFIG.port} is already in use. Please close other applications using this port.`));
                } else {
                    reject(error);
                }
            });
        });
    }

    /**
     * 等待 OAuth 回调
     * @param {http.Server} server
     * @param {string} expectedState
     * @returns {Promise<{code: string, state: string}>}
     */
    async waitForCallback(server, expectedState) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                server.close();
                reject(new Error('Authentication timeout (10 minutes)'));
            }, 10 * 60 * 1000); // 10 分钟

            server.once('auth-success', (result) => {
                clearTimeout(timeout);
                server.close();

                if (result.state !== expectedState) {
                    reject(new Error('State mismatch - possible CSRF attack'));
                } else {
                    resolve(result);
                }
            });

            server.once('auth-error', (error) => {
                clearTimeout(timeout);
                server.close();
                reject(error);
            });
        });
    }

    /**
     * 用授权码换取 tokens
     * @param {string} code
     * @param {string} codeVerifier
     * @returns {Promise<Object>}
     */
    async exchangeCodeForTokens(code, codeVerifier) {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Exchanging authorization code for tokens...`);

        try {
            const response = await this.httpClient.post(
                CODEX_OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: CODEX_OAUTH_CONFIG.clientId,
                    code: code,
                    redirect_uri: CODEX_OAUTH_CONFIG.redirectUri,
                    code_verifier: codeVerifier
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            return response.data;
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token exchange failed:`, error.response?.data || error.message);
            throw new Error(`Failed to exchange code for tokens: ${error.response?.data?.error_description || error.message}`);
        }
    }

    /**
     * 刷新 tokens
     * @param {string} refreshToken
     * @returns {Promise<Object>}
     */
    async refreshTokens(refreshToken) {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Refreshing access token...`);

        try {
            const response = await this.httpClient.post(
                CODEX_OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: CODEX_OAUTH_CONFIG.clientId,
                    refresh_token: refreshToken
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            const tokens = response.data;
            const claims = this.parseJWT(tokens.id_token);

            return {
                id_token: tokens.id_token,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token || refreshToken,
                account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub,
                last_refresh: new Date().toISOString(),
                email: claims.email,
                type: 'codex',
                expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
            };
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token refresh failed:`, error.response?.data || error.message);
            throw new Error(`Failed to refresh tokens: ${error.response?.data?.error_description || error.message}`);
        }
    }

    /**
     * 解析 JWT token
     * @param {string} token
     * @returns {Object}
     */
    parseJWT(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid JWT token format');
            }

            // 解码 payload (base64url)
            const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
            return JSON.parse(payload);
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to parse JWT:`, error.message);
            throw new Error(`Failed to parse JWT token: ${error.message}`);
        }
    }

    /**
     * 保存凭据到文件
     * @param {Object} creds
     * @returns {Promise<Object>}
     */
    async saveCredentials(creds) {
        const email = creds.email || this.config.CODEX_EMAIL || 'default';

        // 优先使用配置中指定的路径，否则保存到 configs/codex 目录
        let credsPath;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            // 保存到 configs/codex 目录（与其他供应商一致）
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');
            await fs.promises.mkdir(targetDir, { recursive: true });
            const timestamp = Date.now();
            const filename = `${timestamp}_codex-${email}.json`;
            credsPath = path.join(targetDir, filename);
        }

        try {
            const credsDir = path.dirname(credsPath);
            await fs.promises.mkdir(credsDir, { recursive: true });
            await fs.promises.writeFile(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });

            const relativePath = path.relative(process.cwd(), credsPath);
            logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Credentials saved to ${relativePath}`);

            // 返回保存路径供后续使用
            return { credsPath, relativePath };
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to save credentials:`, error.message);
            throw new Error(`Failed to save credentials: ${error.message}`);
        }
    }

    /**
     * 加载凭据
     * @param {string} email
     * @returns {Promise<Object|null>}
     */
    async loadCredentials(email) {
        // 优先使用配置中指定的路径，否则从 configs/codex 目录加载
        let credsPath;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            // 从 configs/codex 目录加载（与其他供应商一致）
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');

            // 扫描目录找到匹配的凭据文件
            try {
                const files = await fs.promises.readdir(targetDir);
                const emailPattern = email || 'default';
                const matchingFile = files
                    .filter(f => f.includes(`codex-${emailPattern}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (matchingFile) {
                    credsPath = path.join(targetDir, matchingFile);
                } else {
                    return null;
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        }

        try {
            const data = await fs.promises.readFile(credsPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // 文件不存在
            }
            throw error;
        }
    }

    /**
     * 检查凭据文件是否存在
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    async credentialsExist(email) {
        // 优先使用配置中指定的路径，否则从 configs/codex 目录检查
        let credsPath;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');

            try {
                const files = await fs.promises.readdir(targetDir);
                const emailPattern = email || 'default';
                const hasMatch = files.some(f =>
                    f.includes(`codex-${emailPattern}`) && f.endsWith('.json')
                );
                return hasMatch;
            } catch (error) {
                return false;
            }
        }

        try {
            await fs.promises.access(credsPath);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * 带重试的 Codex token 刷新
 * @param {string} refreshToken
 * @param {Object} config
 * @param {number} maxRetries
 * @returns {Promise<Object>}
 */
export async function refreshCodexTokensWithRetry(refreshToken, config = {}, maxRetries = 3) {
    const auth = new CodexAuth(config);
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await auth.refreshTokens(refreshToken);
        } catch (error) {
            lastError = error;
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Retry ${i + 1}/${maxRetries} failed:`, error.message);

            if (i < maxRetries - 1) {
                // 指数退避
                const delay = Math.min(1000 * Math.pow(2, i), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

/**
 * 安全解析 JWT payload
 * @param {string} token
 * @returns {Object|null}
 */
function parseJwtPayloadSafe(token) {
    try {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

/**
 * 将过期时间候选值转换为 ISO 字符串
 * @param {unknown} value
 * @returns {string|null}
 */
function toExpiryIsoString(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const timestamp = value > 1e12 ? value : value * 1000;
        const parsed = new Date(timestamp);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;

        if (/^\d+$/.test(trimmed)) {
            const numeric = Number(trimmed);
            return toExpiryIsoString(numeric);
        }

        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }

    return null;
}

/**
 * 判断对象是否包含 Codex 凭据关键字段
 * @param {Object} value
 * @returns {boolean}
 */
function hasCodexCredentialShape(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return [
        'access_token',
        'refresh_token',
        'id_token',
        'account_id',
        'email',
        'expired',
        'exp'
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * 提取 Codex 凭据对象（支持常见嵌套结构）
 * @param {Object} rawToken
 * @returns {Object}
 */
function extractCodexCredentialPayload(rawToken) {
    if (hasCodexCredentialShape(rawToken)) {
        return rawToken;
    }

    const nestedKeys = ['token', 'credentials', 'auth', 'data', 'oauth', 'codex'];
    for (const key of nestedKeys) {
        const nested = rawToken?.[key];
        if (hasCodexCredentialShape(nested)) {
            return nested;
        }
    }

    return rawToken;
}

/**
 * 标准化导入的 Codex 凭据
 * @param {Object} rawToken
 * @returns {Object}
 */
function normalizeImportedCodexToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'object' || Array.isArray(rawToken)) {
        throw new Error('Token 必须是 JSON 对象');
    }

    const payload = extractCodexCredentialPayload(rawToken);

    const idToken = payload.id_token || rawToken.id_token || '';
    const accessToken = payload.access_token || rawToken.access_token || '';
    const refreshToken = payload.refresh_token || rawToken.refresh_token || '';

    if (!accessToken) {
        throw new Error('Token 缺少必需字段 access_token');
    }

    const idClaims = parseJwtPayloadSafe(idToken);
    const accessClaims = parseJwtPayloadSafe(accessToken);
    const authClaims = payload['https://api.openai.com/auth']
        || rawToken['https://api.openai.com/auth']
        || idClaims?.['https://api.openai.com/auth']
        || accessClaims?.['https://api.openai.com/auth']
        || {};

    const profileClaims = payload['https://api.openai.com/profile']
        || rawToken['https://api.openai.com/profile']
        || accessClaims?.['https://api.openai.com/profile']
        || {};

    const email = payload.email
        || rawToken.email
        || idClaims?.email
        || profileClaims?.email
        || '';

    const accountId = payload.account_id
        || rawToken.account_id
        || authClaims?.chatgpt_account_id
        || idClaims?.sub
        || accessClaims?.sub
        || '';

    const expired = toExpiryIsoString(payload.expired)
        || toExpiryIsoString(rawToken.expired)
        || toExpiryIsoString(payload.expire)
        || toExpiryIsoString(rawToken.expire)
        || toExpiryIsoString(payload.expires_at)
        || toExpiryIsoString(rawToken.expires_at)
        || toExpiryIsoString(payload.expiresAt)
        || toExpiryIsoString(rawToken.expiresAt)
        || toExpiryIsoString(payload.exp)
        || toExpiryIsoString(rawToken.exp)
        || toExpiryIsoString(accessClaims?.exp)
        || toExpiryIsoString(idClaims?.exp)
        || new Date(Date.now() + 3600 * 1000).toISOString();

    return {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken || undefined,
        account_id: accountId || undefined,
        last_refresh: payload.last_refresh || rawToken.last_refresh || new Date().toISOString(),
        email: email || undefined,
        type: 'codex',
        expired,
        session_id: payload.session_id || rawToken.session_id || undefined
    };
}

/**
 * 生成稳定指纹（避免在内存中存储超长 token）
 * @param {string} value
 * @returns {string}
 */
function stableHash(value) {
    return crypto.createHash('sha1').update(value).digest('hex');
}

/**
 * 生成身份指纹
 * @param {string} email
 * @param {string} accountId
 * @returns {string|null}
 */
function buildIdentityKey(email, accountId) {
    if (!email || !accountId) return null;
    return `${String(email).toLowerCase()}#${String(accountId)}`;
}

/**
 * 规范化并发参数
 * @param {number} value
 * @param {number} defaultValue
 * @param {number} maxValue
 * @returns {number}
 */
function normalizeConcurrency(value, defaultValue, maxValue) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
    return Math.max(1, Math.min(parsed, maxValue));
}

/**
 * 创建并发限制器
 * @param {number} maxConcurrency
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createLimiter(maxConcurrency) {
    let activeCount = 0;
    const queue = [];

    const runNext = () => {
        if (activeCount >= maxConcurrency || queue.length === 0) return;
        const job = queue.shift();
        activeCount++;
        Promise.resolve()
            .then(job.task)
            .then(job.resolve)
            .catch(job.reject)
            .finally(() => {
                activeCount--;
                runNext();
            });
    };

    return (task) => new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        runNext();
    });
}

/**
 * 并发执行索引任务
 * @param {number} total
 * @param {number} concurrency
 * @param {(index: number) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function runWithConcurrency(total, concurrency, worker) {
    if (total <= 0) return;
    let cursor = 0;

    const workers = Array.from({ length: Math.min(total, concurrency) }, async () => {
        while (true) {
            const currentIndex = cursor;
            cursor++;
            if (currentIndex >= total) break;
            await worker(currentIndex);
        }
    });

    await Promise.all(workers);
}

/**
 * 安全文件名片段
 * @param {string} email
 * @param {number} index
 * @returns {string}
 */
function getSafeEmailForFilename(email, index) {
    const base = (email || `unknown-${index + 1}`).toString();
    const sanitized = base.replace(/[\\/:*?"<>|]/g, '_').trim();
    return sanitized || `unknown-${index + 1}`;
}

/**
 * 扫描已有 Codex 凭据，构建去重索引
 * @param {string} targetDir
 * @returns {Promise<{refreshTokenIndex: Map<string, string>, identityIndex: Map<string, string>}>}
 */
async function buildCodexDuplicateIndex(targetDir) {
    const refreshTokenIndex = new Map();
    const identityIndex = new Map();

    if (!fs.existsSync(targetDir)) {
        return { refreshTokenIndex, identityIndex };
    }

    const files = await fs.promises.readdir(targetDir);
    for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const fullPath = path.join(targetDir, file);
        try {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const parsed = JSON.parse(content);
            const payload = extractCodexCredentialPayload(parsed);

            const refreshToken = payload.refresh_token || parsed.refresh_token;
            if (refreshToken && typeof refreshToken === 'string') {
                refreshTokenIndex.set(stableHash(refreshToken), path.relative(process.cwd(), fullPath));
            }

            const identityKey = buildIdentityKey(
                payload.email || parsed.email,
                payload.account_id || parsed.account_id
            );
            if (identityKey) {
                identityIndex.set(identityKey, path.relative(process.cwd(), fullPath));
            }
        } catch {
            // 忽略损坏/非标准文件
        }
    }

    return { refreshTokenIndex, identityIndex };
}

/**
 * 批量导入 Codex Token（流式版本，支持实时进度）
 * @param {Object[]} tokens - Token 对象数组
 * @param {Object} options - 导入选项
 * @param {Function} onProgress - 进度回调
 * @returns {Promise<Object>}
 */
export async function batchImportCodexTokensStream(tokens, options = {}, onProgress = null) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        throw new Error('tokens array is required and must not be empty');
    }

    const skipDuplicateCheck = options.skipDuplicateCheck !== false;
    const importConcurrency = normalizeConcurrency(
        options.concurrency,
        DEFAULT_CODEX_IMPORT_CONCURRENCY,
        MAX_CODEX_IMPORT_CONCURRENCY
    );
    const refreshAfterImport = options.refreshAfterImport === true;
    const refreshConcurrency = normalizeConcurrency(
        options.refreshConcurrency,
        DEFAULT_CODEX_REFRESH_CONCURRENCY,
        MAX_CODEX_REFRESH_CONCURRENCY
    );

    const targetDir = path.join(process.cwd(), 'configs', 'codex');
    await fs.promises.mkdir(targetDir, { recursive: true });

    const results = {
        total: tokens.length,
        success: 0,
        failed: 0,
        details: []
    };

    const details = new Array(tokens.length);
    const importedCredPaths = [];
    let processedCount = 0;

    const { refreshTokenIndex, identityIndex } = skipDuplicateCheck
        ? { refreshTokenIndex: new Map(), identityIndex: new Map() }
        : await buildCodexDuplicateIndex(targetDir);

    const inBatchRefreshTokenSet = new Set();
    const inBatchIdentitySet = new Set();
    const refreshLimiter = createLimiter(refreshConcurrency);

    const handleProgress = (index, current) => {
        processedCount++;
        if (current.success) {
            results.success++;
        } else {
            results.failed++;
        }
        details[index] = current;

        if (onProgress) {
            onProgress({
                index: index + 1,
                total: tokens.length,
                processedCount,
                current,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    };

    await runWithConcurrency(tokens.length, importConcurrency, async (index) => {
        const rawToken = tokens[index];
        let reservedRefreshHash = null;
        let reservedIdentityKey = null;

        try {
            let normalized = normalizeImportedCodexToken(rawToken);

            if (!skipDuplicateCheck) {
                const refreshToken = normalized.refresh_token;
                if (refreshToken) {
                    const refreshHash = stableHash(refreshToken);
                    const existingPath = refreshTokenIndex.get(refreshHash);
                    if (existingPath) {
                        handleProgress(index, {
                            index: index + 1,
                            success: false,
                            error: 'duplicate',
                            reason: 'refresh_token',
                            existingPath
                        });
                        return;
                    }
                    if (inBatchRefreshTokenSet.has(refreshHash)) {
                        handleProgress(index, {
                            index: index + 1,
                            success: false,
                            error: 'duplicate',
                            reason: 'refresh_token_in_batch'
                        });
                        return;
                    }
                    inBatchRefreshTokenSet.add(refreshHash);
                    reservedRefreshHash = refreshHash;
                }

                const identityKey = buildIdentityKey(normalized.email, normalized.account_id);
                if (identityKey) {
                    const existingPath = identityIndex.get(identityKey);
                    if (existingPath) {
                        if (reservedRefreshHash) {
                            inBatchRefreshTokenSet.delete(reservedRefreshHash);
                            reservedRefreshHash = null;
                        }
                        handleProgress(index, {
                            index: index + 1,
                            success: false,
                            error: 'duplicate',
                            reason: 'email_account_id',
                            existingPath
                        });
                        return;
                    }
                    if (inBatchIdentitySet.has(identityKey)) {
                        if (reservedRefreshHash) {
                            inBatchRefreshTokenSet.delete(reservedRefreshHash);
                            reservedRefreshHash = null;
                        }
                        handleProgress(index, {
                            index: index + 1,
                            success: false,
                            error: 'duplicate',
                            reason: 'email_account_id_in_batch'
                        });
                        return;
                    }
                    inBatchIdentitySet.add(identityKey);
                    reservedIdentityKey = identityKey;
                }
            }

            const refreshMeta = {
                attempted: false,
                success: false,
                skipped: false,
                message: ''
            };

            if (refreshAfterImport) {
                if (normalized.refresh_token) {
                    refreshMeta.attempted = true;
                    try {
                        const refreshedTokens = await refreshLimiter(() => refreshCodexTokensWithRetry(normalized.refresh_token, CONFIG));
                        normalized = {
                            ...normalized,
                            ...refreshedTokens,
                            refresh_token: refreshedTokens.refresh_token || normalized.refresh_token,
                            last_refresh: new Date().toISOString(),
                            type: 'codex',
                            expired: toExpiryIsoString(
                                refreshedTokens.expired
                                || refreshedTokens.expire
                                || refreshedTokens.expires_at
                                || refreshedTokens.expiresAt
                            ) || normalized.expired
                        };
                        refreshMeta.success = true;
                        refreshMeta.message = 'refresh_success';
                    } catch (error) {
                        refreshMeta.success = false;
                        refreshMeta.message = error.message || 'refresh_failed';
                    }
                } else {
                    refreshMeta.skipped = true;
                    refreshMeta.message = 'missing_refresh_token';
                }
            }

            const safeEmail = getSafeEmailForFilename(normalized.email, index);
            const filename = `${Date.now()}_${index}_${crypto.randomBytes(3).toString('hex')}_codex-${safeEmail}.json`;
            const credPath = path.join(targetDir, filename);
            await fs.promises.writeFile(credPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });

            const relativePath = path.relative(process.cwd(), credPath);
            importedCredPaths.push(relativePath);

            if (!skipDuplicateCheck) {
                if (reservedRefreshHash) {
                    refreshTokenIndex.set(reservedRefreshHash, relativePath);
                }
                if (reservedIdentityKey) {
                    identityIndex.set(reservedIdentityKey, relativePath);
                }
            }

            const current = {
                index: index + 1,
                success: true,
                path: relativePath,
                email: normalized.email || null
            };

            if (refreshAfterImport) {
                current.refresh = refreshMeta;
            }

            if (refreshAfterImport && refreshMeta.attempted && !refreshMeta.success) {
                current.warning = refreshMeta.message;
            }

            handleProgress(index, current);
        } catch (error) {
            if (!skipDuplicateCheck) {
                if (reservedRefreshHash) {
                    inBatchRefreshTokenSet.delete(reservedRefreshHash);
                }
                if (reservedIdentityKey) {
                    inBatchIdentitySet.delete(reservedIdentityKey);
                }
            }

            handleProgress(index, {
                index: index + 1,
                success: false,
                error: error.message
            });
        }
    });

    results.details = details;

    if (importedCredPaths.length > 0) {
        await autoLinkProviderConfigs(CONFIG, { credPaths: importedCredPaths });
        broadcastEvent('oauth_batch_success', {
            provider: 'openai-codex-oauth',
            count: importedCredPaths.length,
            timestamp: new Date().toISOString()
        });
    }

    return results;
}

/**
 * 处理 Codex OAuth 认证
 * @param {Object} currentConfig - 当前配置
 * @param {Object} options - 选项
 * @returns {Promise<Object>} 返回认证结果
 */
export async function handleCodexOAuth(currentConfig, options = {}) {
    const auth = new CodexAuth(currentConfig);

    try {
        logger.info('[Codex Auth] Generating OAuth URL...');

        // 清理所有旧的会话和服务器
        if (global.codexOAuthSessions && global.codexOAuthSessions.size > 0) {
            logger.info('[Codex Auth] Cleaning up old OAuth sessions...');
            for (const sessionId of Array.from(global.codexOAuthSessions.keys())) {
                try {
                    await cleanupCodexSession(sessionId, 'replaced by new authorization');
                } catch (error) {
                    logger.warn(`[Codex Auth] Failed to clean up session ${sessionId}:`, error.message);
                }
            }
        }

        // 生成授权 URL 和启动回调服务器
        const { authUrl, state, pkce, server } = await auth.generateAuthUrl();

        logger.info('[Codex Auth] OAuth URL generated successfully');

        // 存储 OAuth 会话信息，供后续回调使用
        if (!global.codexOAuthSessions) {
            global.codexOAuthSessions = new Map();
        }

        const sessionId = state; // 使用 state 作为 session ID
        
        // 轮询计数器
        let pollCount = 0;
        const maxPollCount = 200; // 增加到约 10 分钟 (200 * 3s = 600s)
        const pollInterval = 3000; // 轮询间隔（毫秒）
        let pollTimer = null;
        let isCompleted = false;
        
        // 创建会话对象
        const session = {
            auth,
            state,
            pkce,
            server,
            pollTimer: null,
            createdAt: Date.now()
        };
        
        global.codexOAuthSessions.set(sessionId, session);

        // 启动轮询日志
        pollTimer = setInterval(() => {
            pollCount++;
            if (pollCount <= maxPollCount && !isCompleted) {
                // 仅关键进度输出 info，其余降级为 debug，避免日志刷屏
                const isKeyProgress = pollCount === 1 || pollCount % 10 === 0 || pollCount === maxPollCount;
                const progressMessage = `[Codex Auth] Waiting for callback... (${pollCount}/${maxPollCount})`;
                if (isKeyProgress) {
                    logger.info(progressMessage);
                } else {
                    logger.debug(progressMessage);
                }
            }
            
            if (pollCount >= maxPollCount && !isCompleted) {
                isCompleted = true;
                const totalSeconds = (maxPollCount * pollInterval) / 1000;
                logger.info(`[Codex Auth] Polling timeout (${totalSeconds}s), releasing session for next authorization`);
                // 轮询超时时需要同时关闭回调端口，避免继续占用
                cleanupCodexSession(sessionId, 'polling timeout').catch((error) => {
                    logger.warn(`[Codex Auth] Failed to cleanup timeout session ${sessionId}:`, error.message);
                });
            }
        }, pollInterval);
        
        // 将 pollTimer 存储到会话中
        session.pollTimer = pollTimer;

        // 监听回调服务器的 auth-success 事件，自动完成 OAuth 流程
        server.once('auth-success', async (result) => {
            isCompleted = true;
            
            try {
                logger.info('[Codex Auth] Received auth callback, completing OAuth flow...');
                
                const session = global.codexOAuthSessions.get(sessionId);
                if (!session) {
                    logger.warn('[Codex Auth] Session not found (possibly canceled), ignore callback');
                    return;
                }

                // 完成 OAuth 流程
                const credentials = await auth.completeOAuthFlow(result.code, result.state, session.state, session.pkce);

                // 广播认证成功事件
                broadcastEvent('oauth_success', {
                    provider: 'openai-codex-oauth',
                    credPath: credentials.credPath,
                    relativePath: credentials.relativePath,
                    timestamp: new Date().toISOString(),
                    email: credentials.email,
                    accountId: credentials.account_id
                });

                // 自动关联新生成的凭据到 Pools
                await autoLinkProviderConfigs(CONFIG, {
                    onlyCurrentCred: true,
                    credPath: credentials.relativePath
                });

                logger.info('[Codex Auth] OAuth flow completed successfully');
            } catch (error) {
                logger.error('[Codex Auth] Failed to complete OAuth flow:', error.message);
                
                // 广播认证失败事件
                broadcastEvent('oauth_error', {
                    provider: 'openai-codex-oauth',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            } finally {
                await cleanupCodexSession(sessionId, 'callback completed');
            }
        });

        // 监听 auth-error 事件
        server.once('auth-error', async (error) => {
            isCompleted = true;
            
            logger.error('[Codex Auth] Auth error:', error.message);
            await cleanupCodexSession(sessionId, 'callback error');
            
            broadcastEvent('oauth_error', {
                provider: 'openai-codex-oauth',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        });

        return {
            success: true,
            authUrl: authUrl,
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce',
                sessionId: sessionId,
                redirectUri: CODEX_OAUTH_CONFIG.redirectUri,
                port: CODEX_OAUTH_CONFIG.port,
                instructions: [
                    '1. 点击下方按钮在浏览器中打开授权链接',
                    '2. 使用您的 OpenAI 账户登录',
                    '3. 授权应用访问您的 Codex API',
                    '4. 授权成功后会自动保存凭据',
                    '5. 如果浏览器未自动跳转，请手动复制回调 URL'
                ]
            }
        };
    } catch (error) {
        logger.error('[Codex Auth] Failed to generate OAuth URL:', error.message);

        return {
            success: false,
            error: error.message,
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce',
                instructions: [
                    `1. 确保端口 ${CODEX_OAUTH_CONFIG.port} 未被占用`,
                    '2. 确保可以访问 auth.openai.com',
                    '3. 确保浏览器可以正常打开',
                    '4. 如果问题持续，请检查网络连接'
                ]
            }
        };
    }
}

/**
 * 取消 Codex OAuth 授权流程
 * @param {Object} options
 * @param {string} [options.sessionId] - 可选，仅取消指定会话
 * @returns {Promise<Object>}
 */
export async function handleCodexOAuthCancel(options = {}) {
    const { sessionId } = options;
    let canceledCount = 0;

    if (global.codexOAuthSessions && global.codexOAuthSessions.size > 0) {
        const targetSessionIds = sessionId
            ? [sessionId]
            : Array.from(global.codexOAuthSessions.keys());

        for (const id of targetSessionIds) {
            try {
                const canceled = await cleanupCodexSession(id, 'manual cancel');
                if (canceled) canceledCount++;
            } catch (error) {
                logger.warn(`[Codex Auth] Failed to cancel session ${id}:`, error.message);
            }
        }
    }

    // 兜底关闭活动回调服务器（会话可能已过期但端口仍占用）
    await closeActiveServer('openai-codex-oauth', CODEX_OAUTH_CONFIG.port);

    logger.info(`[Codex Auth] OAuth canceled, closed session count: ${canceledCount}`);
    return {
        success: true,
        provider: 'openai-codex-oauth',
        canceled: canceledCount
    };
}

/**
 * 处理 Codex OAuth 回调
 * @param {string} code - 授权码
 * @param {string} state - 状态参数
 * @returns {Promise<Object>} 返回认证结果
 */
export async function handleCodexOAuthCallback(code, state) {
    let callbackSuccess = false;
    try {
        if (!global.codexOAuthSessions || !global.codexOAuthSessions.has(state)) {
            throw new Error('Invalid or expired OAuth session');
        }

        const session = global.codexOAuthSessions.get(state);
        const { auth, state: expectedState, pkce } = session;

        logger.info('[Codex Auth] Processing OAuth callback...');

        // 完成 OAuth 流程
        const result = await auth.completeOAuthFlow(code, state, expectedState, pkce);

        // 广播认证成功事件（与 gemini 格式一致）
        broadcastEvent('oauth_success', {
            provider: 'openai-codex-oauth',
            credPath: result.credPath,
            relativePath: result.relativePath,
            timestamp: new Date().toISOString(),
            email: result.email,
            accountId: result.account_id
        });

        // 自动关联新生成的凭据到 Pools
        await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: result.relativePath
        });

        logger.info('[Codex Auth] OAuth callback processed successfully');
        callbackSuccess = true;

        return {
            success: true,
            message: 'Codex authentication successful',
            credentials: result,
            email: result.email,
            accountId: result.account_id,
            credPath: result.credPath,
            relativePath: result.relativePath
        };
    } catch (error) {
        logger.error('[Codex Auth] OAuth callback failed:', error.message);

        // 广播认证失败事件
        broadcastEvent('oauth_error', {
            provider: 'openai-codex-oauth',
            error: error.message,
            timestamp: new Date().toISOString()
        });

        return {
            success: false,
            error: error.message
        };
    } finally {
        // 无论成功失败都要清理轮询定时器与监听端口
        try {
            await cleanupCodexSession(state, callbackSuccess ? 'manual callback success' : 'manual callback finished');
        } catch (cleanupError) {
            logger.warn('[Codex Auth] Failed to cleanup callback session:', cleanupError.message);
        }
    }
}
