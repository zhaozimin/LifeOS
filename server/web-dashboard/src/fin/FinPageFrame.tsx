/**
 * [INPUT]: 依赖 React Router Outlet。
 * [OUTPUT]: 为财务三页提供纯路由出口。
 * [POS]: fin 域路由边界；范围栏及其数据读取必须下沉到各业务页。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { Outlet } from "react-router";

export function FinPageFrame() {
  return <div className="min-h-0 flex-1 overflow-y-auto pb-6"><Outlet /></div>;
}
