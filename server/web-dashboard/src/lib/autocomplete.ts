/**
 * [INPUT]: 依赖调用方提供的可禁用选项、当前值以及搜索结果顺序。
 * [OUTPUT]: 对外提供组合框打开和搜索时的确定性活动项索引计算。
 * [POS]: lib 的无 DOM 选择器状态规则；Autocomplete 负责焦点与 Portal，不再重复发明索引回退语义。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export interface SelectableOption {
  value: string;
  disabled?: boolean;
}

export function firstEnabledOptionIndex(options: readonly SelectableOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

export function selectedOptionIndex(
  options: readonly SelectableOption[],
  value: string,
): number {
  const selected = options.findIndex((option) => option.value === value && !option.disabled);
  return selected >= 0 ? selected : Math.max(0, firstEnabledOptionIndex(options));
}
