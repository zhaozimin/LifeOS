import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw, X } from "lucide-react";
import {
  WIDGET_LABEL,
  useDashboardLayoutStore,
  type DashboardWidget,
  type DashboardWidgetId,
} from "../store/dashboardLayout";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DashboardCustomizer({ open, onClose }: Props) {
  const widgets = useDashboardLayoutStore((s) => s.widgets);
  const toggle = useDashboardLayoutStore((s) => s.toggle);
  const move = useDashboardLayoutStore((s) => s.move);
  const reorder = useDashboardLayoutStore((s) => s.reorder);
  const reset = useDashboardLayoutStore((s) => s.reset);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = widgets.findIndex((w) => w.id === active.id);
    const newIndex = widgets.findIndex((w) => w.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(widgets, oldIndex, newIndex);
    reorder(next.map((w) => w.id));
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="relative ml-auto flex h-full w-full max-w-[480px] flex-col bg-background shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-display-sm">自定义仪表盘</h2>
            <p className="text-body-sm text-muted-foreground">
              拖拽 <GripVertical size={12} className="inline-block align-middle" /> 排序，或用 ↑↓ 按钮移动；眼睛切换显隐。变更立即保存到本地。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={widgets.map((w) => w.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {widgets.map((w, index) => (
                  <SortableRow
                    key={w.id}
                    widget={w}
                    index={index}
                    last={index === widgets.length - 1}
                    onToggle={() => toggle(w.id)}
                    onMoveUp={() => move(w.id, -1)}
                    onMoveDown={() => move(w.id, 1)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        <footer className="border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RotateCcw size={13} />
            恢复默认顺序
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

function SortableRow({
  widget,
  index,
  last,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  widget: DashboardWidget;
  index: number;
  last: boolean;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.85 : 1,
    boxShadow: isDragging ? "0 12px 32px rgba(0,0,0,0.18)" : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-2 py-2.5"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
        aria-label="拖拽排序"
      >
        <GripVertical size={14} />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{index + 1}</span>
        <span
          className={`text-[13.5px] ${widget.visible ? "text-foreground" : "text-muted-foreground line-through"}`}
        >
          {WIDGET_LABEL[widget.id as DashboardWidgetId] || widget.id}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={index === 0}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="上移"
        >
          <ArrowUp size={14} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={last}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="下移"
        >
          <ArrowDown size={14} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${
            widget.visible
              ? "text-emerald-600 hover:bg-emerald-500/10"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
          aria-label={widget.visible ? "隐藏" : "显示"}
        >
          {widget.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
      </div>
    </div>
  );
}
