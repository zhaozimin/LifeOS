# server/
> L2 | 父级: ../CLAUDE.md

成员清单
lifeos_node_server.py: 单进程启动入口；以 fail-closed 顺序加载配置、初始化两账本、注册声明式路由并绑定回环地址。
launch_lifeos_node_foreground.sh: LaunchAgent 与前台诊断共用的 zsh→Python 薄启动链，避免将解释器作为 macOS 用户服务的直接入口；解释器取 plist 固化下来的 LIFEOS_PYTHON，硬编码 /usr/bin/python3 会让自启进程换掉用户装过 openpyxl 的那个解释器，导出静默降级成 503。
core/: HTTP 安全边界、配置、构建认亲、静态托管、输入校验、审计与每账本 SQLite 原语；局部地图见 `core/CLAUDE.md`。
domains/: 时间与财务的独立业务边界；各域只接触自己的 Ledger，局部地图见 `domains/CLAUDE.md`。
runtime/: 未纳入版本控制的本地配置与双账本根；time/ 和 finance/ 是不可穿透的数据主权边界。
logs/: LaunchAgent 的本地 stdout/stderr 诊断出口；运行态且不纳入版本控制。
install_and_start_lifeos_node.sh: 安装与前台启动入口；放行判据是本机现状——全局指针指向别的安装、或端口被无法用本安装 config 认亲的服务占用，都在第一次写盘之前拒绝，两者都干净时首次安装无需任何环境变量。配置与指针原子生成，安装完成后必须把带 Token 的面板地址打到屏幕上（此前只写 0600 文件不打印，用户面对 TokenGate 无从下手）。LIFEOS_SETUP_ONLY=1 只备料不启动，供引导 skill 接着装自启。
install_launch_agent.sh: macOS 自启定义安装器；注册 com.lifeos.node 的明确工作目录与私有日志、保留回环绑定，并把安装期解析到的解释器绝对路径固化进 plist 的 EnvironmentVariables。写 plist 前先过端口护栏，因为 KeepAlive 会把端口冲突放大成无限重启；HOME 被换离真实家目录时只产出 plist 绝不注册——launchd 的 GUI 域按 UID 划分，一次 bootout 就会按 label 卸掉用户真正在用的服务。plist 是 XML，插入前必须转义安装路径里的 & < >，校验失败给中文诊断并清掉 .plist.tmp（uninstall 只认正式 plist）。
uninstall_lifeos.sh: 当面确认（TTY）或显式 LIFEOS_CONFIRM_UNINSTALL=1 才卸载 LifeOS LaunchAgent，默认保留双账本；指针、health 双 dbPath 与 plist 三重认亲都指向本目录才动手，任一环节存疑即 exit 5。收尾必须挑明 runtime 是安装目录的子目录——删程序本体等于永久销毁一生的账本且无恢复入口。
_port_probe.sh: 三个部署脚本共享的只读认亲层，可 source 也可单跑；Token 只经 LIFEOS_PROBE_TOKEN 传递。三类判据都在此定义一次：端口上那个服务能否被当前 config 换回落在本安装 runtime 内的双 dbPath、全局指针是否指向别的安装、HOME 是否真的被换离 passwd 家目录（后者是自启注册的唯一护栏）。
migration_rehearsal.py: P6 合成账本的封存副本、域目录复制、三锚核验与故障后回滚演练器；只接受 `synthetic-fixture`，没有生产路径入口。封存把副本 chmod 成 0o500/0o400，因此清旧副本必须先放开权限再删——否则同一夹具只能演练一次。
web/: 随源码提交的统一仪表盘预构建发布目录；Python 静态层只读取。
web-dashboard/: 统一 React 仪表盘源码与纯函数回归；构建后原子产出至 web/。
test_lifeos_http_core.py: P0 的隔离 HTTP 回归；锁定双账本 health、Token、Host 与旧无前缀路由拒绝。
test_time_domain.py / test_lifeos_http_time.py: 时间域纯规则金样与随机端口回归；后者含 `timeclock → timectl/time_commands → lifeconn → HTTP → timeview` 的真实命令链、超长软标记的阈值下发，以及新增/修改/删除版本与不可覆盖快照一致性。
test_finance_domain.py / test_lifeos_http_finance.py: 财务算法、边缘端点和随机端口 HTTP 回归；前者含 XLSX 导出前的公式钉死（明细与税务两表、= + - @ 四种前缀），后者含新建路径 90 秒重复闸的六条判据；包含完整账目前后版本链、单币种/周期暂停 MVP 闸、更新路径、导入 commit、双账本互不阻塞、账户改名传播、余额调整补差、类别扩展字段留存与大体积附件的变异锁。
test_finance_attachment_upload.py: 附件上传的落盘副作用回归；404 的上传必须寸土不动，正常上传的目录/文件/索引行三者齐备。
_lifeos_test_support.py: 部署套件三份用例的共享底座；仓库路径、受保护端口、一次性回环端口分配与套件源码清单只在此定义一次。下划线开头，因此不被 `unittest discover` 当成用例。
test_lifeos_deployment.py: 安装与发布门禁；空 Token 拒启、端口被无法认亲者占用即拒装、指针指向别处即拒装、SETUP_ONLY 备料不启动且当面交付面板地址、LaunchAgent 的 XML 转义/解释器固化/fail-closed 清理、原子写入中间态的 .gitignore 覆盖、按 VERSION 命名的发布物与校验和、引导 skill 小包、ZIP 私货扫描、CI 端口纪律步骤的存在。
test_lifeos_skill_golden.py: Skill 契约金样；SOUL 托管块三态与撑大拒绝、时间/账务 display 符号字典、lifeconn 白名单与结果未知矩阵、双 ctl 全命令面护栏，全部对回环替身运行。
test_lifeos_migration_rehearsal.py: 迁移与回滚回归；合成双账本三锚差异后由快照恢复、演练器拒绝非夹具路径、同一封存夹具可被反复演练。

法则：每个请求新建 SQLite 连接；写入锁只覆盖本账本；静态文件先于 Bearer，所有 `/v1/*` 都经 Host 与 Bearer；生产 runtime 不可由测试或开发脚本触及；部署脚本的放行判据只取本机现状，不取施工阶段。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
