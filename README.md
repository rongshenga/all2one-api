<div align="center">

<img src="static/favicon.svg" alt="All2One API logo" style="width: 128px; height: 128px; margin-bottom: 8px;">

# All2One API

**把多种客户端专属或 OAuth 驱动的 AI 服务，统一封装为本地 OpenAI / Claude / Gemini 兼容接口的 Node.js 代理。**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.13.1-orange.svg)](https://pnpm.io/)

</div>

## 项目定位

All2One API 当前是一个以本地部署为核心的 AI 代理服务，代码基于 Node.js ESM 构建，默认提供：

- Web UI 管理控制台
- 主进程 + Worker 守护启动模式
- OpenAI / Claude / Gemini 协议互转
- 提供商池、健康检查、自动切换与降级
- SQLite Runtime Storage
- OAuth 凭据管理、批量导入、手动回调处理
- 可插拔插件系统

它更适合这种场景：

- 你已经有多种 OAuth 凭据、Cookie 或第三方 API 端点，想统一成一套本地入口
- 你想把客户端专用能力接到标准 OpenAI / Claude 兼容客户端里
- 你需要一个带 UI、日志、账号池和运行时存储的本地中转层

## 项目来源

- 当前项目是从 [justlovemaki/AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) fork 后持续演进的分支，仓库技术标识统一为 `all2one-api`，对外展示名称统一为 `All2One API`。
- 早期思路与部分实现参考了 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)。
- 在这条基础线上，当前代码已经继续扩展出主进程守护、SQLite Runtime Storage、插件系统、Grok TLS Sidecar、Codex OAuth、前端管理控制台等能力。

## 当前代码能力

### 已注册并可直接使用的 Provider

下表按当前 [`src/providers/adapter.js`](./src/providers/adapter.js) 的注册状态整理，不拿 README 瞎吹。

| Provider ID | 当前状态 | 主要凭据/配置 | 说明 |
| --- | --- | --- | --- |
| `gemini-cli-oauth` | 已注册 | Gemini OAuth + Project ID | Gemini CLI OAuth 适配器 |
| `gemini-antigravity` | 已注册 | Antigravity OAuth + Project ID | Gemini/Claude 相关增强模型入口 |
| `claude-custom` | 已注册 | `CLAUDE_API_KEY` / `CLAUDE_BASE_URL` | 标准 Claude 兼容提供商 |
| `claude-kiro-oauth` | 已注册 | Kiro OAuth 凭据 | Kiro 路由下的 Claude 能力 |
| `openai-custom` | 已注册 | `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 标准 OpenAI 兼容提供商 |
| `openaiResponses-custom` | 已注册 | `OPENAI_API_KEY` / `OPENAI_BASE_URL` | OpenAI Responses API |
| `openai-qwen-oauth` | 已注册 | Qwen OAuth 凭据 | Qwen Code OAuth |
| `openai-codex-oauth` | 已注册 | Codex OAuth 凭据 | Codex OAuth2 + PKCE |
| `grok-custom` | 已注册 | Grok Cookie / Clearance / UA | Grok Reverse 相关能力 |

### 代码中存在但默认未注册的 Provider

- `openai-iflow`
  - 代码里已经有 OAuth、模型列表、UI 处理和运行时存储映射。
  - 当前默认 adapter 注册被注释掉，不应在 README 里冒充“默认可用”。
- `forward-api`
  - 常量与部分结构预留，但当前默认 adapter 也未注册。

### 协议与路由能力

根据 [`src/handlers/request-handler.js`](./src/handlers/request-handler.js) 和相关转换层，当前项目覆盖这几类主入口：

- OpenAI Chat: `/v1/chat/completions`
- OpenAI Responses: `/v1/responses`
- Claude Messages: `/v1/messages`
- Gemini 兼容入口: `/v1beta/models/...`
- Path Routing: `/{provider}/...`

典型写法例如：

```bash
curl http://127.0.0.1:3000/gemini-cli-oauth/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <REQUIRED_API_KEY>" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## 运行架构

### 默认启动模式

默认脚本是：

```bash
pnpm run start
```

它会启动 [`src/core/master.js`](./src/core/master.js)，再由主进程拉起 [`src/services/api-server.js`](./src/services/api-server.js)。

当前主进程模式具备：

- Worker 异常退出自动重启
- 主进程管理端口 `3100`
- 启动日志与崩溃恢复
- Worker 就绪状态上报

如果你就是想单进程直跑，也有：

```bash
pnpm run start:standalone
```

### 启动前 Bootstrap

服务监听端口前，会先做阻塞式 bootstrap：

- 加载 `configs/config.json`
- 初始化 Runtime Storage
- 初始化 UI 管理模块
- 处理 provider pools 与启动前预热
- 完成后才开始监听 Web/API 端口

这点和那种先 listen 再补状态的糊弄式启动不是一回事。

## 快速开始

### 方式一：Docker 直接运行

```bash
docker run -d \
  --name all2one-api \
  --restart=unless-stopped \
  -p 3000:3000 \
  -p 8085-8087:8085-8087 \
  -p 1455:1455 \
  -p 19876-19880:19876-19880 \
  -v "$(pwd)/configs:/app/configs" \
  justlikemaki/all2one-api:latest
```

这些端口在当前代码里的含义大致是：

- `3000`: Web UI 与主 API
- `8085`: Gemini CLI OAuth 回调
- `8086`: Antigravity OAuth 回调
- `8087`: iFlow OAuth 回调预留
- `1455`: Codex OAuth 回调
- `19876-19880`: Kiro OAuth 回调端口范围

### 方式二：Docker Compose

直接使用预构建镜像：

```bash
cd docker
mkdir -p configs
docker compose up -d
```

如果你要本地源码构建镜像：

```bash
cd docker
docker compose -f docker-compose.build.yml up -d --build
```

当前 Compose 文件见：

- [`docker/docker-compose.yml`](./docker/docker-compose.yml)
- [`docker/docker-compose.build.yml`](./docker/docker-compose.build.yml)

### 方式三：本地运行

```bash
pnpm install --frozen-lockfile
pnpm run start
```

Windows 用户可以直接用：

```bat
install-and-run.bat
```

Linux / macOS 可以用：

```bash
chmod +x install-and-run.sh
./install-and-run.sh
```

### 登录与入口

- Web UI 首页：`http://127.0.0.1:3000/`
- 登录页真实路径：`http://127.0.0.1:3000/login.html`
- 默认登录密码引导值：`admin123`

默认密码来源于：

- [`configs/pwd`](./configs/pwd)
- [`src/ui-modules/auth.js`](./src/ui-modules/auth.js)

当前认证权威模式默认是 `db_only`。也就是说，系统会优先把登录口令与凭据 authority 收拢到 Runtime Storage，而不是继续依赖老式散文件。

## 关键配置

当前主配置文件是 [`configs/config.json`](./configs/config.json)。

几个最关键的配置项：

- `REQUIRED_API_KEY`
  - API 请求访问密钥
- `SERVER_PORT`
  - Web/API 监听端口，默认示例配置是 `3000`
- `MODEL_PROVIDER`
  - 支持逗号分隔的 provider 列表，启动时会标准化并生成 `DEFAULT_MODEL_PROVIDERS`
- `PROVIDER_POOLS_FILE_PATH`
  - 默认是 `configs/provider_pools.json`
- `RUNTIME_STORAGE_DB_PATH`
  - 默认是 `configs/runtime/runtime-storage.sqlite`
- `AUTH_STORAGE_MODE`
  - 允许 `db_only` / `bridge`，当前默认是 `db_only`
- `LOGIN_EXPIRY`
  - 登录过期秒数，默认 `3600`
- `TLS_SIDECAR_ENABLED`
  - 是否启用 Go uTLS sidecar
- `PROXY_URL` / `PROXY_ENABLED_PROVIDERS`
  - 统一代理及启用代理的 provider 列表

## Runtime Storage

当前代码已经把 Runtime Storage 当成主线能力，不是摆设。

默认状态：

- Backend: `db`
- SQLite 文件: `configs/runtime/runtime-storage.sqlite`
- Auth authority mode: `db_only`
- provider pools 兼容快照：从 Runtime Storage 加载并写回 `config.providerPools`

运维脚本入口：

```bash
pnpm run runtime-storage:admin -- <command>
```

已实现的命令来自 [`src/scripts/runtime-storage-admin.js`](./src/scripts/runtime-storage-admin.js)：

- `migrate`
- `verify`
- `verify-auth`
- `export-legacy`
- `rollback`
- `rollback-auth`
- `list-runs`
- `show-run`
- `benchmark`

如果你正在做数据库迁移，不要拿 README 乱试参数，直接看 [docs/runtime-storage-migration.md](./docs/runtime-storage-migration.md)。

## Web UI 与静态页面

当前 Web UI 不是一页表单糊上去的，它由组件加载器动态拼装，主要入口是：

- [`static/index.html`](./static/index.html)
- [`static/login.html`](./static/login.html)
- [`static/components/header.html`](./static/components/header.html)
- [`static/app/component-loader.js`](./static/app/component-loader.js)

首页包含的主模块：

- 仪表盘
- 配置教程
- 配置管理
- 提供商池管理
- 用量查询
- 使用统计
- 插件管理
- 实时日志

另外还存在几个静态工具页：

- `potluck.html`
- `potluck-user.html`
- `codex-zip-checker.html`

其中 `potluck` 页面是否真正有后端能力，取决于插件是否启用。

## 插件系统

插件系统入口在 [`src/core/plugin-manager.js`](./src/core/plugin-manager.js)，配置文件是 `configs/plugins.json`。

当前内置插件：

| 插件 | 类型 | 默认状态 | 说明 |
| --- | --- | --- | --- |
| `default-auth` | `auth` | 启用 | 默认 API Key 认证 |
| `api-potluck` | `auth` | 默认禁用 | API Key 大锅饭、额度、用户侧页面 |
| `ai-monitor` | `middleware` | 默认禁用 | 请求/响应链路监控与聚合日志 |

默认禁用逻辑就在插件管理器里写死了，不是什么“计划支持”。

## TLS Sidecar

当前仓库自带 Go 实现的 TLS Sidecar，用来配合某些需要浏览器指纹/TLS 指纹的请求链路。

代码位置：

- [`tls-sidecar/`](./tls-sidecar)
- [`Dockerfile`](./Dockerfile)

当前行为：

- Docker 镜像构建时会自动编译 sidecar 并复制到 `/app/tls-sidecar/tls-sidecar`
- 本地直接运行时，如果你要用这部分能力，需要自己编译

本地编译方式：

```bash
cd tls-sidecar
go build -o tls-sidecar
cd ..
```

## 健康检查与接口

当前容器健康检查脚本是 [`healthcheck.js`](./healthcheck.js)，会请求：

```text
GET /health
```

此外 UI 层还提供：

- `GET /api/health`
- `GET /api/config`
- `POST /api/config`
- `GET /api/system`

## 常用命令

```bash
pnpm install --frozen-lockfile
pnpm run start
pnpm run start:standalone
pnpm run start:dev
pnpm run runtime-storage:admin -- help
pnpm test
pnpm run test:coverage
```

当前最稳妥的测试入口仍然是：

- `pnpm test`
- `pnpm run test:coverage`

## 目录结构

```text
src/
  auth/           OAuth 与凭据处理
  converters/     协议转换策略
  core/           主进程、配置、插件管理
  handlers/       请求入口与路由分发
  plugins/        内置插件
  providers/      各 provider 实现与 adapter
  scripts/        运维与迁移脚本
  services/       API/UI/服务编排
  storage/        Runtime Storage 与迁移逻辑
  ui-modules/     Web UI 后端接口
static/           前端页面与组件
configs/          运行配置、凭据、SQLite 数据
docker/           Compose 文件
tests/            Jest 测试
tls-sidecar/      Go uTLS sidecar
```

## 致谢

- 上游基础项目：[justlovemaki/AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API)
- 参考项目：[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- Google Gemini CLI
- Cline 相关实现思路与协议转换经验

## 开源许可

本项目遵循 [GNU General Public License v3 (GPLv3)](https://www.gnu.org/licenses/gpl-3.0)。

## 免责声明

- 本项目仅供学习与研究使用。
- 本项目本身不提供任何第三方模型服务。
- 任何账号、Cookie、OAuth 凭据、代理节点或第三方 API 的可用性、稳定性与合规性，均由使用者自行承担风险。
