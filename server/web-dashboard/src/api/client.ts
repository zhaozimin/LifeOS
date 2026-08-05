/**
 * [INPUT]: 依赖 api/core 与 api/time 的正式三文件 API 分层。
 * [OUTPUT]: 为已迁入的时间视图提供兼容导出；新代码应直接导入 core.ts 或 time.ts。
 * [POS]: P3 迁移过渡层，不包含 URL、Token 或领域逻辑。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export { ApiError, clearToken, getToken, isAbortError, setToken } from "./core";
export { timeApi as api } from "./time";
