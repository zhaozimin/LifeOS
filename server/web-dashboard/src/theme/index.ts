/**
 * [INPUT]: 依赖 theme/base 与 8 个 palette 数据分片。
 * [OUTPUT]: 提供 LifeOS 唯一 PALETTES 注册表、查询和 CSS token 应用。
 * [POS]: 全局主题真源；时间与财务图表共同消费。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { ThemePalette, ThemePaletteId } from "./base";
import { paletteGroup01 } from "./palettes/palette-group-01";
import { paletteGroup02 } from "./palettes/palette-group-02";
import { paletteGroup03 } from "./palettes/palette-group-03";
import { paletteGroup04 } from "./palettes/palette-group-04";
import { paletteGroup05 } from "./palettes/palette-group-05";
import { paletteGroup06 } from "./palettes/palette-group-06";
import { paletteGroup07 } from "./palettes/palette-group-07";
import { paletteGroup08 } from "./palettes/palette-group-08";

export { type ThemePalette, type ThemePaletteId } from "./base";
export const PALETTES: ThemePalette[] = [
  ...paletteGroup01,
  ...paletteGroup02,
  ...paletteGroup03,
  ...paletteGroup04,
  ...paletteGroup05,
  ...paletteGroup06,
  ...paletteGroup07,
  ...paletteGroup08,
];

export function getPalette(id: ThemePaletteId): ThemePalette {
  return PALETTES.find((palette) => palette.id === id) || PALETTES[0];
}

export function applyPalette(root: HTMLElement, paletteId: ThemePaletteId, resolvedMode: "light" | "dark"): void {
  const palette = getPalette(paletteId);
  const tokens = resolvedMode === "dark" ? palette.dark : palette.light;
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
  root.dataset.palette = paletteId;
}
