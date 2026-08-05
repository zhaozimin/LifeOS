/**
 * [INPUT]: 依赖 Router 导航状态、ProductLogo 与三组常驻信息架构。
 * [OUTPUT]: 提供支持 Escape/焦点约束的 LifeOS 模态导航。
 * [POS]: shell 的全局导航；只表达路由，不携带时间筛选、流水或任一领域请求。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useRef } from "react";
import { NavLink } from "react-router";
import { BarChart3, CalendarDays, Landmark, ReceiptText, Settings, WalletCards, X } from "lucide-react";
import clsx from "clsx";
import { ProductLogo } from "./ProductLogo";

const GROUPS = [
  { label: "时间", items: [{ to: "/time/day", label: "今天", icon: CalendarDays }, { to: "/time/stats", label: "时间统计", icon: BarChart3 }] },
  { label: "财务", items: [{ to: "/fin/status", label: "财务状况", icon: Landmark }, { to: "/fin/ledger", label: "资金流水", icon: ReceiptText }, { to: "/fin/flow", label: "资金流量", icon: WalletCards }] },
  { label: "系统", items: [{ to: "/settings", label: "设置", icon: Settings }] },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const asideRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(asideRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') || []);
      if (!focusable.length) return;
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
  return <>
    {open && <button type="button" aria-label="关闭侧边栏遮罩" onClick={onClose} className="fixed inset-0 z-40 bg-background/45 backdrop-blur-[5px]" />}
    <aside ref={asideRef} role="dialog" aria-modal="true" aria-label="主导航" aria-hidden={!open} className={clsx("fixed bottom-3 left-3 top-3 z-50 flex w-[min(330px,calc(100vw-24px))] flex-col rounded-xl border border-sidebar-border bg-sidebar p-4 text-sidebar-foreground shadow-2xl transition duration-200", open ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-8 opacity-0")}>
      <div className="flex items-center justify-between border-b border-sidebar-border pb-4"><ProductLogo /><button ref={closeButtonRef} type="button" aria-label="关闭侧边栏" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-sidebar-accent"><X size={16} /></button></div>
      <nav className="mt-4 space-y-4">{GROUPS.map((group) => <section key={group.label}><p className="mb-1 px-2 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground">{group.label}</p><div className="grid gap-1">{group.items.map((item) => <NavLink key={item.to} to={item.to} onClick={onClose} className={({ isActive }) => clsx("flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition", isActive ? "bg-sidebar-primary text-sidebar-primary-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent")}><item.icon size={16} /><span>{item.label}</span></NavLink>)}</div></section>)}</nav>
      <p className="mt-auto border-t border-sidebar-border pt-4 text-xs leading-5 text-muted-foreground">时间与金钱各自保存在本机独立账本。LifeOS 只在你主动记录时工作。</p>
    </aside>
  </>;
}
