/**
 * [INPUT]: 依赖可取消的 summary/configuration API、Layout 软刷新信号、App 注入的服务端记录时区、stats 筛选状态机、nature 主题色映射与 EChart 壳。
 * [OUTPUT]: 对外提供刷新不改筛选、进行中范围逐分钟更新的今日/本周/本月/自定义统计、KPI 与图表。
 * [POS]: pages 的可独立滚动聚合视图；最后一次请求独占写入权，图表只渲染同一范围的服务端统计结果。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { BarChart3, BriefcaseBusiness, Clock3, Layers3 } from "lucide-react";
import type { EChartsOption } from "echarts";
import { api, isAbortError } from "../api/client";
import { isoDate, isoMinute, rangeForStatsMode, recordNow, selectStatsMode } from "../lib/dates";
import type { StatsSelection } from "../lib/dates";
import { formatMinutes, NATURE_LABEL, NATURE_ORDER, readNatureColors } from "../lib/nature";
import { EChart } from "../components/charts/EChart";
import { useThemeStore } from "../store/theme";
import type { RangeSummary } from "../types";
import { Card } from "../components/ui/Card";
import { KPICard } from "../components/ui/KPICard";
import type { LayoutOutletContext } from "../components/Layout";

export function StatsPage({ recordTimeZone }: { recordTimeZone: string }) {
  const { refreshKey } = useOutletContext<LayoutOutletContext>();
  const [tick, setTick] = useState(() => recordNow(recordTimeZone));
  const today = isoDate(tick);
  const [weekStart, setWeekStart] = useState<"monday" | "sunday">("monday");
  const [selection, setSelection] = useState<StatsSelection>(() => (
    selectStatsMode("week", today, "monday", [today, today])
  ));
  const { mode, range } = selection;
  const [summary, setSummary] = useState<RangeSummary | null>(null);
  const [measure, setMeasure] = useState<"grossMinutes" | "pureMinutes">("pureMinutes");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const resolved = useThemeStore((state) => state.resolved);
  const paletteId = useThemeStore((state) => state.palette);
  const [natureColors, setNatureColors] = useState(() => readNatureColors());
  const configurationGeneration = useRef(0);
  const summaryGeneration = useRef(0);

  useEffect(() => {
    setTick(recordNow(recordTimeZone));
    const timer = window.setInterval(() => setTick(recordNow(recordTimeZone)), 60_000);
    return () => window.clearInterval(timer);
  }, [recordTimeZone]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setNatureColors(readNatureColors()));
    return () => window.cancelAnimationFrame(frame);
  }, [resolved, paletteId]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++configurationGeneration.current;
    void api.configuration({ signal: controller.signal })
      .then((config) => {
        if (generation === configurationGeneration.current) setWeekStart(config.settings.weekStart);
      })
      .catch((caught) => {
        if (!isAbortError(caught) && generation === configurationGeneration.current) {
          setError(caught instanceof Error ? caught.message : "统计配置加载失败。");
        }
      });
    return () => controller.abort();
  }, [recordTimeZone, refreshKey]);

  useEffect(() => {
    setSelection((current) => {
      const nextRange = rangeForStatsMode(current.mode, today, weekStart, current.range);
      if (nextRange[0] === current.range[0] && nextRange[1] === current.range[1]) return current;
      return { ...current, range: nextRange };
    });
  }, [today, weekStart]);

  const liveMinute = range[0] <= today && today <= range[1] ? isoMinute(tick) : "";
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++summaryGeneration.current;
    setLoading(true);
    setError("");
    void api.summary(range[0], range[1], { signal: controller.signal })
      .then((nextSummary) => {
        if (generation === summaryGeneration.current) setSummary(nextSummary);
      })
      .catch((caught) => {
        if (!isAbortError(caught) && generation === summaryGeneration.current) {
          setError(caught instanceof Error ? caught.message : "统计加载失败。");
        }
      })
      .finally(() => {
        if (generation === summaryGeneration.current) setLoading(false);
      });
    return () => controller.abort();
  }, [liveMinute, range, refreshKey]);

  const choose = (next: StatsSelection["mode"]) => {
    setSelection((current) => selectStatsMode(next, today, weekStart, current.range));
  };

  const natureOption = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: "item", valueFormatter: (value) => formatMinutes(Number(value)) },
    legend: { bottom: 0 },
    series: [{
      type: "pie", radius: ["48%", "72%"], center: ["50%", "43%"],
      label: { formatter: "{b}\n{d}%" },
      data: NATURE_ORDER.map((nature) => ({
        name: NATURE_LABEL[nature],
        value: summary?.byNature.find((row) => row.nature === nature)?.[measure] || 0,
        itemStyle: { color: natureColors[nature] },
      })),
    }],
  }), [summary, measure, natureColors]);

  const categoryOption = useMemo<EChartsOption>(() => {
    const data = [...(summary?.byCategory || [])].slice(0, 12).reverse();
    return {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value) => formatMinutes(Number(value)) },
      grid: { left: 86, right: 28, top: 14, bottom: 28 },
      xAxis: { type: "value", axisLabel: { formatter: (value: number) => formatMinutes(value) } },
      yAxis: { type: "category", data: data.map((row) => row.name), axisLabel: { width: 74, overflow: "truncate" } },
      series: [{ type: "bar", data: data.map((row) => ({ value: row[measure], itemStyle: { color: natureColors[row.nature] } })), barMaxWidth: 22, borderRadius: [0, 5, 5, 0] }],
    };
  }, [summary, measure, natureColors]);

  const lineOption = useMemo<EChartsOption>(() => ({
    tooltip: { trigger: "axis", valueFormatter: (value) => formatMinutes(Number(value)) },
    grid: { left: 54, right: 24, top: 24, bottom: 42 },
    xAxis: { type: "category", data: summary?.days.map((day) => day.date.slice(5)) || [], axisLabel: { rotate: (summary?.days.length || 0) > 14 ? 35 : 0 } },
    yAxis: { type: "value", axisLabel: { formatter: (value: number) => formatMinutes(value) } },
    series: [{ type: "line", smooth: true, symbolSize: 7, data: summary?.days.map((day) => day.effectiveWorkMinutes) || [], lineStyle: { width: 3, color: natureColors.core }, itemStyle: { color: natureColors.core }, areaStyle: { color: natureColors.core, opacity: 0.1 } }],
  }), [summary, natureColors]);

  return <div className="h-full overflow-y-auto pb-6">
    <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="text-xs font-semibold tracking-widest text-muted-foreground">STATISTICS</p><h1 className="serif mt-1 text-3xl">时间统计</h1><p className="mt-1 text-sm text-muted-foreground">{range[0]} 至 {range[1]}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        {(["today", "week", "month", "custom"] as StatsSelection["mode"][]).map((item) => <button key={item} type="button" onClick={() => choose(item)} className={`h-9 rounded-md border px-3 text-sm ${mode === item ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}>{{ today: "今日", week: "本周", month: "本月", custom: "自定义" }[item]}</button>)}
      </div>
    </div>
    {mode === "custom" && <Card className="flex flex-wrap items-center gap-3 p-4"><label className="text-sm">从 <input type="date" value={range[0]} onChange={(event) => setSelection((current) => ({ ...current, range: [event.target.value, current.range[1]] }))} className="ml-2 h-9 rounded-md border border-border bg-background px-2" /></label><label className="text-sm">到 <input type="date" value={range[1]} onChange={(event) => setSelection((current) => ({ ...current, range: [current.range[0], event.target.value] }))} className="ml-2 h-9 rounded-md border border-border bg-background px-2" /></label></Card>}
    {error && <div className="rounded-lg border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive">{error}</div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KPICard label="有效工作时间" value={formatMinutes(summary?.effectiveWorkMinutes || 0)} helper="核心创作纯时间" emphasis="primary" icon={<Clock3 size={17} />} />
      <KPICard label="工作总时间" value={formatMinutes(summary?.grossWorkMinutes || 0)} helper="核心创作 + 事务支撑毛时间" icon={<BriefcaseBusiness size={17} />} />
      <KPICard label="覆盖率" value={`${((summary?.coverage || 0) * 100).toFixed(1)}%`} helper={`${formatMinutes(summary?.recordedMinutes || 0)} 已记录`} icon={<Layers3 size={17} />} />
      <KPICard label="扣除时间" value={formatMinutes(summary?.deductionMinutes || 0)} helper="记录内未投入主活动的时间" emphasis="subtle" icon={<BarChart3 size={17} />} />
    </div>
    <div className="flex justify-end gap-1"><button type="button" onClick={() => setMeasure("grossMinutes")} className={`rounded-md px-3 py-1.5 text-xs ${measure === "grossMinutes" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>毛时间</button><button type="button" onClick={() => setMeasure("pureMinutes")} className={`rounded-md px-3 py-1.5 text-xs ${measure === "pureMinutes" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>纯时间</button></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5"><h2 className="serif text-xl">性质分布</h2><p className="mt-1 text-xs text-muted-foreground">固定四类 · {measure === "pureMinutes" ? "纯时间" : "毛时间"}</p><EChart option={natureOption} className="mt-3 h-[340px]" /></Card>
      <Card className="p-5"><h2 className="serif text-xl">分类分布</h2><p className="mt-1 text-xs text-muted-foreground">按写入时的分类快照汇总</p><EChart option={categoryOption} className="mt-3 h-[340px]" /></Card>
    </div>
    <Card className="p-5"><h2 className="serif text-xl">逐日有效工作时间</h2><p className="mt-1 text-xs text-muted-foreground">每日 core 纯时间</p><EChart option={lineOption} className="mt-3 h-[330px]" /></Card>
    {loading && <p className="text-center text-sm text-muted-foreground">正在读取本地统计…</p>}
    </div>
  </div>;
}
