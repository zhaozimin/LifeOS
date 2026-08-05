/**
 * [INPUT]: 依赖 React Portal、滚动锁、lucide 关闭图标与全局弹层动效。
 * [OUTPUT]: 对外提供统一尺寸、Esc/遮罩关闭、弹窗内错误槽与固定 footer 的 Modal 原语。
 * [POS]: components/ui 的编辑弹层边界；时间补录与两域主数据表单共享，禁止页面复制遮罩逻辑。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { X } from "lucide-react";
import { useBodyScrollLock } from "../../lib/useBodyScrollLock";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  error?: ReactNode;
  size?: "sm" | "md" | "lg";
  lockScroll?: boolean;
  blurBackdrop?: boolean;
}

const sizeClass = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-4xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  error,
  size = "md",
  lockScroll = true,
  blurBackdrop = false,
}: Props) {
  useBodyScrollLock(open && lockScroll);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="关闭"
        className={clsx("animate-overlay-in absolute inset-0 bg-black/50", blurBackdrop && "backdrop-blur-[2px]")}
        onClick={onClose}
      />
      <div
        className={clsx(
          "animate-modal-in relative w-full bg-card text-card-foreground rounded-xl border border-border shadow-2xl flex flex-col max-h-[calc(100vh-3rem)]",
          sizeClass[size],
        )}
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 border-b border-border">
          <div>
            {title && (
              <h2 className="serif text-[22px] font-medium leading-tight">{title}</h2>
            )}
            {description && (
              <p className="text-[12.5px] text-muted-foreground mt-1">{description}</p>
            )}
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <X size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {error && (
          <div role="alert" className="mx-6 mb-3 rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {footer && (
          <footer className="sticky bottom-0 shrink-0 border-t border-border bg-card/95 px-6 pb-5 pt-3 backdrop-blur flex justify-end gap-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
