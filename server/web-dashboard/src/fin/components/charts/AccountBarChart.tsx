import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { getPalette } from "./theme";
import { useThemeStore } from "../../store/theme";
import { escapeHtml } from "../../lib/format";

interface Props {
  data: Array<{ name: string; amount: number; color?: string }>;
  height?: number;
}

export function AccountBarChart({ data, height = 320 }: Props) {
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);

  if (!data.length) {
    return <div className="empty-state">暂无账户数据</div>;
  }

  const sorted = [...data].sort((a, b) => b.amount - a.amount).slice(0, 10);

  const option: EChartsOption = {
    grid: { top: 16, bottom: 24, left: 100, right: 56 },
    xAxis: {
      type: "value",
      axisLabel: {
        color: palette.muted,
        formatter: (value: number) => `¥${(value / 10000).toFixed(0)}万`,
      },
      axisLine: { lineStyle: { color: palette.hairline } },
      splitLine: { lineStyle: { color: palette.hairline, type: "dashed" } },
    },
    yAxis: {
      type: "category",
      data: sorted.map((d) => d.name),
      axisLabel: { color: palette.body, fontWeight: 500 },
      axisLine: { lineStyle: { color: palette.hairline } },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: ((params: any) => {
        const arr = Array.isArray(params) ? params : [params];
        const item = arr[0];
        const value = Number(item?.value || 0);
        return `${escapeHtml(item?.name)}<br/><b>¥${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</b>`;
      }) as any,
    },
    series: [
      {
        type: "bar",
        data: sorted.map((d) => ({
          value: d.amount,
          itemStyle: {
            color: d.color || palette.brandOrange,
            borderRadius: [0, 6, 6, 0],
          },
        })),
        barWidth: 18,
        label: {
          show: true,
          position: "right",
          color: palette.body,
          fontFamily: "'Inter', sans-serif",
          fontSize: 11,
          formatter: ((params: any) => {
            const v = Number(params.value || 0);
            return `¥${v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
          }) as any,
        },
      },
    ],
  };

  return <EChart option={option} style={{ width: "100%", height }} />;
}
