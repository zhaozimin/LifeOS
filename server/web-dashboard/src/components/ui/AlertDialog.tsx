/**
 * [INPUT]: 依赖 ui/Button、lib/useBodyScrollLock、lucide 图标、index.css 弹层动效类。
 * [OUTPUT]: 对外提供可就地显示失败原因、异步提交期间不可被 Esc 关闭的 AlertDialog —— 确认/通知弹窗（替代浏览器原生 confirm/alert）。
 * [POS]: components/ui 的反馈原语；z-95 站在编辑 Modal 之上，Esc 用捕获阶段拦截以免连带关闭底层弹层；
 *   遮罩不可点击关闭——删除等确认动作必须显式选择。
 *   省略 onCancel 即为单按钮通知形态（替代 alert）。全站禁用原生 confirm/alert。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Button } from "./Button";
import { useBodyScrollLock } from "../../lib/useBodyScrollLock";

interface Props {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** destructive 用于不可恢复操作（红色确认钮 + 警示图标） */
  tone?: "default" | "destructive";
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  /** 省略时为单按钮通知形态（如失败提示，替代 alert） */
  onCancel?: () => void;
}

export function AlertDialog({
  open,
  title,
  description,
  tone = "default",
  confirmLabel = "确认",
  cancelLabel = "取消",
  busy,
  error,
  onConfirm,
  onCancel,
}: Props) {
  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 捕获阶段拦截：不让 Esc 穿透到底层 Modal/Lightbox 的关闭监听
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        (onCancel || onConfirm)();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, open, onCancel, onConfirm]);

  if (!open || typeof document === "undefined") return null;

  const destructive = tone === "destructive";

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="animate-overlay-in absolute inset-0 bg-black/55" aria-hidden />
      <div className="animate-modal-in relative w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-2xl">
        <div className="flex items-start gap-3.5">
          <span
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              destructive ? "bg-destructive/12 text-destructive" : "bg-primary/10 text-primary"
            }`}
            aria-hidden
          >
            {destructive ? <TriangleAlert size={19} /> : <CircleAlert size={19} />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="serif text-[18px] font-medium leading-snug">{title}</h2>
            {description && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
            )}
            {error && (
              <div role="alert" className="mt-3 rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
          )}
          <Button variant={destructive ? "destructive" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
