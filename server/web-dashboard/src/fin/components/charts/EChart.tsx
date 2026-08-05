import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import {
  SankeyChart,
  SunburstChart,
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
} from "echarts/charts";
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  GraphicComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsOption } from "echarts";
import { ensureChartTheme, chartThemeName } from "./theme";
import { useThemeStore } from "../../store/theme";

echarts.use([
  SankeyChart,
  SunburstChart,
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent,
  GraphicComponent,
  CanvasRenderer,
]);

interface Props {
  option: EChartsOption;
  className?: string;
  style?: React.CSSProperties;
  notMerge?: boolean;
  onChartClick?: (params: Record<string, unknown>) => void;
}

export function EChart({ option, className, style, notMerge = true, onChartClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const resolved = useThemeStore((s) => s.resolved);
  const palette = useThemeStore((s) => s.palette);

  useEffect(() => {
    if (!containerRef.current) return;
    const themeName = chartThemeName(palette, resolved);
    ensureChartTheme(themeName);
    // 销毁旧的，按当前主题重新建 — ECharts 不支持运行时切主题
    if (instanceRef.current) {
      instanceRef.current.dispose();
    }
    instanceRef.current = echarts.init(containerRef.current, themeName, { renderer: "canvas" });
    instanceRef.current.setOption(option, { notMerge: true });

    const onResize = () => instanceRef.current?.resize();
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current);
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
    // 重要：依赖 resolved + palette，任意切换会重建图表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, palette]);

  useEffect(() => {
    instanceRef.current?.setOption(option, { notMerge });
  }, [option, notMerge]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || !onChartClick) return;
    const handler = (params: unknown) => onChartClick(params as Record<string, unknown>);
    instance.on("click", handler);
    return () => {
      // 实例可能已被外层 effect 销毁；做一次 dispose 守护
      if (!instance.isDisposed?.()) {
        instance.off("click", handler);
      }
    };
    // 重要：palette / resolved 变化时实例重建，需要重新挂 click 监听器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChartClick, resolved, palette]);

  return <div ref={containerRef} className={className} style={style} />;
}
