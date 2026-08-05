/**
 * [INPUT]: 依赖 ../../api/fin 与 ../../api/core 的统一 LifeOS API 边界。
 * [OUTPUT]: 为迁入的 FinOS 视图提供 `api` 兼容名，不再保留第二个 token 或无前缀路由。
 * [POS]: fin 域迁移过渡层；真实端点真源在 api/fin.ts。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export { ApiError, clearToken, getToken, setToken } from "../../api/core";
export { finApi as api } from "../../api/fin";
