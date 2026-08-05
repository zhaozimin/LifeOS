/**
 * [INPUT]: 依赖 EChart、调色板，以及 data.ts 的三个聚合函数与轴金额格式化。
 * [OUTPUT]: 提供收入、项目与工作生活图表，以及收入曲线口径类型 AreaMode。
 * [POS]: Overview 的图表渲染层，不请求 API。图表形参一律由 data.ts 的 ReturnType 推导，
 *   聚合口径改了这里会直接编译失败——本文件不重新定义任何数据形状。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { EChartsOption } from "echarts";
import { EChart } from "../../components/charts/EChart";
import { getPalette } from "../../components/charts/theme";
import { escapeHtml } from "../../lib/format";
import { buildIncomeTrend, buildProjectCostRevenue, buildWorkLifeExpense, formatAxisCurrency } from "./data";
import type { Transaction } from "../../types";

/** 收入曲线的两种口径；类型归图表所有，页面只是把开关值传进来。 */
export type AreaMode = "income" | "net";


export function IncomeAreaChart({
  data,
  mode,
  palette,
  color,
  onSelect,
}: {
  data: ReturnType<typeof buildIncomeTrend>;
  mode: AreaMode;
  palette: ReturnType<typeof getPalette>;
  color: string;
  onSelect: (label: string, transactions: Transaction[]) => void;
}) {
  if (!data.labels.length) return <div className="empty-state">当前区间暂无收入数据。</div>;

  const option: EChartsOption = {
    tooltip: { trigger: "axis" },
    grid: { top: 28, right: 24, bottom: 36, left: 60 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: data.labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.hairline } },
      axisLabel: { color: palette.muted },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.muted, formatter: formatAxisCurrency },
      splitLine: { lineStyle: { color: palette.hairline } },
    },
    series: [
      {
        name: mode === "income" ? "区间收入" : "区间净额",
        type: "line",
        smooth: true,
        symbolSize: 8,
        data: mode === "income" ? data.income : data.net,
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${color}80` },
              { offset: 1, color: `${color}10` },
            ],
          },
        },
      },
    ],
  };

  return (
    <EChart
      option={option}
      style={{ height: 360 }}
      onChartClick={(params) => {
        const index = Number(params.dataIndex);
        const label = data.labels[index];
        if (!label) return;
        onSelect(label, mode === "income" ? data.incomeTransactions.get(label) || [] : data.allTransactions.get(label) || []);
      }}
    />
  );
}

export function ProjectBarChart({
  data,
  budgetMap,
  palette,
  costColor,
  revenueColor,
  onSelect,
}: {
  data: ReturnType<typeof buildProjectCostRevenue>;
  budgetMap: Map<string, { expectedCost: number; expectedRevenue: number }>;
  palette: ReturnType<typeof getPalette>;
  costColor: string;
  revenueColor: string;
  onSelect: (project: string, transactions: Transaction[]) => void;
}) {
  if (!data.projects.length) return <div className="empty-state">当前区间暂无项目成本与回款数据。</div>;

  const expectedCost = data.projects.map((name) => Number((budgetMap.get(name)?.expectedCost || 0).toFixed(2)));
  const expectedRevenue = data.projects.map((name) => Number((budgetMap.get(name)?.expectedRevenue || 0).toFixed(2)));
  const hasAnyBudget = expectedCost.some((v) => v > 0) || expectedRevenue.some((v) => v > 0);

  const option: EChartsOption = {
    grid: { top: 36, bottom: 52, left: 58, right: 28 },
    legend: {
      top: 0,
      right: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: palette.muted, fontSize: 12 },
      data: hasAnyBudget
        ? ["实际成本", "预算成本", "实际回款", "期望回款"]
        : ["实际成本", "实际回款"],
    },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const arr = params as Array<{ name: string; seriesName: string; value: number; dataIndex: number }>;
        if (!arr || !arr.length) return "";
        const idx = arr[0].dataIndex;
        const name = arr[0].name;
        const actualCost = data.cost[idx] || 0;
        const actualRev = data.revenue[idx] || 0;
        const budCost = expectedCost[idx] || 0;
        const budRev = expectedRevenue[idx] || 0;
        const costPercent = budCost > 0 ? `${((actualCost / budCost) * 100).toFixed(1)}%` : "—";
        const revPercent = budRev > 0 ? `${((actualRev / budRev) * 100).toFixed(1)}%` : "—";
        return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(name)}</div>
          成本：¥${actualCost.toLocaleString()} / 预算 ¥${budCost.toLocaleString()} · ${costPercent}<br/>
          回款：¥${actualRev.toLocaleString()} / 期望 ¥${budRev.toLocaleString()} · ${revPercent}`;
      },
    },
    xAxis: {
      type: "category",
      data: data.projects,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.hairline } },
      axisLabel: { color: palette.muted, interval: 0, overflow: "truncate", width: 124 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.muted, formatter: formatAxisCurrency },
      splitLine: { lineStyle: { color: palette.hairline } },
    },
    series: hasAnyBudget
      ? [
          {
            name: "实际成本",
            type: "bar",
            barGap: 0,
            barWidth: 16,
            data: data.cost,
            itemStyle: { color: costColor, borderRadius: [4, 4, 0, 0] },
          },
          {
            name: "预算成本",
            type: "bar",
            barWidth: 16,
            data: expectedCost,
            itemStyle: {
              color: "transparent",
              borderColor: costColor,
              borderWidth: 1.5,
              borderType: "dashed",
              borderRadius: [4, 4, 0, 0],
            },
          },
          {
            name: "实际回款",
            type: "bar",
            barGap: 0.4,
            barWidth: 16,
            data: data.revenue,
            itemStyle: { color: revenueColor, borderRadius: [4, 4, 0, 0] },
          },
          {
            name: "期望回款",
            type: "bar",
            barWidth: 16,
            data: expectedRevenue,
            itemStyle: {
              color: "transparent",
              borderColor: revenueColor,
              borderWidth: 1.5,
              borderType: "dashed",
              borderRadius: [4, 4, 0, 0],
            },
          },
        ]
      : [
          {
            name: "实际成本",
            type: "bar",
            barWidth: 22,
            data: data.cost,
            itemStyle: { color: costColor, borderRadius: [5, 5, 0, 0] },
          },
          {
            name: "实际回款",
            type: "bar",
            barWidth: 22,
            data: data.revenue,
            itemStyle: { color: revenueColor, borderRadius: [5, 5, 0, 0] },
          },
        ],
  };

  return (
    <EChart
      option={option}
      style={{ height: 390 }}
      onChartClick={(params) => {
        const index = Number(params.dataIndex);
        const project = data.projects[index];
        if (project) onSelect(project, data.transactions.get(project) || []);
      }}
    />
  );
}

export function WorkLifeStackedChart({
  data,
  palette,
  lifeColor,
  workColor,
  onSelect,
}: {
  data: ReturnType<typeof buildWorkLifeExpense>;
  palette: ReturnType<typeof getPalette>;
  lifeColor: string;
  workColor: string;
  onSelect: (label: string, ownership: "company" | "personal", transactions: Transaction[]) => void;
}) {
  if (!data.months.length) return <div className="empty-state">当前区间暂无支出趋势。</div>;

  const option: EChartsOption = {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: {
      bottom: 0,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: palette.muted, fontSize: 12 },
      data: ["生活支出", "工作支出"],
    },
    grid: { left: 54, right: 20, top: 20, bottom: 54 },
    xAxis: {
      type: "category",
      data: data.months,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.hairline } },
      axisLabel: { color: palette.muted },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: palette.muted, formatter: formatAxisCurrency },
      splitLine: { lineStyle: { color: palette.hairline } },
    },
    series: [
      {
        name: "生活支出",
        type: "bar",
        stack: "expense",
        data: data.life.map((value, index) => ({
          value,
          itemStyle: {
            borderRadius: data.work[index] > 0 ? [0, 0, 0, 0] : [5, 5, 0, 0],
          },
        })),
        itemStyle: { color: lifeColor },
      },
      {
        name: "工作支出",
        type: "bar",
        stack: "expense",
        data: data.work,
        itemStyle: { color: workColor, borderRadius: [5, 5, 0, 0] },
      },
    ],
  };

  return (
    <EChart
      option={option}
      style={{ height: 340 }}
      onChartClick={(params) => {
        const index = Number(params.dataIndex);
        const label = data.months[index];
        if (!label) return;
        const ownership = params.seriesName === "生活支出" ? "personal" : "company";
        const key = `${label}__${ownership}`;
        onSelect(label, ownership, data.transactions.get(key) || []);
      }}
    />
  );
}
