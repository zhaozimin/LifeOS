/**
 * [INPUT]: 依赖 configuration/transactions/budget API、Layout 的软刷新信号、store/dashboardLayout 的 widget 布局、
 *   各看板卡片组件与 lib/financeAnalytics 汇总。
 * [OUTPUT]: 对外提供单币种 MVP 的财务状况看板；周期预测与订阅 widget 固定不渲染。
 * [POS]: 纯报表页——不承载任何配置入口；widget 显隐/排序在「财务设置 → 仪表盘」中调整。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Activity, BellRing, Landmark, TrendingUp } from "lucide-react";
import { useRefreshSignal } from "../../components/Layout";
import { Card, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { CategoryTabs } from "../../components/ui/Tabs";
import { ThresholdRingChart } from "../components/charts/ThresholdRingChart";
import { BudgetProgressCard } from "../components/BudgetProgressCard";
import { SavingsGoalCard, buildSavingsGoalSummaries } from "../components/SavingsGoalCard";
import { InvoiceWorkbench } from "../components/InvoiceWorkbench";
import { ReimbursementPieCard } from "../components/ReimbursementPieCard";
import { isReimbursable } from "../lib/reimbursement";
import { TransactionDrawer } from "../components/TransactionDrawer";
import { TransactionEditSheet } from "../components/TransactionEditSheet";
import { FinTimeRangeBar } from "../components/FinTimeRangeBar";
import { api } from "../api/client";
import { useApi } from "../lib/useApi";
import { formatCurrency } from "../lib/format";
import { useTimeRangeStore } from "../store/timeRange";
import { useThemeStore } from "../store/theme";
import { useDashboardLayoutStore, type DashboardWidgetId } from "../store/dashboardLayout";
import { getPalette, getSeriesPalette } from "../components/charts/theme";
import {
  accountBalance,
  filterTransactions,
  summarizeTax,
  summarizeTransactions,
} from "../lib/financeAnalytics";
import type { Transaction } from "../types";

interface DrawerState {
  title: string;
  description?: string;
  transactions: Transaction[];
}

const AREA_OPTIONS: Array<{ value: AreaMode; label: string }> = [
  { value: "income", label: "收入" },
  { value: "net", label: "净额" },
];

import { StatusCard } from "./overview/status-card";
import { IncomeAreaChart, ProjectBarChart, WorkLifeStackedChart, type AreaMode } from "./overview/charts";
import { buildIncomeTrend, buildProjectCostRevenue, buildWorkLifeExpense, transactionsForAccount } from "./overview/data";

export function OverviewPage() {
  const dimension = useTimeRangeStore((s) => s.dimension);
  const bucket = useTimeRangeStore((s) => s.bucket);
  const refreshKey = useRefreshSignal();
  const [areaMode, setAreaMode] = useState<AreaMode>("income");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [editTarget, setEditTarget] = useState<Transaction | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const widgetLayout = useDashboardLayoutStore((s) => s.widgets);
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);
  const series = useMemo(
    () => getSeriesPalette(resolved === "dark", paletteId),
    [resolved, paletteId],
  );
  const accentColors = useMemo(
    () => ({
      income: series[0] ?? palette.brandBlue,
      cost: series[4] ?? palette.brandOrange,
      revenue: series[2] ?? palette.success,
      life: series[4] ?? palette.brandOrange,
      work: series[0] ?? palette.brandBlue,
    }),
    [series, palette],
  );

  const { data: configuration, loading: configLoading, error: configError, refresh: refreshConfig } = useApi(
    () => api.configuration(),
    [refreshKey],
  );
  const { data: transactionData, loading: txLoading, error: txError, refresh: refreshTx } = useApi(
    // 报销总览不随统计区间过滤，必须读取整本账。
    () => api.listTransactions(),
    [refreshKey],
  );
  const currentMonth = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }, []);
  const { data: budgetStatus, refresh: refreshBudget } = useApi(
    () => api.budgetStatus({ month: currentMonth }),
    [currentMonth, refreshKey],
  );

  const accounts = configuration?.accounts || [];
  const projects = configuration?.settings?.projects || [];
  const exchangeRates = configuration?.settings?.exchangeRates?.rates;
  const transactions = transactionData || [];
  const filtered = useMemo(
    () => filterTransactions(transactions, accounts, "combined", dimension, bucket),
    [accounts, bucket, dimension, transactions],
  );
  const savingsGoals = useMemo(
    () => buildSavingsGoalSummaries(projects, accounts, transactions),
    [projects, accounts, transactions],
  );
  const projectBudgetMap = useMemo(() => {
    const map = new Map<string, { expectedCost: number; expectedRevenue: number }>();
    for (const p of projects) {
      map.set(p.name, {
        expectedCost: p.expectedCost || 0,
        expectedRevenue: p.expectedRevenue || 0,
      });
    }
    return map;
  }, [projects]);
  const taxConfig = configuration?.settings?.taxConfig;
  const taxStats = useMemo(() => summarizeTax(transactions, taxConfig), [transactions, taxConfig]);
  const summary = useMemo(() => summarizeTransactions(filtered), [filtered]);
  const incomeTrend = useMemo(() => buildIncomeTrend(filtered), [filtered]);
  const projectBars = useMemo(() => buildProjectCostRevenue(filtered), [filtered]);
  const workLife = useMemo(() => buildWorkLifeExpense(filtered, accounts), [accounts, filtered]);
  const thresholdAccounts = useMemo(
    () =>
      accounts
        .filter((account) => (account.threshold || 0) > 0)
        .map((account) => ({
          name: account.name,
          current: account.currentBalance || 0,
          threshold: account.threshold || 0,
          color: account.tintHex,
          lowZone: account.thresholdZones?.low,
          midZone: account.thresholdZones?.mid,
        })),
    [accounts],
  );

  const loading = (configLoading && !configuration) || (txLoading && !transactionData);
  const error = configError || txError;

  const openDrawer = useCallback((nextDrawer: DrawerState) => {
    setDrawer(nextDrawer);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawer(null);
  }, []);

  const openEditor = useCallback((tx: Transaction) => {
    setEditTarget(tx);
    setEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditTarget(null);
  }, []);

  const onSaved = useCallback((saved: Transaction) => {
    setEditorOpen(false);
    setEditTarget(null);
    setDrawer((current) =>
      current
        ? {
            ...current,
            transactions: current.transactions.map((tx) => (tx.id === saved.id ? saved : tx)),
          }
        : current,
    );
    refreshConfig();
    refreshTx();
    refreshBudget();
  }, [refreshConfig, refreshTx, refreshBudget]);

  const onDeleted = useCallback((id: string) => {
    setEditorOpen(false);
    setEditTarget(null);
    setDrawer((current) =>
      current
        ? {
            ...current,
            transactions: current.transactions.filter((tx) => tx.id !== id),
          }
        : current,
    );
    refreshConfig();
    refreshTx();
    refreshBudget();
  }, [refreshConfig, refreshTx, refreshBudget]);

  if (loading) return <div className="h-[760px] rounded-lg bg-muted animate-pulse" />;
  if (error) {
    return (
      <Card>
        <h2 className="text-display-sm mb-2">无法加载财务状况</h2>
        <p className="text-body-sm text-muted-foreground mb-4">{error.message}</p>
        <Button
          onClick={() => {
            refreshConfig();
            refreshTx();
          }}
        >
          重试
        </Button>
      </Card>
    );
  }

  const widgetRenderers: Record<DashboardWidgetId, () => ReactNode> = {
    "status-cards": () => (
      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <StatusCard icon={<Landmark size={18} />} label="净资产" value={formatCurrency(accountBalance(accounts, undefined, exchangeRates))} />
        <StatusCard icon={<TrendingUp size={18} />} label="区间收入" value={formatCurrency(summary.income)} tone="good" />
        <StatusCard icon={<Activity size={18} />} label="区间支出" value={formatCurrency(summary.expense)} tone="warn" />
        <StatusCard icon={<BellRing size={18} />} label="区间净额" value={formatCurrency(summary.net)} tone={summary.net >= 0 ? "good" : "warn"} />
      </section>
    ),
    "invoice-workbench": () => (
      <Card padding="none">
        <div className="border-b border-border px-5 py-4">
          <CardTitle description="按需打开。汇总所有勾选了「已开 / 应开发票」的交易，按状态分组（应开未上传 / 已绑定 / 全部）。">
            发票工作台
          </CardTitle>
        </div>
        <div className="px-5 py-5">
          <InvoiceWorkbench
            transactions={transactions}
            onSelectTransaction={(tx) => openEditor(tx)}
          />
        </div>
      </Card>
    ),
    "reimbursement-pie": () => (
      <Card padding="none">
        <div className="border-b border-border px-5 py-4">
          <CardTitle description="所有标记了报销状态的支出（不随统计区间过滤），点击扇区查看对应流水。">
            报销总览
          </CardTitle>
        </div>
        {transactions.some(isReimbursable) ? (
          <div className="px-5 py-5">
            <ReimbursementPieCard
              transactions={transactions}
              onSelect={(_status, label, items) =>
                openDrawer({
                  title: `报销 · ${label}`,
                  description: `${items.length} 笔，合计 ${formatCurrency(items.reduce((sum, tx) => sum + tx.amount, 0))}。点击任意一笔可修改报销状态。`,
                  transactions: items,
                })
              }
            />
          </div>
        ) : (
          <div className="px-5 py-8 text-center text-[13px] text-muted-foreground">
            还没有报销相关的支出 — 记账时说明"可以报销"，或在「编辑流水」里把报销状态设为「待报销」。
          </div>
        )}
      </Card>
    ),
    "tax-kpi": () =>
      taxStats.transactionCount > 0 || taxStats.businessIncome > 0 || taxStats.deductible > 0 ? (
        <Card padding="none">
          <div className="border-b border-border px-5 py-4">
            <CardTitle description={`${taxStats.label} · 基于交易上的「税务分类」字段汇总，仅供参考。详细配置在「财务设置 → 税务设置」。`}>
              税务概览（{taxStats.label}）
            </CardTitle>
          </div>
          <div className="grid grid-cols-2 gap-3 p-5 md:grid-cols-4">
            <StatusCard icon={<TrendingUp size={18} />} label="业务收入" value={formatCurrency(taxStats.businessIncome)} tone="good" />
            <StatusCard icon={<Activity size={18} />} label="可抵扣支出" value={formatCurrency(taxStats.deductible)} tone="warn" />
            <StatusCard icon={<Landmark size={18} />} label="净利润" value={formatCurrency(taxStats.profit)} tone={taxStats.profit >= 0 ? "good" : "warn"} />
            <StatusCard icon={<BellRing size={18} />} label="预估个税" value={formatCurrency(taxStats.personalTaxEstimate)} tone="warn" />
          </div>
          <div className="border-t border-border px-5 py-3 text-[12px] text-muted-foreground">
            预估增值税 {formatCurrency(taxStats.vatEstimate)} · 预估社保/公积金 {formatCurrency(taxStats.sebEstimate)} · 不可抵扣支出 {formatCurrency(taxStats.nondeductible)}
          </div>
        </Card>
      ) : (
        <Card padding="none">
          <div className="border-b border-border px-5 py-4">
            <CardTitle description={`${taxStats.label} 暂无标记为业务收入 / 可抵扣的交易。在编辑流水时设置「税务分类」字段，这里就会出现汇总。`}>
              税务概览（{taxStats.label}）
            </CardTitle>
          </div>
          <div className="px-5 py-8 text-center text-[13px] text-muted-foreground">
            还没有税务相关的交易 — 在「编辑流水」底部选择税务分类。
          </div>
        </Card>
      ),
    "budget-progress": () =>
      budgetStatus && budgetStatus.items.length > 0 ? (
        <Card padding="none">
          <div className="border-b border-border px-5 py-4">
            <CardTitle description={`本月（${budgetStatus.month}）有预算的支出分类，点击查看相关流水。`}>
              预算进度
            </CardTitle>
          </div>
          <div className="px-5 py-5">
            <BudgetProgressCard
              items={budgetStatus.items}
              totalBudget={budgetStatus.totalBudget}
              totalSpent={budgetStatus.totalSpent}
              totalRemaining={budgetStatus.totalRemaining}
              month={budgetStatus.month}
              onItemClick={(item) =>
                openDrawer({
                  title: `${item.name} · ${budgetStatus.month} 流水`,
                  description: `预算 ${formatCurrency(item.budget)}，已花 ${formatCurrency(item.spent)}（${item.percentUsed.toFixed(1)}%）。`,
                  transactions: filtered.filter(
                    (tx) =>
                      tx.kind === "expense" &&
                      tx.category?.id === item.categoryId &&
                      tx.occurredAt.slice(0, 7) === budgetStatus.month,
                  ),
                })
              }
            />
          </div>
        </Card>
      ) : null,
    "savings-goals": () =>
      savingsGoals.length > 0 ? (
        <Card padding="none">
          <div className="border-b border-border px-5 py-4">
            <CardTitle description="给项目设置目标金额与日期，进度根据账户余额或项目收入累加。">
              储蓄目标
            </CardTitle>
          </div>
          <div className="px-5 py-5">
            <SavingsGoalCard
              summaries={savingsGoals}
              onClick={(project) =>
                openDrawer({
                  title: `${project.name} · 项目流水`,
                  description: project.goal?.description || `目标 ${formatCurrency(project.goal?.targetAmount || 0)}`,
                  transactions: transactions.filter((tx) => tx.projectName === project.name),
                })
              }
            />
          </div>
        </Card>
      ) : null,
    "cashflow-forecast": () => null,
    "subscriptions": () => null,
    "income-area": () => (
      <Card padding="none">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <CardTitle description="完整宽度展示区间收入，点击曲线节点查看对应月份流水。">
            收入曲线
          </CardTitle>
          <CategoryTabs value={areaMode} onChange={setAreaMode} options={AREA_OPTIONS} />
        </div>
        <div className="px-5 py-5">
          <IncomeAreaChart
            data={incomeTrend}
            mode={areaMode}
            palette={palette}
            color={accentColors.income}
            onSelect={(label, items) =>
              openDrawer({
                title: `${label} ${areaMode === "income" ? "收入流水" : "收支流水"}`,
                description: "来自 Area Chart - Interactive 的节点选择。",
                transactions: items,
              })
            }
          />
        </div>
      </Card>
    ),
    "project-bars": () => (
      <Card padding="none">
        <div className="border-b border-border px-5 py-4">
          <CardTitle description="实心 = 实际发生；描边虚心 = 项目预算 / 期望（在「项目管理」面板设置）。">
            项目成本与回款
          </CardTitle>
        </div>
        <div className="px-5 py-5">
          <ProjectBarChart
            data={projectBars}
            budgetMap={projectBudgetMap}
            palette={palette}
            costColor={accentColors.cost}
            revenueColor={accentColors.revenue}
            onSelect={(project, items) =>
              openDrawer({
                title: `${project} 项目流水`,
                description: "当前项目的成本与回款明细。",
                transactions: items,
              })
            }
          />
        </div>
      </Card>
    ),
    "work-life-stacked": () => (
      <Card padding="none">
        <div className="border-b border-border px-5 py-4">
          <CardTitle description="浅色为生活支出，深色为工作支出，点击柱体查看当月流水。">
            支出比例
          </CardTitle>
        </div>
        <div className="px-5 py-5">
          <WorkLifeStackedChart
            data={workLife}
            palette={palette}
            lifeColor={accentColors.life}
            workColor={accentColors.work}
            onSelect={(label, ownership, items) =>
              openDrawer({
                title: `${label} ${ownership === "personal" ? "生活支出" : "工作支出"}`,
                description: "来自堆叠支出图的流水明细。",
                transactions: items,
              })
            }
          />
        </div>
      </Card>
    ),
    "account-rings": () => (
      <Card padding="none">
        <div className="border-b border-border px-5 py-4">
          <CardTitle description="展示账户当前余额与额度阈值，点击圆环或右侧账户查看相关流水。">
            账户进度
          </CardTitle>
        </div>
        <div className="px-5 py-5">
          <ThresholdRingChart
            accounts={thresholdAccounts}
            height={360}
            onAccountClick={(account) =>
              openDrawer({
                title: `${account.name} 账户流水`,
                description: `当前余额 ${formatCurrency(account.current)}，额度阈值 ${formatCurrency(account.threshold)}。`,
                transactions: transactionsForAccount(filtered, account.name),
              })
            }
          />
        </div>
      </Card>
    ),
  };

  return (
    <div className="space-y-5">
      <FinTimeRangeBar transactions={transactions} />
      {widgetLayout.map((w) => {
        if (!w.visible) return null;
        const renderer = widgetRenderers[w.id];
        if (!renderer) return null;
        const node = renderer();
        if (!node) return null;
        return <div key={w.id}>{node}</div>;
      })}

      <TransactionDrawer
        open={Boolean(drawer)}
        title={drawer?.title || ""}
        description={drawer?.description}
        transactions={drawer?.transactions || []}
        onClose={closeDrawer}
        onEdit={openEditor}
      />

      <TransactionEditSheet
        open={editorOpen}
        initial={editTarget}
        onClose={closeEditor}
        onSaved={onSaved}
        onDeleted={onDeleted}
      />
    </div>
  );
}
