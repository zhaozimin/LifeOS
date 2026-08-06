# components/
> L2 | 父级: ../CLAUDE.md

成员清单
charts/: ECharts 生命周期与主题色适配层；业务页只提供 option。
timeline/: 日/周时间账领域编排层；把 UTC 真实时长、24h 墙钟几何、DST 只读降级、整屏/五档缩放、普通日调时和七日日历映射到 ui 时间画布原语。
ui/: 受控弹层、按钮、卡片、输入与指标卡等设计系统原语。
Layout.tsx: LifeOS 统一顶栏与内容壳；承载跨域导航、主题、连接状态、软刷新与按需财务搜索，业务页面在 Outlet 内自行取数；ErrorBoundary 只裹 Outlet，故障半径因此止于内容区。软刷新信号有两条出口：outlet context 给直接挂在本层 Outlet 下的时间三页，导出的 `useRefreshSignal()` 给任意深度的页面——财务页在 FinPageFrame 的二级 Outlet 下，那层不透传 context，`useOutletContext()` 只会拿到 undefined，跨层信号必须走普通 React context。
ErrorBoundary.tsx: 全站唯一的 render 期故障隔离层（class + getDerivedStateFromError/componentDidCatch）；降级卡片点名出事区块、给出可转达的错误摘要与重试按钮，resetKey 变化即自动复位。Layout 用它隔离单页崩溃，App 另挂一层同款兜住壳层崩溃——两层嵌套时 React 交给最近的边界，页面故障吃不掉顶栏与导航。
ProductLogo.tsx: LifeOS 统一品牌标识；表盘＋右下角压边 ¥ 的几何与 docs/assets/logo.svg、public/ 下的 PWA 图标同源。SVG 内联而不从图标库引入——通用图标库随 npm update 变形，而 logo 变形没有任何测试会变红；此前这里用的是 lucide 的 HeartPulse，与「时间 × 金钱」毫无关系，且与另外三处标识各不相同。
RevisionHistoryModal.tsx: 时间与账目共用的本地版本历史弹窗；只消费审计事件真值，将旧版本和删除内容统一显示为灰色删除线，当前版本保持正常样式。
Sidebar.tsx: 时间、财务、系统三组导航；所有链接均以 `/dashboard` 基路径下的内部路由为目标。
RecordTimeZoneProvider.tsx: 记录时区的变更回流桥；App 持有真源，设置面板隔着 Layout/Outlet 只能经它把迁移结果推回，缺 Provider 直接抛错而非静默丢弃。
StatusIndicator.tsx: `/v1/health` 的只读连接状态，不产生轮询式业务采集。
ThemeProvider.tsx: 将 store 的模式与 palette 投射到根节点；页面和图表共享同一主题真源。
ThemeSwitcher.tsx: 顶栏唯一的 71 套主题与亮暗模式选择器。
TokenGate.tsx: 本地 LifeOS token 登录门；只验证 Bearer health，401 与服务离线分别反馈，候选密钥失败时恢复已有凭证。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
