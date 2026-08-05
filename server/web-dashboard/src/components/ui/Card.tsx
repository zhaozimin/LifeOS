/**
 * [INPUT]: 依赖 React div 属性与 clsx。
 * [OUTPUT]: 对外提供统一表面、边框、圆角和可选标题区的 Card。
 * [POS]: components/ui 的页面容器原语；两域合并后由时间与财务全部页面共享同一层级语言。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type Variant = "default" | "muted" | "filled" | "ghost";

interface Props extends HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  padding?: "lg" | "md" | "sm" | "none";
  children: ReactNode;
}

const variantClass: Record<Variant, string> = {
  default: "bg-card/90 text-card-foreground border border-border rounded-lg",
  muted: "bg-muted/35 text-foreground border border-border rounded-lg",
  filled: "bg-primary text-primary-foreground rounded-lg",
  ghost: "bg-transparent text-foreground rounded-lg",
};

const paddingClass = {
  none: "",
  sm: "p-4",
  md: "p-5",
  lg: "p-6",
};

export function Card({ variant = "default", padding = "lg", className, children, ...rest }: Props) {
  return (
    <div className={clsx(variantClass[variant], paddingClass[padding], className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-start justify-between gap-3 mb-4", className)}>
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  description,
}: {
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-title-md text-foreground">{children}</h3>
      {description && (
        <p className="text-[12.5px] text-muted-foreground mt-0.5">{description}</p>
      )}
    </div>
  );
}
