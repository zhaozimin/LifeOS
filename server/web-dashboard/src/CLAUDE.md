# src/
> L2 | 父级: ../CLAUDE.md

成员清单
App.tsx: 认证四态、双域 history 路由、默认今天页与记录时区真源（写入口经 RecordTimeZoneProvider 下放给设置面板）。
main.tsx: 浏览器启动点；首帧清理同源旧 FinOS Token、主题和 Service Worker。
api/: core/time/fin 三层 API；唯一 Bearer Token 和域前缀真源。
components/: 无业务请求的统一 shell、导航、认证门、主题及时间 UI 基础原语。
fin/: 财务状态、流水、资金流、报销链、图表与页面级时间范围控件。
pages/: 时间域今天、统计、设计系统和设置页。
settings/: 分组设置注册表与 lazy 深链；MVP 不注册货币和周期账目入口，时间组 section 与财务组 initialPanel 共用「一个菜单项一屏」契约。
theme/: 71 套主题的单一真源，按 palette 分片以保持单文件上限。
lib/: 时间投影、导出、时间轴及无副作用转换。
store/: LifeOS 主题唯一持久化状态。
types.ts: 时间健康、时间域响应与双域共用的 AuditEvent 修改版本类型；财务业务类型在 fin/types.ts。

法则：shell 只调 health；time 与 fin API 物理分离；所有业务请求按域下沉；Token 仅存 `lifeos-token`。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
