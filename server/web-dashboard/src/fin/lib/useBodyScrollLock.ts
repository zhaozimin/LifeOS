/**
 * [INPUT]: 依赖 react 的 useLayoutEffect；依赖 index.css 中 html 的 scrollbar-gutter: stable。
 * [OUTPUT]: 对外提供 useBodyScrollLock —— 弹层打开期间锁定页面滚动（引用计数，支持多层嵌套弹层）。
 * [POS]: lib 层的弹层滚动锁；只做 overflow 锁定，不做 padding 补偿——
 *   滚动条占位由全局 scrollbar-gutter: stable 永久预留，clientWidth 恒定。
 *   历史教训：此处曾叠加 padding-right 补偿，与 gutter 双重补偿导致内容左移抖动 + 右侧露底色白边。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useLayoutEffect } from "react";

let lockCount = 0;
let previousOverflow = "";

function lockBodyScroll() {
  if (typeof window === "undefined") return () => {};

  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }

  lockCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(lockCount - 1, 0);

    if (lockCount === 0) {
      document.body.style.overflow = previousOverflow;
      previousOverflow = "";
    }
  };
}

export function useBodyScrollLock(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    return lockBodyScroll();
  }, [active]);
}
