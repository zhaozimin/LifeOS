/**
 * [INPUT]: 依赖税务与导入 API、账户类别数据和设置基础件。
 * [OUTPUT]: 提供税务配置与账单导入面板。
 * [POS]: 财务设置的外部账单和税务边界。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from "react";
import { FileSpreadsheet, FileUp, Percent, Receipt, Upload } from "lucide-react";
import clsx from "clsx";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { TextInput } from "../../../components/ui/TextInput";
import { Autocomplete } from "../../components/ui/Autocomplete";
import { api } from "../../api/client";
import type { Account, CategoryRef, Configuration, Transaction } from "../../types";


import { ItemCard, SectionGrid, SectionHeader } from "./primitives";


export function TaxConfigSection({
  taxConfig,
  onChange,
}: {
  taxConfig: NonNullable<Configuration["settings"]["taxConfig"]>;
  onChange: (next: Configuration["settings"]["taxConfig"]) => void;
}) {
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState<number | "">("");

  const update = (patch: Partial<NonNullable<Configuration["settings"]["taxConfig"]>>) => {
    onChange({ ...taxConfig, ...patch });
  };

  const downloadReport = async () => {
    setDownloadBusy(true);
    try {
      const { blob, filename } = await api.downloadTaxReport({
        year,
        quarter: quarter ? Number(quarter) : undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <Card padding="none">
      <SectionHeader
        title="税务设置 / 报税导出"
        description="编辑全局税率参数，用于交易上 taxCategory 字段的预估计算与导出。所有数据仅供参考，请以专业税务意见为准。"
      />
      <SectionGrid>
        <ItemCard
          header={
            <>
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Percent size={20} />
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Badge tone="primary">税率</Badge>
                <span className="font-mono text-[11px] uppercase text-muted-foreground">
                  增值税 {(taxConfig.vatRate * 100).toFixed(2)}%
                </span>
              </div>
            </>
          }
        >
          <TextInput
            label={`增值税率（当前 ${(taxConfig.vatRate * 100).toFixed(2)}%）`}
            type="number"
            step="0.001"
            value={String(taxConfig.vatRate)}
            onChange={(event) => update({ vatRate: Number(event.target.value) || 0 })}
          />
          <TextInput
            label={`个税起征点（年）`}
            type="number"
            value={String(taxConfig.personalThreshold)}
            onChange={(event) => update({ personalThreshold: Number(event.target.value) || 0 })}
          />
          <TextInput
            label={`个税率（当前 ${(taxConfig.personalRate * 100).toFixed(2)}%）`}
            type="number"
            step="0.001"
            value={String(taxConfig.personalRate)}
            onChange={(event) => update({ personalRate: Number(event.target.value) || 0 })}
          />
          <TextInput
            label={`社保 + 公积金合计费率（当前 ${(taxConfig.sebRate * 100).toFixed(2)}%）`}
            type="number"
            step="0.001"
            value={String(taxConfig.sebRate)}
            onChange={(event) => update({ sebRate: Number(event.target.value) || 0 })}
          />
        </ItemCard>

        <ItemCard
          header={
            <>
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <FileSpreadsheet size={20} />
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Badge tone="brand-blue">导出</Badge>
                <span className="font-mono text-[11px] uppercase text-muted-foreground">
                  5 sheet · xlsx
                </span>
              </div>
            </>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <TextInput
              label="年度"
              type="number"
              value={String(year)}
              onChange={(event) => setYear(Number(event.target.value) || new Date().getFullYear())}
            />
            <Autocomplete
              label="季度（可选）"
              value={String(quarter)}
              onChange={(value) => setQuarter(value ? Number(value) : "")}
              options={[
                { value: "", label: "全年" },
                { value: "1", label: "Q1" },
                { value: "2", label: "Q2" },
                { value: "3", label: "Q3" },
                { value: "4", label: "Q4" },
              ]}
            />
          </div>
          <div className="text-[12px] text-muted-foreground">
            导出 5 个 sheet：业务收入 / 可抵扣 / 不可抵扣 / 汇总 / 说明。所有税务字段在「编辑流水」时设置。
          </div>
          <Button leading={<Receipt size={14} />} onClick={downloadReport} loading={downloadBusy}>
            下载报税表
          </Button>
        </ItemCard>
      </SectionGrid>
    </Card>
  );
}

type ImportTemplate = "wechat" | "alipay" | "generic";
type ImportStep = "upload" | "preview" | "done";

const IMPORT_TEMPLATES: Array<{ value: ImportTemplate; label: string; description: string; help?: string }> = [
  {
    value: "wechat",
    label: "微信支付账单",
    description: "微信账单 CSV，自动跳过顶部说明行。",
    help: "导出路径：微信 → 支付 → 服务 → 钱包 → 账单 → 右上角 → 申请账单（用做记账）→ 邮件接收。",
  },
  {
    value: "alipay",
    label: "支付宝账单",
    description: "支付宝账单 CSV，自动识别表头。",
    help: "导出路径：支付宝 → 我的 → 账单 → 右上角 → 开具交易流水证明 → 邮件接收。",
  },
  {
    value: "generic",
    label: "通用 CSV",
    description: "任意银行 / 平台 CSV，按列名智能匹配。",
    help: "至少需要含「日期」「金额」「交易对方」三列，列名见鼠标 hover 各模板提示。",
  },
];

export function ImportSection({
  accounts,
  categories,
  onImported,
}: {
  accounts: Account[];
  categories: CategoryRef[];
  onImported?: () => void;
}) {
  const [template, setTemplate] = useState<ImportTemplate>("generic");
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ImportStep>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<Array<Partial<Transaction> & { __selected: boolean }>>([]);
  const [result, setResult] = useState<{ imported: number; failed: number; errors: Array<{ index: number; error: string }> } | null>(null);

  const accountOptions = [{ value: "", label: "选择账户" }, ...accounts.map((a) => ({ value: a.name, label: a.name }))];
  const categoryOptions = [
    { value: "", label: "未分类" },
    ...categories.map((c) => ({ value: c.id || c.name, label: c.name })),
  ];

  const reset = () => {
    setFile(null);
    setStep("upload");
    setBusy(false);
    setError(null);
    setWarnings([]);
    setPreview([]);
    setResult(null);
  };

  const onPreview = async () => {
    if (!file) {
      setError("请先选择一个文件。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api.importPreview(template, file);
      setWarnings(data.warnings || []);
      setPreview((data.transactions || []).map((tx) => ({ ...tx, __selected: true })));
      setStep("preview");
    } catch (err) {
      setError((err as Error).message || "解析失败");
    } finally {
      setBusy(false);
    }
  };

  const onCommit = async () => {
    const selected = preview.filter((tx) => tx.__selected).map(({ __selected: _, ...rest }) => rest);
    if (!selected.length) {
      setError("没有选中任何交易。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api.importCommit(selected);
      setResult(data);
      setStep("done");
      onImported?.();
    } catch (err) {
      setError((err as Error).message || "导入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="none">
      <SectionHeader
        title="账单导入"
        description="从微信 / 支付宝 / 任意银行 CSV 导入账单。系统会按列名识别 + 用 keywords 自动匹配分类与账户。"
        action={
          step !== "upload" ? (
            <Button variant="outline" size="sm" onClick={reset}>重新开始</Button>
          ) : undefined
        }
      />

      {error && (
        <div className="mx-5 mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      )}

      {step === "upload" && (
        <div className="space-y-5 px-5 py-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {IMPORT_TEMPLATES.map((tpl) => (
              <button
                key={tpl.value}
                type="button"
                onClick={() => setTemplate(tpl.value)}
                title={tpl.help}
                className={clsx(
                  "rounded-lg border p-4 text-left transition-colors",
                  template === tpl.value ? "border-primary bg-primary/5" : "border-border hover:border-border/80",
                )}
              >
                <div className="mb-1 text-[14px] font-semibold text-foreground">{tpl.label}</div>
                <div className="text-[12.5px] text-muted-foreground">{tpl.description}</div>
                {template === tpl.value && tpl.help && (
                  <div className="mt-2 rounded border border-border/60 bg-background/50 px-2 py-1 text-[11.5px] text-muted-foreground">
                    💡 {tpl.help}
                  </div>
                )}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-background/30 px-6 py-10 transition-colors hover:bg-background/50">
            <FileUp size={20} className="text-muted-foreground" />
            <span className="text-[13.5px] text-muted-foreground">
              {file ? `已选：${file.name}（${(file.size / 1024).toFixed(1)} KB）` : "点击或拖拽 CSV / TSV 文件到此处"}
            </span>
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv"
              onChange={(event) => {
                const f = event.target.files?.[0];
                if (f) setFile(f);
              }}
              className="hidden"
            />
          </label>
          <div className="flex justify-end">
            <Button leading={<Upload size={14} />} onClick={onPreview} disabled={!file || busy} loading={busy}>
              解析预览
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4 px-5 py-5">
          {warnings.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-300">
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 text-[13px]">
            <div className="flex items-center gap-3 text-muted-foreground">
              <span>共解析 {preview.length} 条 · 已选 {preview.filter((p) => p.__selected).length} 条</span>
              <button
                type="button"
                onClick={() => setPreview(preview.map((p) => ({ ...p, __selected: !preview.every((x) => x.__selected) })))}
                className="text-primary hover:underline"
              >
                {preview.every((p) => p.__selected) ? "全不选" : "全选"}
              </button>
            </div>
            <Button leading={<Upload size={14} />} onClick={onCommit} loading={busy}>
              确认导入
            </Button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[1100px] table-fixed border-collapse text-left text-[13px]">
              <colgroup>
                <col className="w-[44px]" />
                <col className="w-[150px]" />
                <col className="w-[80px]" />
                <col className="w-[120px]" />
                <col className="w-[220px]" />
                <col className="w-[180px]" />
                <col className="w-[180px]" />
              </colgroup>
              <thead className="bg-muted/30 text-caption-uppercase">
                <tr>
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2 font-semibold">时间</th>
                  <th className="px-3 py-2 font-semibold">类型</th>
                  <th className="px-3 py-2 text-right font-semibold">金额</th>
                  <th className="px-3 py-2 font-semibold">摘要</th>
                  <th className="px-3 py-2 font-semibold">分类</th>
                  <th className="px-3 py-2 font-semibold">账户</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((tx, index) => {
                  const cat = (tx.category as { id?: string; name?: string } | undefined) || undefined;
                  return (
                    <tr key={index} className="border-t border-border/60 hover:bg-muted/20">
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={tx.__selected}
                          onChange={(e) => {
                            const next = [...preview];
                            next[index] = { ...next[index], __selected: e.target.checked };
                            setPreview(next);
                          }}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">
                        {(tx.occurredAt || "").slice(0, 10)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={tx.kind === "income" ? "success" : tx.kind === "transfer" ? "brand-blue" : "destructive"}>
                          {tx.kind === "income" ? "收入" : tx.kind === "transfer" ? "转账" : "支出"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right font-serif tabular-nums">¥{(tx.amount || 0).toFixed(2)}</td>
                      <td className="truncate px-3 py-2">{tx.title || "未命名"}</td>
                      <td className="px-3 py-2">
                        <Autocomplete
                          size="sm"
                          ariaLabel="分类"
                          value={cat?.id || cat?.name || ""}
                          onChange={(value) => {
                            const target = categories.find((c) => (c.id || c.name) === value);
                            const next = [...preview];
                            next[index] = {
                              ...next[index],
                              category: target
                                ? { id: target.id, name: target.name, tintHex: target.tintHex }
                                : { name: "未分类" },
                            };
                            setPreview(next);
                          }}
                          options={categoryOptions}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Autocomplete
                          size="sm"
                          ariaLabel="账户"
                          value={tx.accountName || ""}
                          onChange={(value) => {
                            const next = [...preview];
                            next[index] = { ...next[index], accountName: value };
                            setPreview(next);
                          }}
                          options={accountOptions}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-4 px-5 py-8 text-center">
          <div className="text-display-sm">导入完成</div>
          <div className="text-[14px] text-muted-foreground">
            成功 <span className="font-semibold text-emerald-700 dark:text-emerald-300">{result.imported}</span> 条
            {result.failed > 0 && (
              <>，失败 <span className="font-semibold text-destructive">{result.failed}</span> 条</>
            )}
          </div>
          {result.errors.length > 0 && (
            <div className="mx-auto max-w-2xl rounded-md border border-destructive/30 bg-destructive/5 p-3 text-left text-[12px] text-destructive">
              {result.errors.slice(0, 5).map((e) => (
                <div key={e.index}>第 {e.index + 1} 行：{e.error}</div>
              ))}
              {result.errors.length > 5 && <div className="mt-1">...还有 {result.errors.length - 5} 条错误</div>}
            </div>
          )}
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={reset}>再导入一份</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
