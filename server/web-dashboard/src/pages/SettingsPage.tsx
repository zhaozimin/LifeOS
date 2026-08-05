/**
 * [INPUT]: 依赖含非空 resolvedTimezone/nullable currentSystemTimezone 的 configuration/timezone API、gaps/segments、主数据操作、导出与确认弹层。
 * [OUTPUT]: 对外提供 TimeSettingsSection 与按分区渲染的 SettingsPage：主数据、周起点、账本/系统 IANA 漂移提示、
 *   仅候选可识别时的 blank→blank 入口、不可识别时的显式 IANA 护栏、preserve 护栏与全量导出。
 * [POS]: pages 的主数据与数据主权边界；resolvedTimezone 独占日期投影，nullable currentSystemTimezone 只用于提示和显式迁移候选。
 *   section 由设置中心的时间组菜单注入，三个菜单项各得一屏——与财务侧 initialPanel 同构；
 *   时区保存成功后必须经 onRecordTimeZoneChange 上报，否则日/统计页会停留在旧口径。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useOutletContext } from "react-router";
import { Download, FolderKanban, Globe2, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { api, isAbortError } from "../api/client";
import { healthRecordTimeZone, isoDate, recordNow, recordTimeZoneSelectionChanged } from "../lib/dates";
import { buildTimeOSExport, collectAllSegments, serializeTimeOSExport, timeOSExportFileName } from "../lib/export";
import { NATURE_LABEL, NATURE_ORDER } from "../lib/nature";
import type { Category, Configuration, GapsResponse, Nature, Project, TimezoneHistoryMode } from "../types";
import { AlertDialog } from "../components/ui/AlertDialog";
import { Autocomplete } from "../components/ui/Autocomplete";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { TextArea, TextInput } from "../components/ui/TextInput";
import type { LayoutOutletContext } from "../components/Layout";

type CategoryDraft = { currentName?: string; name: string; nature: Nature; keywords: string };
type ProjectDraft = { currentName?: string; name: string; status: string };
type DeleteTarget = { entity: "category" | "project"; name: string };

/** 设置中心「时间」组三个菜单项各自对应的分区；一个菜单项 = 一屏，绝不重复整页。 */
export type TimeSettingsSection = "catalog" | "week-start" | "timezone";

type SettingsPageProps = {
  section?: TimeSettingsSection;
  onRecordTimeZoneChange: (timeZone: string) => void;
};

const SECTION_META: Record<TimeSettingsSection, { title: string; description: string }> = {
  catalog: {
    title: "分类与项目主数据",
    description: "主数据修改从现在起生效，历史时段保留写入时快照。",
  },
  "week-start": {
    title: "周起点",
    description: "只决定统计页“本周”的快捷区间，不改写任何已有时段。",
  },
  timezone: {
    title: "记录时区迁移",
    description: "决定“今天”、统计边界与所有本地分钟的解释口径；换算模式会先备份账本再迁移。",
  },
};

const PRIORITY_TIME_ZONES = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Australia/Sydney",
  "UTC",
];

const intlWithTimeZones = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
const availableTimeZones = Array.from(new Set([
  ...PRIORITY_TIME_ZONES,
  ...(intlWithTimeZones.supportedValuesOf?.("timeZone") || []),
]));
export function SettingsPage({ section = "catalog", onRecordTimeZoneChange }: SettingsPageProps) {
  const { refreshKey } = useOutletContext<LayoutOutletContext>();
  const [config, setConfig] = useState<Configuration | null>(null);
  const [timeZoneDraft, setTimeZoneDraft] = useState("");
  const [timeZoneHistoryMode, setTimeZoneHistoryMode] = useState<TimezoneHistoryMode>("convert");
  const [timeZoneConfirmation, setTimeZoneConfirmation] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [timeZoneError, setTimeZoneError] = useState("");
  const [openSegment, setOpenSegment] = useState<GapsResponse["openSegment"]>(null);
  const [openSegmentCheckError, setOpenSegmentCheckError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportMessage, setExportMessage] = useState("");
  const loadGeneration = useRef(0);
  const systemTimeZoneUnavailable = config?.currentSystemTimezone === null;
  const systemTimeZoneDrift = !!config
    && config.timezoneSource === "system"
    && config.currentSystemTimezone !== null
    && config.resolvedTimezone !== config.currentSystemTimezone;
  const timeZoneOptions = useMemo(() => [
    {
      value: "",
      label: systemTimeZoneUnavailable
        ? "无法识别当前服务端系统时区，请显式配置 IANA"
        : `${systemTimeZoneDrift ? "重新采用" : "采用"}当前服务端系统时区（${config?.currentSystemTimezone || "加载中"}）`,
      disabled: systemTimeZoneUnavailable,
    },
    ...availableTimeZones.map((timeZone) => ({ value: timeZone, label: timeZone })),
  ], [config?.currentSystemTimezone, systemTimeZoneDrift, systemTimeZoneUnavailable]);

  const inspectOpenSegment = useCallback(async (configuration: Configuration, signal?: AbortSignal) => {
    const timeZone = healthRecordTimeZone(
      configuration.timezone,
      configuration.timezoneSource,
      configuration.resolvedTimezone,
    );
    const today = isoDate(recordNow(timeZone));
    return (await api.gaps(today, { signal })).openSegment;
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    try {
      const nextConfig = await api.configuration({ signal });
      if (signal?.aborted || generation !== loadGeneration.current) return;
      setConfig(nextConfig);
      setTimeZoneDraft(nextConfig.timezoneSource === "config" ? nextConfig.timezone : "");
      setError("");
      try {
        const nextOpenSegment = await inspectOpenSegment(nextConfig, signal);
        if (signal?.aborted || generation !== loadGeneration.current) return;
        setOpenSegment(nextOpenSegment);
        setOpenSegmentCheckError("");
      } catch (caught) {
        if (isAbortError(caught) || generation !== loadGeneration.current) return;
        setOpenSegment(null);
        setOpenSegmentCheckError("无法确认当前是否有进行中时段；为保护账本，暂不允许保留原显示时间。");
      }
    }
    catch (caught) {
      if (!isAbortError(caught) && generation === loadGeneration.current) {
        setError(caught instanceof Error ? caught.message : "设置加载失败。");
      }
    }
  }, [inspectOpenSegment]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const saveCategory = async () => {
    if (!categoryDraft?.name.trim()) { setFormError("请填写分类名称。"); return; }
    setBusy(true);
    setFormError("");
    try {
      const action = categoryDraft.currentName ? "update" : "create";
      await api.masterOperation({
        entity: "category", action, ...(categoryDraft.currentName ? { name: categoryDraft.currentName } : {}),
        payload: { name: categoryDraft.name.trim(), nature: categoryDraft.nature, keywords: categoryDraft.keywords.split(/[，,]/).map((word) => word.trim()).filter(Boolean) },
        userConfirmation: `用户在 TimeOS 设置页确认${action === "create" ? "创建" : "修改"}分类“${categoryDraft.name.trim()}”`,
      });
      setCategoryDraft(null); await load();
    } catch (caught) { setFormError(caught instanceof Error ? caught.message : "分类保存失败。"); }
    finally { setBusy(false); }
  };

  const saveProject = async () => {
    if (!projectDraft?.name.trim()) { setFormError("请填写项目名称。"); return; }
    setBusy(true);
    setFormError("");
    try {
      const action = projectDraft.currentName ? "update" : "create";
      await api.masterOperation({
        entity: "project", action, ...(projectDraft.currentName ? { name: projectDraft.currentName } : {}),
        payload: { name: projectDraft.name.trim(), status: projectDraft.status },
        userConfirmation: `用户在 TimeOS 设置页确认${action === "create" ? "创建" : "修改"}项目“${projectDraft.name.trim()}”`,
      });
      setProjectDraft(null); await load();
    } catch (caught) { setFormError(caught instanceof Error ? caught.message : "项目保存失败。"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setDeleteError("");
    try {
      await api.masterOperation({
        entity: deleteTarget.entity, action: "delete", name: deleteTarget.name, payload: {},
        userConfirmation: `用户在 TimeOS 设置页确认删除${deleteTarget.entity === "category" ? "分类" : "项目"}“${deleteTarget.name}”`,
      });
      setDeleteTarget(null); await load();
    } catch (caught) { setDeleteError(caught instanceof Error ? caught.message : "删除失败。"); }
    finally { setBusy(false); }
  };

  const updateWeekStart = async (weekStart: "monday" | "sunday") => {
    if (!config) return;
    setBusy(true);
    setTimeZoneError("");
    try { await api.updateSettings({ weekStart }); setConfig({ ...config, settings: { weekStart } }); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "周起点保存失败。"); }
    finally { setBusy(false); }
  };

  const saveTimeZone = async () => {
    if (!config) return;
    if (!timeZoneDraft && config.currentSystemTimezone === null) {
      setTimeZoneError("当前平台无法识别系统 IANA 时区，请选择一个具体 IANA 时区。");
      setTimeZoneConfirmation(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await api.updateTimezone(timeZoneDraft, timeZoneHistoryMode);
      setConfig({ ...config, ...updated });
      onRecordTimeZoneChange(healthRecordTimeZone(
        updated.timezone,
        updated.timezoneSource,
        updated.resolvedTimezone,
      ));
      setTimeZoneConfirmation(false);
      setError("");
    } catch (caught) {
      setTimeZoneError(caught instanceof Error ? caught.message : "记录时区保存失败。");
    } finally { setBusy(false); }
  };

  const requestTimeZoneConfirmation = async () => {
    if (!config) return;
    setTimeZoneError("");
    if (!timeZoneDraft && config.currentSystemTimezone === null) {
      setTimeZoneError("当前平台无法识别系统 IANA 时区，请选择一个具体 IANA 时区。");
      return;
    }
    if (timeZoneHistoryMode !== "preserve") {
      setTimeZoneConfirmation(true);
      return;
    }
    setBusy(true);
    try {
      const latestOpenSegment = await inspectOpenSegment(config);
      setOpenSegment(latestOpenSegment);
      if (latestOpenSegment) {
        setOpenSegmentCheckError(`“${latestOpenSegment.title}”仍在进行中。请先结束该时段，或改用“换算历史时间”。`);
        return;
      }
      setOpenSegmentCheckError("");
      setTimeZoneConfirmation(true);
    } catch {
      setOpenSegmentCheckError("无法确认当前是否有进行中时段；为保护账本，本次 preserve 已拒绝。请稍后重试或改用换算模式。");
    } finally {
      setBusy(false);
    }
  };

  const exportAllData = async () => {
    setExporting(true);
    setExportError("");
    setExportMessage("");
    try {
      const [latestConfig, segments] = await Promise.all([
        api.configuration(),
        collectAllSegments(({ offset, limit, includeDeleted, signal }) => (
          api.segments({ offset, limit, includeDeleted }, { signal })
        )),
      ]);
      const payload = buildTimeOSExport(latestConfig, segments);
      const blobUrl = URL.createObjectURL(new Blob(
        [serializeTimeOSExport(payload)],
        { type: "application/json;charset=utf-8" },
      ));
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = timeOSExportFileName(payload.exportedAt);
      anchor.rel = "noopener";
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      setExportMessage(`已导出 ${payload.counts.segments} 条时段（含 ${payload.counts.deletedSegments} 条已删除记录）。`);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "数据导出失败。");
    } finally {
      setExporting(false);
    }
  };

  const timeZoneChanged = !!config && recordTimeZoneSelectionChanged(timeZoneDraft, config);
  const targetTimeZoneLabel = timeZoneDraft
    || (config?.currentSystemTimezone
      ? `当前服务端系统时区（${config.currentSystemTimezone}，保存后冻结）`
      : "无法识别的系统时区");
  const preserveBlocked = !!openSegment || !!openSegmentCheckError;
  const confirmationDescription = timeZoneHistoryMode === "convert"
    ? `记录时区将改为“${targetTimeZoneLabel}”。系统会先备份，再换算全部历史时段的日期与钟点，以保持它们实际发生的时刻。`
    : `记录时区将改为“${targetTimeZoneLabel}”。历史时段的日期与钟点保持不变，只有后续记录、“今天”和统计边界采用新时区。`;

  const meta = SECTION_META[section];

  return <div className="h-full overflow-y-auto pb-6">
    <div className="space-y-6">
    <div>
      <p className="text-xs font-semibold tracking-widest text-muted-foreground">SETTINGS</p>
      <h1 className="serif mt-1 text-3xl">{meta.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{meta.description}</p>
    </div>
    {error && <div className="rounded-lg border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive">{error}</div>}

    {section === "catalog" && <>
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="serif text-xl">分类</h2><p className="mt-1 text-xs text-muted-foreground">每个分类必须归属于固定 nature。</p></div><Button leading={<Plus size={15} />} onClick={() => { setFormError(""); setCategoryDraft({ name: "", nature: "core", keywords: "" }); }}>新建分类</Button></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{config?.categories.map((category) => <CategoryCard key={category.id} category={category} onEdit={() => { setFormError(""); setCategoryDraft({ currentName: category.name, name: category.name, nature: category.nature, keywords: category.keywords.join("，") }); }} onDelete={() => { setDeleteError(""); setDeleteTarget({ entity: "category", name: category.name }); }} />)}</div>
      </Card>
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="serif text-xl">项目</h2><p className="mt-1 text-xs text-muted-foreground">与 FinOS 项目名需要互通含义时，请保持字面一致。</p></div><Button leading={<Plus size={15} />} onClick={() => { setFormError(""); setProjectDraft({ name: "", status: "active" }); }}>新建项目</Button></div>
        <div className="mt-4 divide-y divide-border rounded-lg border border-border">{config?.projects.length ? config.projects.map((project) => <ProjectRow key={project.id} project={project} onEdit={() => { setFormError(""); setProjectDraft({ currentName: project.name, name: project.name, status: project.status }); }} onDelete={() => { setDeleteError(""); setDeleteTarget({ entity: "project", name: project.name }); }} />) : <p className="p-5 text-sm text-muted-foreground">还没有项目。</p>}</div>
      </Card>
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="serif text-xl">数据主权</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">下载完整 JSON：当前配置、分类、项目以及全部有效和已删除时段。导出文件不包含本地访问密钥。</p></div>
          <Button leading={<Download size={15} />} loading={exporting} onClick={() => { void exportAllData(); }}>导出全部数据</Button>
        </div>
        {exportError && <div role="alert" className="mt-3 rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-sm text-destructive">{exportError}</div>}
        {exportMessage && <p role="status" className="mt-3 text-sm text-success">{exportMessage}</p>}
      </Card>
      <Card className="p-5"><h2 className="serif text-xl">本地访问密钥</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Token 保存在当前浏览器 localStorage，并通过 Authorization Bearer 头发送给 127.0.0.1 上的 TimeOS。首次带 `?token=` 打开时，页面会立刻保存并从地址栏删除。退出登录会清除本浏览器保存的 Token。</p></Card>
      <CategoryModal draft={categoryDraft} busy={busy} error={formError} onChange={setCategoryDraft} onClose={() => { setCategoryDraft(null); setFormError(""); }} onSave={saveCategory} />
      <ProjectModal draft={projectDraft} busy={busy} error={formError} onChange={setProjectDraft} onClose={() => { setProjectDraft(null); setFormError(""); }} onSave={saveProject} />
      <AlertDialog open={!!deleteTarget} title={`删除${deleteTarget?.entity === "category" ? "分类" : "项目"}？`} description={deleteTarget ? `“${deleteTarget.name}”将从有效清单移除，历史时段快照不受影响。` : ""} error={deleteError} tone="destructive" confirmLabel="确认删除" busy={busy} onConfirm={remove} onCancel={() => { setDeleteTarget(null); setDeleteError(""); }} />
    </>}

    {section === "week-start" && <>
      <Card className="p-5 lg:max-w-xl"><h2 className="serif text-xl">统计周起点</h2><p className="mt-1 text-xs text-muted-foreground">只影响统计页“本周”快捷区间。</p><div className="mt-4 flex gap-2"><button disabled={busy} onClick={() => updateWeekStart("monday")} className={`rounded-md border px-4 py-2 text-sm ${config?.settings.weekStart === "monday" ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>周一</button><button disabled={busy} onClick={() => updateWeekStart("sunday")} className={`rounded-md border px-4 py-2 text-sm ${config?.settings.weekStart === "sunday" ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>周日</button></div></Card>
    </>}

    {section === "timezone" && <>
      <Card className="p-5 lg:max-w-3xl">
        <div className="flex items-start gap-3"><Globe2 size={18} className="mt-0.5 text-primary" /><div><h2 className="serif text-xl">记录时区</h2><p className="mt-1 text-xs text-muted-foreground">决定“今天”、统计边界以及所有本地分钟的解释口径。</p></div></div>
        <div className="mt-4"><Autocomplete ariaLabel="记录时区" value={timeZoneDraft} options={timeZoneOptions} onChange={setTimeZoneDraft} searchable searchPlaceholder="搜索 IANA 时区，例如 Shanghai…" emptyText="没有匹配的时区" disabled={!config || busy} /></div>
        {config && <div className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground"><p>当前账本解析时区：<strong className="font-mono font-medium text-foreground">{config.resolvedTimezone}</strong>{config.timezoneSource === "system" ? "（服务端系统来源，已冻结）" : "（显式配置）"}</p><p>当前服务端系统时区：<strong className="font-mono font-medium text-foreground">{config.currentSystemTimezone ?? "无法识别"}</strong></p></div>}
        {systemTimeZoneUnavailable && <div role="alert" className="mt-3 rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs leading-5 text-foreground">当前平台无法识别系统 IANA 时区。账本仍按 {config?.resolvedTimezone} 运行；如需修改，请选择一个具体 IANA 时区。</div>}
        {systemTimeZoneDrift && <div role="alert" className="mt-3 rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs leading-5 text-foreground">系统时区已从 {config?.resolvedTimezone} 变为 {config?.currentSystemTimezone}。账本仍按原时区运行；如需重新采用当前系统时区，请选择历史处理方式后保存。</div>}
        <fieldset className="mt-4" disabled={!config || busy}>
          <legend className="text-sm font-medium">历史时间处理</legend>
          <div className="mt-2 grid gap-2" role="radiogroup" aria-label="历史时间处理方式">
            <label className={`cursor-pointer rounded-lg border p-3 transition-colors ${timeZoneHistoryMode === "convert" ? "border-primary bg-primary/8" : "border-border hover:bg-muted/35"}`}>
              <span className="flex items-start gap-3"><input type="radio" name="timezone-history-mode" value="convert" checked={timeZoneHistoryMode === "convert"} onChange={() => setTimeZoneHistoryMode("convert")} className="mt-1 accent-primary" /><span><span className="block text-sm font-medium">换算历史时间（推荐）</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">保持记录实际发生的时刻；历史日期和钟点会随新时区移动。</span></span></span>
            </label>
            <label className={`rounded-lg border p-3 transition-colors ${preserveBlocked ? "cursor-not-allowed border-border opacity-60" : "cursor-pointer"} ${timeZoneHistoryMode === "preserve" ? "border-primary bg-primary/8" : "border-border hover:bg-muted/35"}`}>
              <span className="flex items-start gap-3"><input type="radio" name="timezone-history-mode" value="preserve" checked={timeZoneHistoryMode === "preserve"} disabled={preserveBlocked} onChange={() => setTimeZoneHistoryMode("preserve")} className="mt-1 accent-primary" /><span><span className="block text-sm font-medium">保留原显示时间</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">历史日期和钟点不变；只让后续记录与统计边界采用新时区。存在进行中时段时不可使用。</span></span></span>
            </label>
          </div>
        </fieldset>
        {openSegment && <div role="alert" className="mt-3 rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs leading-5 text-foreground">“{openSegment.title}”从 {openSegment.startedAt} 起仍在进行。请先结束它，或使用“换算历史时间”。</div>}
        {openSegmentCheckError && <div role="alert" className="mt-3 rounded-md border border-warning/35 bg-warning/8 px-3 py-2 text-xs leading-5 text-foreground">{openSegmentCheckError}</div>}
        <div className="mt-4 flex justify-end"><Button disabled={!timeZoneChanged || busy || (!timeZoneDraft && systemTimeZoneUnavailable)} onClick={() => { void requestTimeZoneConfirmation(); }}>保存时区</Button></div>
      </Card>
      <AlertDialog open={timeZoneConfirmation} title="确认修改记录时区？" description={confirmationDescription} error={timeZoneError} confirmLabel={timeZoneHistoryMode === "convert" ? "确认换算" : "确认保留"} busy={busy} onConfirm={saveTimeZone} onCancel={() => { setTimeZoneConfirmation(false); setTimeZoneError(""); }} />
    </>}
    </div>
  </div>;
}

function CategoryCard({ category, onEdit, onDelete }: { category: Category; onEdit: () => void; onDelete: () => void }) {
  return <div className="rounded-lg border border-border bg-background/45 p-4"><div className="flex items-start gap-3"><Tags size={17} className="mt-0.5 text-primary" /><div className="min-w-0 flex-1"><p className="font-medium">{category.name}</p><p className="mt-1 text-xs text-muted-foreground">{NATURE_LABEL[category.nature]}</p><p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{category.keywords.join(" · ")}</p></div>{!category.protected && <><button aria-label="编辑分类" onClick={onEdit} className="p-1.5 text-muted-foreground hover:text-foreground"><Pencil size={14} /></button><button aria-label="删除分类" onClick={onDelete} className="p-1.5 text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button></>}</div></div>;
}

function ProjectRow({ project, onEdit, onDelete }: { project: Project; onEdit: () => void; onDelete: () => void }) {
  return <div className="flex items-center gap-3 p-4"><FolderKanban size={17} className="text-primary" /><div className="flex-1"><p className="font-medium">{project.name}</p><p className="text-xs text-muted-foreground">{project.status}</p></div><button aria-label="编辑项目" onClick={onEdit} className="p-2 text-muted-foreground hover:text-foreground"><Pencil size={14} /></button><button aria-label="删除项目" onClick={onDelete} className="p-2 text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button></div>;
}

function CategoryModal({ draft, busy, error, onChange, onClose, onSave }: { draft: CategoryDraft | null; busy: boolean; error: string; onChange: Dispatch<SetStateAction<CategoryDraft | null>>; onClose: () => void; onSave: () => void }) {
  const field = <K extends keyof CategoryDraft,>(key: K, value: CategoryDraft[K]) => onChange((current) => current ? { ...current, [key]: value } : null);
  return <Modal open={!!draft} onClose={onClose} title={draft?.currentName ? "修改分类" : "新建分类"} description="保存动作即代表你明确确认这次主数据变更。" error={error} footer={<><Button variant="outline" onClick={onClose}>取消</Button><Button loading={busy} onClick={onSave}>确认保存</Button></>}><div className="space-y-4">{draft && <><TextInput label="名称" value={draft.name} onChange={(event) => field("name", event.target.value)} /><Select label="性质" value={draft.nature} onChange={(event) => field("nature", event.target.value as Nature)} options={NATURE_ORDER.map((nature) => ({ value: nature, label: NATURE_LABEL[nature] }))} /><TextArea label="关键词（逗号分隔）" value={draft.keywords} onChange={(event) => field("keywords", event.target.value)} /></>}</div></Modal>;
}

function ProjectModal({ draft, busy, error, onChange, onClose, onSave }: { draft: ProjectDraft | null; busy: boolean; error: string; onChange: Dispatch<SetStateAction<ProjectDraft | null>>; onClose: () => void; onSave: () => void }) {
  const field = <K extends keyof ProjectDraft,>(key: K, value: ProjectDraft[K]) => onChange((current) => current ? { ...current, [key]: value } : null);
  return <Modal open={!!draft} onClose={onClose} title={draft?.currentName ? "修改项目" : "新建项目"} description="若同一项目也在 FinOS 中使用，请保持名称完全一致。" error={error} footer={<><Button variant="outline" onClick={onClose}>取消</Button><Button loading={busy} onClick={onSave}>确认保存</Button></>}><div className="space-y-4">{draft && <><TextInput label="名称" value={draft.name} onChange={(event) => field("name", event.target.value)} /><Select label="状态" value={draft.status} onChange={(event) => field("status", event.target.value)} options={[{ value: "active", label: "active" }, { value: "paused", label: "paused" }, { value: "completed", label: "completed" }]} /></>}</div></Modal>;
}
