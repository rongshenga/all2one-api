## Context

当前项目的运行时持久化能力分散在多个文件模块中：

- `configs/config.json` 承载主配置
- `configs/provider_pools.json` 承载 Provider 池状态和凭据路径引用
- `configs/<provider>/` 承载各类 OAuth 或凭据文件
- `configs/usage-cache.json` 承载使用缓存
- `configs/api-potluck-data.json` 与 `configs/api-potluck-keys.json` 承载插件运行数据

文件存储适合低规模、低并发、手工可见性的场景，但不适合承载高频状态变更和持续膨胀的凭据目录。当前已经出现如下风险：

- 大 JSON 文件高频整文件改写
- 不同模块对同一文件使用不同写入策略
- 中断时残留 `.tmp` 文件
- 目录扫描和去重成本持续升高
- Provider 运行时状态与凭据资产混杂在同一条链路中

当前工作区里已经能看到问题规模：

- `configs/codex/` 约有 `96447` 个凭据文件
- `configs/provider_pools.json` 当前约 `58,167,411` 字节，`openai-codex-oauth` 池内约 `88,610` 条记录
- `configs/` 根目录当前可见 `4` 个 `provider_pools.json.*.tmp` 残留文件

这些现象说明文件存储不只是“以后可能有风险”，而是已经在当前仓库数据规模下开始直接制造复杂度和故障面。

## Goals / Non-Goals

- Goals:
  - 为高频运行时状态提供事务化、可索引、可并发控制的数据库存储
  - 将“配置文件导入导出”与“运行时权威状态”解耦
  - 允许分阶段迁移，并保留兼容旧文件流的能力
  - 降低 `configs/` 目录规模膨胀和临时文件残留风险
- Non-Goals:
  - 本次提案不直接删除现有文件导入能力
  - 本次提案不要求第一阶段立刻移除所有基于文件的凭据原文
  - 本次提案不要求一次性重写全部提供商认证流程
  - 本次提案不要求把日志、更新包、上传暂存文件这类明显的文件型数据迁入数据库

## Current Data Flows

### 1. 启动与配置加载链路

1. 服务启动时由 `src/core/config-manager.js` 读取 `configs/config.json`。
2. 同一初始化阶段读取 `SYSTEM_PROMPT_FILE_PATH` 指向的提示词文件，以及 `configs/provider_pools.json`。
3. Web UI 更新配置时，`src/ui-modules/config-api.js` 先更新内存中的 `CONFIG`，再回写 `configs/config.json` 和系统提示词文件。
4. Reload 操作会再次从文件系统重建配置和 provider pools。

结论：这条链路主要属于“低频人工配置 + 启动引导配置”，不是数据库迁移的首要矛盾。

### 2. Provider 凭据接入链路

1. 用户可通过 Web UI 上传 OAuth/凭据文件，文件先落到 `configs/temp/`，再被移动到 `configs/<provider>/`。
2. 各 OAuth 流程和批量导入逻辑会把新凭据写入 `configs/gemini/`、`configs/qwen/`、`configs/iflow/`、`configs/kiro/`、`configs/codex/` 等目录，部分提供商也支持写入用户家目录默认凭据路径。
3. 新文件写入后会调用 `autoLinkProviderConfigs()` 扫描目录并把新路径追加进 `provider_pools.json`。
4. 配置管理页面又通过 `config-scanner` 递归扫描 `configs/` 展示文件状态。

结论：这条链路同时承担“凭据原文保存”“凭据索引”“Provider 注册”“UI 清单展示”四种职责，耦合过重，是数据库迁移的核心目标之一。

### 3. Provider 运行期鉴权与刷新链路

1. Provider 适配器在请求前从凭据文件读取 token。
2. 当 token 接近过期或刷新成功后，Gemini、Antigravity、Qwen、iFlow、Codex、Kiro 都会把新 token 重新写回原文件。
3. Qwen 还会额外创建 `.lock` 文件防止并发刷新冲突；Kiro 会尝试修复损坏 JSON；Codex 会在未绑定固定路径时继续生成新文件。

结论：这条链路说明凭据文件当前仍是 Provider 认证的运行时权威源。第一阶段不能粗暴删掉文件兼容层，但需要尽快把“凭据索引 / 去重 / 查询 / 绑定关系”从文件系统移出。

### 4. Provider 池运行时状态链路

1. 请求选点时，`ProviderPoolManager` 会更新 `lastUsed`、`usageCount`、`_lastSelectionSeq` 等运行时字段。
2. 防抖写入会把这些字段批量落到 `configs/provider_pools.json`。
3. OAuth 导入和自动关联也会直接写同一个文件。
4. 启动时又从该文件恢复 provider pools。

结论：这是当前最需要数据库迁移的链路，因为它把静态注册数据和高频运行时状态塞进同一个巨型 JSON 文件里。

### 4.1 `provider_pools.json` 调用面与迁移要求

| 调用面 | 关键文件 | 当前行为 | 迁移要求 |
|---|---|---|---|
| 启动与 Reload | `src/core/config-manager.js`、`src/ui-modules/config-api.js`、`src/services/service-manager.js` | 启动/重载时把文件内容装入 `currentConfig.providerPools`，再据此初始化 `ProviderPoolManager` | 数据库模式必须先 hydrate Provider 池兼容快照，再同步给 `currentConfig.providerPools` 与 `ProviderPoolManager`，否则路由判断和热重载都会失效 |
| 运行时状态写回 | `src/providers/provider-pool-manager.js` | `markProviderHealthy`、`markProviderUnhealthy`、`disableProvider`、`refreshProviderUuid`、`resetProviderCounters` 等通过 `_debouncedSave()` / `_flushPendingSaves()` 合并回写同一 JSON 文件 | 改为批量事务 upsert；保留防抖/批写语义，但不能再整文件重写，也不能把每次选点都错误放大成数据库热写 |
| Web UI 管理接口 | `src/ui-modules/provider-api.js`、`src/services/ui-manager.js` | 列表读取以及 add/update/delete/disable/reset/delete unhealthy/refresh unhealthy UUIDs/quick link/Grok batch import 等都直接读写 `provider_pools.json` 并广播事件 | 所有 mutation 必须收口到统一的 RuntimeStorage/Repository 服务，提交成功后再刷新内存快照并保持现有广播语义 |
| 自动关联与批量关联 | `src/services/service-manager.js` | 递归扫描 `configs/<provider>/`，按路径去重后把新 Provider 直接追加到 `config.providerPools`，部分流程再写回文件 | 改为先写凭据索引/绑定关系，再 upsert Provider 注册记录；去重规则不能继续依赖全目录扫描和路径字符串碰运气 |
| 读取侧兼容 | `src/ui-modules/usage-api.js`、`src/ui-modules/config-scanner.js`、`src/services/service-manager.js#getProviderStatus`、`src/ui-modules/provider-api.js#loadProviderPools` | 优先读 `providerPoolManager.providerPools`，其次读 `currentConfig.providerPools` 或文件 | 必须提供 DB-backed compatibility snapshot，保证现有读侧在迁移期不需要立刻理解新表结构 |

### 5. 用量缓存与健康状态链路

1. `usage-api` 查询各 Provider 用量后，将汇总结果写入 `configs/usage-cache.json`。
2. 该缓存同时会影响 UI 展示和部分 Provider 健康状态同步。
3. 写入采用串行队列，但仍然是单文件整体写回。

结论：这属于典型的运行时缓存数据，适合第一阶段迁移到数据库。

### 6. 管理员认证与会话链路

1. 管理员密码从 `configs/pwd` 读取。
2. 登录成功后会话 token 存入 `configs/token-store.json`。
3. `api-potluck` 的管理员校验也会复用这个 token store。

结论：`token-store.json` 属于易变会话数据，适合迁入数据库；`pwd` 更像本地 secret/bootstrap 配置，不是本轮数据库迁移的重点。

### 7. API Potluck 插件业务链路

1. `api-potluck-data.json` 保存用户、凭据关联、资源包和插件配置。
2. `api-potluck-keys.json` 保存 Key 配额、状态和用量。
3. `user-data-manager` 还通过文件监听支持配置热更新。
4. Potluck 用户上传凭据时，也会先落 `configs/temp/`，再移动到 Provider 目录，并把引用写入业务数据文件。

结论：这部分已经具备独立业务数据模型，且有明显的并发写入需求，适合第一阶段迁移到数据库。

### 8. 观测、日志与维护链路

1. 日志写入 `logs/app-*.log`。
2. Prompt 日志会按文件追加写入 `prompt_log-*.log`。
3. `fetch_system_prompt.txt` 与 `input_system_prompt.txt` 分别承担运行辅助提示词和主提示词文件角色。
4. 更新流程会把 tarball 落到 `.update_temp/` 并解压。
5. 配置文件下载会把 `configs/` 目录打包成 zip 返回，但不做长期持久化。

结论：这部分是典型文件型资产，不建议迁入数据库。

## Local Persistence Inventory and Migration Assessment

| 数据域 | 本地路径/介质 | 当前职责 | 主要读写方 | 是否迁移到数据库 | 结论 |
|---|---|---|---|---|---|
| 主配置 | `configs/config.json` | 启动配置、人工可编辑配置 | `config-manager`、`config-api` | 否 | 保持文件作为 bootstrap 配置 |
| 主提示词 | `configs/input_system_prompt.txt` | 低频人工维护文本 | `config-manager`、`config-api` | 否 | 保持文件，便于人工编辑 |
| 抓取提示词缓存 | `configs/fetch_system_prompt.txt` | 运行辅助提示词缓存 | `provider-strategy` | 否 | 非数据库目标，后续可考虑降级为临时态 |
| 管理员密码 | `configs/pwd` | 本地管理口令 | `auth.js`、`config-api` | 否（本轮） | 更适合作为本地 secret/env，而不是业务数据库字段 |
| 管理员会话 | `configs/token-store.json` | 后台登录 token 与过期时间 | `auth.js`、`api-potluck/api-routes.js` | 是 | 运行时会话数据，建议迁移到数据库 |
| 插件配置 | `configs/plugins.json` | 插件启停配置 | `plugin-manager` | 否 | 低频配置，保留文件 |
| Provider 池 | `configs/provider_pools.json` | Provider 注册 + 路由 UUID + 运行时状态 + 部分内联敏感字段混合存储 | `config-manager`、`service-manager`、`provider-pool-manager`、`provider-api` | 是（强制） | 第一阶段核心迁移对象，必须拆分成注册、secret、绑定、运行时状态与兼容投影 |
| Provider 凭据原文 | `configs/kiro/`、`configs/gemini/`、`configs/qwen/`、`configs/antigravity/`、`configs/iflow/`、`configs/codex/`、`configs/grok/` 及部分家目录默认文件 | OAuth/token 原文 | OAuth 模块、Provider Core、上传接口 | 分阶段 | 文件型凭据先迁元数据/索引，原文文件保留兼容；但 `provider_pools.json` 内联 secret 不能继续留在旧文件里当权威源 |
| 凭据索引与去重 | 当前隐含在目录扫描与文件名中 | 识别、去重、绑定、展示 | `service-manager`、`config-scanner` | 是（强制） | 应迁到数据库索引，避免全目录扫描 |
| 用量缓存 | `configs/usage-cache.json` | Provider 用量查询缓存 | `usage-api`、`usage-cache` | 是 | 第一阶段迁移对象 |
| API Potluck 用户数据 | `configs/api-potluck-data.json` | 用户、凭据关联、资源包、插件配置 | `user-data-manager` | 是 | 第一阶段迁移对象 |
| API Potluck Key 数据 | `configs/api-potluck-keys.json` | Key 配额、状态、用量 | `key-manager` | 是 | 第一阶段迁移对象 |
| 上传暂存 | `configs/temp/` | Web 上传中转目录 | `event-broadcast`、`api-potluck/api-routes` | 否 | 明显的临时文件目录，不应入库 |
| 日志 | `logs/`、`prompt_log-*.log` | 审计、问题排查、调试 | `logger`、`utils/common.js` | 否 | 保持文件日志，不纳入业务数据库 |
| 更新临时文件 | `.update_temp/`、`update.tar.gz` | 自更新下载与解压 | `update-api` | 否 | 纯运维临时文件，不应入库 |

## Migration Priority

### Phase 1: 必须迁移

- `provider_pools.json` 中的 Provider 注册关系、运行时状态、路径绑定索引，以及内联 secret 字段（如 `OPENAI_API_KEY`、`CLAUDE_API_KEY`、`GROK_COOKIE_TOKEN`）
- 凭据索引、去重键、绑定关系、展示清单
- `usage-cache.json`
- `token-store.json`
- `api-potluck-data.json`
- `api-potluck-keys.json`

### Phase 2: 分阶段迁移

- Provider 凭据原文（OAuth token / refresh token / cookie / apiKey 等）
- 是否接入应用层加密或专用 secret store

### Phase 3: 明确保留文件形态

- `configs/config.json`
- `configs/input_system_prompt.txt`
- `configs/plugins.json`
- `logs/` 与 prompt log 文件
- `configs/temp/`、`.update_temp/` 等临时文件目录

## Recommended Target Model

- `bootstrap config` 继续留在文件：负责应用启动、路径约定和 feature flag
- `provider registry & routing identity` 进入数据库：保存不可变 `provider_id`、可变路由 `uuid`、`providerType`、展示字段与非敏感静态配置
- `provider runtime state` 进入数据库：保存健康状态、禁用状态、错误/使用计数、恢复时间、健康检查时间、可选的持久化选点状态
- `inline provider secret payload` 进入受保护的数据库记录：覆盖当前直接存在于 `provider_pools.json` 内的 API Key / Cookie / Token 等敏感字段
- `file-backed credential inventory` 进入数据库：记录 stable id、provider、identity key、checksum、当前激活路径；第一阶段继续保留原文文件兼容层
- `file import/export layer` 保留：保证现有 Web UI、批量导入和人工备份流程不被一次性打断

## Layered Runtime Model

### Recommended Layers

#### Layer 0: Bootstrap file layer

- 继续保留 `configs/config.json`、`configs/plugins.json`、`configs/input_system_prompt.txt`、`configs/pwd`
- 负责应用启动前即可读取的低频人工配置
- 不承担高频运行态写入

#### Layer 1: In-memory hot state layer

- 负责请求热路径上的短周期状态
- 典型内容：`active_count`、瞬时并发占位、选点辅助序号、待 flush 的 usage 增量、短周期熔断/冷却标记
- 这一层必须允许高频读写且避免每次请求都触发数据库事务
- 这一层在进程重启后允许部分非关键瞬时态丢失，只要求可从数据库恢复聚合后的稳定状态

#### Layer 2: Runtime database layer

- 负责高频业务状态的持久化“聚合结果”与可检索事实
- 典型内容：Provider 注册关系、运行时健康快照、累积 usage 计数、凭据索引与绑定关系、后台会话、Potluck 业务数据、迁移记录
- 这一层是运行期的权威持久化层，但写入应以批量 flush、状态合并和追加事件为主，而不是逐请求同步 commit

#### Layer 3: Optional secret backend

- 仅在第二阶段需要把敏感 payload 完整入库时启用
- 可实现为同库加密表，或独立 secret backend
- 这一层不承载热查询主路径，只承载敏感 token/cookie/apiKey 原文

#### Layer 4: Compatibility import/export layer

- 保留 `configs/<provider>/`、`provider_pools.json` 兼容导出、zip 打包导出、手工导入入口
- 作为迁移过渡层和运维兜底层存在
- 不再作为高频运行态的主写入路径

### Design Principle

- 请求热路径优先读 Layer 1 内存态
- 聚合后的稳定状态再异步 flush 到 Layer 2 数据库
- Layer 0 和 Layer 4 保持人工可见、可编辑、可导出，但退出高频写路径
- Layer 3 只处理敏感原文，不参与常规状态查询

## Large Pool Performance Strategy

### Problem framing

十几万账号规模下，真正的瓶颈不是“数据库里有十几万行”，而是：

- 是否还在对热字段做逐请求同步写入
- 是否把静态字段和高频状态塞在同一行/同一大 JSON 里
- 是否需要全目录扫描或全表扫描才能完成常规查询
- 是否让 UI 和后台任务一次性拉全量数据

### Required strategy for 100k+ provider accounts

#### 1. Separate static and hot data

- `provider_registrations` 只存静态/低频字段
- `provider_runtime_state` 只存可持久化的聚合运行态
- 不允许把 Provider 配置、健康状态、并发计数、错误历史继续揉成一个大对象整体重写

#### 2. Buffer hot-path writes in memory

- `active_count`、短周期命中次数、选择序号这类热字段先在内存层更新
- `usage_count`、`last_used_at`、健康状态变化按窗口或批次 flush
- flush 触发策略可先采用“时间窗口 + 脏记录数量阈值”的组合，例如 `1~5s` 或累计 `N` 次变更后写入
- 不要求每次请求结束都做同步 durable commit

#### 3. Use append-only events where suitable

- 健康检查失败、认证失败、UUID 刷新、批量导入结果等历史信息优先写追加事件表
- 主状态表只保留当前快照，避免无限膨胀的 JSON 历史字段

#### 4. Keep request-path selection mostly in memory

- Provider 选点、并发占位、分组游标优先依赖 `ProviderPoolManager` 内存索引
- 数据库负责恢复、校验、管理查询和聚合持久化，而不是在每次请求时重新做 DB 排序选点
- 对十几万账号场景，启动时构建内存索引比逐请求数据库扫描更合理

#### 5. Make management queries paginated and indexed

- Web UI、状态页、配置管理页必须使用分页、过滤和按需加载
- 不允许默认一次性返回十几万条 Provider 或凭据记录
- 常用筛选字段必须有索引，例如 `provider_type`、`is_healthy`、`is_disabled`、`identity_key`、`email`、`account_id`

#### 6. Prefer batch upsert over row-by-row churn

- 导入、自动关联、批量健康更新、用量快照刷新都应采用批量 upsert 或事务分批提交
- 避免把 100k 级导入任务拆成 100k 次独立小事务

### Implication for database count

- 十几万账号规模本身**不足以**证明需要多个主数据库
- 先把分层、表拆分、索引、批量 flush 做对，单个 `runtime` 主库就足够承接第一阶段
- 只有在未来出现多实例高并发写热点表、跨机部署或敏感密文体积明显拖累主库时，才考虑把 `secret` backend 独立出去或迁移到外部数据库

## Proposed Database Topology

### Recommendation

- **必须只有 1 个主数据库**：第一阶段建议只引入一个 `runtime` 数据库，默认实现为单文件 SQLite，例如 `data/runtime.sqlite`
- **高频热状态不直接等于数据库热写**：`runtime` 库负责持久化聚合结果，真正的请求热路径状态先进入内存层，再按批次 flush 到数据库
- **第一阶段就要容纳 provider_pools 内联 secret**：它们可先留在同一主库的受保护表中；只有在第二阶段决定把更大范围的 OAuth 原文完整入库时，才考虑额外的 `secret` backend
- **不建议一开始拆 2~3 个业务数据库**：当前项目还是单机部署、单进程主导，先拆多表，不要先拆多库；不然迁移、备份、回滚、开发联调全都会一起变得恶心

### Why one database first

- 当前最痛的问题是高频运行态数据和凭据索引无法事务化管理，不是数据库数量不够
- 单库更适合做统一事务、统一迁移脚本、统一备份恢复
- SQLite 足够承接第一阶段目标，后续如果有多实例部署需求，再把同一套表结构迁到外部数据库

## Proposed Tables

### DB-1: `runtime`

#### A. Core provider domain

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `provider_registrations` | Provider 注册与非敏感静态配置，替代 `provider_pools.json` 中的注册部分 | `provider_id`, `provider_type`, `routing_uuid`, `display_name`, `check_model`, `project_id`, `base_url`, `config_json`, `source_kind`, `created_at`, `updated_at` |
| `provider_runtime_state` | Provider 高频运行态字段 | `provider_id`, `is_healthy`, `is_disabled`, `usage_count`, `error_count`, `last_used_at`, `last_health_check_at`, `last_health_check_model`, `last_error_time`, `last_error_message`, `scheduled_recovery_at`, `refresh_count`, `last_selection_seq`, `updated_at` |
| `provider_inline_secrets` | 当前内联在 `provider_pools.json` 中的 API Key / Cookie / Token 等敏感字段 | `provider_id`, `secret_kind`, `secret_payload`, `protection_mode`, `updated_at` |
| `provider_health_events` | 健康检查、熔断、恢复、认证失败等事件历史 | `id`, `provider_id`, `event_type`, `level`, `message`, `status_code`, `detail_json`, `created_at` |
| `provider_group_state` | 大号池分组选点相关游标和组状态 | `provider_type`, `group_key`, `cursor`, `healthy_count`, `unhealthy_ratio`, `updated_at` |

#### B. Credential inventory domain

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `credential_assets` | 凭据资产主表，记录 provider 凭据的元数据和稳定身份 | `id`, `provider_type`, `identity_key`, `dedupe_key`, `email`, `account_id`, `external_user_id`, `source_kind`, `source_path`, `source_checksum`, `storage_mode`, `is_active`, `last_imported_at`, `last_refreshed_at`, `created_at`, `updated_at` |
| `credential_bindings` | 凭据与 Provider 注册记录、业务用户、导入来源之间的绑定关系 | `id`, `credential_asset_id`, `binding_type`, `binding_target_id`, `binding_status`, `created_at`, `updated_at` |
| `credential_import_jobs` | 批量导入任务、去重结果、失败原因 | `id`, `provider_type`, `source_kind`, `total_count`, `success_count`, `failed_count`, `status`, `summary_json`, `started_at`, `finished_at` |
| `credential_file_index` | 文件兼容层索引，便于从旧文件系统定位资产 | `id`, `credential_asset_id`, `file_path`, `file_name`, `file_size`, `checksum`, `mtime`, `is_primary`, `created_at`, `updated_at` |

#### C. Usage and cache domain

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `usage_snapshots` | 替代 `usage-cache.json` 的 Provider 用量快照 | `id`, `provider_type`, `provider_id`, `snapshot_at`, `total_count`, `success_count`, `error_count`, `payload_json` |
| `usage_refresh_tasks` | 用量刷新任务与进度记录 | `id`, `task_type`, `provider_type`, `status`, `progress_json`, `result_json`, `error_message`, `created_at`, `started_at`, `finished_at` |

#### D. Admin/session domain

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `admin_sessions` | 替代 `token-store.json` 的后台登录会话 | `id`, `token_hash`, `subject`, `expires_at`, `created_at`, `last_seen_at`, `source_ip`, `user_agent`, `meta_json` |
| `runtime_settings` | 少量运行时配置开关或后台元配置，不替代 `config.json` | `scope`, `key`, `value_json`, `updated_at` |

#### E. API Potluck domain

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `potluck_users` | Potluck 用户主数据 | `id`, `user_identifier`, `display_name`, `status`, `daily_limit`, `bonus_remaining`, `bonus_expires_at`, `meta_json`, `created_at`, `updated_at` |
| `potluck_user_credentials` | 用户绑定的凭据关系，替代用户数据文件中的路径引用 | `id`, `user_id`, `credential_asset_id`, `provider_type`, `binding_status`, `linked_at`, `meta_json` |
| `potluck_api_keys` | Potluck API Key 主表 | `id`, `key_id`, `key_hash`, `name`, `enabled`, `daily_limit`, `used_today`, `bonus_remaining`, `last_reset_at`, `owner_user_id`, `created_at`, `updated_at` |
| `potluck_key_usage_daily` | Potluck Key 的按日用量聚合 | `id`, `api_key_id`, `usage_date`, `request_count`, `quota_used`, `error_count`, `updated_at` |
| `potluck_config` | Potluck 插件自身的业务配置 | `key`, `value_json`, `updated_at` |

#### F. Migration and operations domain

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `storage_migration_runs` | 文件到数据库迁移任务记录 | `id`, `migration_type`, `source_version`, `status`, `summary_json`, `started_at`, `finished_at` |
| `storage_migration_items` | 迁移过程中单项文件/记录的处理结果 | `id`, `run_id`, `item_type`, `source_ref`, `target_ref`, `status`, `error_message`, `detail_json`, `created_at` |

### DB-2: `secret`（可选，面向第二阶段更大范围密文托管）

| 表名 | 用途 | 简略字段 |
|---|---|---|
| `credential_secret_blobs` | 如果后续决定把敏感凭据原文完整入库，则存储加密后的 payload | `credential_asset_id`, `encrypted_payload`, `payload_version`, `key_version`, `checksum`, `updated_at` |

## Suggested Keys and Indexes

- `provider_registrations`: 主键建议 `provider_id`，兼容唯一键建议 `unique(provider_type, routing_uuid)`
- `provider_runtime_state`: 唯一键建议 `unique(provider_id)`
- `provider_inline_secrets`: 唯一键建议 `unique(provider_id)`
- `provider_group_state`: 唯一键建议 `unique(provider_type, group_key)`
- `credential_assets`: 唯一键建议 `unique(provider_type, dedupe_key)`，辅助索引 `identity_key`, `email`, `account_id`
- `credential_file_index`: 唯一键建议 `unique(file_path)`
- `admin_sessions`: 唯一键建议 `unique(token_hash)`，过期索引 `expires_at`
- `potluck_api_keys`: 唯一键建议 `unique(key_id)`，辅助索引 `owner_user_id`, `enabled`
- `usage_snapshots`: 辅助索引 `provider_type`, `snapshot_at`
- `storage_migration_items`: 辅助索引 `run_id`, `status`

## Draft Mapping from File Storage to Tables

| 当前文件/目录 | 目标表 |
|---|---|
| `configs/provider_pools.json` | `provider_registrations`, `provider_runtime_state`, `provider_inline_secrets`, `provider_group_state` |
| `configs/<provider>/` 凭据目录 | `credential_assets`, `credential_file_index`, `credential_bindings` |
| `configs/usage-cache.json` | `usage_snapshots`, `usage_refresh_tasks` |
| `configs/token-store.json` | `admin_sessions` |
| `configs/api-potluck-data.json` | `potluck_users`, `potluck_user_credentials`, `potluck_config` |
| `configs/api-potluck-keys.json` | `potluck_api_keys`, `potluck_key_usage_daily` |

## Schema Notes for Later Refinement

- 现在先按“一个主库 + 一堆表”的方式定边界，别急着拆多库
- `provider_registrations` 和 `provider_runtime_state` 必须拆开，静态配置与高频状态不能再继续睡一张大通铺
- `active_count`、短周期选择序号、待 flush 计数增量等热字段默认停留在内存层，不直接建成逐请求持久化字段
- `provider_inline_secrets` 必须和普通列表/摘要视图隔离，避免把敏感字段顺手暴露给读接口
- `provider_registrations.routing_uuid` 是兼容路由标识，不是内部真主键；内部关联一律走 `provider_id`
- `active_count`、`waiting_count`、刷新队列、选点锁这类纯内存并发态不应作为数据库权威字段
- `credential_assets` 要先解决“身份唯一”和“去重键”问题，再决定密文原文最终放在哪
- `runtime_settings` 只放运行时元配置，不要把整个 `config.json` 又塞回数据库，不然只是换个介质继续混乱
- `potluck` 域已经接近独立业务模块，后续如果它继续膨胀，再考虑是否拆独立 schema 或独立数据库

## `provider_pools.json` Required Migration Details

### 字段拆分规则

- Provider 注册记录（必须持久化）
  - `providerType`
  - 不可变内部主键 `provider_id`
  - 对外兼容路由标识 `uuid`
  - `customName`
  - `checkModelName`、`concurrencyLimit`、`queueLimit`
  - 各 Provider 的非敏感静态字段，如 `OPENAI_BASE_URL`、`CLAUDE_BASE_URL`、`GEMINI_BASE_URL`
- Provider secret 记录（第一阶段必须覆盖内联 secret）
  - 当前直接保存在 `provider_pools.json` 中的敏感字段，例如 `OPENAI_API_KEY`、`CLAUDE_API_KEY`、`GROK_COOKIE_TOKEN`
  - 该记录必须与注册记录分离，避免把敏感字段暴露给普通列表、摘要和导出视图
- Credential binding / inventory 记录（第一阶段必须持久化）
  - `*_CREDS_FILE_PATH`、`*_TOKEN_FILE_PATH` 这类文件型凭据引用
  - 路径归一化结果、checksum、identity key、导入来源、最近一次扫描时间、去重状态
- Provider 运行时状态记录（第一阶段必须持久化）
  - `isHealthy`、`isDisabled`
  - `usageCount`、`errorCount`
  - `lastUsed`、`lastErrorTime`、`lastErrorMessage`
  - `lastHealthCheckTime`、`lastHealthCheckModel`
  - `scheduledRecoveryTime`、`refreshCount`
  - `_lastSelectionSeq` 仅在 `PERSIST_SELECTION_STATE=true` 时视为持久字段
- 纯内存态字段（不应作为数据库权威持久化目标）
  - `activeCount`、`waitingCount`
  - 选点锁、刷新队列、缓冲队列、`refreshingUuids`
  - `activeProviderRefreshes`、`globalRefreshWaiters`

### Provider runtime field placement checklist

下面这张表只回答一个很现实的问题：别再把 `provider.config` 里出现过的字段都一股脑塞进 `provider_runtime_state`。能跨重启成立、且对查询/恢复有意义的 provider 级快照才进库；纯粹为了当前进程调度、Promise 队列、锁和瞬时并发服务的状态继续留内存。否则数据库只是在替 `provider_pools.json` 背锅，架构一点没变。

#### A. 进入 `provider_runtime_state` 的字段

| 当前字段 | 当前载体 | Layer 1 内存态 | `provider_runtime_state` 列 | flush 规则 / 备注 |
|---|---|---|---|---|
| `isHealthy` | `provider.config.isHealthy` | 保留镜像 | `is_healthy` | 健康/熔断的 durable snapshot；状态切换后和相关计数一起批量 upsert |
| `isDisabled` | `provider.config.isDisabled` | 保留镜像 | `is_disabled` | 管理面控制位；add/update/disable/enable 必须走统一 mutation 路径并持久化 |
| `usageCount` | `provider.config.usageCount` | 热路径先累计增量 | `usage_count` | 允许按窗口聚合 flush；禁止逐请求同步 commit |
| `errorCount` | `provider.config.errorCount` | 热路径即时更新 | `error_count` | 与健康状态、最近错误时间一并 flush；重启后应可恢复 |
| `lastUsed` | `provider.config.lastUsed` | 选点时先更新 | `last_used_at` | 内存用于 LRU 立即排序；数据库只保存窗口后的聚合结果 |
| `lastErrorTime` | `provider.config.lastErrorTime` | 保留镜像 | `last_error_time` | 影响恢复窗口和健康检查跳过逻辑，必须可跨重启恢复 |
| `lastErrorMessage` | `provider.config.lastErrorMessage` | 保留镜像 | `last_error_message` | 只保留最近一次错误摘要；详细历史进入 `provider_health_events` |
| `lastHealthCheckTime` | `provider.config.lastHealthCheckTime` | 保留镜像 | `last_health_check_at` | 最近一次健康检查时间，供恢复和管理查询使用 |
| `lastHealthCheckModel` | `provider.config.lastHealthCheckModel` | 保留镜像 | `last_health_check_model` | 最近一次健康检查使用的模型 |
| `scheduledRecoveryTime` | `provider.config.scheduledRecoveryTime` | 保留镜像 | `scheduled_recovery_at` | 到点自动恢复不能因重启丢失，所以必须持久化 |
| `refreshCount` | `provider.config.refreshCount` | 热路径更新 | `refresh_count` | 刷新失败/重试上限需要跨重启延续；与 `needsRefresh` 分离 |
| `_lastSelectionSeq` | `provider.config._lastSelectionSeq` | 默认由内存主写 | `last_selection_seq`（可选） | 仅当 `PERSIST_SELECTION_STATE=true` 时持久化；默认不应为每次选点落库 |

#### B. 只留在 Layer 1 内存热状态层的字段

| 当前字段 / 状态 | 当前载体 | 为什么不进 `provider_runtime_state` |
|---|---|---|
| `needsRefresh` | `provider.config.needsRefresh` | 仅表示“当前进程需要把节点送入刷新队列”的短周期标记；重启后允许丢失，重新由适配器/健康流程判定 |
| `activeCount` | `provider.state.activeCount` | 纯瞬时并发占位；进程退出即失效，持久化只会制造脏状态 |
| `waitingCount` | `provider.state.waitingCount` | 只是当前进程本地排队长度，没有跨重启业务意义 |
| `queue` | `provider.state.queue` | 存的是 Promise handler / 回调队列，根本不该尝试持久化 |
| `_selectionSequence` | `ProviderPoolManager._selectionSequence` | 进程内全局自增序号，只用于同毫秒并发打破平局 |
| `_minSelectionSeqByType` | `ProviderPoolManager._minSelectionSeqByType` | 只是 O(1) 读取优化缓存，可随启动重建 |
| `roundRobinIndex` | `ProviderPoolManager.roundRobinIndex` | 典型调度游标，默认只服务当前进程，不作为 durable 事实 |
| `_selectionLocks` / `_isSelecting` | `ProviderPoolManager` | 锁和同步标记是纯进程内控制位，入库纯属胡闹 |
| `refreshingUuids` | `ProviderPoolManager.refreshingUuids` | 只是进程内刷新去重集合，不应跨进程复制旧任务 |
| `refreshQueues` / `refreshBufferQueues` | `ProviderPoolManager` | 进程内刷新调度队列；应由任务系统重建，不应塞进状态快照 |
| `refreshBufferTimers` | `ProviderPoolManager` | 定时器句柄没有持久化意义 |
| `activeProviderRefreshes` / `globalRefreshWaiters` | `ProviderPoolManager` | 仅是当前进程的并发槽位和等待队列 |
| `pendingSaves` / `saveTimer` | `ProviderPoolManager` | flush bookkeeping，只和当前批次提交有关 |
| `providerIndexByType` / `providerIndexGlobal` | `ProviderPoolManager` | 内存索引，启动时根据注册表和运行时快照重建即可 |

#### C. 明确不属于这次二选一的字段（应进其他表）

| 当前字段 | 目标位置 | 说明 |
|---|---|---|
| `uuid` | `provider_registrations.routing_uuid` | 对外兼容路由标识，可变但不是运行时状态主键 |
| `customName` | `provider_registrations.display_name` | 展示属性，不属于运行态 |
| `concurrencyLimit` / `queueLimit` | `provider_registrations.config_json` | 调度策略配置，不是运行结果 |
| `providerType` | `provider_registrations.provider_type` | 注册维度字段 |
| `_groupCursor[providerType]` | `provider_group_state.cursor`（如需持久化） | 分组轮转属于 providerType 级游标，不应混进单个 provider 的 runtime state |

#### D. 字段落位后的默认规则

- `provider_runtime_state` 只保存“跨重启仍成立”的 provider 级快照，不保存锁、Promise 队列、瞬时并发占位。
- 所有进入 `provider_runtime_state` 的字段，在请求热路径上依然先写内存镜像；数据库负责批量 flush 后的 durable result，而不是逐请求同步提交。
- `lastUsed` 与 `_lastSelectionSeq` 这类选点辅助字段默认按“内存主写 + 可选持久化”处理，避免十几万节点场景下把数据库打成新的瓶颈。
- `needsRefresh` 默认留在内存层；如果后续确实要做跨进程刷新协同，应单独设计 `refresh job` / `refresh lease` 机制，而不是继续污染 `provider_runtime_state`。

### 主键与兼容标识规则

- 数据库必须使用不可变 `provider_id` 作为内部主键，不能继续把现有 `uuid` 当作唯一身份真相。
- 当前对外暴露的 `uuid` 继续保留为路由兼容字段，因为 `refreshProviderUuid()` 和 UI 手动刷新 UUID 都依赖它可变。
- 所有外键、去重规则、审计记录、凭据绑定关系都必须锚定 `provider_id`，而不是可变 `uuid`。
- 对外 API 在迁移期仍可继续接受 `providerType + uuid` 作为定位参数，但存储层必须先解析到 `provider_id` 后再执行更新。

### 读写语义要求

1. `config-manager` 在数据库模式下不再把 `provider_pools.json` 当权威源，而是加载数据库中的 Provider 池兼容快照，并填充 `currentConfig.providerPools` 作为兼容缓存。
2. `ProviderPoolManager` 的 `_flushPendingSaves()` 必须改写为对注册记录 / 运行时状态记录的批量提交；当 `PERSIST_SELECTION_STATE=false` 时，不得把每次选点都同步落库。
3. `provider-api` 的 add/update/delete/disable/reset/delete unhealthy/refresh unhealthy UUIDs/quick link/Grok batch import/refresh UUID 等 mutation 必须统一通过同一存储服务提交，禁止继续各自直接 `writeFileSync()`。
4. `service-manager` 的 auto-link / batch-link 必须先更新 credential inventory，再维护 Provider 注册关系，不能继续以目录扫描 + 路径字符串集合充当唯一去重机制。
5. `usage-api`、`config-scanner`、`getProviderStatus()`、列表/摘要接口必须从 `ProviderPoolManager` 或数据库兼容快照读取，不再依赖原始 JSON 文件存在。
6. 兼容导出的 `provider_pools.json` 只作为显式导出/备份结果，不能在每次运行时更新后自动重写回文件系统。

## Decisions

- Decision: 引入统一的 `RuntimeStorage` 抽象层，屏蔽文件后端与数据库后端差异。
  - Why: 当前写入逻辑散落在多个模块里，先抽象边界，再谈迁移，否则只会把混乱从文件复制到数据库里。

- Decision: 第一阶段优先将高频变更的数据迁移到数据库，文件保留为导入源和兼容出口。
  - Why: `provider_pools`、usage cache、插件用户数据、凭据索引元数据都是高频读写，最需要数据库事务和索引能力。

- Decision: `provider_pools.json` 拆分后必须使用“不可变 `provider_id` + 可变路由 `uuid`”双标识模型。
  - Why: 现有系统会在认证错误或人工操作时刷新 UUID；如果还拿 `uuid` 当数据库主键，那就属于自己给自己挖坑。

- Decision: 当前直接内嵌在 `provider_pools.json` 内的 secret 字段纳入第一阶段数据库迁移范围，但必须与普通 Provider 配置分离存储。
  - Why: `openai-custom`、`claude-custom`、`grok-custom` 这类 Provider 的敏感字段没有单独的文件兼容层可依赖；不把它们一起迁走，`provider_pools.json` 就根本退不下来。

- Decision: `currentConfig.providerPools` 在数据库模式下仅作为兼容快照缓存，不再允许任何模块把它当直接写入目标。
  - Why: 现在 `currentConfig`、`ProviderPoolManager` 和磁盘文件三处都可能各改各的，状态漂移得像开盲盒，必须收口成单一权威写路径。

- Decision: 默认数据库实现优先采用嵌入式方案（如 SQLite），并预留外部数据库扩展点。
  - Why: 这能保留当前项目“单机即可部署”的优势，又能获得事务、索引和并发协调能力；后续如果有更高并发需求，再扩展到外部数据库。

- Decision: 凭据原文入库采用分阶段策略。
  - Why: 直接把所有敏感凭据一次性塞进数据库，听起来很猛，实际上会把安全、加密、导出恢复、密钥管理一起引爆。第一阶段先迁移索引和元数据，第二阶段再决定是否将敏感字段完整入库或接入专用 secret store。

- Decision: `config.json`、`plugins.json`、系统提示词文件、日志文件和上传/更新临时目录继续保留文件语义。
  - Why: 它们要么是低频人工配置，要么是天然文件型资产，要么属于临时运维产物，迁入数据库收益极低。

- Decision: `token-store.json` 与 `api-potluck` 数据纳入第一阶段数据库迁移范围。
  - Why: 这些数据本质上都是运行态业务数据，已经存在过期清理、并发写入、跨模块读取等需求，放在 JSON 文件里只是在攒技术债。

## Risks / Trade-offs

- 数据库引入了新的部署与备份要求
  - Mitigation: 先提供默认本地数据库方案和自动初始化流程

- 文件与数据库双轨期会增加系统复杂度
  - Mitigation: 使用特性开关控制权威数据源，并为迁移过程提供校验报告

- 凭据安全边界会更敏感
  - Mitigation: 明确区分元数据与密文字段，敏感内容需加密存储或延后迁移

- 大量历史文件迁移可能耗时较长
  - Mitigation: 提供批量导入、断点续跑、幂等去重与迁移摘要

## Migration Plan

1. 盘点当前 `configs/` 中的文件类型和权威来源。
2. 引入 `RuntimeStorage` 抽象，并为文件后端补齐统一接口。
3. 先为 `provider_pools.json` 建立数据库数据模型：注册记录、secret 记录、credential inventory、运行时状态、兼容投影视图。
4. 优先替换 `provider-pool-manager`、`provider-api`、`service-manager auto-link` 的 Provider 池写路径。
5. 让启动、Reload、状态接口、用量接口、配置扫描统一读取数据库兼容快照，不再依赖原始 JSON 文件。
6. 再迁移其他高频运行时状态：`usage-cache.json`、后台 `token-store.json`、`api-potluck` 数据。
7. 保留文件导入/导出能力，并使用特性开关切换读写权威源。
8. 在稳定后评估是否将文件型敏感凭据原文迁入数据库或 secret store。
9. 最后再决定是否继续保留 `fetch_system_prompt.txt` 这类运行辅助文件，或将其降级为纯临时态。

## Open Questions

- 默认数据库是否只支持 SQLite，还是第一阶段就同时支持 PostgreSQL/MySQL？
- `provider_pools.json` 内联 secret 的默认保护策略采用应用层加密、数据库扩展加密，还是先约束为本地单机受控存储？
- 现有 Web UI 的“配置文件管理”页面，在数据库模式下应展示数据库实体、兼容投影，还是继续展示文件系统镜像？
- 对外接口何时从 `providerType + uuid` 逐步演进到显式 `provider_id`，以及是否需要版本化 API 过渡？
- `token-store.json` 是否需要继续兼容无数据库部署模式，还是直接并入统一 RuntimeStorage？
- `pwd` 最终应该继续保留文件形式，还是迁移到更合适的 secret 管理机制？
