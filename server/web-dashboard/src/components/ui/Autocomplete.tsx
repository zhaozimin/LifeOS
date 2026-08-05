/**
 * [INPUT]: 依赖 react、react-dom 的 createPortal、lucide 的 Check/ChevronsUpDown/Search、clsx、lib/autocomplete 索引规则与同目录 Select。
 * [OUTPUT]: 对外提供 Autocomplete（自适应下拉：桌面(细指针)渲染 shadcn 风 Combobox，
 *   移动/触屏(粗指针)渲染原生 <select> 唤起系统自带 picker；size md/sm 两档）与 useCoarsePointer。
 * [POS]: components/ui 的可搜索下拉原语；作为 FinOS 同源兼容组件保留，当前 TimeOS 小枚举表单优先原生 select。
 *   自适应判据：matchMedia('(pointer: coarse)')，可随外接鼠标/设备旋转实时切换。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import clsx from "clsx";
import { firstEnabledOptionIndex, selectedOptionIndex } from "../../lib/autocomplete";
import { Select } from "./Select";

export interface AutocompleteOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: AutocompleteOption[];
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** 是否显示搜索框（桌面 Combobox）。缺省：选项 > 6 才显示，小枚举不显示。 */
  searchable?: boolean;
  /** 尺寸：md=h-10（表单默认）；sm=h-8（侧栏 / 表格行内等紧凑场景）。 */
  size?: "md" | "sm";
  /** 加在触发器上的类名（例如宽度）。 */
  className?: string;
  ariaLabel?: string;
}

interface Placement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

const MENU_GAP = 4;
const MIN_MENU_SPACE = 200;
const SEARCH_THRESHOLD = 6;

/** 主指针是否为粗指针（触屏）。手机/平板 true，桌面鼠标 false；外接设备变化时实时更新。 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return coarse;
}

export function Autocomplete({
  value,
  options,
  onChange,
  label,
  hint,
  placeholder = "请选择…",
  searchPlaceholder = "搜索…",
  emptyText = "无匹配项",
  disabled,
  searchable,
  size = "md",
  className,
  ariaLabel,
}: Props) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousQueryRef = useRef(query);
  const listId = useId();

  const showSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const selected = useMemo(() => options.find((option) => option.value === value), [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !showSearch) return options;
    return options.filter((option) => option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q));
  }, [options, query, showSearch]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUp = spaceBelow < MIN_MENU_SPACE && spaceAbove > spaceBelow;
    setPlacement({
      left: rect.left,
      width: rect.width,
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + MENU_GAP, maxHeight: Math.max(140, spaceAbove - 12) }
        : { top: rect.bottom + MENU_GAP, maxHeight: Math.max(140, spaceBelow - 12) }),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    // 有搜索框聚焦搜索框；无搜索框（小枚举）聚焦列表容器以接收键盘
    (showSearch ? inputRef.current : menuRef.current)?.focus();
    setActiveIndex(selectedOptionIndex(filtered, value));

    const onScrollResize = () => reposition();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reposition, value, showSearch]);

  useEffect(() => {
    const queryChanged = previousQueryRef.current !== query;
    previousQueryRef.current = query;
    if (!open || !queryChanged) return;
    setActiveIndex(Math.max(0, firstEnabledOptionIndex(filtered)));
  }, [filtered, open, query]);

  useEffect(() => {
    if (!open || !menuRef.current) return;
    const node = menuRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const closeAndReset = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const commit = useCallback(
    (option: AutocompleteOption) => {
      if (option.disabled) return;
      onChange(option.value);
      closeAndReset();
      triggerRef.current?.focus();
    },
    [onChange, closeAndReset],
  );

  const moveActive = useCallback(
    (dir: 1 | -1) => {
      if (!filtered.length) return;
      setActiveIndex((prev) => {
        let next = prev;
        for (let step = 0; step < filtered.length; step++) {
          next = (next + dir + filtered.length) % filtered.length;
          if (!filtered[next]?.disabled) return next;
        }
        return prev;
      });
    },
    [filtered],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Enter": {
        event.preventDefault();
        const option = filtered[activeIndex];
        if (option) commit(option);
        break;
      }
      case "Escape":
        event.preventDefault();
        // 阻断原生冒泡：否则 Esc 会同时触发父级 Modal/Sheet 挂在 window 上的关闭监听，
        // 导致一次 Esc 连带把整个编辑弹窗关掉。这里只关下拉。
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation?.();
        closeAndReset();
        triggerRef.current?.focus();
        break;
      case "Tab":
        closeAndReset();
        break;
    }
  };

  // ———— 移动/触屏：原生 <select>，唤起系统自带 picker ————
  const nativeOptions = useMemo(() => {
    if (options.some((option) => option.value === value) || !placeholder) return options;
    return [{ value: value || "", label: placeholder, disabled: true }, ...options];
  }, [options, value, placeholder]);

  if (coarse) {
    return (
      <Select
        label={label}
        hint={hint}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
        options={nativeOptions}
        className={size === "sm" ? "!h-8 text-[13px]" : undefined}
      />
    );
  }

  // ———— 桌面：自绘 Combobox ————
  return (
    <div className="block">
      {label && (
        <span className="mb-1.5 block text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
          {label}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={clsx(
          "flex w-full items-center justify-between gap-2 rounded-md border bg-background/70 transition-colors",
          size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-10 px-3 text-[13.5px]",
          "focus:outline-none focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open ? "border-ring ring-2 ring-inset ring-ring/30" : "border-border",
          className,
        )}
      >
        <span className={clsx("truncate text-left", selected ? "text-foreground" : "text-muted-foreground/80")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown size={15} className="shrink-0 text-muted-foreground/70" aria-hidden />
      </button>
      {hint && <span className="mt-1 block text-[11.5px] text-muted-foreground">{hint}</span>}

      {open &&
        placement &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="fixed z-[90] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg outline-none"
            style={{
              left: placement.left,
              width: placement.width,
              top: placement.top,
              bottom: placement.bottom,
              maxHeight: placement.maxHeight,
            }}
          >
            {showSearch && (
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search size={14} className="shrink-0 text-muted-foreground/70" aria-hidden />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-activedescendant={filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined}
                  className="h-10 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
                />
              </div>
            )}
            <div
              id={listId}
              role="listbox"
              className="overflow-y-auto p-1"
              style={{ maxHeight: placement.maxHeight - (showSearch ? 42 : 0) }}
            >
              {filtered.length === 0 ? (
                <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">{emptyText}</div>
              ) : (
                filtered.map((option, index) => {
                  const isSelected = option.value === value;
                  const isActive = index === activeIndex;
                  return (
                    <button
                      key={option.value}
                      id={`${listId}-${index}`}
                      data-index={index}
                      role="option"
                      aria-selected={isSelected}
                      type="button"
                      disabled={option.disabled}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => commit(option)}
                      className={clsx(
                        "flex w-full items-center gap-2 rounded-[5px] px-2.5 py-2 text-left text-[13.5px] transition-colors",
                        option.disabled
                          ? "cursor-not-allowed text-muted-foreground/50"
                          : isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      <Check size={15} className={clsx("shrink-0", isSelected ? "opacity-100" : "opacity-0")} aria-hidden />
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
