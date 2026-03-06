## 1. Proposal

- [ ] 1.1 完成本地持久化位置、数据流转和迁移边界盘点
- [ ] 1.2 明确数据库托管范围与非目标
- [ ] 1.3 确认数据库选型与部署约束
- [ ] 1.4 确认凭据原文入库策略与安全边界
- [ ] 1.5 明确 `provider_pools.json` 的字段拆分、主键策略和兼容视图
- [ ] 1.6 输出 `ProviderPoolManager` 字段级归属清单，明确内存热状态、`provider_runtime_state` 与其他表之间的边界

## 2. Storage Foundation

- [ ] 2.1 设计统一存储抽象，隔离文件与数据库实现
- [ ] 2.2 明确数据库数量、逻辑域与初版表清单
- [ ] 2.3 为 Provider 池定义注册表、secret 表、credential inventory、运行时状态表和兼容投影视图
- [ ] 2.4 提供事务化写入、并发控制、幂等更新以及 `provider_id` / `uuid` 双标识解析能力
- [ ] 2.5 定义内存热状态层与数据库 flush 策略，明确哪些字段逐请求更新、哪些字段批量持久化

## 3. Migration

- [ ] 3.1 实现从 `provider_pools.json` 到数据库模型的初始化导入工具
- [ ] 3.2 为 Provider 池、内联 secret 和凭据目录建立去重、稳定主键与绑定规则
- [ ] 3.3 迁移 `provider-pool-manager`、`provider-api`、`service-manager auto-link` 的 Provider 池写路径
- [ ] 3.4 提供迁移校验、差异报告与回滚方案

## 4. Compatibility

- [ ] 4.1 保留现有文件导入/导出接口，并提供 `provider_pools.json` 兼容导出
- [ ] 4.2 让 `provider-api`、`usage-api`、`config-scanner`、`getProviderStatus()` 使用数据库兼容快照
- [ ] 4.3 保持 `config_update` / `provider_update` 广播语义与现有 Web UI 响应结构兼容
- [ ] 4.4 使用特性开关支持分阶段切换与灰度回退

## 5. Validation

- [ ] 5.1 增加数据库模式下 Provider 池 CRUD、健康状态、UUID 刷新、Quick Link、Batch Import 的单元与集成测试
- [ ] 5.2 验证启动/Reload/状态接口在数据库模式下仍能拿到正确的 Provider 池兼容快照
- [ ] 5.3 验证高频写入场景下不再产生 `provider_pools.json.*.tmp` 临时文件堆积
- [ ] 5.4 验证十几万账号规模下选点、批量 flush、分页查询和恢复加载的性能边界
- [ ] 5.5 补充运维文档、备份恢复和监控说明
