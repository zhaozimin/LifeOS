/**
 * [INPUT]: 依赖财务时间范围 store 与 rangeBucket 的日期区间编码。
 * [OUTPUT]: 提供财务页共享的自定义起止日期抽屉。
 * [POS]: FinOS 旧壳日历下放后的页面级控件；不属于全局导航或 shell 状态。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { CalendarDays, X } from "lucide-react";
import { useEffect, useState } from "react";
import { rangeBucket } from "../lib/timeRange";
import { useTimeRangeStore } from "../store/timeRange";

function localIsoDate(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

export function FinCalendarDrawer() {
  const [open, setOpen] = useState(false);
  const { dimension, bucket, setDimension, setBucket } = useTimeRangeStore();
  const [from, setFrom] = useState(localIsoDate(new Date()));
  const [to, setTo] = useState(localIsoDate(new Date()));

  useEffect(() => {
    if (dimension !== "custom" || !bucket.includes("..")) return;
    const [start, end] = bucket.split("..");
    if (start) setFrom(start);
    if (end) setTo(end);
  }, [bucket, dimension]);

  const apply = () => {
    if (!from || !to) return;
    const [start, end] = from <= to ? [from, to] : [to, from];
    setDimension("custom");
    setBucket(rangeBucket(new Date(`${start}T12:00:00`), new Date(`${end}T12:00:00`)));
    setOpen(false);
  };

  return <>
    <button type="button" onClick={() => setOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs hover:bg-accent">
      <CalendarDays size={14} />日历区间
    </button>
    {open && <div className="fixed inset-0 z-[70] flex justify-end bg-black/35" role="dialog" aria-modal="true" aria-label="财务日历区间">
      <section className="h-full w-full max-w-sm border-l border-border bg-background p-5 shadow-2xl">
        <div className="flex items-center justify-between"><div><h2 className="serif text-xl">流水日历</h2><p className="mt-1 text-sm text-muted-foreground">选择财务视图的自定义统计区间。</p></div><button type="button" aria-label="关闭日历" onClick={() => setOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"><X size={17} /></button></div>
        <div className="mt-7 grid gap-4">
          <label className="grid gap-2 text-sm font-medium">开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-10 rounded-md border border-border bg-card px-3" /></label>
          <label className="grid gap-2 text-sm font-medium">结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-10 rounded-md border border-border bg-card px-3" /></label>
          <button type="button" onClick={apply} disabled={!from || !to} className="mt-2 h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">应用区间</button>
        </div>
      </section>
    </div>}
  </>;
}
