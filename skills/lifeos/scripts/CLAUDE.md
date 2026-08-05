# skills/lifeos/scripts/
> L2 | 父级: ../CLAUDE.md

成员清单
lifeconn.py: 唯一安全传输层；从 LifeOS 指针发现安装、仅回环直连、禁代理/重定向、Token 不出进程；其 HTTP/传输异常域中立，不继承时间或财务护栏语义。
test_lifeconn.py: lifeconn 传输层金样；锁定只读数组回执可用、标量回执作为结果未知拒绝。
timeclock.py: 时间参数与写入护栏纯函数；以业务冻结时钟解析 HH:MM、拒绝跨整日歧义，兼容 `TimeOSError` 但新主异常为 `LifeOSTimeError`，不访问网络。
timeview.py: 时间行 display 纯函数；以账本状态而非命令模板生成「上一格 + 当前格」回执，正式接口 `render(command, receipt)`/`attach_display(command, receipt)`（兼容 `attach`），永不出现金额符号。
finview.py: 账务行 display 纯函数；金额只在此层渲染为 ¥。
time_commands.py: 时间命令编排层；switch 在没有前驱可收尾时产出 precedingRecord/boundary/openedWithoutPredecessor —— 这三个字段是 timeview 画「⚠ 未记录」行的全部输入，缺一条空白提示通道就两头皆空；以冻结业务钟与主数据校验收敛 record/switch/stop/cancel/update/delete/reconcile，4xx 明确未写、传输失败结果未知，并只经 lifeconn 访问 time 域。
timectl.py: 时间 CLI 门面；将参数收归为受护栏的完整命令面，写回执统一委托 `timeview.attach_display`，只允许 `/v1/time/*` 写入和 `/v1/health` 只读。
finctl.py: 财务命令面；request 是逃生通道但守两条纪律——拒绝 PUT /v1/fin/configuration（主数据整表重写须走强制 userConfirmation 的 agent/operations），写方法一律经 _write 以保住「退出码 3 + result_unknown」这条机器判据；correct 是部分补丁，护栏因此判「库里现状叠上本次补丁后会变成什么样」而非补丁字面（并复刻服务端的方向字段推导），否则缺 kind 的补丁能让还款判据整条失效；只允许 `/v1/fin/*` 写入和 `/v1/health` 只读；三条新建命令带 `--allow-duplicate`，它是服务端 90 秒重复闸的逃生阀而不是重试开关——只有向用户确认过「确实是另一笔真实消费」才允许带上，默认绝不出现在请求体里，否则那道闸等于没写；信用卡还款按账户类型与资金方向结构性判定（钱进卡必须是 transfer，卡上消费放行），商户退款等外部流入由 `--external-inflow` 显式声明，仅「卡上 expense」这一格保留收窄词表兜底。
install_lifeos_router.py: Hermes SOUL 托管块安装器；替换旧 TimeOS 块，`--check` 的四条断言是 deployment.md 明写的上线闸门。行数那一条必须数 SOUL.md 里托管块的**实际**行数——量安装器自己的模板等于两个常量比较，对被人手撑大或塞进额外指令的托管块一律放行。
test_time_skill.py: 纯函数隔离金样；锁定钟点解析、边界证明、五态 display 与渲染降级，不读取安装指针或账本。

法则：timeclock/timeview/finview 互不发网络；ctl 只能经 lifeconn。4xx 是明确未写入，5xx、断连、重定向和畸形成功回执均是结果未知，禁止盲目重试。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
