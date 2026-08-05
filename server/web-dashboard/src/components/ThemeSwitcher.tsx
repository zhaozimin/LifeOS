/**
 * [INPUT]: 依赖主题 store、完整主题注册表、lucide 图标和 clsx。
 * [OUTPUT]: 对外提供紧凑或完整的亮暗/主题选择器。
 * [POS]: components 的全局主题交互入口；只在顶栏出现，避免设置页重复展示外观控制。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Sun, Moon, Monitor, Palette, Check, Search } from "lucide-react";
import clsx from "clsx";
import { useThemeStore, type ThemePref } from "../store/theme";
import { PALETTES } from "../theme";

const MODE_OPTIONS: Array<{ value: ThemePref; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "亮色", Icon: Sun },
  { value: "dark", label: "暗色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
];

type ThemeGroup = "ai" | "dev" | "finance" | "auto" | "design" | "other";

// 基于主题 name 推断 group。新加主题会自动落入 'other' 或匹配关键词。
const GROUP_KEYWORDS: Record<ThemeGroup, string[]> = {
  ai: ["claude", "opencode", "cohere", "mistral", "xai", "together", "minimax", "replicate", "ollama", "voltagent", "elevenlabs", "composio", "lovable"],
  dev: ["cursor", "linear", "vercel", "figma", "framer", "supabase", "posthog", "raycast", "sentry", "mongodb", "webflow", "mintlify", "clickhouse", "sanity", "resend", "cal.com", "expo", "hashicorp", "airtable", "zapier", "ibm", "github"],
  finance: ["stripe", "coinbase", "kraken", "binance", "mastercard", "revolut", "wise", "robinhood"],
  auto: ["bmw", "bugatti", "ferrari", "lamborghini", "renault", "tesla", "nvidia"],
  design: ["apple", "notion", "slack", "intercom", "shopify", "uber", "airbnb", "miro", "meta", "spacex", "playstation", "nike", "pinterest", "spotify", "starbucks", "superhuman", "verge", "wired", "runway", "warp", "clay", "vodafone"],
  other: [],
};

const GROUP_ORDER: ThemeGroup[] = ["ai", "dev", "design", "finance", "auto", "other"];
const GROUP_LABEL: Record<ThemeGroup, string> = {
  ai: "AI",
  dev: "开发者工具",
  design: "设计 / 品牌",
  finance: "金融",
  auto: "汽车",
  other: "其他",
};

function inferGroup(name: string): ThemeGroup {
  const lower = name.toLowerCase();
  for (const g of GROUP_ORDER) {
    if (g === "other") continue;
    for (const kw of GROUP_KEYWORDS[g]) {
      if (lower.includes(kw)) return g;
    }
  }
  return "other";
}

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const palette = useThemeStore((s) => s.palette);
  const setPalette = useThemeStore((s) => s.setPalette);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<ThemeGroup | "all">("all");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const map = new Map<ThemeGroup, typeof PALETTES>();
    for (const g of GROUP_ORDER) map.set(g, [] as typeof PALETTES);
    for (const p of PALETTES) {
      const g = inferGroup(p.name);
      map.get(g)!.push(p);
    }
    return map;
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groupsToShow = activeGroup === "all" ? GROUP_ORDER : [activeGroup];
    return groupsToShow
      .map((g) => ({
        group: g,
        items: (grouped.get(g) || []).filter((p) =>
          !needle ||
          p.name.toLowerCase().includes(needle) ||
          p.description.toLowerCase().includes(needle),
        ),
      }))
      .filter((entry) => entry.items.length > 0);
  }, [query, activeGroup, grouped]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveGroup("all");
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="主题"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "inline-flex items-center justify-center rounded-md border border-border bg-card/70 text-foreground transition-colors hover:bg-accent",
          compact ? "h-9 w-9" : "h-9 px-3 gap-2",
        )}
      >
        <Palette size={16} strokeWidth={2} />
        {!compact && <span className="text-[13px] font-medium">主题</span>}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="主题设置"
          className="absolute right-0 top-full z-50 mt-2 w-[340px] rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl"
        >
          <div className="border-b border-border px-4 py-3">
            <div className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
              外观
            </div>
            <div
              role="radiogroup"
              aria-label="亮暗"
              className="relative mt-2 grid grid-cols-3 rounded-md border border-border bg-card/60 p-1"
            >
              {MODE_OPTIONS.map((opt) => {
                const active = preference === opt.value;
                return (
                  <button
                    key={opt.value}
                    role="radio"
                    aria-checked={active}
                    type="button"
                    title={opt.label}
                    onClick={() => setPreference(opt.value)}
                    className={clsx(
                      "inline-flex h-8 items-center justify-center gap-1.5 rounded-sm text-[12px] font-medium transition-colors",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent",
                    )}
                  >
                    <opt.Icon size={12} strokeWidth={2.2} />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
                主题
              </div>
              <div className="text-[10.5px] tabular-nums text-muted-foreground/70">
                {PALETTES.length} 套
              </div>
            </div>

            {/* 搜索框 */}
            <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
              <Search size={13} className="text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索主题名 / 描述..."
                className="flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/50"
              />
            </div>

            {/* 分类 chip */}
            <div className="mt-2 flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setActiveGroup("all")}
                className={clsx(
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                  activeGroup === "all"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background/40 text-muted-foreground hover:border-border/80",
                )}
              >
                全部 · {PALETTES.length}
              </button>
              {GROUP_ORDER.map((g) => {
                const count = (grouped.get(g) || []).length;
                if (count === 0) return null;
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setActiveGroup(g)}
                    className={clsx(
                      "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
                      activeGroup === g
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background/40 text-muted-foreground hover:border-border/80",
                    )}
                  >
                    {GROUP_LABEL[g]} · {count}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 flex max-h-[420px] flex-col gap-3 overflow-y-auto pr-1">
              {filtered.length === 0 && (
                <div className="py-8 text-center text-[12px] text-muted-foreground">
                  没有匹配「{query}」的主题
                </div>
              )}
              {filtered.map((entry) => (
                <div key={entry.group}>
                  {activeGroup === "all" && (
                    <div className="mb-1 text-[10.5px] font-semibold tracking-wider uppercase text-muted-foreground">
                      {GROUP_LABEL[entry.group]} · {entry.items.length}
                    </div>
                  )}
                  <ul className="flex flex-col gap-1">
                    {entry.items.map((p) => {
                      const active = p.id === palette;
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => setPalette(p.id)}
                            aria-pressed={active}
                            className={clsx(
                              "flex w-full items-center gap-3 rounded-md border px-2.5 py-2 text-left transition-colors",
                              active
                                ? "border-primary/55 bg-primary/8"
                                : "border-transparent hover:border-border hover:bg-accent/60",
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className="relative inline-block h-9 w-9 shrink-0 overflow-hidden rounded-md border border-border"
                              style={{ background: p.swatch.canvas }}
                            >
                              <span
                                className="absolute right-0 top-0 h-full w-1/2"
                                style={{ background: p.swatch.accent }}
                              />
                              <span
                                className="absolute bottom-0 left-0 h-1/2 w-1/2"
                                style={{ background: p.swatch.ink, opacity: 0.86 }}
                              />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-semibold leading-tight text-foreground">
                                {p.name}
                              </div>
                              <div className="mt-0.5 text-[11.5px] leading-tight text-muted-foreground">
                                {p.description}
                              </div>
                            </div>
                            {active && <Check size={14} className="shrink-0 text-primary" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
