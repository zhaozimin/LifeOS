# api/

> L2 | 父级: ../CLAUDE.md

成员清单

client.ts: FinOS 迁移兼容层；将历史 `api` 导入统一映射到 `../../api/fin`，复用 LifeOS 的 Bearer token 与 `/v1/fin/*` 前缀。

法则: 页面不得直接拼接 HTTP 请求；端点与认证真源只在 `src/api/fin.ts`、`src/api/core.ts`，删除状态必须通过统一契约读取。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
