/**
 * ECharts 主题 — 由 themes.ts 注册表自动派生，所有 palette 通用。
 * EChart 组件按 themeName 重建实例切换主题。
 */
import * as echarts from "echarts/core";
import { getPalette as getThemePalette, type ThemePaletteId } from "../../../theme";

export interface ChartPalette {
  bg: string;
  fg: string;
  body: string;
  muted: string;
  hairline: string;
  brandOrange: string;
  brandApricot: string;
  brandCream: string;
  brandViolet: string;
  brandBlueViolet: string;
  brandBlue: string;
  success: string;
}

export type ChartThemeName = `${ThemePaletteId}-${"light" | "dark"}`;

const registered = new Set<ChartThemeName>();
const paletteCache = new Map<ChartThemeName, ChartPalette>();

export function chartThemeName(palette: ThemePaletteId, resolved: "light" | "dark"): ChartThemeName {
  return `${palette}-${resolved}` as ChartThemeName;
}

function deriveChartPalette(palette: ThemePaletteId, isDark: boolean): ChartPalette {
  const name = chartThemeName(palette, isDark ? "dark" : "light") as ChartThemeName;
  const cached = paletteCache.get(name);
  if (cached) return cached;

  const theme = getThemePalette(palette);
  const tokens = isDark ? theme.dark : theme.light;
  const series = theme.series[isDark ? "dark" : "light"];

  const result: ChartPalette = {
    bg: tokens["--background"],
    fg: tokens["--foreground"],
    body: tokens["--muted-foreground"],
    muted: tokens["--muted-foreground"],
    hairline: tokens["--border"],
    brandOrange: series[0] || tokens["--primary"],
    brandApricot: series[4] || series[0] || tokens["--primary"],
    brandCream: tokens["--muted"],
    brandViolet: series[2] || series[0] || tokens["--primary"],
    brandBlueViolet: series[3] || series[0] || tokens["--primary"],
    brandBlue: series[1] || series[0] || tokens["--primary"],
    success: tokens["--success"],
  };

  paletteCache.set(name, result);
  return result;
}

export function ensureChartTheme(name: ChartThemeName) {
  if (registered.has(name)) return;
  const dashIdx = name.lastIndexOf("-");
  const paletteId = name.slice(0, dashIdx) as ThemePaletteId;
  const isDark = name.slice(dashIdx + 1) === "dark";
  const palette = deriveChartPalette(paletteId, isDark);
  const theme = getThemePalette(paletteId);
  const seriesPalette = theme.series[isDark ? "dark" : "light"];
  const tokens = isDark ? theme.dark : theme.light;

  const baseTextStyle = {
    fontFamily: tokens["--font-sans"],
    color: palette.body,
  };

  echarts.registerTheme(name, {
    color: seriesPalette,
    backgroundColor: "transparent",
    textStyle: baseTextStyle,
    title: {
      textStyle: { ...baseTextStyle, color: palette.fg },
      subtextStyle: { ...baseTextStyle, color: palette.muted },
    },
    legend: { textStyle: baseTextStyle },
    tooltip: {
      backgroundColor: tokens["--popover"],
      borderColor: palette.hairline,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { ...baseTextStyle, color: palette.fg },
      extraCssText: isDark
        ? "box-shadow: 0 8px 24px rgba(0,0,0,0.4); border-radius: 8px;"
        : "box-shadow: 0 8px 24px rgba(20,20,19,0.08); border-radius: 8px;",
    },
  });

  registered.add(name);
}

export function getPalette(isDark: boolean, palette: ThemePaletteId = "claude"): ChartPalette {
  return deriveChartPalette(palette, isDark);
}

export function getSeriesPalette(isDark: boolean, palette: ThemePaletteId = "claude"): string[] {
  return getThemePalette(palette).series[isDark ? "dark" : "light"];
}

// 旧 API 兼容
export function ensureClaudeTheme(name: ChartThemeName = "claude-light" as ChartThemeName) {
  ensureChartTheme(name);
}

export const lightPalette = deriveChartPalette("claude", false);
export const darkPalette = deriveChartPalette("claude", true);
export const seriesPaletteLight = getThemePalette("claude").series.light;
export const seriesPaletteDark = getThemePalette("claude").series.dark;
