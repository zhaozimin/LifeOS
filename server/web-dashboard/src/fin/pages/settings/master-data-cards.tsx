/**
 * [INPUT]: 依赖账户、项目、资金来源模型和基础设置原语。
 * [OUTPUT]: 提供仪表盘、账户、项目与资金来源设置卡片。
 * [POS]: 财务主数据编辑的第一组面板。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from "react";
import { BarChart3, FolderKanban, History, LayoutDashboard, Plus, TrendingUp } from "lucide-react";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { TextInput } from "../../../components/ui/TextInput";
import { Autocomplete } from "../../components/ui/Autocomplete";
import { DatePicker } from "../../../components/ui/DatePicker";
import { ProjectPLDrawer } from "../../components/ProjectPLDrawer";
import { AdjustmentHistoryDrawer } from "../../components/AdjustmentHistoryDrawer";
import { TransactionEditSheet } from "../../components/TransactionEditSheet";
import { DashboardCustomizer } from "../../components/DashboardCustomizer";
import { formatCurrency } from "../../lib/format";
import type { Account, AccountClassification, AccountOwnership, ExchangeRates, FinanceSource, Project, ProjectGoal, Transaction } from "../../types";


import { CLASSIFICATION_OPTIONS, OWNERSHIP_OPTIONS } from "./constants";
import { ColorSwatchPicker, ItemCard, LiabilitySummary, SectionGrid, SectionHeader } from "./primitives";
import { formatSigned } from "./categories";


export function DashboardSection() {
  const [customizerOpen, setCustomizerOpen] = useState(false);
  return (
    <Card padding="none">
      <SectionHeader
        title="仪表盘布局"
        description="控制「财务状况」页各模块的显隐与排序；配置保存在本机浏览器，不写入 Finance Node。"
        action={
          <Button
            variant="outline"
            size="sm"
            leading={<LayoutDashboard size={13} />}
            onClick={() => setCustomizerOpen(true)}
          >
            自定义仪表盘
          </Button>
        }
      />
      <div className="px-5 py-4 text-body-sm text-muted-foreground">
        隐藏的模块不参与渲染；重新开启后立即恢复。财务状况页本身保持纯报表，不放配置入口。
      </div>
      <DashboardCustomizer open={customizerOpen} onClose={() => setCustomizerOpen(false)} />
    </Card>
  );
}

export function AccountsSection({
  accounts,
  exchangeRates,
  showOwnership,
  onChange,
}: {
  accounts: Account[];
  exchangeRates?: ExchangeRates;
  showOwnership: boolean;
  onChange: (next: Account[]) => void;
}) {
  const baseCurrency = exchangeRates?.baseCurrency || "CNY";
  const rates = exchangeRates?.rates || { CNY: 1 };
  const [historyAccount, setHistoryAccount] = useState<Account | null>(null);
  const update = (index: number, patch: Partial<Account>) => {
    const next = [...accounts];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const add = () =>
    onChange([
      ...accounts,
      {
        id: `account-${Date.now()}`,
        name: "新账户",
        type: "other",
        currency: "CNY",
        openingBalance: 0,
        currentBalance: 0,
        threshold: 0,
        tintHex: "#7f91d6",
        keywords: [],
        uiAccountType: "其他",
        // personal 模式不暴露归属，新账户直接落 personal，避免后端 infer 误判
        ownership: showOwnership ? "unspecified" : "personal",
        classification: "asset",
        creditLimit: 0,
      },
    ]);
  return (
    <Card padding="none">
      <SectionHeader
        title="账户管理"
        description="账户归属会影响工作/生活资金流。当前余额由你直接填写，记账与实际不符的差额视为黑洞资金。"
        action={<Button variant="outline" size="sm" leading={<Plus size={13} />} onClick={add}>新增账户</Button>}
      />
      <SectionGrid>
        {accounts.map((account, index) => (
          <ItemCard
            key={account.id}
            className={account.deletedAt ? "border-destructive/40 bg-destructive/5 opacity-65" : undefined}
            header={
              <>
                <ColorSwatchPicker
                  value={account.tintHex || "#7f91d6"}
                  onChange={(hex) => update(index, { tintHex: hex })}
                  label="账户主题色"
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                  {showOwnership && (
                    <Badge tone={account.ownership === "company" ? "brand-blue" : account.ownership === "personal" ? "success" : "neutral"}>
                      {OWNERSHIP_OPTIONS.find((item) => item.value === account.ownership)?.label || "未指定"}
                    </Badge>
                  )}
                  <span className="font-mono text-[11px] uppercase text-muted-foreground">
                    {(account.tintHex || "#7f91d6").toUpperCase()}
                  </span>
                </div>
              </>
            }
            actions={
              <button
                type="button"
                onClick={() => setHistoryAccount(account)}
                title="查看余额调整历史"
                aria-label="查看余额调整历史"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
              >
                <History size={14} />
              </button>
            }
            onDelete={() => onChange(accounts.map((item, i) => i === index ? {
              ...item,
              deletedAt: new Date().toISOString(),
              deletedBy: "dashboard",
              deletionReason: "用户在设置页删除",
              deletionImpact: {
                balance: item.currentBalance ?? item.openingBalance ?? 0,
                assetDelta: item.classification === "liability" ? 0 : -(item.currentBalance ?? item.openingBalance ?? 0),
                liabilityDelta: item.classification === "liability" ? -(item.currentBalance ?? item.openingBalance ?? 0) : 0,
                netWorthDelta: item.classification === "liability" ? (item.currentBalance ?? item.openingBalance ?? 0) : -(item.currentBalance ?? item.openingBalance ?? 0),
              },
            } : item))}
            deleteLabel="删除此账户"
          >
            {account.deletedAt && (
              <>
                <span className="pointer-events-none absolute inset-x-3 top-1/2 h-0.5 -rotate-6 bg-destructive/70" />
                <div className="rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2 text-[12px] text-destructive">
                <div className="font-semibold line-through decoration-2">已删除账户 · {account.deletedBy || "Agent"}</div>
                <div className="mt-1 text-muted-foreground">删除时余额 {formatCurrency(account.deletionImpact?.balance ?? account.currentBalance ?? account.openingBalance ?? 0)} · 当前资产 {formatSigned(account.deletionImpact?.assetDelta ?? 0)} · 净资产 {formatSigned(account.deletionImpact?.netWorthDelta ?? 0)}</div>
                </div>
              </>
            )}
            <TextInput label="账户名称" value={account.name} onChange={(event) => update(index, { name: event.target.value })} />
            {showOwnership ? (
              <div className="grid grid-cols-2 gap-3">
                <Autocomplete label="归属类型" value={account.ownership || "unspecified"} onChange={(value) => update(index, { ownership: value as AccountOwnership })} options={OWNERSHIP_OPTIONS} />
                <Autocomplete label="性质" value={account.classification || "asset"} onChange={(value) => update(index, { classification: value as AccountClassification })} options={CLASSIFICATION_OPTIONS} />
              </div>
            ) : (
              <Autocomplete label="性质" value={account.classification || "asset"} onChange={(value) => update(index, { classification: value as AccountClassification })} options={CLASSIFICATION_OPTIONS} />
            )}
            {account.classification === "liability" && (
              <TextInput
                label={account.type === "creditCard" ? "信用额度" : "总借款额"}
                type="number"
                value={String(account.creditLimit || 0)}
                onChange={(event) => update(index, { creditLimit: Number(event.target.value) || 0 })}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="阈值" type="number" value={String(account.threshold || 0)} onChange={(event) => update(index, { threshold: Number(event.target.value) || 0 })} />
              <TextInput
                label={account.classification === "liability" ? "当前已欠" : "当前余额"}
                type="number"
                value={String(account.currentBalance ?? account.openingBalance ?? 0)}
                onChange={(event) => update(index, { currentBalance: Number(event.target.value) || 0 })}
              />
            </div>
            {(account.threshold || 0) > 0 && (
              <details className="rounded-md border border-border/60 bg-background/30 px-3 py-2" open={Boolean(account.thresholdZones?.low || account.thresholdZones?.mid)}>
                <summary className="cursor-pointer text-[12.5px] font-medium text-foreground select-none">
                  阈值警戒区间（可选 · 默认 60% / 85%）
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <TextInput
                    label={`绿→黄 (低警戒)`}
                    type="number"
                    value={String(account.thresholdZones?.low || "")}
                    onChange={(event) =>
                      update(index, {
                        thresholdZones: {
                          ...(account.thresholdZones || {}),
                          low: Number(event.target.value) || 0,
                        },
                      })
                    }
                    placeholder={`默认 ${Math.round((account.threshold || 0) * 0.6)}`}
                  />
                  <TextInput
                    label={`黄→红 (中警戒)`}
                    type="number"
                    value={String(account.thresholdZones?.mid || "")}
                    onChange={(event) =>
                      update(index, {
                        thresholdZones: {
                          ...(account.thresholdZones || {}),
                          mid: Number(event.target.value) || 0,
                        },
                      })
                    }
                    placeholder={`默认 ${Math.round((account.threshold || 0) * 0.85)}`}
                  />
                </div>
              </details>
            )}
            {account.classification === "liability" && (account.creditLimit || 0) > 0 && (
              <LiabilitySummary
                used={account.currentBalance ?? account.openingBalance ?? 0}
                limit={account.creditLimit || 0}
              />
            )}
            {(account.currency || "CNY") !== baseCurrency && (
              <div className="rounded-md border border-border bg-background/30 px-3 py-2 text-[12px]">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">原币</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {(account.currentBalance ?? account.openingBalance ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2 })} {account.currency}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="text-muted-foreground">≈ {baseCurrency}</span>
                  <span className="font-mono text-foreground tabular-nums">
                    {formatCurrency((account.currentBalance ?? account.openingBalance ?? 0) * (rates[(account.currency || "CNY").toUpperCase()] || 1))}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  汇率 {rates[(account.currency || "CNY").toUpperCase()] || "—"}（在「货币与单位」面板编辑）
                </div>
              </div>
            )}
          </ItemCard>
        ))}
      </SectionGrid>
      <AdjustmentHistoryDrawer
        open={Boolean(historyAccount)}
        account={historyAccount}
        onClose={() => setHistoryAccount(null)}
      />
    </Card>
  );
}

export function ProjectsSection({
  projects,
  accounts,
  onChange,
}: {
  projects: Project[];
  accounts: Account[];
  onChange: (next: Project[]) => void;
}) {
  const [plProject, setPlProject] = useState<Project | null>(null);
  const [editTarget, setEditTarget] = useState<Transaction | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const accountOptions = [{ value: "", label: "不指定" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))];
  const update = (index: number, patch: Partial<Project>) => {
    const next = [...projects];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const updateGoal = (index: number, patch: Partial<ProjectGoal>) => {
    const project = projects[index];
    const currentGoal = project.goal || { targetAmount: 0 };
    update(index, { goal: { ...currentGoal, ...patch } });
  };
  const add = () =>
    onChange([...projects, { id: `project-${Date.now()}`, name: "新项目", direction: "支出", group: "新项目", note: "", trackingEnabled: false }]);
  return (
    <Card padding="none">
      <SectionHeader
        title="项目管理"
        description="项目用于追踪你正在进行的事情，同时记录它的成本、带来的收入与储蓄目标。"
        action={<Button variant="outline" size="sm" leading={<Plus size={13} />} onClick={add}>新增项目</Button>}
      />
      <SectionGrid>
        {projects.map((project, index) => (
          <ItemCard
            key={project.id}
            actions={
              <button
                type="button"
                onClick={() => setPlProject(project)}
                title="查看项目 P&L 报表"
                aria-label="查看项目 P&L 报表"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
              >
                <BarChart3 size={14} />
              </button>
            }
            header={
              <>
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <FolderKanban size={20} />
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Badge tone={project.trackingEnabled ? "success" : "neutral"}>
                    {project.trackingEnabled ? "追踪中" : "未追踪"}
                  </Badge>
                  {project.goal && (project.goal.targetAmount || 0) > 0 && (
                    <span className="font-mono text-[11px] uppercase text-muted-foreground">
                      目标：{formatCurrency(project.goal.targetAmount)}
                    </span>
                  )}
                </div>
              </>
            }
            onDelete={() => onChange(projects.filter((_, i) => i !== index))}
            deleteLabel="删除此项目"
          >
            <TextInput label="项目名称" value={project.name} onChange={(event) => update(index, { name: event.target.value })} />
            <TextInput label="说明" value={project.note || ""} onChange={(event) => update(index, { note: event.target.value })} />
            <Autocomplete
              label="资金追踪"
              value={project.trackingEnabled ? "yes" : "no"}
              onChange={(value) => update(index, { trackingEnabled: value === "yes" })}
              options={[{ value: "yes", label: "开启" }, { value: "no", label: "关闭" }]}
            />
            <details className="rounded-md border border-border/60 bg-background/30 px-3 py-2" open={(project.expectedCost || 0) > 0 || (project.expectedRevenue || 0) > 0}>
              <summary className="cursor-pointer text-[12.5px] font-medium text-foreground select-none">
                项目预算 / 期望（可选）
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="预算成本"
                    type="number"
                    value={String(project.expectedCost || 0)}
                    onChange={(event) => update(index, { expectedCost: Number(event.target.value) || 0 })}
                  />
                  <TextInput
                    label="期望收入"
                    type="number"
                    value={String(project.expectedRevenue || 0)}
                    onChange={(event) => update(index, { expectedRevenue: Number(event.target.value) || 0 })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <DatePicker
                    label="起始日期"
                    value={project.startDate || ""}
                    max={project.endDate || undefined}
                    onChange={(value) => update(index, { startDate: value || null })}
                  />
                  <DatePicker
                    label="结束日期"
                    value={project.endDate || ""}
                    min={project.startDate || undefined}
                    onChange={(value) => update(index, { endDate: value || null })}
                  />
                </div>
              </div>
            </details>
            <details className="rounded-md border border-border/60 bg-background/30 px-3 py-2" open={!!project.goal && (project.goal.targetAmount || 0) > 0}>
              <summary className="cursor-pointer text-[12.5px] font-medium text-foreground select-none">
                储蓄目标（可选）
              </summary>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <TextInput
                  label="目标金额（0 表示不设目标）"
                  type="number"
                  value={String(project.goal?.targetAmount || 0)}
                  onChange={(event) => updateGoal(index, { targetAmount: Number(event.target.value) || 0 })}
                />
                <DatePicker
                  label="目标日期"
                  value={project.goal?.targetDate || ""}
                  onChange={(value) => updateGoal(index, { targetDate: value || null })}
                />
                <Autocomplete
                  label="资金来自账户"
                  value={project.goal?.sourceAccountId || ""}
                  onChange={(value) => updateGoal(index, { sourceAccountId: value })}
                  options={accountOptions}
                  placeholder="选择账户…"
                  searchPlaceholder="搜索账户…"
                />
                <TextInput
                  label="描述"
                  value={project.goal?.description || ""}
                  onChange={(event) => updateGoal(index, { description: event.target.value })}
                  placeholder="例：买台新电脑、装修首付"
                />
              </div>
            </details>
          </ItemCard>
        ))}
      </SectionGrid>
      <ProjectPLDrawer
        open={Boolean(plProject)}
        project={plProject}
        onClose={() => setPlProject(null)}
        onEditTransaction={(tx) => {
          setEditTarget(tx);
          setEditorOpen(true);
          setPlProject(null);
        }}
      />
      <TransactionEditSheet
        open={editorOpen}
        initial={editTarget}
        onClose={() => {
          setEditorOpen(false);
          setEditTarget(null);
        }}
        onSaved={() => {
          setEditorOpen(false);
          setEditTarget(null);
        }}
        onDeleted={() => {
          setEditorOpen(false);
          setEditTarget(null);
        }}
      />
    </Card>
  );
}

export function SourcesSection({
  sources,
  accounts,
  onChange,
}: {
  sources: FinanceSource[];
  accounts: Account[];
  onChange: (next: FinanceSource[]) => void;
}) {
  const accountOptions = [{ value: "", label: "不指定" }, ...accounts.map((account) => ({ value: account.id, label: account.name }))];
  const update = (index: number, patch: Partial<FinanceSource>) => {
    const next = [...sources];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const add = () =>
    onChange([...sources, { id: `source-${Date.now()}`, name: "新资金来源", defaultAccountId: "", note: "", tintHex: "#87b99b" }]);
  return (
    <Card padding="none">
      <SectionHeader
        title="资金来源管理"
        description="资金来源对应桑基图第 1 层，用来记录开源项目或收入渠道。"
        action={<Button variant="outline" size="sm" leading={<Plus size={13} />} onClick={add}>新增来源</Button>}
      />
      <SectionGrid>
        {sources.map((source, index) => (
          <ItemCard
            key={source.id}
            header={
              <>
                <ColorSwatchPicker
                  value={source.tintHex || "#87b99b"}
                  onChange={(hex) => update(index, { tintHex: hex })}
                  icon={<TrendingUp size={20} />}
                  label="资金来源主题色"
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Badge tone="success">资金来源</Badge>
                  <span className="font-mono text-[11px] uppercase text-muted-foreground">
                    {(source.tintHex || "#87b99b").toUpperCase()}
                  </span>
                </div>
              </>
            }
            onDelete={() => onChange(sources.filter((_, i) => i !== index))}
            deleteLabel="删除此资金来源"
          >
            <TextInput label="来源名称" value={source.name} onChange={(event) => update(index, { name: event.target.value })} />
            <Autocomplete label="默认入账账户" value={source.defaultAccountId || ""} onChange={(value) => update(index, { defaultAccountId: value })} options={accountOptions} placeholder="选择账户…" searchPlaceholder="搜索账户…" />
            <TextInput label="备注" value={source.note || ""} onChange={(event) => update(index, { note: event.target.value })} />
          </ItemCard>
        ))}
      </SectionGrid>
    </Card>
  );
}

// 转账是服务于 kind=transfer 的系统类别，不作为用户可编辑的收支分类展示（数据仍保留）。