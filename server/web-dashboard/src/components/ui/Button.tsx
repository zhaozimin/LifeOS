/**
 * [INPUT]: 依赖 React button 属性与 clsx。
 * [OUTPUT]: 对外提供语义变体、尺寸、图标和 loading 状态统一的 Button。
 * [POS]: components/ui 的动作原语；页面通过语义变体表达层级，不重复按钮样式。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type Variant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "icon"
  | "text";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "md" | "sm" | "lg";
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
}

const baseClass =
  "inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150 disabled:cursor-not-allowed select-none whitespace-nowrap";

const sizeClass = {
  lg: "h-11 px-5 text-[14.5px] rounded-md",
  md: "h-9 px-4 text-[13.5px] rounded-md",
  sm: "h-8 px-3 text-[12.5px] rounded-md",
};

const variantClass: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 shadow-sm",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 border border-border",
  outline:
    "bg-card/80 text-foreground border border-border hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
  ghost:
    "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50",
  icon:
    "rounded-md w-9 h-9 p-0 bg-card/70 border border-border text-foreground hover:bg-accent hover:text-accent-foreground",
  text:
    "bg-transparent text-muted-foreground hover:text-foreground disabled:opacity-50",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "primary",
    size = "md",
    leading,
    trailing,
    loading,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const isIcon = variant === "icon";
  return (
    <button
      ref={ref}
      className={clsx(baseClass, !isIcon && sizeClass[size], variantClass[variant], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
});
