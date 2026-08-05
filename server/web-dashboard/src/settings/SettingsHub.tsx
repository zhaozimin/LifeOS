/**
 * [INPUT]: 依赖 React.lazy、Router panelId、时间/财务设置页、记录时区变更 context 与全局主题开关。
 * [OUTPUT]: 提供 MVP 设置面板注册表和 `/dashboard/settings/:panelId` 深链；货币与周期账目入口已暂停。
 * [POS]: 设置域组合根；仅在选中时加载领域设置，项目主数据保持两域独立。
 *   时间组 section 与财务组 initialPanel 是同一套「菜单项 → 分区」契约，一个菜单项只落一屏。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { lazy, Suspense } from "react";
import { NavLink, useParams } from "react-router";
import { useRecordTimeZoneChange } from "../components/RecordTimeZoneProvider";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import type { TimeSettingsSection } from "../pages/SettingsPage";

const TimeSettings = lazy(async () => ({ default: (await import("../pages/SettingsPage")).SettingsPage }));
const TimeDesign = lazy(async () => ({ default: (await import("../pages/DesignSystemPage")).DesignSystemPage }));
const FinSettings = lazy(async () => ({ default: (await import("../fin/pages/SettingsPage")).SettingsPage }));
const FinDesign = lazy(async () => ({ default: (await import("../fin/pages/DesignSystemPage")).DesignSystemPage }));

type Panel = { id: string; group: "通用" | "时间" | "财务"; label: string; element: () => React.ReactNode };
type FinancePanelId = "accounts" | "projects" | "sources" | "categories" | "counterparties" | "import" | "tax" | "dashboard" | "developer";
const financePanel = (initialPanel: FinancePanelId) => () => <FinSettings initialPanel={initialPanel} />;

// Route element 里的 SettingsHub 拿不到 App 的 setter，时区迁移结果只能经 context 回流；
// 这层薄包装存在的唯一理由，是让 hook 落在真正的组件里而不是 PANELS 的工厂函数中。
function TimeSettingsPanel({ section }: { section: TimeSettingsSection }) {
  const onRecordTimeZoneChange = useRecordTimeZoneChange();
  return <TimeSettings section={section} onRecordTimeZoneChange={onRecordTimeZoneChange} />;
}

const timePanel = (section: TimeSettingsSection) => () => <TimeSettingsPanel section={section} />;
const PANELS: Panel[] = [
  { id: "appearance", group: "通用", label: "外观与主题", element: () => <section className="rounded-lg border border-border bg-card p-5"><h1 className="serif text-2xl">外观与主题</h1><p className="mt-2 text-sm text-muted-foreground">统一主题会同步应用于时间、财务和所有图表。</p><div className="mt-5"><ThemeSwitcher /></div></section> },
  { id: "developer", group: "通用", label: "开发者模式", element: () => <section className="rounded-lg border border-border bg-card p-5"><h1 className="serif text-2xl">开发者模式</h1><p className="mt-2 text-sm text-muted-foreground">两域设计系统可作为合并后的活文档与验收仪器。</p><div className="mt-5 flex gap-2"><NavLink to="/settings/design/time" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">时间设计系统</NavLink><NavLink to="/settings/design/fin" className="rounded-md border border-border px-3 py-2 text-sm">财务设计系统</NavLink></div></section> },
  { id: "time-catalog", group: "时间", label: "分类与项目主数据", element: timePanel("catalog") },
  { id: "time-week-start", group: "时间", label: "周起点", element: timePanel("week-start") },
  { id: "time-timezone", group: "时间", label: "记录时区迁移", element: timePanel("timezone") },
  { id: "finance-accounts", group: "财务", label: "账户", element: financePanel("accounts") },
  { id: "finance-projects", group: "财务", label: "项目", element: financePanel("projects") },
  { id: "finance-sources", group: "财务", label: "资金来源", element: financePanel("sources") },
  { id: "finance-categories", group: "财务", label: "类别", element: financePanel("categories") },
  { id: "finance-counterparties", group: "财务", label: "客户与合作方", element: financePanel("counterparties") },
  { id: "finance-import", group: "财务", label: "账单导入", element: financePanel("import") },
  { id: "finance-tax", group: "财务", label: "税务", element: financePanel("tax") },
  { id: "finance-dashboard", group: "财务", label: "仪表盘定制", element: financePanel("dashboard") },
  { id: "design-time", group: "时间", label: "时间设计系统", element: () => <TimeDesign /> },
  { id: "design-fin", group: "财务", label: "财务设计系统", element: () => <FinDesign /> },
];

export function SettingsHub() {
  const { panelId } = useParams();
  const active = PANELS.find((panel) => panel.id === panelId) || PANELS[0];
  const ActivePanel = active.element;
  return <div className="min-h-0 flex-1 overflow-y-auto pb-6"><div className="mb-4"><p className="text-xs font-semibold tracking-widest text-muted-foreground">SYSTEM SETTINGS</p><h1 className="serif mt-1 text-3xl">设置</h1></div><div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]"><aside className="rounded-lg border border-border bg-card p-3">{(["通用", "时间", "财务"] as const).map((group) => <section key={group} className="mb-4 last:mb-0"><p className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-muted-foreground">{group}</p>{PANELS.filter((panel) => panel.group === group && !panel.id.startsWith("design-")).map((panel) => <NavLink key={panel.id} to={`/settings/${panel.id}`} className={({ isActive }) => `block rounded-md px-2 py-2 text-sm ${isActive ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{panel.label}</NavLink>)}</section>)}</aside><Suspense fallback={<div className="h-64 rounded-lg bg-muted animate-pulse" />}><ActivePanel /></Suspense></div></div>;
}
