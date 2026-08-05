/**
 * [INPUT]: 依赖 zustand persist 与主题注册表的 ThemePaletteId。
 * [OUTPUT]: 对外提供亮暗偏好、解析后模式、主题 ID 及其更新动作。
 * [POS]: web-dashboard 的主题状态真源；ThemeProvider 和 EChart 共同消费，业务页面不另存主题。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ThemePaletteId } from "../theme";

export type ThemePref = "light" | "dark" | "system";

interface ThemeState {
  preference: ThemePref;
  resolved: "light" | "dark";
  palette: ThemePaletteId;
  setPreference: (pref: ThemePref) => void;
  setResolved: (resolved: "light" | "dark") => void;
  setPalette: (palette: ThemePaletteId) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: "system",
      resolved: "light",
      palette: "claude",
      setPreference: (pref) => set({ preference: pref }),
      setResolved: (resolved) => set({ resolved }),
      setPalette: (palette) => set({ palette }),
    }),
    {
      name: "lifeos-theme",
      partialize: (state) => ({ preference: state.preference, palette: state.palette }),
    },
  ),
);
