/**
 * [INPUT]: 依赖根 store/theme 的 LifeOS 全局主题状态。
 * [OUTPUT]: 向财务图表保留 `useThemeStore` 兼容导出。
 * [POS]: 防止迁入页面另起 finance-theme 状态源。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export { useThemeStore, type ThemePref } from "../../store/theme";
