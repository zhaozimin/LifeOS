/**
 * [INPUT]: 依赖 themes.ts 注册表、ThemeProvider 实时 CSS 令牌、nature 语义色契约、图表系列桥与 components/ui 真实原语。
 * [OUTPUT]: 对外提供随 71 套主题和亮暗模式即时联动的只读设计系统路由，以及 nature 跨模式锁色相校验区。
 * [POS]: pages 的活文档投影；只读取视觉真源并渲染真实组件，不复制主题色值或另造组件外观。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, Palette, TriangleAlert } from "lucide-react";
import { getSeriesPalette } from "../components/charts/theme";
import { useThemeStore } from "../store/theme";
import { PALETTES } from "../theme";
import {
  NATURE_COLOR,
  NATURE_LABEL,
  NATURE_ORDER,
  NATURE_TOKEN,
  colorHueDegrees,
  hueDistance,
  readNatureColors,
} from "../lib/nature";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { KPICard } from "../components/ui/KPICard";
import { SegmentedSwitch } from "../components/ui/SegmentedSwitch";
import { Select } from "../components/ui/Select";
import { StatusPill } from "../components/ui/StatusPill";
import { TextInput } from "../components/ui/TextInput";
import {
  TimelineDistributionBlock,
  TimelineEventContent,
  TimelineEventFrame,
} from "../components/ui/TimelineCanvas";

const SEMANTIC_TOKENS = [
  "--background", "--foreground", "--card", "--popover", "--primary",
  "--secondary", "--muted", "--accent", "--destructive", "--warning",
  "--success", "--border", "--input", "--ring", "--sidebar",
  "--sidebar-accent",
] as const;

export function DesignSystemPage() {
  const resolved = useThemeStore((state) => state.resolved);
  const paletteId = useThemeStore((state) => state.palette);
  const [mode, setMode] = useState<"day" | "week">("day");
  const [sampleText, setSampleText] = useState("晨间写作");
  const [tokenValues, setTokenValues] = useState<Record<string, string>>({});
  const [lightNature, setLightNature] = useState(() => readNatureColors("light"));
  const [darkNature, setDarkNature] = useState(() => readNatureColors("dark"));
  const series = useMemo(
    () => getSeriesPalette(resolved === "dark", paletteId),
    [paletteId, resolved],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      setTokenValues(Object.fromEntries(
        SEMANTIC_TOKENS.map((token) => [token, styles.getPropertyValue(token).trim()]),
      ));
      setLightNature(readNatureColors("light"));
      setDarkNature(readNatureColors("dark"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [paletteId, resolved]);

  return (
    <div className="h-full overflow-y-auto pb-6">
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Palette size={20} className="mt-1 text-primary" />
          <div>
            <h1 className="serif text-2xl">设计系统</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              TimeOS 视觉真源的实时投影 · {PALETTES.length} 套主题 × 亮暗模式 · 当前 {paletteId} / {resolved}
            </p>
          </div>
        </div>

        <Card className="p-4">
          <SectionTitle>语义色彩令牌 · Semantic Tokens</SectionTitle>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-2">
            {SEMANTIC_TOKENS.map((token) => (
              <div key={token} className="overflow-hidden rounded-md border border-border bg-card">
                <i className="block h-9" style={{ background: `var(${token})` }} />
                <div className="px-2 py-1.5">
                  <strong className="block truncate text-[11px]">{token.slice(2)}</strong>
                  <code className="block truncate font-mono text-[10px] text-muted-foreground">{tokenValues[token] || "…"}</code>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
          <Card className="p-4">
            <SectionTitle>性质四色 · Nature Semantics</SectionTitle>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {NATURE_ORDER.map((nature) => (
                <div key={nature} className="rounded-md border border-border bg-card p-3">
                  <i className="mb-2 block h-2 rounded-full" style={{ background: NATURE_COLOR[nature] }} />
                  <strong className="block text-sm">{NATURE_LABEL[nature]}</strong>
                  <code className="text-[10px] text-muted-foreground">{NATURE_TOKEN[nature]}</code>
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-4">
            <SectionTitle>图表系列色 · ECharts Series</SectionTitle>
            <div className="flex gap-1.5">
              {series.map((color, index) => (
                <i key={`${color}-${index}`} className="h-8 min-w-0 flex-1 rounded" style={{ background: color }} title={`series[${index}] ${color}`} />
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">序列色只保证彼此可区分，不再承担 nature 业务语义。</p>
          </Card>
        </div>

        <Card className="p-4">
          <SectionTitle>性质亮暗色相契约 · Nature Hue Contract</SectionTitle>
          <div className="grid gap-2 lg:grid-cols-4">
            {NATURE_ORDER.map((nature) => {
              const lightHue = colorHueDegrees(lightNature[nature]);
              const darkHue = colorHueDegrees(darkNature[nature]);
              const delta = lightHue === null || darkHue === null ? null : hueDistance(lightHue, darkHue);
              const pass = delta !== null && delta <= 2;
              return (
                <div key={nature} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">{NATURE_LABEL[nature]}</strong>
                    <span className={pass ? "text-success" : "text-destructive"} title={pass ? "色相一致" : "色相偏移"}>
                      {pass ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <ModeColor label="亮" color={lightNature[nature]} hue={lightHue} />
                    <ModeColor label="暗" color={darkNature[nature]} hue={darkHue} />
                  </div>
                  <p className="mt-2 text-[10.5px] text-muted-foreground">色相差 {delta === null ? "无法解析" : `${delta.toFixed(2)}°`}</p>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <SectionTitle>字体排印 · Typography</SectionTitle>
            <div className="space-y-2">
              <p className="text-display-md">时间流向 28</p>
              <p className="text-display-sm">Baskerville + 思源宋体</p>
              <p className="text-title-md">标题 Inter / 苹方 650</p>
              <p className="text-body-sm">正文用于解释口径，不评判用户如何使用时间。</p>
              <p className="text-caption-uppercase">Caption uppercase · 0.06em</p>
              <p className="text-mono">mono · 09:10–10:40 · 90m</p>
            </div>
          </Card>
          <Card className="p-4">
            <SectionTitle>UI 原语 · components/ui</SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button>主要操作</Button>
              <Button variant="outline">次要操作</Button>
              <Button variant="destructive">危险操作</Button>
              <Badge tone="primary">核心创作</Badge>
              <StatusPill tone="success">本地节点已连接</StatusPill>
              <SegmentedSwitch value={mode} options={[{ value: "day", label: "日" }, { value: "week", label: "周" }]} onChange={setMode} ariaLabel="原语示例" />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <TextInput label="事项" value={sampleText} onChange={(event) => setSampleText(event.target.value)} />
              <Select label="性质" value="core" onChange={() => undefined} options={NATURE_ORDER.map((nature) => ({ value: nature, label: NATURE_LABEL[nature] }))} />
            </div>
            <div className="mt-3 max-w-xs"><KPICard label="有效创作" value="5h35m" helper="记录不评判" icon={<Clock3 size={17} />} /></div>
          </Card>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <Card className="p-4">
            <SectionTitle>时间轴原语 · Timeline Primitives</SectionTitle>
            <div className="relative h-24 overflow-hidden rounded-md border border-border bg-background/60">
              <TimelineDistributionBlock timelineColor={NATURE_COLOR.core} style={{ top: 8, height: 72, left: 10, width: 18 }} aria-hidden />
              <TimelineEventFrame
                variant="day"
                timelineColor={NATURE_COLOR.core}
                style={{ top: 8, bottom: 8, left: 40, right: 12 }}
                actionProps={{ "aria-label": "时间轴事项原语" }}
              >
                <TimelineEventContent title="晨间写作" duration="1h30m" meta="09:10–10:40 · 核心创作" note="真实分钟高度 + 渐进披露" />
              </TimelineEventFrame>
            </div>
          </Card>
          <Card className="p-4">
            <SectionTitle>形态与动效 · Shape & Motion</SectionTitle>
            <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
              <span>圆角 <b className="text-foreground">单一 8px</b></span>
              <span>焦点 <b className="text-foreground">2px ring</b></span>
              <span>弹窗 <b className="text-foreground">180ms</b></span>
              <span>抽屉 <b className="text-foreground">200ms</b></span>
              <span>纸感 <b className="text-foreground">背景渐变</b></span>
              <span>减弱动效 <b className="text-foreground">系统优先</b></span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-caption-uppercase">{children}</h2>;
}

function ModeColor({ label, color, hue }: { label: string; color: string; hue: number | null }) {
  return (
    <div className="overflow-hidden rounded border border-border">
      <i className="block h-7" style={{ background: color }} />
      <div className="px-2 py-1">
        <span className="block text-[10px] font-semibold">{label} · {hue === null ? "—" : `${hue.toFixed(1)}°`}</span>
        <code className="block truncate text-[9px] text-muted-foreground">{color}</code>
      </div>
    </div>
  );
}
