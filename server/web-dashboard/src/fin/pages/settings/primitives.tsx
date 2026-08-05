/**
 * [INPUT]: 依赖共享 UI 原语、财务配置类型和汇率 API。
 * [OUTPUT]: 提供设置统计、卡片框架、色板与汇率编辑基础件。
 * [POS]: 各设置面板共享的视觉和小型交互原语。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { CreditCard, Trash2 } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { api } from "../../api/client";
import { formatCurrency } from "../../lib/format";
import type { Configuration, ExchangeRates } from "../../types";




export function TopStat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background/45 p-4">
      <div className="mb-2 flex items-center justify-between text-muted-foreground">
        <span className="text-caption">{label}</span>
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-muted">{icon}</span>
      </div>
      <div className="text-display-sm tabular-nums">{value}</div>
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div>
        <h2 className="text-title-lg">{title}</h2>
        <p className="text-body-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function SectionGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 p-5 xl:grid-cols-3">{children}</div>;
}

export function ItemCard({
  header,
  onDelete,
  deleteLabel,
  actions,
  className,
  children,
}: {
  header: ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`group/itemcard relative rounded-lg border border-border bg-background/40 p-4 transition-colors hover:border-border/80 ${className || ""}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">{header}</div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title={deleteLabel}
              aria-label={deleteLabel}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground opacity-0 transition-all hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/itemcard:opacity-100"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3">{children}</div>
    </div>
  );
}

export function LiabilitySummary({ used, limit }: { used: number; limit: number }) {
  const safeLimit = Math.max(limit, 0);
  const safeUsed = Math.max(used, 0);
  const remaining = Math.max(safeLimit - safeUsed, 0);
  const percent = safeLimit > 0 ? Math.min(100, (safeUsed / safeLimit) * 100) : 0;
  const overLimit = safeUsed > safeLimit;
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/8 p-3">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted-foreground">已用 / 总额</span>
        <span className="font-semibold tabular-nums text-foreground">
          {formatCurrency(safeUsed)} / {formatCurrency(safeLimit)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-500/15">
        <div
          className={`h-full rounded-full ${overLimit ? "bg-destructive" : "bg-amber-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex items-baseline justify-between text-[12px]">
        <span className="text-muted-foreground">{overLimit ? "已超限" : "剩余可用"}</span>
        <span className={`font-semibold tabular-nums ${overLimit ? "text-destructive" : "text-emerald-700"}`}>
          {formatCurrency(remaining)}
        </span>
      </div>
    </div>
  );
}

export function ColorSwatchPicker({
  value,
  onChange,
  icon,
  label = "主题色",
}: {
  value: string;
  onChange: (hex: string) => void;
  icon?: ReactNode;
  label?: string;
}) {
  return (
    <label
      className="relative inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-white shadow-sm ring-1 ring-inset ring-black/5 transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring/40"
      style={{ background: value }}
      title="点击更改主题色"
    >
      {icon || <CreditCard size={20} />}
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label={label}
      />
    </label>
  );
}

export function cloneConfig(config: Configuration): Configuration {
  return JSON.parse(JSON.stringify(config)) as Configuration;
}

export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function ExchangeRatesEditor({
  value,
  onChange,
}: {
  value?: ExchangeRates;
  onChange: (next: ExchangeRates) => void;
}) {
  const baseCurrency = value?.baseCurrency || "CNY";
  const rates = value?.rates || { CNY: 1 };
  const [newCode, setNewCode] = useState("");
  const [newRate, setNewRate] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const updateRate = (code: string, rate: number) => {
    onChange({
      ...value,
      baseCurrency,
      rates: { ...rates, [code]: rate, [baseCurrency]: 1 },
    });
  };
  const removeRate = (code: string) => {
    if (code === baseCurrency) return;
    const next = { ...rates };
    delete next[code];
    onChange({ ...value, baseCurrency, rates: next });
  };
  const add = () => {
    const code = newCode.trim().toUpperCase();
    const rate = Number(newRate);
    if (!code || !Number.isFinite(rate) || rate <= 0) return;
    updateRate(code, rate);
    setNewCode("");
    setNewRate("");
  };
  const setAutoFetch = (enabled: boolean) => {
    onChange({ ...value, baseCurrency, rates, autoFetch: enabled });
  };
  const refreshNow = async () => {
    setRefreshMsg(null);
    setRefreshing(true);
    try {
      const fresh = await api.refreshExchangeRates();
      onChange(fresh);
      setRefreshMsg(`已拉取 · ${new Date(fresh.updatedAt || Date.now()).toLocaleString("zh-CN")}`);
    } catch (err) {
      setRefreshMsg(`拉取失败：${(err as Error).message || "未知错误"}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[11.5px] text-muted-foreground">
        本位币：<span className="font-semibold text-foreground">{baseCurrency}</span>。其他币种填"1 单位外币 = X {baseCurrency}"。
      </div>
      <div className="flex items-center justify-between rounded-md border border-border/60 bg-background/30 px-3 py-2 text-[12px]">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={Boolean(value?.autoFetch)}
            onChange={(e) => setAutoFetch(e.target.checked)}
          />
          <span>启动时自动从 open.er-api.com 拉取（默认关闭）</span>
        </label>
        <Button size="sm" variant="outline" onClick={refreshNow} loading={refreshing}>
          立即拉取
        </Button>
      </div>
      {refreshMsg && (
        <div
          className={`rounded-md border px-3 py-1.5 text-[11.5px] ${
            refreshMsg.startsWith("拉取失败")
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          }`}
        >
          {refreshMsg}
        </div>
      )}
      {value?.updatedAt && (
        <div className="text-[11px] text-muted-foreground">
          上次更新：{new Date(value.updatedAt).toLocaleString("zh-CN")}
          {value.lastFetchSource && ` · 来源 ${value.lastFetchSource}`}
        </div>
      )}
      <div className="space-y-1.5">
        {Object.entries(rates)
          .sort((a, b) => (a[0] === baseCurrency ? -1 : b[0] === baseCurrency ? 1 : a[0].localeCompare(b[0])))
          .map(([code, rate]) => (
            <div key={code} className="flex items-center gap-2 rounded-md border border-border bg-background/30 px-2 py-1.5">
              <span className="w-12 font-mono text-[12.5px] font-semibold text-foreground">{code}</span>
              <input
                type="number"
                step="0.0001"
                value={String(rate)}
                onChange={(event) => updateRate(code, Number(event.target.value) || 0)}
                disabled={code === baseCurrency}
                className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px] tabular-nums disabled:opacity-60"
              />
              <span className="text-[11px] text-muted-foreground">→ {baseCurrency}</span>
              {code !== baseCurrency && (
                <button
                  type="button"
                  onClick={() => removeRate(code)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label="删除"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          value={newCode}
          onChange={(event) => setNewCode(event.target.value.toUpperCase())}
          placeholder="代码（如 GBP）"
          className="h-7 w-20 rounded-md border border-border bg-background px-2 text-[12.5px] uppercase"
        />
        <input
          type="number"
          step="0.0001"
          value={newRate}
          onChange={(event) => setNewRate(event.target.value)}
          placeholder="汇率"
          className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px]"
        />
        <Button size="sm" variant="outline" onClick={add}>添加</Button>
      </div>
    </div>
  );
}
