/**
 * [INPUT]: 依赖 Router Outlet、单一 health 指示、主题、认证、渲染故障边界与 fin 域按需搜索入口。
 * [OUTPUT]: 提供 LifeOS 顶栏、常驻三组导航、软刷新信号和零业务请求的全局壳。
 * [POS]: 统一面板的稳定外壳；任何时间/财务请求必须下沉到对应领域页面。
 *   ErrorBoundary 只包 <Outlet/> 而不包整个壳：页面 render 期抛错时顶栏与 Sidebar 必须活着，
 *   用户才能切到别的页面自救；pathname 作为复位键，切页即自动清除降级态。
 *   软刷新信号有两条出口：outlet context 供直接挂在本层 Outlet 下的时间三页，
 *   useRefreshSignal 供任意深度的页面——财务三页挂在 FinPageFrame 的二级 Outlet 下，
 *   那一层没有透传 context，取到的是 undefined，跨层信号只能走普通 React context。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { createContext, useContext, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { LogOut, Menu, RefreshCw, Search } from "lucide-react";
import { clearToken } from "../api/core";
import { FinSearchPalette } from "../fin/components/FinSearchPalette";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProductLogo } from "./ProductLogo";
import { Sidebar } from "./Sidebar";
import { StatusIndicator } from "./StatusIndicator";
import { ThemeSwitcher } from "./ThemeSwitcher";

const TITLES: Record<string, string> = {
  "/time/day": "今天", "/time/stats": "时间统计", "/fin/status": "财务状况",
  "/fin/ledger": "资金流水", "/fin/flow": "资金流量", "/settings": "设置",
};

export type LayoutOutletContext = { refreshKey: number };

/**
 * 顶栏「刷新数据」的软刷新信号。
 *
 * outlet context 只到最近的一个 <Outlet>：财务三页挂在 FinPageFrame 的二级 Outlet 下，
 * 那层渲染的是不带 context 的 <Outlet/>，useOutletContext() 在页面里拿到的是 undefined。
 * 于是「刷新数据」曾只对时间三页有效，财务页的取数依赖恒定不重跑——按钮看着生效，
 * 金额、报销待回款、预算却纹丝不动。信号因此额外走一条与路由层级无关的普通 context。
 */
const RefreshSignalContext = createContext(0);

/** 页面把它放进取数依赖，顶栏刷新即重新取数；不在 Layout 下时恒为 0，取数照常只跑一次。 */
export function useRefreshSignal(): number {
  return useContext(RefreshSignalContext);
}

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  const title = TITLES[pathname] || (pathname.startsWith("/settings/") ? "设置" : "LifeOS");
  const closeSidebar = () => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  return <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
    <header className="z-30 flex-none border-b border-border bg-background/88 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button ref={menuButtonRef} type="button" aria-label="打开导航" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card/70 hover:bg-accent"><Menu size={17} /></button>
          <div className="hidden sm:block"><ProductLogo /></div>
          <span className="truncate text-sm font-semibold sm:border-l sm:border-border sm:pl-3">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden md:inline-flex"><StatusIndicator /></span>
          <button type="button" aria-label="全局搜索（⌘K）" onClick={() => setSearchOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card/70 px-3 text-xs text-muted-foreground hover:bg-accent"><Search size={15} /><span className="hidden sm:inline">搜索</span><kbd className="hidden font-mono text-[10px] sm:inline">⌘K</kbd></button>
          <ThemeSwitcher compact />
          <button type="button" aria-label="刷新数据" onClick={() => setRefreshKey((current) => current + 1)} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card/70 hover:bg-accent"><RefreshCw size={16} /></button>
          <button type="button" aria-label="退出登录" onClick={() => { clearToken(); window.location.reload(); }} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card/70 hover:bg-accent"><LogOut size={16} /></button>
        </div>
      </div>
    </header>
    <Sidebar open={sidebarOpen} onClose={closeSidebar} />
    <main className="mx-auto flex min-h-0 w-full max-w-[1500px] flex-1 flex-col px-4 py-3 sm:px-6 lg:px-8">
      <ErrorBoundary label={title} resetKey={pathname}>
        <RefreshSignalContext.Provider value={refreshKey}>
          <Outlet context={{ refreshKey } satisfies LayoutOutletContext} />
        </RefreshSignalContext.Provider>
      </ErrorBoundary>
    </main>
    <FinSearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
  </div>;
}
