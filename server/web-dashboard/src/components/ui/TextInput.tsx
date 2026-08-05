/**
 * [INPUT]: 依赖 React input 属性、可选前后内容与 clsx。
 * [OUTPUT]: 对外提供标签、提示、错误与焦点状态统一的 TextInput 和 TextArea。
 * [POS]: components/ui 的文本输入原语；两域表单共享，TextArea 仅时间侧关键词编辑使用，本体不承担业务字段验证。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import clsx from "clsx";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  containerClassName?: string;
}

export const TextInput = forwardRef<HTMLInputElement, Props>(function TextInput(
  { label, hint, error, leading, trailing, className, containerClassName, ...rest },
  ref,
) {
  return (
    <label className={clsx("block", containerClassName)}>
      {label && (
        <span className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground block mb-1.5">
          {label}
        </span>
      )}
      <span
        className={clsx(
          "flex items-center gap-2 h-10 px-3 rounded-md bg-background/70 border transition-colors text-[13.5px]",
          error
            ? "border-destructive"
            : "border-border focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/30",
        )}
      >
        {leading && <span className="text-muted-foreground">{leading}</span>}
        <input
          ref={ref}
          className={clsx(
            "flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground/70",
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
            className,
          )}
          {...rest}
        />
        {trailing && <span className="text-muted-foreground">{trailing}</span>}
      </span>
      {(hint || error) && (
        <span className={clsx("text-[11.5px] mt-1 block", error ? "text-destructive" : "text-muted-foreground")}>
          {error || hint}
        </span>
      )}
    </label>
  );
});

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  containerClassName?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, className, containerClassName, ...rest },
  ref,
) {
  return (
    <label className={clsx("block", containerClassName)}>
      {label && <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>}
      <textarea
        ref={ref}
        className={clsx(
          "min-h-20 w-full resize-y rounded-md border bg-background/70 px-3 py-2.5 text-[13.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/30",
          error ? "border-destructive" : "border-border",
          className,
        )}
        {...rest}
      />
      {(hint || error) && <span className={clsx("mt-1 block text-[11.5px]", error ? "text-destructive" : "text-muted-foreground")}>{error || hint}</span>}
    </label>
  );
});
