# web-dashboard/
> L2 | 父级: ../CLAUDE.md

成员清单
src/: LifeOS React 19 前端；共享壳、双域页面、单 Token API 与设置注册表都在此维护。
public/: LifeOS PWA 元数据与品牌图标；绝不放置 Service Worker。
scripts/mirror-dashboard-index.mjs: 构建后将 dashboard 入口镜像到静态根以保持 history 深链 fallback，并把 src/ 的内容指纹写入产物；部署门禁据此判定已提交的 web/ 是否真由当前源码构建，因为忘记构建不会让任何别的测试变红。
index.html: `/dashboard/` SPA 入口，声明 LifeOS 品牌与 PWA 元数据。
package.json: Vite 8 构建、纯函数回归、组件回归与资产镜像命令；`npm test` 串联两套宿主，CI 直接跑它。
package-lock.json: npm 可复现依赖锁。
vite.config.ts: `/dashboard/` base、`../web/dashboard` 发布目录和只接受 `LIFEOS_API_TARGET` 的隔离开发代理。
tsconfig.json / tsconfig.app.json / tsconfig.node.json: 应用与构建脚本分离的 TypeScript 项目引用。
vitest.config.ts / test_setup.ts: 组件回归宿主（happy-dom + @testing-library/react），只收 `test_*.tsx`；setup 里禁掉真实网络，漏网请求当场硬失败而非静默挂起。
test_error_boundary.tsx: 渲染故障隔离的变异锁——兜住 render 期抛出、故障半径止于边界内（顶栏与导航仍可点）、重试复位、resetKey 变化即自救。本项目两次白屏事故的安全网，没验过的安全网不算安全网。
test_chart_tooltip_xss.tsx: tooltip 转义纪律的**调用点**变异锁；mock 图表壳捕获真实 option，取出 formatter 调用后把返回的 HTML 塞进真 DOM，按「有没有危险节点成活」判定。改坏 escapeHtml 本体会让多条同时红——这是源码文本断言做不到的。
test_fin_page_fetching.tsx: 财务页取数契约的变异锁；刷新信号推进必须真的重取、流水必须按整本账取。#19 的形态正是「依赖数组里写着 refreshKey，但下发的值永远不变」，文本断言看不见。
test_revision_history.tsx: 修改痕迹的可见性变异锁；真实渲染旧/新版本，锁定灰色删除线、AI 操作者、修改字段与删除原因，防止审计数据虽存在却在界面上失真。
test_dates.mjs: 时间域记录时区选择与墙钟投影的变异锁；含「墙钟载体走 UTC 槽位」契约——在 DST 缺失小时的浏览器时区（America/Santiago）与 ±14 小时的极端时区下，同一份输入必须给出同一答案。
test_timeline.mjs / test_timeline_interaction.mjs / test_timeline_callouts.mjs: 时间轴投影、拖拽交互与标注布局的变异锁；前者还锁死午夜前跳时区（不存在的 00:00）必须保守降级而非抛错——日界解析在 render 期，抛错等于白屏。
test_frontend_state.mjs: 前端状态推导的变异锁。
test_fin_pure.mjs: 财务域变异锁；直接 import fin/lib 与 fin/store 真实实现，覆盖跨月/跨年/单日区间边界、报销状态迁移不变式、软删除账户聚合、桑基连线逐字还原与无环约束、区间显示与过滤同源、全量取数上限。末尾一组「源码结构」用例按真实源码文本锁定刷新接线、全量取数、区间归一以及 MVP 不暴露多币种/周期账目入口。

法则：只用 react-router 8 与 echarts 6；没有 Service Worker；静态壳不承载业务请求；API 不得默认连接 59418。
回归必须 import 被测源码本身——断言常量等于常量的空壳测试视同没有测试。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
