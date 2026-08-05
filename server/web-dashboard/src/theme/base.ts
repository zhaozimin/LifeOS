/**
 * [INPUT]: 依赖各 palette 分片的 ThemeSpec。
 * [OUTPUT]: 提供主题类型、token 派生和 makeTheme。
 * [POS]: theme 的无数据核心；主题色值必须位于 palettes/。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * [INPUT]: 依赖浏览器 CSS 自定义属性与 TimeOS 主题选择状态。
 * [OUTPUT]: 对外提供 70+ 主题注册表、主题类型、查找与向根节点应用 token 的函数。
 * [POS]: web-dashboard 的视觉主题真源；ThemeProvider 和图表派生桥共同消费，不包含业务颜色映射。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

/**
 * 主题色板注册表 — 每个主题包含亮 / 暗两套设计 token + ECharts 系列色 + 字体覆盖。
 *
 * 添加新主题：在 PALETTES 数组里 push 一个 makeTheme({...})，把 light / dark 的核心色填上即可。
 * 由 ThemeProvider 在运行时把 token 写到 <html> 上。
 */

export type ThemePaletteId =
  | "claude"
  | "apple"
  | "cursor"
  | "linear"
  | "notion"
  | "stripe"
  | "vercel"
  | "figma"
  | "framer"
  | "supabase"
  | "posthog"
  | "raycast"
  | "sentry"
  | "slack"
  | "intercom"
  | "mintlify"
  | "tesla"
  | "nvidia"
  | "mongodb"
  | "webflow"
  | "replicate"
  | "cohere"
  | "mistral"
  | "xai"
  | "together"
  | "opencode"
  | "ollama"
  | "voltagent"
  | "runway"
  | "elevenlabs"
  | "minimax"
  | "coinbase"
  | "kraken"
  | "binance"
  | "mastercard"
  | "revolut"
  | "wise"
  | "shopify"
  | "uber"
  | "zapier"
  | "airbnb"
  | "airtable"
  | "hashicorp"
  | "ibm"
  | "miro"
  | "expo"
  | "cal"
  | "clickhouse"
  | "sanity"
  | "composio"
  | "lovable"
  | "bmw"
  | "bmwm"
  | "bugatti"
  | "ferrari"
  | "lamborghini"
  | "renault"
  | "meta"
  | "spacex"
  | "playstation"
  | "nike"
  | "pinterest"
  | "spotify"
  | "starbucks"
  | "superhuman"
  | "theverge"
  | "wired"
  | "warp"
  | "vodafone"
  | "resend"
  | "clay";

interface CssTokens {
  // —— shadcn 基础 ——
  "--background": string;
  "--foreground": string;
  "--card": string;
  "--card-foreground": string;
  "--popover": string;
  "--popover-foreground": string;
  "--primary": string;
  "--primary-foreground": string;
  "--secondary": string;
  "--secondary-foreground": string;
  "--muted": string;
  "--muted-foreground": string;
  "--accent": string;
  "--accent-foreground": string;
  "--destructive": string;
  "--destructive-foreground": string;
  "--warning": string;
  "--success": string;
  "--border": string;
  "--input": string;
  "--ring": string;
  // —— 侧边栏 ——
  "--sidebar": string;
  "--sidebar-foreground": string;
  "--sidebar-primary": string;
  "--sidebar-primary-foreground": string;
  "--sidebar-accent": string;
  "--sidebar-accent-foreground": string;
  "--sidebar-border": string;
  // —— 品牌点缀 ——
  "--brand-red": string;
  "--brand-coral": string;
  "--brand-sand": string;
  "--brand-sage": string;
  "--brand-blue": string;
  "--brand-violet": string;
  "--brand-ink": string;
  // —— 图表系列 ——
  "--chart-1": string;
  "--chart-2": string;
  "--chart-3": string;
  "--chart-4": string;
  "--chart-5": string;
  // —— 字体 ——
  "--font-sans": string;
  "--font-serif": string;
  "--font-mono": string;
  // —— 主题特异 token ——
  "--display-letter-spacing": string;
  "--display-font-weight": string;
}

export interface ThemePalette {
  id: ThemePaletteId;
  name: string;
  description: string;
  swatch: { canvas: string; accent: string; ink: string };
  metaThemeColor: { light: string; dark: string };
  series: { light: string[]; dark: string[] };
  light: CssTokens;
  dark: CssTokens;
}

// —— 简化 spec 形式（每个主题只填核心色，由 makeTheme 派生完整 token） ——

interface ColorSpec {
  bg: string;
  fg: string;
  body?: string;
  card?: string;
  cardFg?: string;
  popover?: string;
  primary: string;
  onPrimary: string;
  secondary?: string;
  secondaryFg?: string;
  muted?: string;
  mutedFg: string;
  accent?: string;
  accentFg?: string;
  destructive?: string;
  onDestructive?: string;
  warning?: string;
  success?: string;
  border: string;
  input?: string;
  ring?: string;
  sidebar?: string;
  sidebarFg?: string;
  sidebarBorder?: string;
  series: string[];
}

export interface ThemeSpec {
  id: ThemePaletteId;
  name: string;
  description: string;
  fontSans: string;
  fontSerif?: string;
  fontMono?: string;
  displayLetterSpacing?: string;
  displayFontWeight?: string;
  light: ColorSpec;
  dark: ColorSpec;
}

export const FONT_MONO_DEFAULT =
  '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace';

function tokensFromSpec(spec: ThemeSpec, mode: "light" | "dark"): CssTokens {
  const c = spec[mode];
  const card = c.card ?? c.bg;
  const cardFg = c.cardFg ?? c.fg;
  const popover = c.popover ?? card;
  const muted = c.muted ?? c.secondary ?? card;
  const secondary = c.secondary ?? muted;
  const secondaryFg = c.secondaryFg ?? c.fg;
  const accent = c.accent ?? muted;
  const accentFg = c.accentFg ?? c.fg;
  const destructive = c.destructive ?? (mode === "dark" ? "#ff6b6b" : "#c64545");
  const onDestructive = c.onDestructive ?? "#ffffff";
  const warning = c.warning ?? (mode === "dark" ? "#ffb547" : "#d4a017");
  const success = c.success ?? (mode === "dark" ? "#7ee0a3" : "#15a84d");
  const ring = c.ring ?? c.primary;
  const input = c.input ?? c.border;
  const sidebar = c.sidebar ?? card;
  const sidebarFg = c.sidebarFg ?? cardFg;
  const sidebarBorder = c.sidebarBorder ?? c.border;
  const series = c.series;
  void c.body; // 当前尚未映射到独立 CSS var

  return {
    "--background": c.bg,
    "--foreground": c.fg,
    "--card": card,
    "--card-foreground": cardFg,
    "--popover": popover,
    "--popover-foreground": cardFg,
    "--primary": c.primary,
    "--primary-foreground": c.onPrimary,
    "--secondary": secondary,
    "--secondary-foreground": secondaryFg,
    "--muted": muted,
    "--muted-foreground": c.mutedFg,
    "--accent": accent,
    "--accent-foreground": accentFg,
    "--destructive": destructive,
    "--destructive-foreground": onDestructive,
    "--warning": warning,
    "--success": success,
    "--border": c.border,
    "--input": input,
    "--ring": ring,
    "--sidebar": sidebar,
    "--sidebar-foreground": sidebarFg,
    "--sidebar-primary": c.primary,
    "--sidebar-primary-foreground": c.onPrimary,
    "--sidebar-accent": accent,
    "--sidebar-accent-foreground": accentFg,
    "--sidebar-border": sidebarBorder,
    "--brand-red": destructive,
    "--brand-coral": series[0] || c.primary,
    "--brand-sand": c.bg,
    "--brand-sage": success,
    "--brand-blue": series[1] || c.primary,
    "--brand-violet": series[2] || c.primary,
    "--brand-ink": c.fg,
    "--chart-1": series[0] || c.primary,
    "--chart-2": series[1] || c.primary,
    "--chart-3": series[2] || c.primary,
    "--chart-4": series[3] || c.primary,
    "--chart-5": series[4] || c.primary,
    "--font-sans": spec.fontSans,
    "--font-serif": spec.fontSerif ?? spec.fontSans,
    "--font-mono": spec.fontMono ?? FONT_MONO_DEFAULT,
    "--display-letter-spacing": spec.displayLetterSpacing ?? "0",
    "--display-font-weight": spec.displayFontWeight ?? "600",
  };
}

export function makeTheme(spec: ThemeSpec): ThemePalette {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    swatch: { canvas: spec.light.bg, accent: spec.light.primary, ink: spec.light.fg },
    metaThemeColor: { light: spec.light.bg, dark: spec.dark.bg },
    series: { light: spec.light.series, dark: spec.dark.series },
    light: tokensFromSpec(spec, "light"),
    dark: tokensFromSpec(spec, "dark"),
  };
}

// —— 共享字体栈 ——

export const FONT_INTER =
  '"Inter", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_SERIF_BASKERVILLE =
  'Baskerville, "Times New Roman", "Source Han Serif SC", "Noto Serif SC", Georgia, serif';
export const FONT_SF =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Inter, "PingFang SC", system-ui, sans-serif';
export const FONT_GEIST =
  '"Geist", "Inter", -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", system-ui, sans-serif';
export const FONT_GEIST_MONO =
  '"Geist Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace';
export const FONT_INTER_VARIABLE =
  '"Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", system-ui, sans-serif';

// —— 主题清单 ——

