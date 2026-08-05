/**
 * [INPUT]: 依赖 react-dom 的 createPortal、lucide 的 Calendar/ChevronLeft/ChevronRight、clsx、
 *   同目录 Autocomplete 的 useCoarsePointer。
 * [OUTPUT]: 对外提供 DatePicker —— shadcn Calendar 风格的单日期选择（触发器 + 弹出月历）。
 * [POS]: components/ui 的日期原语；两域合并后的单一实现，财务项目起止/目标日期消费它，
 *   时间统计页仍以原生日期输入完成自定义区间。
 *   自适应：桌面(细指针)弹出主题化月历（今天描边、选中填充、min/max 禁用）；
 *   移动(粗指针)降级为原生 <input type="date"> 唤起系统日期滚轮。值恒为 "YYYY-MM-DD" 或 ""。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import clsx from "clsx";
import { useCoarsePointer } from "./Autocomplete";

interface Props {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  /** 可选边界（含端点），格式 YYYY-MM-DD；界外日期禁选。 */
  min?: string;
  max?: string;
  className?: string;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const MENU_GAP = 4;
const MENU_WIDTH = 280;

function parseIso(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DatePicker({ value, onChange, label, hint, placeholder = "选择日期…", disabled, min, max, className }: Props) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const selected = parseIso(value);
  const [visibleMonth, setVisibleMonth] = useState<Date>(() => selected || new Date());

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 340 && rect.top > spaceBelow) {
      setPos({ left, bottom: window.innerHeight - rect.top + MENU_GAP });
    } else {
      setPos({ left, top: rect.bottom + MENU_GAP });
    }
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    setVisibleMonth(parseIso(value) || new Date());
    const onScrollResize = () => reposition();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 只关日历，不连带关掉父级 Modal/Sheet（它们的 Esc 监听挂在 window 上）
        event.stopImmediatePropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reposition]);

  // ———— 移动/触屏：原生日期输入，唤起系统滚轮 ————
  if (coarse) {
    return (
      <label className={clsx("block", className)}>
        {label && (
          <span className="mb-1.5 block text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">{label}</span>
        )}
        <input
          type="date"
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-md border border-border bg-background/70 px-3 text-[13.5px] text-foreground focus:outline-none focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
        />
        {hint && <span className="mt-1 block text-[11.5px] text-muted-foreground">{hint}</span>}
      </label>
    );
  }

  // ———— 桌面：弹出月历 ————
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const firstOffset = new Date(year, month, 1).getDay();
  const gridStart = new Date(year, month, 1 - firstOffset);
  const todayIso = toIso(new Date());
  const minDate = min ? parseIso(min) : null;
  const maxDate = max ? parseIso(max) : null;

  const commit = (date: Date) => {
    onChange(toIso(date));
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={clsx("block", className)}>
      {label && (
        <span className="mb-1.5 block text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">{label}</span>
      )}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={clsx(
          "flex h-10 w-full items-center gap-2 rounded-md border bg-background/70 px-3 text-[13.5px] transition-colors",
          "focus:outline-none focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open ? "border-ring ring-2 ring-inset ring-ring/30" : "border-border",
        )}
      >
        <CalendarIcon size={15} className="shrink-0 text-muted-foreground/70" aria-hidden />
        <span className={clsx("truncate text-left", value ? "text-foreground" : "text-muted-foreground/80")}>
          {value || placeholder}
        </span>
      </button>
      {hint && <span className="mt-1 block text-[11.5px] text-muted-foreground">{hint}</span>}

      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label="选择日期"
            className="fixed z-[90] rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
            style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: MENU_WIDTH }}
          >
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="上个月"
                onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="text-[13.5px] font-medium">{year} 年 {month + 1} 月</span>
              <button
                type="button"
                aria-label="下个月"
                onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <ChevronRight size={15} />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {WEEKDAYS.map((day) => (
                <span key={day} className="py-1 text-center text-[11px] font-medium text-muted-foreground">{day}</span>
              ))}
              {Array.from({ length: 42 }, (_, index) => {
                const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
                const iso = toIso(date);
                const inMonth = date.getMonth() === month;
                const isSelected = iso === value;
                const isToday = iso === todayIso;
                const outOfRange = (minDate !== null && date < minDate) || (maxDate !== null && date > maxDate);
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={outOfRange}
                    aria-label={iso}
                    aria-pressed={isSelected}
                    onClick={() => commit(date)}
                    className={clsx(
                      "h-8 rounded-md text-[12.5px] tabular-nums transition-colors",
                      isSelected
                        ? "bg-primary font-semibold text-primary-foreground"
                        : outOfRange
                          ? "cursor-not-allowed text-muted-foreground/35"
                          : clsx(
                              "hover:bg-accent hover:text-accent-foreground",
                              inMonth ? "text-foreground" : "text-muted-foreground/45",
                              isToday && "border border-primary/55",
                            ),
                    )}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <button
                type="button"
                onClick={() => commit(new Date())}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                今天
              </button>
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                清除
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
