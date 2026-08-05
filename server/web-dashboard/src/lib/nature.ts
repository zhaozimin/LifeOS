/**
 * [INPUT]: 依赖 TimeOS 固定 nature 枚举与 ThemeProvider 写入的跨亮暗锁色相 CSS 语义令牌。
 * [OUTPUT]: 对外提供 nature 顺序、中文名、语义/源令牌、CSS 色引用、画布可消费的实色解析及分钟格式化函数。
 * [POS]: web-dashboard 的 nature 视觉真源；业务组件依赖语义令牌而非图表序列下标，序列色与业务色彻底解耦。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { Nature } from "../types";

export const NATURE_ORDER: Nature[] = ["core", "support", "recovery", "leisure"];
export const NATURE_LABEL: Record<Nature, string> = {
  core: "核心创作",
  support: "事务支撑",
  recovery: "恢复滋养",
  leisure: "消遣",
};
export const NATURE_TOKEN: Record<Nature, `--nature-${Nature}`> = {
  core: "--nature-core",
  support: "--nature-support",
  recovery: "--nature-recovery",
  leisure: "--nature-leisure",
};
export const NATURE_SOURCE_TOKEN: Record<Nature, `--nature-${Nature}-src`> = {
  core: "--nature-core-src",
  support: "--nature-support-src",
  recovery: "--nature-recovery-src",
  leisure: "--nature-leisure-src",
};
export const NATURE_COLOR: Record<Nature, string> = Object.fromEntries(
  NATURE_ORDER.map((nature) => [nature, `var(${NATURE_TOKEN[nature]})`]),
) as Record<Nature, string>;

function readCssColor(token: string): string {
  if (typeof document === "undefined") return `var(${token})`;
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.color = `var(${token})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

export function readNatureColors(mode?: "light" | "dark"): Record<Nature, string> {
  if (typeof document === "undefined") return NATURE_COLOR;
  return Object.fromEntries(NATURE_ORDER.map((nature) => [
    nature,
    readCssColor(mode ? `${NATURE_TOKEN[nature]}-${mode}` : NATURE_TOKEN[nature]),
  ])) as Record<Nature, string>;
}

export function colorHueDegrees(color: string): number | null {
  const oklch = color.match(/oklch\([^\s]+\s+[^\s]+\s+(-?[\d.]+)/i);
  if (oklch) return normalizeHue(Number(oklch[1]));
  const rgb = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!rgb) return null;
  const [red, green, blue] = rgb.slice(1, 4).map((value) => srgbToLinear(Number(value) / 255));
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return normalizeHue(Math.atan2(b, a) * 180 / Math.PI);
}

export function hueDistance(left: number, right: number): number {
  const difference = Math.abs(normalizeHue(left) - normalizeHue(right));
  return Math.min(difference, 360 - difference);
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function formatMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}
