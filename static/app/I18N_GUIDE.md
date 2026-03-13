# 中文文案维护指南

## 概述

项目现已收敛为简体中文单语界面，`static/app/i18n.js` 继续作为统一文案入口，负责：

- 维护页面中所有 `data-i18n` 文案键
- 为动态渲染内容提供 `t()` 方法
- 在组件异步加载后统一刷新中文文案

## 当前约束

- 仅保留 `zh-CN` 文案对象
- 不再提供语言切换按钮
- `setLanguage()` 仅作为兼容层保留，调用后始终应用简体中文
- 新增文案时不要再添加英文或其他语言映射

## HTML 中使用文案键

使用 `data-i18n`、`data-i18n-placeholder`、`data-i18n-title`、`data-i18n-aria-label` 标记需要替换的内容：

```html
<h1 data-i18n="header.title">All2One API 管理控制台</h1>
<button data-i18n="common.save">保存</button>
<input data-i18n-placeholder="config.apiKeyPlaceholder" placeholder="请输入 API 密钥">
```

## JavaScript 中使用

```javascript
import { t } from './i18n.js';

showToast(t('common.success'), t('config.saved'), 'success');
```

## 新增文案流程

1. 在 `static/app/i18n.js` 的 `zh-CN` 对象内补充新键。
2. 给对应 HTML 元素补上合适的 `data-i18n-*` 属性。
3. 若内容由 JavaScript 动态生成，直接调用 `t('your.key')`。
4. 新增用户可见默认文案时，默认值也保持中文。

## 推荐命名

- `header.*`：页头
- `nav.*`：导航
- `dashboard.*`：仪表盘
- `config.*`：系统配置
- `modal.*`：弹窗
- `usage.*`：用量信息
- `logs.*`：日志相关
- `common.*`：通用提示

## 注意事项

- 所有新增用户可见文案统一使用简体中文。
- 不要重新引入 `en-US`、语言切换器或语言偏好存储逻辑。
- 如果某个字段需要保留原始英文名称（如 API Key、OAuth、Provider ID），仅保留专业名词本身，不新增整段英文提示。
