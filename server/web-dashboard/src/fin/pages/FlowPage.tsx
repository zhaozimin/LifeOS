/**
 * [INPUT]: 依赖 configuration / transactions API、Layout 的软刷新信号、lib/financeAnalytics 的过滤、桑基构建与全量取数上限。
 * [OUTPUT]: 对外提供 FlowPage（全局资金流桑基图 + 抽屉钻取；桑基容器自适应视口高度）。
 * [POS]: web-dashboard 首屏；全部/工作/生活 三视图 tab 仅在 ledgerMode=dual（或存在 company 账户）时显示。
 *   本页所有派生量（桑基路径、可支撑月数、时间范围栏的可选桶）都建立在整本账之上，取数必须走 FULL_LEDGER_LIMIT。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { BriefcaseBusiness, CircleDollarSign, Home, WalletCards } from "lucide-react";
import { useRefreshSignal } from "../../components/Layout";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { CategoryTabs } from "../../components/ui/Tabs";
import { SankeyChart, type SankeySelection } from "../components/charts/SankeyChart";
import { TransactionDrawer } from "../components/TransactionDrawer";
import { TransactionEditSheet } from "../components/TransactionEditSheet";
import { FinTimeRangeBar } from "../components/FinTimeRangeBar";
import { api } from "../api/client";
import { useApi } from "../lib/useApi";
import { formatCurrency } from "../lib/format";
import { useTimeRangeStore } from "../store/timeRange";
import {
  FULL_LEDGER_LIMIT,
  accountBalance,
  averageMonthlyExpense,
  buildSankey,
  filterTransactions,
  runwayMonths,
} from "../lib/financeAnalytics";
import type { Transaction, ViewMode } from "../types";

interface DrawerState {
  title: string;
  description?: string;
  transactions: Transaction[];
}

const FLOW_TABS: Array<{ value: ViewMode; label: string }> = [
  { value: "combined", label: "全部资金流" },
  { value: "company", label: "工作资金流" },
  { value: "personal", label: "生活资金流" },
];

export function FlowPage() {
  const [flowView, setFlowView] = useState<ViewMode>("combined");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [editTarget, setEditTarget] = useState<Transaction | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const dimension = useTimeRangeStore((s) => s.dimension);
  const bucket = useTimeRangeStore((s) => s.bucket);
  const refreshKey = useRefreshSignal();
  const { data: configuration, loading: configLoading, error: configError, refresh: refreshConfig } = useApi(
    () => api.configuration(),
    [refreshKey],
  );
  const { data: transactionData, loading: txLoading, error: txError, refresh: refreshTx } = useApi(
    // 「全部时间」必须真的是全部：服务端按 occurred_at DESC 切片，limit 只会拿到最近的头部，
    // 早期的账整体不进页面——桑基缺早期路径、可支撑月数偏差、早期月份从下拉里消失。
    () => api.listTransactions({ limit: FULL_LEDGER_LIMIT }),
    [refreshKey],
  );

  const accounts = configuration?.accounts || [];
  const transactions = transactionData || [];
  // 全部/工作/生活 三视图本质是账户归属维度；personal 模式下三者同一份数据，属噪音，隐藏。
  const showFlowTabs = configuration?.settings?.ledgerMode === "dual" || accounts.some((account) => account.ownership === "company");
  const filtered = useMemo(
    () => filterTransactions(transactions, accounts, flowView, dimension, bucket),
    [accounts, bucket, dimension, flowView, transactions],
  );
  const sankey = useMemo(() => buildSankey(filtered, accounts), [accounts, filtered]);

  const exchangeRates = configuration?.settings?.exchangeRates?.rates;
  const support = useMemo(() => {
    const workTx = filterTransactions(transactions, accounts, "company", dimension, bucket);
    const lifeTx = filterTransactions(transactions, accounts, "personal", dimension, bucket);
    const allTx = filterTransactions(transactions, accounts, "combined", dimension, bucket);
    const total = accountBalance(accounts, undefined, exchangeRates);
    const work = accountBalance(accounts, "company", exchangeRates);
    const life = accountBalance(accounts, "personal", exchangeRates);
    return {
      total,
      work,
      life,
      totalRunway: runwayMonths(total, averageMonthlyExpense(allTx)),
      workRunway: runwayMonths(work, averageMonthlyExpense(workTx)),
      lifeRunway: runwayMonths(life, averageMonthlyExpense(lifeTx)),
    };
  }, [accounts, bucket, dimension, transactions, exchangeRates]);

  const loading = (configLoading && !configuration) || (txLoading && !transactionData);
  const error = configError || txError;

  const closeDrawer = useCallback(() => setDrawer(null), []);
  const openEditor = useCallback((tx: Transaction) => {
    setEditTarget(tx);
    setEditorOpen(true);
  }, []);
  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setEditTarget(null);
  }, []);
  const onSaved = useCallback(
    (saved: Transaction) => {
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
    },
    [refreshConfig, refreshTx],
  );
  const onDeleted = useCallback(
    (id: string) => {
      setEditorOpen(false);
      setEditTarget(null);
      setDrawer((current) =>
        current
          ? { ...current, transactions: current.transactions.filter((tx) => tx.id !== id) }
          : current,
      );
      refreshConfig();
      refreshTx();
    },
    [refreshConfig, refreshTx],
  );

  const handleSankeySelect = useCallback(
    (selection: SankeySelection) => {
      let matched: Transaction[];
      let title: string;
      let label: string;
      if (selection.kind === "edge") {
        matched = filtered.filter((tx) =>
          edgeMatchesTransaction(selection.source, selection.target, tx),
        );
        label = `${selection.source} → ${selection.target}`;
        title = `${label} 流水`;
      } else {
        matched = filtered.filter((tx) => nodeMatchesTransaction(selection.name, tx));
        label = selection.name;
        title = `${label} 流水`;
      }
      setDrawer({
        title,
        description:
          matched.length > 0
            ? `桑基图${selection.kind === "edge" ? "连线" : "节点"} “${label}” 关联的 ${matched.length} 条流水。`
            : `桑基图${selection.kind === "edge" ? "连线" : "节点"} “${label}” 暂无可匹配的流水。`,
        transactions: matched,
      });
    },
    [filtered],
  );

  if (loading) return <div className="h-[680px] rounded-lg bg-muted animate-pulse" />;
  if (error) {
    return (
      <Card>
        <h2 className="text-display-sm mb-2">无法加载资金流量</h2>
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

  return (
    // 一屏装下：根容器 = 视口 − 顶栏(65px) − 主区上下留白(24px)；极小窗口以 560px 保底转为页面滚动。
    // 这个高度是桑基图的唯一来源：图用 height="100%"，链路上任何一环缺少确定高度，
    // 图就会塌成一条几十像素的窄带——时间范围栏按自然高度占位，剩余全部归 Card 的 flex-1。
    <div className="flex h-[calc(100vh-89px)] min-h-[560px] flex-col">
      <div className="shrink-0">
        <FinTimeRangeBar transactions={transactions} />
      </div>
      <Card padding="lg" className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="items-start">
          <CardTitle description="保留完整路径，统一查看来源、账户、内部流转、项目、类别之间的关系。">
            全局资金流
          </CardTitle>
          {showFlowTabs && (
            <CategoryTabs
              value={flowView}
              onChange={setFlowView}
              options={FLOW_TABS}
              ariaLabel="资金流视图"
              variant="pills"
            />
          )}
        </CardHeader>

        {/* 桑基区是唯一弹性层：吃掉标题与 KPI 之外的全部剩余高度，图随容器伸缩 */}
        <div className="min-h-0 flex-1 overflow-x-auto rounded-lg border border-border bg-background/35 px-2 py-3">
          <div className="h-full min-w-[900px]">
            <SankeyChart
              nodes={sankey.nodes}
              links={sankey.links}
              height="100%"
              onSelect={handleSankeySelect}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <MetricCard
            icon={<CircleDollarSign size={18} />}
            label="净资产"
            value={formatCurrency(support.total)}
            helper={`可支撑 ${support.totalRunway}`}
          />
          <MetricCard
            icon={<BriefcaseBusiness size={18} />}
            label="工作账户余额"
            value={formatCurrency(support.work)}
            helper={`可支撑 ${support.workRunway}`}
          />
          <MetricCard
            icon={<Home size={18} />}
            label="生活账户余额"
            value={formatCurrency(support.life)}
            helper={`可支撑 ${support.lifeRunway}`}
          />
        </div>
      </Card>

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

function nodeMatchesTransaction(name: string, tx: Transaction): boolean {
  if (!name) return false;
  if (tx.accountName === name) return true;
  if (tx.fromAccountName === name) return true;
  if (tx.toAccountName === name) return true;
  if (tx.category?.name === name) return true;
  if (tx.projectName === name) return true;
  if (tx.sourceName === name) return true;
  if (tx.merchant === name) return true;
  if (tx.title === name) return true;
  // buildSankey 在没有 sourceName/merchant/title 时用 "资金来源" 兜底
  if (name === "资金来源" && tx.kind === "income" && !tx.sourceName && !tx.merchant && !tx.title) {
    return true;
  }
  // 未分类 / 未命名账户兜底
  if (name === "未分类" && tx.kind === "expense" && !tx.category?.name) return true;
  return false;
}

/**
 * 反推桑基连线匹配 — 与 buildSankey 的 add(source, target) 一一对应：
 *  - income:   sourceName → toAccount
 *  - transfer: fromAccount → toAccount
 *  - expense:  fromAccount → projectName        （第一段）
 *              projectName → categoryName        （第二段，仅当 project ≠ category）
 */
function edgeMatchesTransaction(source: string, target: string, tx: Transaction): boolean {
  if (!source || !target) return false;
  const txCategory = tx.category?.name || "未分类";
  const txProject = tx.projectName || txCategory;

  if (tx.kind === "income") {
    const txSource = tx.sourceName || tx.merchant || tx.title || "资金来源";
    const txTarget = tx.toAccountName || tx.accountName || "未命名账户";
    return source === txSource && target === txTarget;
  }
  if (tx.kind === "transfer") {
    const txSource = tx.fromAccountName || tx.accountName || "转出账户";
    const txTarget = tx.toAccountName || "转入账户";
    return source === txSource && target === txTarget;
  }
  if (tx.kind === "expense") {
    const txSource = tx.fromAccountName || tx.accountName || "支出账户";
    // 第一段：账户 → 项目
    if (source === txSource && target === txProject) return true;
    // 第二段：项目 → 分类（仅当 project ≠ category）
    if (txProject !== txCategory && source === txProject && target === txCategory) return true;
    return false;
  }
  return false;
}

function MetricCard({
  icon,
  label,
  value,
  helper,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-background/45 p-4">
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon || <WalletCards size={18} />}
      </span>
      <div className="min-w-0">
        <div className="text-caption">{label}</div>
        <div className="text-display-sm tabular-nums">{value}</div>
        <div className="text-caption mt-1">{helper}</div>
      </div>
    </div>
  );
}
