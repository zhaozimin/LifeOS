import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { getPalette } from "./theme";
import { useThemeStore } from "../../store/theme";

interface Props {
  projects: string[];
  cost: number[];
  revenue: number[];
  height?: number;
}

export function RoiChart({ projects, cost, revenue, height = 320 }: Props) {
  const resolved = useThemeStore((s) => s.resolved);
  const paletteId = useThemeStore((s) => s.palette);
  const palette = getPalette(resolved === "dark", paletteId);

  if (!projects.length) return <div className="empty-state">暂无项目数据</div>;

  const option: EChartsOption = {
    grid: { top: 32, bottom: 28, left: 64, right: 24 },
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
      data: projects,
      axisLine: { lineStyle: { color: palette.hairline } },
      axisTick: { show: false },
      axisLabel: { color: palette.body, fontSize: 12 },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: palette.muted,
        formatter: (v: number) => `¥${(v / 1000).toFixed(0)}k`,
      },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: palette.hairline, type: "dashed" } },
    },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    series: [
      {
        name: "收入",
        type: "bar",
        data: revenue,
        itemStyle: { color: palette.brandBlue, borderRadius: [4, 4, 0, 0] },
        barWidth: 22,
      },
      {
        name: "成本",
        type: "bar",
        data: cost,
        itemStyle: { color: palette.brandOrange, borderRadius: [4, 4, 0, 0] },
        barWidth: 22,
      },
    ],
  };

  return <EChart option={option} style={{ width: "100%", height }} />;
}
