# pages/
> L2 | 父级: ../CLAUDE.md

成员清单
DayPage.tsx: 按服务端记录时区加载可导航的日/周账本；同时下发墙钟当前分钟与 UTC 当前瞬间，DST 时长服从 UTC，AbortSignal/请求代次阻止旧覆盖，进行中范围逐分钟刷新并在跨午夜时有条件跟随今天；修改痕迹入口读取本地审计版本，旧内容统一灰色删除线且不参与统计。
DesignSystemPage.tsx: 视觉真源的只读活文档；实时读取 CSS token、71 套主题注册表、nature 语义色、图表系列桥与真实 UI 原语，并以亮暗并排色相角自证 nature 锁色相契约。
StatsPage.tsx: 以 mode/range 单状态按记录时区确定快捷范围；刷新保持自定义选择，AbortSignal/代次保证最后响应，含今日时逐分钟更新 KPI 与三类图表。
SettingsPage.tsx: 按 section 分区渲染主数据 / 周起点 / 记录时区迁移三屏（与财务侧 initialPanel 同构，一个菜单项只落一屏）；并列展示非空 resolvedTimezone 账本真源和 nullable currentSystemTimezone 候选，候选不可识别时禁用 system 入口并要求显式 IANA，可识别且漂移时才允许 blank→blank 配合 historyMode 重新采用，preserve 继续 fail-closed；迁移成功后经 onRecordTimeZoneChange 回流 App，日/统计页立即换口径重绘。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
