/**
 * [INPUT]: 依赖周期规则 API、账户类别数据与设置基础件。
 * [OUTPUT]: 提供周期账目的创建、编辑与删除面板。
 * [POS]: 财务设置中负责未来交易模板的独立区域。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from "react";
import { Plus, Repeat } from "lucide-react";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { TextInput } from "../../../components/ui/TextInput";
import { Autocomplete } from "../../components/ui/Autocomplete";
import { AlertDialog } from "../../components/ui/AlertDialog";
import { todayIso } from "./primitives";
import { api } from "../../api/client";
import { useApi } from "../../lib/useApi";
import type { Account, CategoryRef, RecurringFrequency, RecurringRule, Transaction, TransactionKind } from "../../types";


import { FREQUENCY_LABEL, FREQUENCY_OPTIONS, TRANSACTION_KIND_OPTIONS } from "./constants";
import { ItemCard, SectionGrid, SectionHeader } from "./primitives";


export function RecurringSection({ accounts, categories }: { accounts: Account[]; categories: CategoryRef[] }) {
  const { data, loading, refresh } = useApi(() => api.listRecurring(), []);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecurringRule | null>(null);
  const rules = data || [];
  const accountOptions = [{ value: "", label: "—" }, ...accounts.map((a) => ({ value: a.name, label: a.name }))];
  const categoryOptions = [
    { value: "", label: "—" },
    ...categories.map((c) => ({ value: c.id || c.name, label: c.name })),
  ];

  const updateRule = async (rule: RecurringRule, patch: Partial<RecurringRule>) => {
    setBusy(true);
    try {
      await api.updateRecurring(rule.id, { ...rule, ...patch });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const updateTemplate = async (rule: RecurringRule, templatePatch: Partial<Transaction>) => {
    setBusy(true);
    try {
      await api.updateRecurring(rule.id, { ...rule, template: { ...rule.template, ...templatePatch } });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      const t = todayIso();
      const defaultCat = categories.find((c) => (c.direction || "支出") === "支出");
      await api.createRecurring({
        name: "新周期账目",
        frequency: "monthly",
        intervalN: 1,
        startDate: t,
        nextDueAt: t,
        enabled: true,
        template: {
          title: "新周期账目",
          amount: 100,
          kind: "expense",
          accountName: accounts[0]?.name || "",
          merchant: "",
          note: "",
          category: defaultCat
            ? { id: defaultCat.id, name: defaultCat.name, tintHex: defaultCat.tintHex }
            : { name: "未分类" },
        },
      });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = (rule: RecurringRule) => setDeleteTarget(rule);

  const performRemove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deleteRecurring(deleteTarget.id);
      setDeleteTarget(null);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="none">
      <SectionHeader
        title="周期账目"
        description="按日 / 周 / 月 / 年自动生成交易，例如订阅、租金、固定工资。系统启动 + 每次刷新都会扫一次到期规则。"
        action={
          <Button variant="outline" size="sm" leading={<Plus size={13} />} onClick={add} loading={busy}>
            新增规则
          </Button>
        }
      />
      {loading && !data ? (
        <div className="px-5 py-8 text-center text-body-sm text-muted-foreground">载入中...</div>
      ) : rules.length === 0 ? (
        <div className="px-5 py-8 text-center text-body-sm text-muted-foreground">
          还没有周期规则。点右上角「新增规则」开始。
        </div>
      ) : (
        <SectionGrid>
          {rules.map((rule) => {
            const tpl = rule.template || {};
            const kind = (tpl.kind as TransactionKind) || "expense";
            const tplCategory = (tpl.category as { id?: string; name?: string } | undefined) || undefined;
            return (
              <ItemCard
                key={rule.id}
                header={
                  <>
                    <span
                      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white shadow-sm"
                      style={{ background: tplCategory?.name ? "#7f91d6" : "#9aa0a6" }}
                    >
                      <Repeat size={20} />
                    </span>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Badge tone={rule.enabled ? "success" : "neutral"}>
                        {rule.enabled ? `${FREQUENCY_LABEL[rule.frequency]} · 启用` : "已暂停"}
                      </Badge>
                      <span className="font-mono text-[11px] uppercase text-muted-foreground">
                        下次：{rule.nextDueAt}
                      </span>
                    </div>
                  </>
                }
                onDelete={() => remove(rule)}
                deleteLabel="删除此规则"
              >
                <TextInput
                  label="规则名"
                  value={rule.name}
                  onChange={(event) => updateRule(rule, { name: event.target.value })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <Autocomplete
                    label="类型"
                    value={kind}
                    onChange={(value) => updateTemplate(rule, { kind: value as TransactionKind })}
                    options={TRANSACTION_KIND_OPTIONS}
                  />
                  <TextInput
                    label="金额"
                    type="number"
                    value={String(tpl.amount ?? 0)}
                    onChange={(event) => updateTemplate(rule, { amount: Number(event.target.value) || 0 })}
                  />
                </div>
                <TextInput
                  label="标题"
                  value={String(tpl.title || "")}
                  onChange={(event) => updateTemplate(rule, { title: event.target.value })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <Autocomplete
                    label="账户"
                    value={String(tpl.accountName || "")}
                    onChange={(value) => updateTemplate(rule, { accountName: value })}
                    options={accountOptions}
                    placeholder="选择账户…"
                    searchPlaceholder="搜索账户…"
                  />
                  <Autocomplete
                    label="分类"
                    value={tplCategory?.id || tplCategory?.name || ""}
                    onChange={(value) => {
                      const cat = categories.find((c) => (c.id || c.name) === value);
                      updateTemplate(rule, {
                        category: cat
                          ? { id: cat.id, name: cat.name, tintHex: cat.tintHex }
                          : { name: "未分类" },
                      });
                    }}
                    options={categoryOptions}
                    placeholder="选择分类…"
                    searchPlaceholder="搜索分类…"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Autocomplete
                    label="频率"
                    value={rule.frequency}
                    onChange={(value) => updateRule(rule, { frequency: value as RecurringFrequency })}
                    options={FREQUENCY_OPTIONS}
                  />
                  <TextInput
                    label="间隔"
                    type="number"
                    value={String(rule.intervalN || 1)}
                    onChange={(event) => updateRule(rule, { intervalN: Math.max(1, Number(event.target.value) || 1) })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="起始日期"
                    type="date"
                    value={rule.startDate}
                    onChange={(event) => updateRule(rule, { startDate: event.target.value })}
                  />
                  <TextInput
                    label="下次触发"
                    type="date"
                    value={rule.nextDueAt}
                    onChange={(event) => updateRule(rule, { nextDueAt: event.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="结束日期（可空）"
                    type="date"
                    value={rule.endDate || ""}
                    onChange={(event) => updateRule(rule, { endDate: event.target.value || null })}
                  />
                  <Autocomplete
                    label="是否启用"
                    value={rule.enabled ? "yes" : "no"}
                    onChange={(value) => updateRule(rule, { enabled: value === "yes" })}
                    options={[
                      { value: "yes", label: "启用" },
                      { value: "no", label: "暂停" },
                    ]}
                  />
                </div>
                {rule.lastRunAt && (
                  <div className="rounded-md border border-border bg-background/40 px-3 py-2 text-[12px] text-muted-foreground">
                    上次生成：{new Date(rule.lastRunAt).toLocaleString("zh-CN")}
                  </div>
                )}
              </ItemCard>
            );
          })}
        </SectionGrid>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        tone="destructive"
        title="删除周期账目"
        description={deleteTarget ? `确认删除「${deleteTarget.name}」？此操作不可恢复。` : undefined}
        confirmLabel="删除"
        busy={busy}
        onConfirm={performRemove}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
