/**
 * [INPUT]: 依赖类别、对手方模型与基础设置原语。
 * [OUTPUT]: 提供类别、客户合作方编辑和金额符号化。
 * [POS]: 财务主数据编辑的第二组面板。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo, useState } from "react";
import { Pencil, Plus, Tags, Trash2, UserSquare } from "lucide-react";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { TextInput } from "../../../components/ui/TextInput";
import { Autocomplete } from "../../components/ui/Autocomplete";
import { Modal } from "../../../components/ui/Modal";
import { CategoryTabs } from "../../../components/ui/Tabs";
import { api } from "../../api/client";
import { useApi } from "../../lib/useApi";
import { formatCurrency } from "../../lib/format";
import type { Account, CategoryRef, Counterparty, CounterpartyKind, Project } from "../../types";


import { COUNTERPARTY_KIND_OPTIONS, COUNTERPARTY_KIND_TONE } from "./constants";
import { ColorSwatchPicker, ItemCard, SectionGrid, SectionHeader } from "./primitives";


const SYSTEM_CATEGORY_IDS = new Set(["category-transfer"]);

export function CategoriesSection({
  categories,
  accounts,
  projects,
  onChange,
}: {
  categories: CategoryRef[];
  accounts: Account[];
  projects: Project[];
  onChange: (next: CategoryRef[]) => void;
}) {
  const accountOptions = [{ value: "", label: "不指定" }, ...accounts.map((account) => ({ value: account.id, label: account.name }))];
  const projectOptions = [{ value: "", label: "未绑定项目" }, ...projects.map((project) => ({ value: project.id, label: project.name }))];
  const accountNameById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.name] as const)),
    [accounts],
  );
  const [directionTab, setDirectionTab] = useState<"支出" | "收入">("支出");
  const [editIndex, setEditIndex] = useState<number | null>(null);

  const update = (index: number, patch: Partial<CategoryRef>) => {
    const next = [...categories];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const remove = (index: number) => {
    setEditIndex(null);
    onChange(categories.filter((_, i) => i !== index));
  };
  const add = () => {
    const newIndex = categories.length;
    onChange([
      ...categories,
      { id: `category-${Date.now()}`, name: directionTab === "收入" ? "新收入类别" : "新支出类别", direction: directionTab, group: "", keywords: [], tintHex: "#d97757" },
    ]);
    setEditIndex(newIndex);
  };

  // 保留真实索引，供 update / remove 定位；同时按方向 tab + 排除系统类别做展示过滤
  const rows = categories
    .map((category, index) => ({ category, index }))
    .filter(({ category }) => !SYSTEM_CATEGORY_IDS.has(category.id || "") && (category.direction || "支出") === directionTab);
  const expenseCount = categories.filter((c) => !SYSTEM_CATEGORY_IDS.has(c.id || "") && (c.direction || "支出") === "支出").length;
  const incomeCount = categories.filter((c) => !SYSTEM_CATEGORY_IDS.has(c.id || "") && c.direction === "收入").length;

  const editing = editIndex != null ? categories[editIndex] : null;

  return (
    <Card padding="none">
      <SectionHeader
        title="类别管理"
        description="收入与支出分开管理。点开任意类别可编辑默认账户、月度预算与识别关键词。"
        action={
          <Button variant="outline" size="sm" leading={<Plus size={13} />} onClick={add}>
            新增{directionTab}类别
          </Button>
        }
      />
      <div className="border-b border-border px-5 py-3">
        <CategoryTabs
          value={directionTab}
          onChange={setDirectionTab}
          options={[
            { value: "支出", label: `支出 (${expenseCount})` },
            { value: "收入", label: `收入 (${incomeCount})` },
          ]}
          variant="pills"
          ariaLabel="类别方向"
        />
      </div>
      <div className="space-y-1.5 p-4">
        {rows.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
            还没有{directionTab}类别，点右上角「新增{directionTab}类别」创建。
          </div>
        )}
        {rows.map(({ category, index }) => {
          const accountName = category.defaultAccountId ? accountNameById.get(category.defaultAccountId) : undefined;
          const budget = category.monthlyBudget || 0;
          return (
            <div key={category.id || index} className="flex items-center gap-1.5 rounded-lg border border-border bg-card">
              <button
                type="button"
                onClick={() => setEditIndex(index)}
                className="flex flex-1 items-center gap-3 rounded-l-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
              >
                <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: category.tintHex || "#d97757" }} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{category.name}</span>
                {accountName && (
                  <span className="hidden shrink-0 items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-flex">
                    → {accountName}
                  </span>
                )}
                {budget > 0 && (
                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    预算 {formatCurrency(budget)}
                  </span>
                )}
                <Pencil size={13} className="shrink-0 text-muted-foreground" />
              </button>
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={`删除类别 ${category.name}`}
                title="删除此类别"
                className="mr-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <Modal
        open={editing != null}
        onClose={() => setEditIndex(null)}
        size="sm"
        title={
          <span className="flex items-center gap-2">
            <Tags size={16} /> 编辑类别
          </span>
        }
        footer={
          <div className="flex justify-end">
            <Button onClick={() => setEditIndex(null)}>完成</Button>
          </div>
        }
      >
        {editing && editIndex != null && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <ColorSwatchPicker
                value={editing.tintHex || "#d97757"}
                onChange={(hex) => update(editIndex, { tintHex: hex })}
                icon={<Tags size={20} />}
                label="类别主题色"
              />
              <div className="flex-1">
                <TextInput label="类别名称" value={editing.name} onChange={(event) => update(editIndex, { name: event.target.value })} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Autocomplete label="方向" value={editing.direction || "支出"} onChange={(value) => update(editIndex, { direction: value as "收入" | "支出" })} options={[{ value: "支出", label: "支出" }, { value: "收入", label: "收入" }]} />
              <Autocomplete label="默认账户" value={editing.defaultAccountId || ""} onChange={(value) => update(editIndex, { defaultAccountId: value })} options={accountOptions} placeholder="选择账户…" searchPlaceholder="搜索账户…" />
            </div>
            {(editing.direction || "支出") === "支出" && (
              <TextInput
                label="月度预算（0 表示不设预算）"
                type="number"
                value={String(editing.monthlyBudget || 0)}
                onChange={(event) => update(editIndex, { monthlyBudget: Number(event.target.value) || 0 })}
                placeholder="留空 / 0 不参与预算追踪"
              />
            )}
            <TextInput
              label="关键词（帮助 AI 与账单导入自动归类）"
              value={(editing.keywords || []).join(", ")}
              onChange={(event) => update(editIndex, { keywords: event.target.value.split(/[,，、]/).map((item) => item.trim()).filter(Boolean) })}
            />
            <details className="rounded-md border border-border px-3 py-2 text-[13px]">
              <summary className="cursor-pointer select-none text-muted-foreground">高级 · 项目归属</summary>
              <div className="pt-3">
                <Autocomplete label="项目归属" value={editing.projectId || ""} onChange={(value) => update(editIndex, { projectId: value })} options={projectOptions} placeholder="选择项目…" searchPlaceholder="搜索项目…" />
              </div>
            </details>
          </div>
        )}
      </Modal>
    </Card>
  );
}

export function CounterpartiesSection({
  counterparties,
  accounts,
  onChange,
}: {
  counterparties: Counterparty[];
  accounts: Account[];
  onChange: (next: Counterparty[]) => void;
}) {
  const { data: transactionData } = useApi(() => api.listTransactions({ limit: 3000 }), []);
  const transactions = transactionData || [];
  const recentByCp = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const tx of transactions) {
      if (!tx.counterpartyId) continue;
      const t = new Date(tx.occurredAt).getTime();
      if (Number.isFinite(t) && t < cutoff) continue;
      const cur = map.get(tx.counterpartyId) || { count: 0, total: 0 };
      cur.count += 1;
      const sign = tx.kind === "income" ? 1 : tx.kind === "expense" ? -1 : 0;
      cur.total += sign * tx.amount;
      map.set(tx.counterpartyId, cur);
    }
    return map;
  }, [transactions]);
  const accountOptions = [{ value: "", label: "不指定" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))];
  const update = (index: number, patch: Partial<Counterparty>) => {
    const next = [...counterparties];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const add = () =>
    onChange([
      ...counterparties,
      {
        id: `counterparty-${Date.now()}`,
        name: "新对手方",
        kind: "client",
        tintHex: "#7F91D6",
        defaultAccountId: "",
        note: "",
        contactInfo: "",
      },
    ]);
  return (
    <Card padding="none">
      <SectionHeader
        title="客户与合作方"
        description="登记长期合作的客户、供应商或雇主，登记后可以挂到流水的对手方字段，方便归账与回款查询。"
        action={<Button variant="outline" size="sm" leading={<Plus size={13} />} onClick={add}>新增对手方</Button>}
      />
      <SectionGrid>
        {counterparties.map((cp, index) => (
          <ItemCard
            key={cp.id}
            header={
              <>
                <ColorSwatchPicker
                  value={cp.tintHex || "#7F91D6"}
                  onChange={(hex) => update(index, { tintHex: hex })}
                  icon={<UserSquare size={20} />}
                  label="对手方主题色"
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Badge tone={COUNTERPARTY_KIND_TONE[cp.kind] || "neutral"}>
                    {COUNTERPARTY_KIND_OPTIONS.find((opt) => opt.value === cp.kind)?.label || "客户"}
                  </Badge>
                  <span className="font-mono text-[11px] uppercase text-muted-foreground">
                    {(cp.tintHex || "#7F91D6").toUpperCase()}
                  </span>
                </div>
              </>
            }
            onDelete={() => onChange(counterparties.filter((_, i) => i !== index))}
            deleteLabel="删除此对手方"
          >
            <TextInput label="名称" value={cp.name} onChange={(event) => update(index, { name: event.target.value })} />
            <Autocomplete
              label="类型"
              value={cp.kind}
              onChange={(value) => update(index, { kind: value as CounterpartyKind })}
              options={COUNTERPARTY_KIND_OPTIONS}
            />
            <Autocomplete
              label="默认结算账户"
              value={cp.defaultAccountId || ""}
              onChange={(value) => update(index, { defaultAccountId: value })}
              options={accountOptions}
              placeholder="选择账户…"
              searchPlaceholder="搜索账户…"
            />
            <TextInput
              label="联系方式"
              value={cp.contactInfo || ""}
              onChange={(event) => update(index, { contactInfo: event.target.value })}
              placeholder="电话 / 邮箱 / 微信"
            />
            <TextInput label="备注" value={cp.note || ""} onChange={(event) => update(index, { note: event.target.value })} />
            {(() => {
              const stats = recentByCp.get(cp.id);
              if (!stats || stats.count === 0) {
                return (
                  <div className="rounded-md border border-dashed border-border bg-background/30 px-3 py-2 text-[11.5px] text-muted-foreground">
                    近 30 天没有相关流水
                  </div>
                );
              }
              return (
                <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-[12px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">近 30 天</span>
                    <span className="font-mono text-foreground tabular-nums">{stats.count} 笔</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">合计</span>
                    <span className={`font-mono tabular-nums ${stats.total >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>
                      {stats.total >= 0 ? "+" : "−"}{formatCurrency(Math.abs(stats.total))}
                    </span>
                  </div>
                </div>
              );
            })()}
          </ItemCard>
        ))}
      </SectionGrid>
    </Card>
  );
}

export function formatSigned(value: number) {
  return `${value >= 0 ? "+" : "−"}${formatCurrency(Math.abs(value))}`;
}
