/**
 * 全局视角状态：公司 / 个人 / 合并。
 * 切换视角会触发所有数据请求重发（订阅了 viewStore 的组件自动 re-render）。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ViewMode } from "../types";

interface ViewState {
  view: ViewMode;
  setView: (next: ViewMode) => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      view: "combined",
      setView: (next) => set({ view: next }),
    }),
    {
      name: "finance-view",
    },
  ),
);
