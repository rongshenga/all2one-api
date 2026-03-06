# Change: Refactor runtime storage to database-backed persistence

## Why

当前项目使用 `configs/` 目录保存主配置、Provider 池、OAuth 凭据、使用缓存和部分插件数据。这种方案最初有几个现实优势：零外部依赖、便于手工编辑、方便直接导入第三方凭据文件、也容易和现有的目录扫描逻辑对接。

但随着高频运行时状态和批量凭据导入规模扩大，文件存储已经开始暴露结构性问题：大文件高频重写、并发写入冲突、临时文件残留、目录扫描成本持续升高，以及凭据文件无限增长导致的运维和恢复复杂度上升。

因此需要把“高频变化、需要原子更新、需要查询与去重”的运行时数据迁移到数据库中，同时保留文件导入/导出兼容能力，作为长期演进方向。

## What Changes

- 补充一份覆盖当前项目的数据流转与本地落盘清单，明确哪些数据应保留文件存储，哪些数据应迁移到数据库，哪些数据应采用分阶段迁移。
- 引入数据库作为运行时存储的权威数据源，用于承载高频更新和可索引的数据。
- 明确采用 `bootstrap file + in-memory hot state + runtime database + optional secret backend` 的运行分层，避免把高频热状态直接变成每请求同步落库。
- 补充 `ProviderPoolManager` 运行时字段的字段级归属清单，明确哪些字段只保留在内存热状态层，哪些字段进入 `provider_runtime_state`，以及哪些字段应转入 `provider_registrations` / `provider_group_state` 等其他表。
- 将 `provider_pools.json` 明确为第一阶段必须迁移对象，并拆分为 Provider 注册记录、凭据绑定/索引记录、运行时状态记录、内联敏感字段记录和兼容投影视图，覆盖启动加载、Reload、自动关联、Web UI CRUD、健康检查、UUID 刷新、用量查询等现有调用链。
- 将以下数据纳入数据库迁移范围：Provider 池持久化状态、凭据目录索引与去重元数据、使用缓存、`api-potluck` 相关用户与 Key 数据。
- 保留 `configs/` 目录的导入/导出能力，用于初始化、兼容旧流程、人工备份和应急恢复。
- 通过统一的存储抽象替代零散的 `writeFile` / `rename` / 目录扫描逻辑，避免同一份状态被多个模块以不同方式写入。
- 采用分阶段迁移：优先迁移高频运行时状态；凭据原文是否完全进入数据库作为后续阶段决策，不在第一阶段强制完成。
- 增加迁移工具、校验机制、回滚策略和运行可观测性要求。
- 在提案中补充十几万账号规模下的性能约束：热路径以内存缓冲和批量 flush 为主，数据库负责聚合后的持久状态与查询索引，不要求每次选点都同步 durable commit。

## Impact

- Affected specs: `runtime-data-storage`
- Affected code:
  - `src/core/config-manager.js`
  - `src/providers/provider-pool-manager.js`
  - `src/services/service-manager.js`
  - `src/services/ui-manager.js`
  - `src/ui-modules/config-scanner.js`
  - `src/ui-modules/config-api.js`
  - `src/ui-modules/provider-api.js`
  - `src/ui-modules/auth.js`
  - `src/ui-modules/usage-api.js`
  - `src/ui-modules/usage-cache.js`
  - `src/auth/codex-oauth.js`
  - `src/providers/openai/codex-core.js`
  - `src/providers/openai/openai-core.js`
  - `src/auth/gemini-oauth.js`
  - `src/auth/qwen-oauth.js`
  - `src/auth/iflow-oauth.js`
  - `src/auth/kiro-oauth.js`
  - `src/providers/gemini/gemini-core.js`
  - `src/providers/gemini/antigravity-core.js`
  - `src/providers/grok/grok-core.js`
  - `src/providers/openai/qwen-core.js`
  - `src/providers/openai/iflow-core.js`
  - `src/providers/claude/claude-kiro.js`
  - `src/plugins/api-potluck/user-data-manager.js`
  - `src/plugins/api-potluck/key-manager.js`
  - `src/plugins/api-potluck/api-routes.js`
  - `src/core/plugin-manager.js`
  - `src/utils/provider-strategy.js`
  - `src/utils/common.js`
  - `src/utils/logger.js`
  - `src/ui-modules/event-broadcast.js`
  - `src/ui-modules/upload-config-api.js`
  - `src/ui-modules/update-api.js`
  - `static/app/modal.js`
  - `tests/provider-api.test.js`
  - `tests/usage-api.test.js`
- Operational impact:
  - 需要定义数据库选型、初始化和备份策略
  - 需要规划文件存储向数据库的迁移窗口
  - 需要为 Web UI 和现有导入流程保留兼容层
  - 需要提供 `provider_pools.json` 的兼容投影导出与差异校验，避免双轨期间读写语义漂移
