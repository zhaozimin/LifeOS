import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { getPalette } from "./theme";
import { useThemeStore } from "../../store/theme";

interface Props {
  months: string[];
  income: number[];
  expense: number[];
  height?: number;
}

export function TrendLineChart({ months, income, expense, height = 320 }: Props) {
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);

  if (!months.length) return <div className="empty-state">暂无趋势数据</div>;

  const option: EChartsOption = {
    grid: { top: 36, bottom: 30, left: 56, right: 24 },
    legend: {
      top: 0,
      right: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: palette.muted, fontSize: 12 },
    },
    xAxis: {
      type: "category",
      data: months,
      axisLine: { lineStyle: { color: palette.hairline } },
      axisTick: { show: false },
      axisLabel: { color: palette.muted, fontSize: 11 },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: palette.muted,
        formatter: (v: number) => `¥${(v / 10000).toFixed(0)}万`,
      },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: palette.hairline, type: "dashed" } },
    },
    tooltip: {
      trigger: "axis",
      formatter: ((params: any) => {
        const arr = Array.isArray(params) ? params : [params];
        const lines = arr
          .map((p: any) => {
            const v = Number(p.value || 0);
            return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}: <b>¥${v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}</b>`;
          })
          .join("<br/>");
        return `${arr[0]?.axisValue || ""}<br/>${lines}`;
      }) as any,
    },
    series: [
      {
        name: "收入",
        type: "line",
        data: income,
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2, color: palette.brandBlue },
        itemStyle: { color: palette.brandBlue },
        areaStyle: { color: "rgba(61, 153, 255, 0.12)" },
      },
      {
        name: "支出",
        type: "line",
        data: expense,
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { width: 2, color: palette.brandOrange },
        itemStyle: { color: palette.brandOrange },
        areaStyle: { color: "rgba(242, 154, 98, 0.12)" },
      },
    ],
  };

  return <EChart option={option} style={{ width: "100%", height }} />;
}
