/**
 * [INPUT]: 依赖 components/ui 全套基础控件、charts/theme 的序列色派生、store/theme 的当前主题。
 * [OUTPUT]: 对外提供 DesignSystemPage —— 产品设计系统的活文档（色彩令牌 / 排版 / 组件矩阵 / 导航原语）。
 * [POS]: pages 的开发者模式内容，由 SettingsPage 内嵌；所有色值经 MutationObserver 实时测量自 <html> 的主题 token，
 *   切换任意主题（71 套）本页同步刷新——组件即文档，文档即组件，不允许出现硬编码色。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Shapes, Save, Plus } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { TextInput } from "../../components/ui/TextInput";
import { Modal } from "../../components/ui/Modal";
import { Autocomplete } from "../components/ui/Autocomplete";
import { DatePicker } from "../../components/ui/DatePicker";
import { StatusPill } from "../../components/ui/StatusPill";
import { ReimbursementActions, ReimbursementStatusTag, SettlePill } from "../components/ReimbursementPill";
import { AlertDialog } from "../components/ui/AlertDialog";
import { SegmentedSwitch } from "../../components/ui/SegmentedSwitch";
import { CategoryTabs } from "../../components/ui/Tabs";
import { NavigationTile } from "../../components/ui/NavigationTile";
import { EChart } from "../components/charts/EChart";
import { SankeyChart } from "../components/charts/SankeyChart";
import { getPalette, getSeriesPalette } from "../components/charts/theme";
import { useThemeStore } from "../store/theme";

// ———— 主题 token 清单（与 ThemeProvider.applyPalette 写入 <html> 的 token 同源）————
const COLOR_TOKENS = [
  "background", "foreground", "card", "card-foreground",
  "primary", "primary-foreground", "secondary", "secondary-foreground",
  "muted", "muted-foreground", "accent", "accent-foreground",
  "border", "input", "ring", "destructive",
];

const BRAND_TOKENS = ["brand-blue", "brand-coral", "brand-sage", "brand-sand", "brand-violet", "brand-red", "brand-ink"];

const BADGE_TONES = ["neutral", "outline", "primary", "success", "warning", "destructive", "brand-orange", "brand-blue", "brand-violet"] as const;

const BUTTON_VARIANTS = ["primary", "secondary", "outline", "ghost", "destructive", "text"] as const;

/** 主题切换（ThemeProvider 改写 <html> 的 style/class）时触发重渲，让测量值实时跟随。 */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setTick((t) => t + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => observer.disconnect();
  }, []);
  return tick;
}

function rgbToHex(rgb: string): string {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return rgb;
  const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`.toUpperCase();
}

/** 单个色块：渲染 var(--token)，再实测计算色以显示真实 hex。 */
function TokenSwatch({ token, tick }: { token: string; tick: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hex, setHex] = useState("");
  useEffect(() => {
    if (ref.current) setHex(rgbToHex(getComputedStyle(ref.current).backgroundColor));
  }, [tick, token]);
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2">
      <div ref={ref} className="h-9 w-9 shrink-0 rounded-md border border-border/60" style={{ backgroundColor: `var(--${token})` }} />
      <div className="min-w-0">
        <div className="truncate font-mono text-[11.5px] text-foreground">--{token}</div>
        <div className="font-mono text-[11px] uppercase text-muted-foreground">{hex}</div>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card padding="none">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-title-lg">{title}</h2>
        <p className="mt-0.5 text-body-sm text-muted-foreground">{description}</p>
      </div>
      <div className="p-5">{children}</div>
    </Card>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{children}</div>;
}

export function DesignSystemPage() {
  const tick = useThemeTick();
  const resolved = useThemeStore((s) => s.resolved);
  const palette = useThemeStore((s) => s.palette);
  const series = getSeriesPalette(resolved === "dark", palette);
  const chartPalette = getPalette(resolved === "dark", palette);

  const [demoMode, setDemoMode] = useState<"personal" | "dual">("personal");
  const [demoTab, setDemoTab] = useState<"a" | "b" | "c">("a");
  const [demoText, setDemoText] = useState("");
  const [demoSelect, setDemoSelect] = useState("wechat");
  const [demoDate, setDemoDate] = useState("");
  const [demoReimb, setDemoReimb] = useState<import("../types").ReimbursementStatus>("draft");
  const [demoAlert, setDemoAlert] = useState<"confirm" | "notice" | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="space-y-5">
      <Card padding="none">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <h1 className="flex items-center gap-2 text-display-sm">
              <Shapes size={20} /> 设计系统
            </h1>
            <p className="text-body-sm text-muted-foreground">
              当前产品的活组件库：色彩随主题实时测量（当前主题 {palette} · {resolved}），控件全部为真实组件而非截图。
            </p>
          </div>
          <Badge tone="primary" uppercase>{COLOR_TOKENS.length + BRAND_TOKENS.length} tokens · 71 themes</Badge>
        </div>
      </Card>

      <Section title="色彩令牌" description="语义色 token（--background / --primary …），由 ThemeProvider 按当前主题写入 <html>；下方 hex 为实测值。">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {COLOR_TOKENS.map((token) => <TokenSwatch key={token} token={token} tick={tick} />)}
        </div>
        <Label>品牌色</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {BRAND_TOKENS.map((token) => <TokenSwatch key={token} token={token} tick={tick} />)}
        </div>
      </Section>

      <Section title="图表序列色" description="ECharts 系列色由主题注册表派生（charts/theme.ts getSeriesPalette），所有 71 套主题自动可用。">
        <div className="flex flex-wrap gap-2">
          {series.map((color, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
              <span className="h-5 w-5 rounded" style={{ backgroundColor: color }} />
              <span className="font-mono text-[11px] uppercase text-muted-foreground">{color}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="图表组件" description="全站图表统一走 EChart 壳 + 主题注册表派生配色（71 套主题自动适配）：桑基图承载资金流，饼图承载报销/占比，柱状图承载项目成本回款，折线承载趋势。">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <Label>桑基图 SankeyChart —— 资金流量页主视图</Label>
            <div className="overflow-hidden rounded-md border border-border bg-background/35 px-2 py-2">
              <SankeyChart
                height={220}
                nodes={[{ name: "工资" }, { name: "工资卡" }, { name: "生活支出" }, { name: "餐饮" }, { name: "交通" }]}
                links={[
                  { source: "工资", target: "工资卡", value: 8000 },
                  { source: "工资卡", target: "生活支出", value: 3200 },
                  { source: "生活支出", target: "餐饮", value: 1800 },
                  { source: "生活支出", target: "交通", value: 700 },
                ]}
              />
            </div>
          </div>
          <div>
            <Label>饼图（环形）—— 报销总览 / 占比类</Label>
            <div className="rounded-md border border-border bg-background/35">
              <EChart
                style={{ height: 236 }}
                option={{
                  tooltip: { trigger: "item" },
                  legend: { bottom: 4, icon: "circle", itemWidth: 9, itemHeight: 9, textStyle: { color: chartPalette.body, fontSize: 11.5 } },
                  series: [{
                    type: "pie",
                    radius: ["42%", "68%"],
                    center: ["50%", "44%"],
                    itemStyle: { borderRadius: 5, borderColor: chartPalette.bg, borderWidth: 2 },
                    label: { color: chartPalette.body, fontSize: 11 },
                    data: [
                      { name: "待报销", value: 86, itemStyle: { color: chartPalette.brandOrange } },
                      { name: "已提交", value: 320, itemStyle: { color: chartPalette.brandBlue } },
                      { name: "已报销", value: 1300, itemStyle: { color: chartPalette.success } },
                    ],
                  }],
                }}
              />
            </div>
          </div>
          <div>
            <Label>柱状图 —— 项目成本 / 回款对比</Label>
            <div className="rounded-md border border-border bg-background/35">
              <EChart
                style={{ height: 220 }}
                option={{
                  tooltip: { trigger: "axis" },
                  grid: { left: 44, right: 12, top: 24, bottom: 28 },
                  xAxis: { type: "category", data: ["项目 A", "项目 B", "项目 C"], axisLabel: { color: chartPalette.muted } },
                  yAxis: { type: "value", axisLabel: { color: chartPalette.muted } },
                  series: [
                    { name: "成本", type: "bar", barWidth: 18, itemStyle: { color: series[0], borderRadius: [4, 4, 0, 0] }, data: [3200, 1800, 2600] },
                    { name: "回款", type: "bar", barWidth: 18, itemStyle: { color: series[1], borderRadius: [4, 4, 0, 0] }, data: [5000, 2400, 1900] },
                  ],
                }}
              />
            </div>
          </div>
          <div>
            <Label>折线图 —— 收入 / 现金流趋势</Label>
            <div className="rounded-md border border-border bg-background/35">
              <EChart
                style={{ height: 220 }}
                option={{
                  tooltip: { trigger: "axis" },
                  grid: { left: 44, right: 12, top: 24, bottom: 28 },
                  xAxis: { type: "category", data: ["3月", "4月", "5月", "6月", "7月"], axisLabel: { color: chartPalette.muted } },
                  yAxis: { type: "value", axisLabel: { color: chartPalette.muted } },
                  series: [{
                    name: "收入",
                    type: "line",
                    smooth: true,
                    symbolSize: 5,
                    lineStyle: { color: series[0], width: 2 },
                    itemStyle: { color: series[0] },
                    areaStyle: { opacity: 0.12, color: series[0] },
                    data: [5200, 6800, 6100, 8000, 7400],
                  }],
                }}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="排版" description="展示级衬线（EB Garamond / Noto Serif SC）承载数字与标题，正文用 Inter / Noto Sans SC，代码与 token 用 JetBrains Mono。">
        <div className="space-y-3">
          <div>
            <Label>text-display-sm · 22px 衬线 —— KPI / 页面标题</Label>
            <div className="text-display-sm">净资产 ¥128,450.00</div>
          </div>
          <div>
            <Label>text-title-lg —— 区块标题</Label>
            <div className="text-title-lg">账户管理</div>
          </div>
          <div>
            <Label>text-body-sm —— 正文与说明</Label>
            <div className="text-body-sm text-muted-foreground">类别是桑基图末层，点开任意类别可编辑默认账户、月度预算与识别关键词。</div>
          </div>
          <div>
            <Label>font-mono —— token / 代码 / hex</Label>
            <div className="font-mono text-[12px] uppercase text-muted-foreground">source: openClaw · account-salary · #5C6BC0</div>
          </div>
        </div>
      </Section>

      <Section title="按钮" description="六种语义变体 × 三档尺寸；主操作永远只有一个 primary。">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {BUTTON_VARIANTS.map((variant) => (
              <Button key={variant} variant={variant}>{variant}</Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="lg" leading={<Save size={15} />}>保存设置 · lg</Button>
            <Button size="md" leading={<Save size={14} />}>保存设置 · md</Button>
            <Button size="sm" variant="outline" leading={<Plus size={13} />}>新增账户 · sm</Button>
            <Button loading>保存中</Button>
            <Button disabled>已禁用</Button>
          </div>
        </div>
        <Label>侧边栏导航 NavigationTile —— 业务侧栏与本页共同消费的真实导航原语</Label>
        <div className="grid max-w-[360px] grid-cols-2 gap-2">
          <NavigationTile icon={Shapes} label="财务状况" active />
          <NavigationTile icon={Save} label="财务设置" />
        </div>
      </Section>

      <Section title="徽章" description="九种语气：状态（success/warning/destructive）、语义（primary/neutral/outline）与品牌强调。">
        <div className="flex flex-wrap items-center gap-2">
          {BADGE_TONES.map((tone) => <Badge key={tone} tone={tone}>{tone}</Badge>)}
        </div>
      </Section>

      <Section title="表单控件" description="输入、下拉、分段开关与页签——设置页与编辑弹窗的全部原料。下拉统一用自适应 Autocomplete：桌面(细指针)是可搜索的 shadcn Combobox，移动/触屏(粗指针)自动降级为原生 <select> 唤起系统 picker。同一 API，两种呈现。">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="文本输入 TextInput" placeholder="请输入账户名称" value={demoText} onChange={(event) => setDemoText(event.target.value)} />
          <Autocomplete
            label="自适应下拉 Autocomplete"
            value={demoSelect}
            onChange={setDemoSelect}
            placeholder="选择账户…"
            searchPlaceholder="搜索账户…"
            searchable
            hint="桌面：搜索式 Combobox · 手机：原生 picker（选项 > 6 才默认显示搜索框）"
            options={[
              { value: "wechat", label: "微信支付" },
              { value: "alipay", label: "支付宝" },
              { value: "salary", label: "工资卡" },
              { value: "creditcard", label: "信用卡" },
              { value: "cash", label: "现金" },
              { value: "invest", label: "投资账户" },
            ]}
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <DatePicker
            label="日期选择 DatePicker"
            value={demoDate}
            onChange={setDemoDate}
            hint="桌面：弹出月历（今天描边 / 选中填充 / 支持 min-max 禁用）· 手机：系统原生日期滚轮"
          />
          <div>
            <Label>状态指示 StatusPill —— 保存状态（文字恒用前景色，任何主题可读）</Label>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone="success">已保存</StatusPill>
              <StatusPill tone="warning">有未保存改动</StatusPill>
            </div>
          </div>
          <div>
            <Label>
              报销操作 ReimbursementActions / SettlePill —— 是否报销双按钮（点击激活项撤回待报销，当前：
              {demoReimb === "draft" ? "待报销" : demoReimb === "reimbursed" ? "已报销" : "已驳回"}）与回款核销入口
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <ReimbursementActions status={demoReimb} onMark={setDemoReimb} />
              <SettlePill count={3} />
            </div>
          </div>
          <div>
            <Label>报销状态 ReimbursementStatusTag —— 非交互展示态（可嵌入可点击容器）</Label>
            <div className="flex flex-wrap items-center gap-2">
              <ReimbursementStatusTag status="draft" />
              <ReimbursementStatusTag status="submitted" />
              <ReimbursementStatusTag status="rejected" />
              <ReimbursementStatusTag status="reimbursed" />
            </div>
          </div>
          <div>
            <Label>警示弹窗 AlertDialog —— 替代浏览器原生 confirm/alert；遮罩不可点关，必须显式选择</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDemoAlert("confirm")}>
                删除确认（destructive）
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDemoAlert("notice")}>
                单按钮通知
              </Button>
            </div>
            <AlertDialog
              open={demoAlert === "confirm"}
              tone="destructive"
              title="删除附件"
              description="确定删除附件「demo.png」？此操作不可恢复。"
              confirmLabel="删除"
              onConfirm={() => setDemoAlert(null)}
              onCancel={() => setDemoAlert(null)}
            />
            <AlertDialog
              open={demoAlert === "notice"}
              title="PDF 导出失败"
              description="网络中断，请稍后重试。"
              confirmLabel="知道了"
              onConfirm={() => setDemoAlert(null)}
            />
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <div>
            <Label>分段开关 SegmentedSwitch —— 少档位模式切换（记账模式即此控件）</Label>
            <SegmentedSwitch
              value={demoMode}
              onChange={setDemoMode}
              ariaLabel="演示模式开关"
              options={[
                { value: "personal", label: "个人记账" },
                { value: "dual", label: "个人 + 经营" },
              ]}
            />
          </div>
          <div>
            <Label>页签 CategoryTabs —— 多面板导航（pills 变体）</Label>
            <CategoryTabs
              value={demoTab}
              onChange={setDemoTab}
              variant="pills"
              ariaLabel="演示页签"
              options={[
                { value: "a", label: "支出 (7)" },
                { value: "b", label: "收入 (3)" },
                { value: "c", label: "转账" },
              ]}
            />
          </div>
        </div>
      </Section>

      <Section title="容器与弹层" description="Card 是页面唯一容器原语；Modal 经 portal 挂载 body，Esc 关闭。">
        <div className="flex flex-wrap items-center gap-3">
          <Card className="max-w-[240px]">
            <div className="text-title-lg">卡片 Card</div>
            <p className="mt-1 text-body-sm text-muted-foreground">圆角 lg + border-border + bg-card。</p>
          </Card>
          <Button variant="outline" onClick={() => setModalOpen(true)}>打开 Modal 示例</Button>
        </div>
        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          size="sm"
          title="弹窗 Modal"
          description="portal 到 body、锁滚动、Esc 关闭——类别编辑用的就是它。"
          footer={<div className="flex justify-end"><Button onClick={() => setModalOpen(false)}>完成</Button></div>}
        >
          <p className="text-body-sm text-muted-foreground">尺寸 sm / md / lg，对应 max-w-md / 2xl / 4xl。</p>
        </Modal>
      </Section>

      <Section title="圆角与间距" description="圆角三档（md 6px 控件 / lg 卡片 / full 徽点）；间距走 4px 栅格。">
        <div className="flex flex-wrap items-end gap-4">
          {(["rounded-md", "rounded-lg", "rounded-xl", "rounded-full"] as const).map((radius) => (
            <div key={radius} className="text-center">
              <div className={`h-14 w-14 border border-border bg-muted ${radius}`} />
              <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">{radius}</div>
            </div>
          ))}
          <div className="flex items-end gap-1.5 pl-4">
            {[1, 2, 3, 4, 5, 6, 8].map((step) => (
              <div key={step} className="text-center">
                <div className="w-4 rounded-sm bg-primary/70" style={{ height: step * 4 }} />
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">{step * 4}</div>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}
