import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, X } from "lucide-react";
import type { EChartsOption } from "echarts";
import type { Project, Transaction } from "../types";
import { api } from "../api/client";
import { useApi } from "../lib/useApi";
import { formatCurrency } from "../lib/format";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";
import { EChart } from "./charts/EChart";
import { AlertDialog } from "./ui/AlertDialog";
import { useThemeStore } from "../store/theme";
import { getPalette } from "./charts/theme";

interface Props {
  open: boolean;
  project: Project | null;
  onClose: () => void;
  onEditTransaction?: (tx: Transaction) => void;
}

export function ProjectPLDrawer({ open, project, onClose, onEditTransaction }: Props) {
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);
  const printableRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportPdf = async () => {
    if (!printableRef.current || !project) return;
    setExporting(true);
    try {
      // 动态 import 避免 jspdf 在初始 chunk 里
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const canvas = await html2canvas(printableRef.current, {
        scale: 2,
        backgroundColor: resolved === "dark" ? "#111" : "#fff",
        useCORS: true,
        logging: false,
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageWidth = 210;
      const pageHeight = 297;
      const ratio = canvas.width / canvas.height;
      const imgWidth = pageWidth - 20;
      const imgHeight = imgWidth / ratio;
      // 若高度超过一页 → 多页拆分
      let positionY = 10;
      if (imgHeight <= pageHeight - 20) {
        pdf.addImage(imgData, "PNG", 10, positionY, imgWidth, imgHeight);
      } else {
        // 简单分页：把 image 按页高切片
        const pageSliceHeightPx = ((pageHeight - 20) * canvas.width) / imgWidth;
        let yPx = 0;
        while (yPx < canvas.height) {
          const slice = document.createElement("canvas");
          slice.width = canvas.width;
          slice.height = Math.min(pageSliceHeightPx, canvas.height - yPx);
          const ctx = slice.getContext("2d");
          if (!ctx) break;
          ctx.drawImage(canvas, 0, yPx, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
          const sliceData = slice.toDataURL("image/png");
          const sliceHeight = (slice.height * imgWidth) / canvas.width;
          pdf.addImage(sliceData, "PNG", 10, positionY, imgWidth, sliceHeight);
          yPx += slice.height;
          if (yPx < canvas.height) {
            pdf.addPage();
            positionY = 10;
          }
        }
      }
      pdf.save(`${project.name}-PL-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (err) {
      console.error("PDF export failed", err);
      setExportError((err as Error).message || "未知错误");
    } finally {
      setExporting(false);
    }
  };

  const { data: transactions } = useApi(
    () => (project ? api.listTransactions({ limit: 3000 }) : Promise.resolve([] as Transaction[])),
    [project?.id, open],
  );

  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const projectTxs = useMemo(() => {
    if (!project || !transactions) return [];
    return transactions
      .filter((tx) => tx.projectName === project.name)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }, [project, transactions]);

  const stats = useMemo(() => {
    const cost = projectTxs.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
    const revenue = projectTxs.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
    const profit = revenue - cost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    return { cost, revenue, profit, margin };
  }, [projectTxs]);

  const monthlyChart = useMemo(() => buildMonthlyTrend(projectTxs), [projectTxs]);

  if (!open || !project) return null;

  const expectedCost = project.expectedCost || 0;
  const expectedRevenue = project.expectedRevenue || 0;
  const costPercent = expectedCost > 0 ? (stats.cost / expectedCost) * 100 : null;
  const revenuePercent = expectedRevenue > 0 ? (stats.revenue / expectedRevenue) * 100 : null;

  const chartOption: EChartsOption = {
    tooltip: { trigger: "axis" },
    grid: { top: 24, right: 16, bottom: 32, left: 56 },
    xAxis: {
      type: "category",
      data: monthlyChart.labels,
      axisLine: { lineStyle: { color: palette.hairline } },
      axisLabel: { color: palette.muted },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: palette.muted,
        formatter: (v: number) => (Math.abs(v) >= 1000 ? `¥${(v / 1000).toFixed(1)}k` : `¥${Math.round(v)}`),
      },
      splitLine: { lineStyle: { color: palette.hairline } },
    },
    series: [
      {
        name: "净利润",
        type: "line",
        smooth: true,
        symbolSize: 7,
        data: monthlyChart.profit,
        lineStyle: { width: 2.5, color: palette.brandBlue },
        itemStyle: { color: palette.brandBlue },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${palette.brandBlue}80` },
              { offset: 1, color: `${palette.brandBlue}10` },
            ],
          },
        },
      },
    ],
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative ml-auto flex h-full w-full max-w-[760px] flex-col bg-background shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-display-sm">{project.name}</h2>
              {project.trackingEnabled ? (
                <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                  追踪中
                </span>
              ) : (
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                  未追踪
                </span>
              )}
            </div>
            <div className="mt-1 text-[12.5px] text-muted-foreground">
              {project.startDate || "—"} → {project.endDate || "—"}
              {project.note && <span className="ml-2">· {project.note}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={exportPdf}
              disabled={exporting}
              title="导出 PDF"
              aria-label="导出 PDF"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12.5px] text-muted-foreground hover:border-primary/40 hover:text-primary disabled:opacity-50"
            >
              <Download size={13} />
              <span>{exporting ? "生成中…" : "导出 PDF"}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div ref={printableRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <PLKpi
              label="实际成本"
              value={formatCurrency(stats.cost)}
              hint={costPercent !== null ? `${costPercent.toFixed(1)}% 预算` : "未设预算"}
              tone="warn"
            />
            <PLKpi
              label="实际回款"
              value={formatCurrency(stats.revenue)}
              hint={revenuePercent !== null ? `${revenuePercent.toFixed(1)}% 期望` : "未设期望"}
              tone="good"
            />
            <PLKpi
              label="净利润"
              value={formatCurrency(stats.profit)}
              hint={stats.profit >= 0 ? "盈利" : "亏损"}
              tone={stats.profit >= 0 ? "good" : "warn"}
            />
            <PLKpi
              label="利润率"
              value={`${stats.margin.toFixed(1)}%`}
              hint={`基于 ${projectTxs.length} 笔流水`}
              tone={stats.margin >= 0 ? "neutral" : "warn"}
            />
          </section>

          {monthlyChart.labels.length > 0 ? (
            <section>
              <h3 className="mb-2 text-title-md">月度净利润趋势</h3>
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <EChart option={chartOption} style={{ height: 240 }} />
              </div>
            </section>
          ) : (
            <section>
              <div className="rounded-lg border border-border bg-background/40 p-6 text-center text-[13px] text-muted-foreground">
                暂无月度交易数据 — 给该项目记录至少一笔流水后会出现折线。
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-title-md">项目流水（{projectTxs.length} 笔）</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[600px] table-fixed border-collapse text-left text-[13px]">
                <colgroup>
                  <col className="w-[110px]" />
                  <col className="w-[70px]" />
                  <col className="w-[200px]" />
                  <col className="w-[120px]" />
                  <col className="w-[110px]" />
                </colgroup>
                <thead className="bg-muted/30 text-caption-uppercase">
                  <tr>
                    <th className="px-3 py-2 font-semibold">时间</th>
                    <th className="px-3 py-2 font-semibold">类型</th>
                    <th className="px-3 py-2 font-semibold">摘要</th>
                    <th className="px-3 py-2 font-semibold">分类</th>
                    <th className="px-3 py-2 text-right font-semibold">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {projectTxs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        无相关流水
                      </td>
                    </tr>
                  )}
                  {projectTxs.map((tx) => (
                    <tr
                      key={tx.id}
                      className="cursor-pointer border-t border-border/60 hover:bg-muted/20"
                      onClick={() => onEditTransaction?.(tx)}
                    >
                      <td className="px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
                        {tx.occurredAt.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            tx.kind === "income"
                              ? "rounded border border-emerald-700/30 bg-emerald-600/10 px-1.5 py-0.5 text-[10.5px] text-emerald-800 dark:text-emerald-300"
                              : tx.kind === "expense"
                                ? "rounded border border-red-700/30 bg-red-600/10 px-1.5 py-0.5 text-[10.5px] text-red-800 dark:text-red-300"
                                : "rounded border border-blue-700/30 bg-blue-600/10 px-1.5 py-0.5 text-[10.5px] text-blue-800 dark:text-blue-300"
                          }
                        >
                          {tx.kind === "income" ? "收入" : tx.kind === "expense" ? "支出" : "转账"}
                        </span>
                      </td>
                      <td className="truncate px-3 py-2">{tx.title}</td>
                      <td className="truncate px-3 py-2 text-muted-foreground">{tx.category?.name || "—"}</td>
                      <td
                        className={`px-3 py-2 text-right font-serif tabular-nums ${
                          tx.kind === "income" ? "text-emerald-800" : tx.kind === "expense" ? "text-red-700" : "text-blue-800"
                        }`}
                      >
                        {tx.kind === "expense" ? "−" : tx.kind === "income" ? "+" : ""}
                        ¥{tx.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </aside>

      <AlertDialog
        open={exportError !== null}
        title="PDF 导出失败"
        description={exportError}
        confirmLabel="知道了"
        onConfirm={() => setExportError(null)}
      />
    </div>,
    document.body,
  );
}

function PLKpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "neutral" | "good" | "warn";
}) {
  const valueClass = {
    neutral: "text-foreground",
    good: "text-emerald-700 dark:text-emerald-300",
    warn: "text-destructive",
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className={`mt-1 font-serif text-[18px] tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function buildMonthlyTrend(txs: Transaction[]) {
  const buckets = new Map<string, number>();
  for (const tx of txs) {
    const key = (tx.occurredAt || "").slice(0, 7);
    if (!key) continue;
    const current = buckets.get(key) || 0;
    const delta = tx.kind === "income" ? tx.amount : tx.kind === "expense" ? -tx.amount : 0;
    buckets.set(key, current + delta);
  }
  const labels = Array.from(buckets.keys()).sort();
  return {
    labels: labels.map((m) => m.replace("-", "/")),
    profit: labels.map((m) => Number((buckets.get(m) || 0).toFixed(2))),
  };
}
