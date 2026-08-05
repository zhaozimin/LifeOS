/**
 * [INPUT]: 依赖配置 API、Layout 的软刷新信号、设置面板组件，以及 settings/constants 的面板清单与领域枚举选项
 *   （这些常量的唯一真源在 constants.ts，本页不得重新声明）。
 * [OUTPUT]: 对外提供单币种 MVP 的设置状态编排与分组面板装配；周期和汇率入口不参与渲染。
 * [POS]: web-dashboard 的主数据配置中心；已删除账户可见但不再作为活跃账户编辑。
 *   记账模式（settings.ledgerMode）为总门控：personal 隐藏归属选择器 + 客户合作方 + 税务面板，
 *   类别管理按收/支分 tab 并以行 + 编辑弹窗呈现（转账等系统类别不入列表）。
 *   顶栏「刷新数据」＝从服务端重取配置并据此重建草稿，未保存的改动会被服务端状态覆盖——
 *   与时间设置页同一口径，两个设置页对「刷新」不能给出两种含义。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useMemo, useState } from "react";
import { CreditCard, Database, FolderKanban, Save } from "lucide-react";
import { useRefreshSignal } from "../../components/Layout";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { StatusPill } from "../../components/ui/StatusPill";
import { SegmentedSwitch } from "../../components/ui/SegmentedSwitch";
import { CategoryTabs } from "../../components/ui/Tabs";
import { DesignSystemPage } from "./DesignSystemPage";
import { api } from "../api/client";
import { useApi } from "../lib/useApi";
import { formatCurrency } from "../lib/format";
import type { Configuration } from "../types";

// 主数据枚举与面板清单的单一真源在 settings/constants.ts；
// 此处曾逐字节复制过一份，拆分文件时两处会各自漂移，已删除。
import {
  LEDGER_MODE_OPTIONS,
  SETTINGS_PANEL_OPTIONS,
  type SettingsPanel,
} from "./settings/constants";

import { DashboardSection, AccountsSection, ProjectsSection, SourcesSection } from "./settings/master-data-cards";
import { CategoriesSection, CounterpartiesSection } from "./settings/categories";
import { TopStat, cloneConfig } from "./settings/primitives";
import { ImportSection, TaxConfigSection } from "./settings/import-tax";

export function SettingsPage({ initialPanel = "accounts" }: { initialPanel?: SettingsPanel }) {
  const refreshKey = useRefreshSignal();
  const { data, loading, error, refresh } = useApi(() => api.configuration(), [refreshKey]);
  const [draft, setDraft] = useState<Configuration | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<SettingsPanel>(initialPanel);

  useEffect(() => {
    const target = sessionStorage.getItem("settings-target-panel");
    if (target) {
      setActivePanel(target as SettingsPanel);
      sessionStorage.removeItem("settings-target-panel");
    }
  }, []);

  useEffect(() => {
    if (data) setDraft(cloneConfig(data));
  }, [data]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return JSON.stringify(data) !== JSON.stringify(draft);
  }, [data, draft]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setToast(null);
    try {
      const saved = await api.putConfiguration(draft);
      setDraft(cloneConfig(saved));
      setToast("设置已保存");
      refresh();
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err ? String((err as Error).message) : "保存失败";
      setToast(message);
    } finally {
      setBusy(false);
      window.setTimeout(() => setToast(null), 2600);
    }
  };

  if (loading && !draft) return <div className="h-[760px] rounded-lg bg-muted animate-pulse" />;
  if (error) {
    return (
      <Card>
        <h2 className="text-display-sm mb-2">无法加载财务设置</h2>
        <p className="text-body-sm text-muted-foreground mb-4">{error.message}</p>
        <Button onClick={refresh}>重试</Button>
      </Card>
    );
  }
  if (!draft) return null;

  const totalBalance = draft.accounts.filter((account) => !account.deletedAt).reduce(
    (sum, account) => sum + (account.currentBalance ?? account.openingBalance ?? 0),
    0,
  );

  const updateSettings = (patch: Partial<Configuration["settings"]>) =>
    setDraft({ ...draft, settings: { ...draft.settings, ...patch } });

  // 记账模式门控：dual 才显示归属选择器、客户合作方、税务面板。
  // 防御性地把"存在 company 归属账户"也判为 dual，避免老库漏字段时藏掉经营维度。
  const isDual = draft.settings.ledgerMode === "dual" || draft.accounts.some((account) => account.ownership === "company");
  const panelOptions = SETTINGS_PANEL_OPTIONS.filter(
    (option) => isDual || (option.value !== "counterparties" && option.value !== "tax"),
  );
  // 旧深链、切模式或暂停面板会回落到账户页，杜绝空白。
  const effectivePanel: SettingsPanel = panelOptions.some((option) => option.value === activePanel)
    ? activePanel
    : "accounts";

  return (
    <div className="space-y-5">
      <Card padding="none">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h1 className="text-display-sm">财务设置</h1>
            <p className="text-body-sm text-muted-foreground">
              管理账户、项目、资金来源与支出类别，这些内容会写入 Finance Node。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedSwitch
              value={isDual ? "dual" : "personal"}
              options={LEDGER_MODE_OPTIONS}
              onChange={(mode) => updateSettings({ ledgerMode: mode })}
              ariaLabel="记账模式"
            />
            <StatusPill tone={dirty ? "warning" : "success"}>
              {dirty ? "有未保存改动" : "已保存"}
            </StatusPill>
            <Button variant="outline" disabled={!dirty || busy || !data} onClick={() => data && setDraft(cloneConfig(data))}>
              恢复默认
            </Button>
            <Button leading={<Save size={14} />} disabled={!dirty} loading={busy} onClick={save}>
              保存设置
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 p-5 md:grid-cols-4">
          <TopStat label="当前统计区间" value="由左侧日历控制" icon={<Database size={17} />} />
          <TopStat label="默认币种总额" value={formatCurrency(totalBalance)} icon={<CreditCard size={17} />} />
          <TopStat label="账户 / 项目 / 类别" value={`${draft.accounts.length}/${draft.settings.projects.length}/${draft.categories.length}`} icon={<FolderKanban size={17} />} />
          <TopStat label="保存状态" value={draft.settings.updatedAt ? new Date(draft.settings.updatedAt).toLocaleString("zh-CN") : "尚未同步"} icon={<Save size={17} />} />
        </div>
        <div className="border-t border-border px-5 py-4">
          <CategoryTabs
            value={effectivePanel}
            onChange={setActivePanel}
            options={panelOptions}
            variant="pills"
            ariaLabel="设置分组"
          />
        </div>
      </Card>

      {effectivePanel === "accounts" && (
        <AccountsSection
          accounts={draft.accounts}
          exchangeRates={draft.settings.exchangeRates}
          showOwnership={isDual}
          onChange={(accounts) => setDraft({ ...draft, accounts })}
        />
      )}

      {effectivePanel === "projects" && (
        <ProjectsSection
          projects={draft.settings.projects}
          accounts={draft.accounts}
          onChange={(projects) => updateSettings({ projects })}
        />
      )}

      {effectivePanel === "sources" && (
        <SourcesSection
          sources={draft.settings.financeSources || []}
          accounts={draft.accounts}
          onChange={(financeSources) => updateSettings({ financeSources })}
        />
      )}

      {effectivePanel === "categories" && (
        <CategoriesSection
          categories={draft.categories}
          accounts={draft.accounts}
          projects={draft.settings.projects}
          onChange={(categories) => setDraft({ ...draft, categories })}
        />
      )}

      {isDual && effectivePanel === "counterparties" && (
        <CounterpartiesSection
          counterparties={draft.settings.counterparties || []}
          accounts={draft.accounts}
          onChange={(counterparties) => updateSettings({ counterparties })}
        />
      )}

      {effectivePanel === "import" && (
        <ImportSection
          accounts={draft.accounts}
          categories={draft.categories}
          onImported={() => {
            setToast("账单已导入，可在流水页查看。");
            window.setTimeout(() => setToast(null), 2600);
          }}
        />
      )}

      {isDual && effectivePanel === "tax" && (
        <TaxConfigSection
          taxConfig={draft.settings.taxConfig || { vatRate: 0.03, personalThreshold: 60000, personalRate: 0.20, sebRate: 0.10, currency: "CNY" }}
          onChange={(taxConfig) => updateSettings({ taxConfig })}
        />
      )}

      {effectivePanel === "dashboard" && <DashboardSection />}

      {effectivePanel === "developer" && <DesignSystemPage />}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 rounded-md bg-foreground px-4 py-3 text-[13px] text-background shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
