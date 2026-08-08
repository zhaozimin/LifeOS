/**
 * [INPUT]: 依赖可取消的时段/统计/configuration API（含超长软标记阈值）、Layout 软刷新信号、记录时区与 UTC 当前瞬间、timeline 缩放/交互真源、日/周时间轴组件及共享编辑确认原语。
 * [OUTPUT]: 对外提供只接受最新请求、进行中摘要逐分钟更新、DST 真实时长投影、跨午夜跟随今日的日/周时间账、编辑/软删除及全部灰色删除线修改痕迹。
 * [POS]: pages 的时间账浏览核心；同时向时间轴下发墙钟当前分钟、绝对当前瞬间与服务端超长阈值（配置未到手即传 null），最后写入权、局部回填和手势几何下沉到领域模块。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useOutletContext } from "react-router";
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, History, Trash2 } from "lucide-react";
import { api, ApiError, isAbortError } from "../api/client";
import { addDays, isoDate, isoMinute, rangeForWeek, recordNow, shiftMinutes } from "../lib/dates";
import { deriveDayGaps } from "../lib/timeline";
import { TIMELINE_FIT_ZOOM_ID } from "../lib/timelineInteraction";
import type { TimelineZoomSelection } from "../lib/timelineInteraction";
import { formatMinutes, NATURE_COLOR, NATURE_LABEL, NATURE_ORDER } from "../lib/nature";
import type { ApiErrorBody, AuditEvent, Category, Configuration, Gap, RangeSummary, Segment, SegmentSource } from "../types";
import { RevisionHistoryModal } from "../components/RevisionHistoryModal";
import { AlertDialog } from "../components/ui/AlertDialog";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { SegmentedSwitch } from "../components/ui/SegmentedSwitch";
import { Autocomplete } from "../components/ui/Autocomplete";
import { Select } from "../components/ui/Select";
import { TextArea, TextInput } from "../components/ui/TextInput";
import { DayTimeline } from "../components/timeline/DayTimeline";
import { WeekTimeline } from "../components/timeline/WeekTimeline";
import type { LayoutOutletContext } from "../components/Layout";

type Draft = {
  id?: string;
  title: string;
  categoryName: string;
  projectName: string;
  startedAt: string;
  endedAt: string;
  deductionMinutes: string;
  deductionNote: string;
  note: string;
};

const emptyDraft: Draft = { title: "", categoryName: "未归类", projectName: "", startedAt: "", endedAt: "", deductionMinutes: "0", deductionNote: "", note: "" };
type ViewMode = "day" | "week";
type SegmentFormError = { message: string; conflicts: NonNullable<ApiErrorBody["conflicts"]> };

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(day: string) {
  return `${day} · ${WEEKDAY[new Date(`${day}T12:00:00`).getDay()]}`;
}

function rangeLabel(from: string, to: string) {
  return `${from} – ${to}`;
}

function blankDraft(recordTimeZone: string, day: string, gap?: Gap): Draft {
  const now = recordNow(recordTimeZone);
  const today = isoDate(now);
  if (gap) return { ...emptyDraft, startedAt: gap.start, endedAt: gap.end };
  if (day !== today) return { ...emptyDraft, startedAt: `${day}T09:00`, endedAt: `${day}T10:00` };
  // 走 shiftMinutes 而非本地 setMinutes：now 是墙钟载体，本地字段读写会在
  // 浏览器时区的 DST 缺失小时里把「一小时前」抹平成零长度草稿。
  return { ...emptyDraft, startedAt: isoMinute(shiftMinutes(now, -60)), endedAt: isoMinute(now) };
}

export function DayPage({ recordTimeZone }: { recordTimeZone: string }) {
  const { refreshKey } = useOutletContext<LayoutOutletContext>();
  const [instant, setInstant] = useState(() => new Date());
  const tick = useMemo(() => recordNow(recordTimeZone, instant), [instant, recordTimeZone]);
  const today = isoDate(tick);
  const nowMinute = isoMinute(tick);
  const nowUtc = instant.toISOString();
  const [anchorDay, setAnchorDay] = useState(today);
  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [zoomId, setZoomId] = useState<TimelineZoomSelection>(TIMELINE_FIT_ZOOM_ID);
  const [calloutsEnabled, setCalloutsEnabled] = useState(true);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [summary, setSummary] = useState<RangeSummary | null>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [source, setSource] = useState<"all" | SegmentSource>("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<SegmentFormError | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<AuditEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const loadGeneration = useRef(0);
  const summaryGeneration = useRef(0);
  const previousToday = useRef(today);
  const range = useMemo<[string, string]>(() => (
    viewMode === "day"
      ? [anchorDay, anchorDay]
      : rangeForWeek(anchorDay, configuration?.settings.weekStart || "monday")
  ), [anchorDay, configuration?.settings.weekStart, viewMode]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const config = await api.configuration({ signal });
      const nextRange: [string, string] = viewMode === "day"
        ? [anchorDay, anchorDay]
        : rangeForWeek(anchorDay, config.settings.weekStart);
      const result = await api.segments(
        { from: `${nextRange[0]}T00:00`, to: `${addDays(nextRange[1], 1)}T00:00` },
        { signal },
      );
      if (signal?.aborted || generation !== loadGeneration.current) return;
      setConfiguration(config);
      setSegments(result.segments);
    } catch (caught) {
      if (!isAbortError(caught) && generation === loadGeneration.current) {
        setError(caught instanceof Error ? caught.message : "加载时间账失败。");
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [anchorDay, viewMode]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);
  useEffect(() => {
    setInstant(new Date());
    const timer = window.setInterval(() => setInstant(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [recordTimeZone]);
  useEffect(() => {
    const priorToday = previousToday.current;
    previousToday.current = today;
    if (priorToday !== today) {
      setAnchorDay((current) => current === priorToday ? today : current);
    }
  }, [today]);

  const loadSummary = useCallback(async (
    signal?: AbortSignal,
    failureMessage = "统计摘要加载失败，请稍后重试。",
  ) => {
    const generation = ++summaryGeneration.current;
    try {
      const nextSummary = await api.summary(range[0], range[1], { signal });
      if (!signal?.aborted && generation === summaryGeneration.current) setSummary(nextSummary);
    } catch (caught) {
      if (!isAbortError(caught) && generation === summaryGeneration.current) setError(failureMessage);
    }
  }, [range]);

  const liveMinute = range[0] <= today && today <= range[1] ? nowMinute : "";
  useEffect(() => {
    const controller = new AbortController();
    void loadSummary(controller.signal);
    return () => controller.abort();
  }, [liveMinute, loadSummary, refreshKey]);

  const gaps = useMemo(
    () => viewMode === "day"
      ? deriveDayGaps(segments, anchorDay, nowMinute, { timeZone: recordTimeZone, nowUtc })
      : [],
    [segments, anchorDay, nowMinute, nowUtc, recordTimeZone, viewMode],
  );
  const filtered = useMemo(
    () => source === "all" ? segments : segments.filter((item) => item.source === source),
    [segments, source],
  );
  const distributionTotal = summary?.byNature.reduce((sum, item) => sum + item.grossMinutes, 0) || 0;

  const navigate = (amount: number) => {
    setAnchorDay((current) => addDays(current, amount * (viewMode === "week" ? 7 : 1)));
  };

  const showHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      setHistoryEvents(await api.auditEvents());
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "修改痕迹读取失败。");
    } finally {
      setHistoryLoading(false);
    }
  };

  const edit = (segment: Segment) => {
    setDraftError(null);
    setDraft({
      id: segment.id, title: segment.title, categoryName: segment.category.name,
      projectName: segment.projectName || "", startedAt: segment.startedAt, endedAt: segment.endedAt || "",
      deductionMinutes: String(segment.deductionMinutes), deductionNote: segment.deductionNote || "", note: segment.note || "",
    });
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.title.trim() || !draft.categoryName || !draft.startedAt) {
      setDraftError({ message: "请填写事项、分类和开始时间。", conflicts: [] });
      return;
    }
    setSaving(true);
    setDraftError(null);
    const body: Record<string, unknown> = {
      title: draft.title.trim(), categoryName: draft.categoryName,
      projectName: draft.projectName || null, startedAt: draft.startedAt,
      endedAt: draft.endedAt || null, deductionMinutes: Number(draft.deductionMinutes || 0),
      deductionNote: draft.deductionNote || null, note: draft.note || null,
    };
    if (!draft.id) body.source = "manual";
    try {
      if (draft.id) await api.updateSegment(draft.id, body);
      else await api.createSegment(body);
      setDraft(null);
      await load();
      await loadSummary(undefined, "时段已保存，但统计摘要刷新失败；重新载入页面即可恢复。");
    } catch (caught) {
      const body = caught instanceof ApiError && caught.body && typeof caught.body === "object"
        ? caught.body as ApiErrorBody
        : null;
      setDraftError({
        message: caught instanceof ApiError ? caught.message : "保存时段失败。",
        conflicts: body?.conflicts || [],
      });
    } finally {
      setSaving(false);
    }
  };

  const updateSegmentTime = useCallback(async (
    segment: Segment,
    changes: { startedAt?: string; endedAt?: string },
  ): Promise<Segment> => {
    setError("");
    try {
      const result = await api.updateSegment(segment.id, changes);
      setSegments((current) => current.map((item) => (
        item.id === result.segment.id ? result.segment : item
      )));
      void loadSummary(undefined, "时段已保存，但统计摘要刷新失败；重新载入页面即可恢复。");
      return result.segment;
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "调整时段失败。";
      await load();
      setError(message);
      throw caught;
    }
  }, [load, loadSummary]);

  const remove = async () => {
    if (!deleteTarget) return;
    const removedId = deleteTarget.id;
    setSaving(true);
    setDeleteError("");
    try {
      await api.deleteSegment(removedId, "在今日页确认删除");
      setSegments((current) => current.filter((item) => item.id !== removedId));
      setDeleteTarget(null);
      void loadSummary(undefined, "时段已删除，但统计摘要刷新失败；时间轴记录不受影响。");
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "删除失败。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5">
      <div className="flex flex-none flex-wrap items-center gap-2.5">
        <h1 className="serif text-xl leading-none">时间流向</h1>
        <p className="text-[13px] text-muted-foreground">
          {viewMode === "day" ? dayLabel(range[0]) : rangeLabel(range[0], range[1])}
        </p>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="icon" aria-label="上一周期" onClick={() => navigate(-1)}>
            <ChevronLeft size={16} />
          </Button>
          <Button variant="outline" leading={<CalendarDays size={15} />} onClick={() => setAnchorDay(today)}>
            今天
          </Button>
          <Button variant="icon" aria-label="下一周期" onClick={() => navigate(1)}>
            <ChevronRight size={16} />
          </Button>
          <SegmentedSwitch
            value={viewMode}
            options={[{ value: "day", label: "日" }, { value: "week", label: "周" }]}
            onChange={setViewMode}
            ariaLabel="时间视图"
          />
          <Button variant="outline" leading={<History size={15} />} onClick={() => void showHistory()}>
            修改痕迹
          </Button>
          <Button
            leading={<CalendarPlus size={15} />}
            onClick={() => { setDraftError(null); setDraft(blankDraft(recordTimeZone, anchorDay, gaps[0])); }}
          >
            补录时段
          </Button>
        </div>
      </div>
      {error && <div className="rounded-lg border border-destructive/35 bg-destructive/8 px-4 py-3 text-sm text-destructive">{error}</div>}
      <Card className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span><i className="text-xs not-italic text-muted-foreground">有效创作</i> <strong className="ml-1 tabular-nums">{formatMinutes(summary?.effectiveWorkMinutes || 0)}</strong></span>
            <span><i className="text-xs not-italic text-muted-foreground">已记录</i> <strong className="ml-1 tabular-nums">{formatMinutes(summary?.recordedMinutes || 0)}</strong></span>
            <span><i className="text-xs not-italic text-muted-foreground">覆盖率</i> <strong className="ml-1 tabular-nums">{((summary?.coverage || 0) * 100).toFixed(1)}%</strong></span>
            <span><i className="text-xs not-italic text-muted-foreground">空白</i> <strong className="ml-1 tabular-nums">{formatMinutes(summary?.gapMinutes || 0)}</strong></span>
          </div>
          <div className="flex h-2.5 min-w-40 flex-1 overflow-hidden rounded-full bg-muted" aria-label="性质时间分配">
            {distributionTotal > 0 && NATURE_ORDER.map((nature) => {
              const minutes = summary?.byNature.find((item) => item.nature === nature)?.grossMinutes || 0;
              return minutes > 0 ? (
                <span
                  key={nature}
                  style={{
                    width: `${minutes / distributionTotal * 100}%`,
                    background: NATURE_COLOR[nature],
                  }}
                  title={`${NATURE_LABEL[nature]} · ${formatMinutes(minutes)}`}
                />
              ) : null;
            })}
          </div>
          <div className="flex flex-wrap gap-2.5 text-[11.5px] text-muted-foreground">
            {NATURE_ORDER.map((nature) => (
              <span key={nature} className="inline-flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full" style={{ background: NATURE_COLOR[nature] }} />
                {NATURE_LABEL[nature]}
              </span>
            ))}
          </div>
          <select value={source} onChange={(event) => setSource(event.target.value as typeof source)} className="h-8 rounded-md border border-border bg-background px-2 text-xs"><option value="all">全部来源</option><option value="agent">AI</option><option value="manual">手动</option><option value="import">导入</option></select>
      </Card>
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        {loading && <p className="p-5 text-sm text-muted-foreground">正在读取本地时间账…</p>}
        {!loading && viewMode === "day" && (
          <DayTimeline
            day={range[0]}
            segments={filtered}
            allSegments={segments}
            gaps={gaps}
            nowMinute={nowMinute}
            nowUtc={nowUtc}
            recordTimeZone={recordTimeZone}
            overlongSegmentMinutes={configuration?.overlongSegmentMinutes ?? null}
            natureColors={NATURE_COLOR}
            zoomId={zoomId}
            calloutsEnabled={calloutsEnabled}
            onZoomChange={setZoomId}
            onCalloutsEnabledChange={setCalloutsEnabled}
            onEdit={edit}
            onFillGap={(gap) => { setDraftError(null); setDraft(blankDraft(recordTimeZone, anchorDay, gap)); }}
            onTimeChange={updateSegmentTime}
          />
        )}
        {!loading && viewMode === "week" && (
          <WeekTimeline
            from={range[0]}
            to={range[1]}
            segments={filtered}
            nowMinute={nowMinute}
            nowUtc={nowUtc}
            recordTimeZone={recordTimeZone}
            natureColors={NATURE_COLOR}
            overlongSegmentMinutes={configuration?.overlongSegmentMinutes ?? null}
            zoomId={zoomId}
            onZoomChange={setZoomId}
            onEdit={edit}
          />
        )}
      </Card>

      <SegmentModal
        draft={draft}
        categories={configuration?.categories || []}
        projects={configuration?.projects || []}
        saving={saving}
        error={draftError}
        onChange={setDraft}
        onClose={() => { setDraft(null); setDraftError(null); }}
        onSave={save}
        onDelete={(segmentId) => {
          const segment = segments.find((item) => item.id === segmentId);
          if (!segment) return;
          setDeleteError("");
          setDraft(null);
          setDeleteTarget(segment);
        }}
      />
      <AlertDialog open={!!deleteTarget} title="删除这条时段？" description={deleteTarget ? `${deleteTarget.title} · ${deleteTarget.startedAt.slice(11)}–${deleteTarget.endedAt?.slice(11) || "进行中"}。删除后统计会立即排除，v1 不提供恢复入口。` : ""} error={deleteError} tone="destructive" confirmLabel="确认删除" busy={saving} onConfirm={remove} onCancel={() => { setDeleteTarget(null); setDeleteError(""); }} />
      <RevisionHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} events={historyEvents} loading={historyLoading} error={historyError} entityType="segment" />
    </div>
  );
}

function SegmentModal({ draft, categories, projects, saving, error, onChange, onClose, onSave, onDelete }: { draft: Draft | null; categories: Category[]; projects: Configuration["projects"]; saving: boolean; error: SegmentFormError | null; onChange: Dispatch<SetStateAction<Draft | null>>; onClose: () => void; onSave: () => void; onDelete: (segmentId: string) => void }) {
  const field = (key: keyof Draft, value: string) => onChange((current) => current ? { ...current, [key]: value } : null);
  const footer = <div className="flex w-full items-center justify-between gap-3">
    <div>{draft?.id && <Button variant="destructive" leading={<Trash2 size={15} />} onClick={() => onDelete(draft.id!)}>删除</Button>}</div>
    <div className="flex gap-2.5"><Button variant="outline" onClick={onClose}>取消</Button><Button loading={saving} onClick={onSave}>保存</Button></div>
  </div>;
  const errorContent = error ? <><p>{error.message}</p>{error.conflicts.length > 0 && <ul className="mt-1 list-disc pl-5">{error.conflicts.map((conflict) => <li key={conflict.id}>{conflict.title} · {conflict.startedAt.slice(11)}–{conflict.endedAt?.slice(11) || "进行中"}</li>)}</ul>}</> : undefined;
  return <Modal open={!!draft} onClose={onClose} title={draft?.id ? "编辑时段" : "补录时段"} description="所有时间按分钟保存；服务端会检查重叠、顺序和未来时间。" error={errorContent} footer={footer}>
    {draft && <div className="grid gap-4 sm:grid-cols-2">
      <TextInput containerClassName="sm:col-span-2" label="事项" value={draft.title} onChange={(event) => field("title", event.target.value)} />
      <Select label="分类" value={draft.categoryName} onChange={(event) => field("categoryName", event.target.value)} options={categories.map((category) => ({ value: category.name, label: `${category.name} · ${NATURE_LABEL[category.nature]}` }))} />
      <Autocomplete ariaLabel="项目" label="项目" value={draft.projectName} onChange={(value) => field("projectName", value)} options={[{ value: "", label: "无项目" }, ...projects.map((project) => ({ value: project.name, label: project.name }))]} searchable={projects.length > 6} />
      <TextInput label="开始" type="datetime-local" value={draft.startedAt} onChange={(event) => field("startedAt", event.target.value)} />
      <TextInput label="结束" type="datetime-local" value={draft.endedAt} onChange={(event) => field("endedAt", event.target.value)} hint="留空表示进行中。" />
      <TextInput label="扣除分钟" type="number" min="0" value={draft.deductionMinutes} onChange={(event) => field("deductionMinutes", event.target.value)} className="tabular-nums" />
      <TextInput label="扣除说明" value={draft.deductionNote} onChange={(event) => field("deductionNote", event.target.value)} />
      <TextArea containerClassName="sm:col-span-2" label="备注" value={draft.note} onChange={(event) => field("note", event.target.value)} />
    </div>}
  </Modal>;
}
