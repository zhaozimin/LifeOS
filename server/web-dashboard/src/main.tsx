/**
 * [INPUT]: 依赖 React 19、BrowserRouter、全局 token CSS 与 App 编排入口。
 * [OUTPUT]: 将 TimeOS 仪表盘挂载到 `#root`，路由基准固定 `/dashboard`。
 * [POS]: web-dashboard 的浏览器启动点；不包含领域状态或 API 调用。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { cleanLegacyBrowserState } from "./api/core";
import "./index.css";

// 旧 FinOS SW 注册在同 origin 的根 scope；在第一帧前发起注销，防止 cache-first 旧壳劫持 LifeOS。
void cleanLegacyBrowserState();

createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter basename="/dashboard"><App /></BrowserRouter></StrictMode>);
