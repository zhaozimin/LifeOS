/**
 * [INPUT]: 依赖 charts/EChart 壳与 charts/theme 语义色、store/theme 当前主题、
 *   lib/reimbursement 的状态元数据与 isReimbursable 判定。
 * [OUTPUT]: 对外提供 ReimbursementPieCard —— 报销进度扇形图（待报销/已提交/已报销/已驳回），
 *   点击扇区回调对应状态的流水列表。
 * [POS]: OverviewPage 的 reimbursement-pie widget 主体；只统计 reimbursementStatus ≠ notApplicable
 *   的支出。空态由父级 renderer 处理，本组件假定有数据。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "./charts/EChart";
import { useThemeStore } from "../store/theme";
import { getPalette } from "./charts/theme";
import { formatCurrency } from "../lib/format";
import { REIMBURSEMENT_STATUS_META, isReimbursable } from "../lib/reimbursement";
import type { ReimbursementStatus, Transaction } from "../types";

export function ReimbursementPieCard({
  transactions,
  onSelect,
}: {
  transactions: Transaction[];
  onSelect: (status: ReimbursementStatus, label: string, items: Transaction[]) => void;
}) {
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);

  const groups = useMemo(() => {
    const map = new Map<ReimbursementStatus, Transaction[]>();
    for (const meta of REIMBURSEMENT_STATUS_META) map.set(meta.value, []);
    for (const tx of transactions) {
      if (!isReimbursable(tx)) continue;
      map.get(tx.reimbursementStatus)?.push(tx);
    }
    return map;
  }, [transactions]);

  const statusColor: Record<ReimbursementStatus, string> = {
    draft: palette.brandOrange,
    submitted: palette.brandBlue,
    reimbursed: palette.success,
    rejected: palette.muted,
    notApplicable: palette.muted,
  };

  const slices = REIMBURSEMENT_STATUS_META.map((meta) => {
    const items = groups.get(meta.value) || [];
    return { meta, items, total: items.reduce((sum, tx) => sum + tx.amount, 0) };
  }).filter((slice) => slice.items.length > 0);

  const pendingTotal = slices
    .filter((slice) => slice.meta.value === "draft" || slice.meta.value === "submitted")
    .reduce((sum, slice) => sum + slice.total, 0);
  const reimbursedTotal = slices.find((slice) => slice.meta.value === "reimbursed")?.total || 0;

  const option: EChartsOption = {
    tooltip: {
      trigger: "item",
      formatter: (params) => {
        const p = params as { name: string; value: number; percent: number; dataIndex: number };
        const slice = slices[p.dataIndex];
        return `${p.name}<br/>${formatCurrency(p.value)} · ${slice?.items.length || 0} 笔 (${p.percent}%)`;
      },
    },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 9,
      itemHeight: 9,
      textStyle: { color: palette.body, fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["44%", "70%"],
        center: ["50%", "44%"],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 5, borderColor: palette.bg, borderWidth: 2 },
        label: {
          color: palette.body,
          fontSize: 11.5,
          formatter: (params) => `${params.name}\n${formatCurrency(Number(params.value))}`,
        },
        emphasis: { scaleSize: 4 },
        data: slices.map((slice) => ({
          name: slice.meta.label,
          value: Math.round(slice.total * 100) / 100,
          itemStyle: { color: statusColor[slice.meta.value] },
        })),
      },
    ],
  };

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1">
        <span className="text-[12.5px] text-muted-foreground">
          待回款 <span className="text-display-sm text-foreground">{formatCurrency(pendingTotal)}</span>
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          已报销 <span className="font-medium text-foreground">{formatCurrency(reimbursedTotal)}</span>
        </span>
      </div>
      <EChart
        option={option}
        style={{ height: 260 }}
        onChartClick={(params) => {
          const name = String(params.name || "");
          const slice = slices.find((item) => item.meta.label === name);
          if (slice) onSelect(slice.meta.value, slice.meta.label, slice.items);
        }}
      />
    </div>
  );
}
