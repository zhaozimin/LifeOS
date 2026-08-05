# api/
> L2 | 父级: ../CLAUDE.md

成员清单
client.ts: 时间域迁移兼容层；把历史 `api` 名称映射到 time.ts，不持有端点或认证状态。
core.ts: 单一 Bearer Token、请求序列化、AbortSignal、错误投影与受保护二进制下载边界。
time.ts: `/v1/time/*` 时间 API 门面；覆盖配置、时段、统计、主数据与不可覆盖修改版本查询。
fin.ts: `/v1/fin/*` 财务 API 门面；覆盖账目、配置、报销、附件、导入导出与不可覆盖修改版本查询。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
