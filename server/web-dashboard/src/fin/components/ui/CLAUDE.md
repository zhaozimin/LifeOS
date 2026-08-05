# ui/
> L2 | 父级: ../CLAUDE.md

成员清单
AlertDialog.tsx: 受控确认与通知弹窗；统一危险操作和单按钮反馈，禁止业务层退回原生 alert/confirm。
Autocomplete.tsx: 自适应选择器；桌面提供可搜索组合框，触屏设备降级为原生 select。

法则: 本目录只保留与共享 `src/components/ui/` 行为真正分叉、合并即改变财务侧现有交互的原语。
其余 12 个原语（Badge/Button/Card/DatePicker/KPICard/Modal/NavigationTile/SegmentedSwitch/
Select/StatusPill/Tabs/TextInput）已并入 `src/components/ui/`，财务页面一律从那里导入，禁止再复制回来。
两处分叉的确切差异写在各自文件的 L3 头部；消解分叉必须先对齐行为，再删副本。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
