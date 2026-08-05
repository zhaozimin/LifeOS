/**
 * [INPUT]: 依赖 core 认证卫生、双域页面、统一 shell、渲染故障边界、记录时区变更桥与设置注册表。
 * [OUTPUT]: 提供 LifeOS 的认证状态机、history 路由和默认今天页。
 * [POS]: React 应用编排根；持有记录时区真源并经 RecordTimeZoneProvider 把写入口交给设置面板，
 *   使时区迁移后日/统计页立即按新口径重绘，无需刷新页面。不承载领域数据或旧系统兼容路由。
 *   这里的 ErrorBoundary 只是最后一道网，专治认证壳自身崩溃；页面级隔离归 Layout 那一层，
 *   两层同名组件嵌套时 React 交给最近的边界，页面故障不会冒到这里把顶栏一起吃掉。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { ApiError, consumeUrlToken, getToken } from "./api/core";
import { timeApi } from "./api/time";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { RecordTimeZoneProvider } from "./components/RecordTimeZoneProvider";
import { ThemeProvider } from "./components/ThemeProvider";
import { TokenGate } from "./components/TokenGate";
import { FinPageFrame } from "./fin/FinPageFrame";
import { FlowPage } from "./fin/pages/FlowPage";
import { LedgerPage } from "./fin/pages/LedgerPage";
import { OverviewPage } from "./fin/pages/OverviewPage";
import { healthRecordTimeZone } from "./lib/dates";
import { SettingsHub } from "./settings/SettingsHub";
import { DayPage } from "./pages/DayPage";
import { StatsPage } from "./pages/StatsPage";
import type { Health } from "./types";

function recordTimezone(health: Health): string {
  const time = health.domains?.time || health;
  return healthRecordTimeZone(time.timezone, time.timezoneSource, time.resolvedTimezone);
}

export default function App() {
  const [status, setStatus] = useState<"checking" | "authenticated" | "anonymous" | "unreachable">("checking");
  const [recordTimeZone, setRecordTimeZone] = useState("UTC");
  const authenticate = (health: Health) => { setRecordTimeZone(recordTimezone(health)); setStatus("authenticated"); };
  const connect = useCallback(async () => {
    if (!getToken()) { setStatus("anonymous"); return; }
    setStatus("checking");
    try { authenticate(await timeApi.health()); }
    catch (caught) { setStatus(caught instanceof ApiError && caught.status === 401 ? "anonymous" : "unreachable"); }
  }, []);
  useEffect(() => { consumeUrlToken(); void connect(); }, [connect]);

  return <ThemeProvider><ErrorBoundary label="LifeOS">
    {status === "checking" && <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">正在连接本地 LifeOS…</div>}
    {status === "unreachable" && <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground"><section className="w-full max-w-md rounded-xl border border-border bg-card p-7 text-center shadow-xl"><h1 className="serif text-2xl">本机服务暂时不可达</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">访问密钥仍安全保留。请确认 LifeOS 服务已经启动，然后重试连接。</p><button type="button" onClick={() => void connect()} className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground">重新连接</button></section></main>}
    {status === "anonymous" && <TokenGate onAuthenticated={authenticate} />}
    {status === "authenticated" && <RecordTimeZoneProvider onChange={setRecordTimeZone}>
      <Routes><Route element={<Layout />}>
        <Route index element={<Navigate to="/time/day" replace />} />
        <Route path="time/day" element={<DayPage recordTimeZone={recordTimeZone} />} />
        <Route path="time/stats" element={<StatsPage recordTimeZone={recordTimeZone} />} />
        <Route path="fin" element={<FinPageFrame />}><Route path="status" element={<OverviewPage />} /><Route path="ledger" element={<LedgerPage />} /><Route path="flow" element={<FlowPage />} /></Route>
        <Route path="settings" element={<Navigate to="/settings/appearance" replace />} />
        <Route path="settings/:panelId" element={<SettingsHub />} />
        <Route path="settings/design/time" element={<Navigate to="/settings/design-time" replace />} />
        <Route path="settings/design/fin" element={<Navigate to="/settings/design-fin" replace />} />
        <Route path="*" element={<Navigate to="/time/day" replace />} />
      </Route></Routes>
    </RecordTimeZoneProvider>}
  </ErrorBoundary></ThemeProvider>;
}
