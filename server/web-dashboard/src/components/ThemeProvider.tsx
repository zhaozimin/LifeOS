/**
 * [INPUT]: 依赖主题 store、注册表的 applyPalette/getPalette 与 nature 源色令牌映射。
 * [OUTPUT]: 对外提供 ThemeProvider，将亮暗偏好、主题 token、跨模式同源的 nature 色相和 theme-color 同步到 html。
 * [POS]: components 的主题运行时；图表序列可随模式自由变化，nature 始终取亮色序列前四色作为稳定色相来源。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useThemeStore } from "../store/theme";
import { applyPalette, getPalette } from "../theme";
import { NATURE_ORDER, NATURE_SOURCE_TOKEN } from "../lib/nature";

interface Props {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: Props) {
  const preference = useThemeStore((s) => s.preference);
  const palette = useThemeStore((s) => s.palette);
  const setResolved = useThemeStore((s) => s.setResolved);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: "light" | "dark" =
        preference === "system" ? (mql.matches ? "dark" : "light") : preference;
      const root = document.documentElement;
      if (resolved === "dark") root.classList.add("dark");
      else root.classList.remove("dark");

      applyPalette(root, palette, resolved);

      const p = getPalette(palette);
      NATURE_ORDER.forEach((nature, index) => {
        root.style.setProperty(
          NATURE_SOURCE_TOKEN[nature],
          p.series.light[index] || p.light["--primary"],
        );
      });
      const themeColor = p.metaThemeColor[resolved];
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", themeColor);
      setResolved(resolved);
    };
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [preference, palette, setResolved]);

  return <>{children}</>;
}
