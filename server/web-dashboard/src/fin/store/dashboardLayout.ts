import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DashboardWidgetId =
  | "status-cards"
  | "tax-kpi"
  | "invoice-workbench"
  | "reimbursement-pie"
  | "budget-progress"
  | "savings-goals"
  | "cashflow-forecast"
  | "subscriptions"
  | "income-area"
  | "project-bars"
  | "work-life-stacked"
  | "account-rings";

export interface DashboardWidget {
  id: DashboardWidgetId;
  visible: boolean;
}

const DEFAULT_ORDER: DashboardWidget[] = [
  { id: "status-cards", visible: true },
  { id: "tax-kpi", visible: false }, // 默认隐藏；创业者用户在自定义里打开
  { id: "invoice-workbench", visible: false }, // 默认隐藏；按需打开
  { id: "reimbursement-pie", visible: true }, // 报销总览扇形图
  { id: "budget-progress", visible: true },
  { id: "savings-goals", visible: true },
  { id: "cashflow-forecast", visible: true },
  { id: "subscriptions", visible: true },
  { id: "income-area", visible: true },
  { id: "project-bars", visible: true },
  { id: "work-life-stacked", visible: true },
  { id: "account-rings", visible: true },
];

interface DashboardLayoutState {
  widgets: DashboardWidget[];
  toggle: (id: DashboardWidgetId) => void;
  move: (id: DashboardWidgetId, direction: -1 | 1) => void;
  reorder: (orderedIds: DashboardWidgetId[]) => void;
  reset: () => void;
  ensureAll: () => void;
}

function mergeWithDefault(saved: DashboardWidget[] | undefined): DashboardWidget[] {
  if (!Array.isArray(saved)) return DEFAULT_ORDER;
  const knownIds = new Set(DEFAULT_ORDER.map((w) => w.id));
  const filtered = saved.filter((w) => knownIds.has(w.id));
  // 补齐 default 里有但 saved 里没有的（新增 widget 自动加到末尾，可见）
  const presentIds = new Set(filtered.map((w) => w.id));
  for (const w of DEFAULT_ORDER) {
    if (!presentIds.has(w.id)) filtered.push(w);
  }
  return filtered;
}

export const useDashboardLayoutStore = create<DashboardLayoutState>()(
  persist(
    (set, get) => ({
      widgets: DEFAULT_ORDER,
      toggle: (id) =>
        set({
          widgets: get().widgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)),
        }),
      move: (id, direction) => {
        const widgets = [...get().widgets];
        const idx = widgets.findIndex((w) => w.id === id);
        if (idx === -1) return;
        const target = idx + direction;
        if (target < 0 || target >= widgets.length) return;
        const tmp = widgets[idx];
        widgets[idx] = widgets[target];
        widgets[target] = tmp;
        set({ widgets });
      },
      reorder: (orderedIds) => {
        const current = get().widgets;
        const map = new Map(current.map((w) => [w.id, w]));
        const reordered: DashboardWidget[] = [];
        for (const id of orderedIds) {
          const w = map.get(id);
          if (w) {
            reordered.push(w);
            map.delete(id);
          }
        }
        // 任何遗漏的（不应有，但保险）追加到末尾
        for (const w of map.values()) reordered.push(w);
        set({ widgets: reordered });
      },
      reset: () => set({ widgets: DEFAULT_ORDER }),
      ensureAll: () => set({ widgets: mergeWithDefault(get().widgets) }),
    }),
    {
      name: "finance-dashboard-layout",
      version: 1,
      onRehydrateStorage: () => (state) => {
        // 加载完毕后补齐新 widget
        if (state) state.widgets = mergeWithDefault(state.widgets);
      },
    },
  ),
);

export const WIDGET_LABEL: Record<DashboardWidgetId, string> = {
  "status-cards": "顶部 KPI（净资产 / 收支 / 净额）",
  "tax-kpi": "税务 KPI（本季度业务收入 / 净利润 / 预估个税）",
  "invoice-workbench": "发票工作台（应开未上传 / 已绑定 / 全部）",
  "reimbursement-pie": "报销总览（待报销 / 已报销扇形图）",
  "budget-progress": "预算进度",
  "savings-goals": "储蓄目标",
  "cashflow-forecast": "现金流预测",
  "subscriptions": "月度订阅",
  "income-area": "收入曲线",
  "project-bars": "项目成本与回款",
  "work-life-stacked": "工作 / 生活支出比例",
  "account-rings": "账户进度",
};
