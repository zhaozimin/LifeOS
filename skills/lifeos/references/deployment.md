<!--
[INPUT]: 依赖 LifeOS 仓库的 server 安装/自启/卸载脚本、`~/.config/lifeos/install.json` 指针、migration_rehearsal.py 与本机 Bash + Python 3.9+。
[OUTPUT]: 对外提供单进程单部署八段流程、状态驱动的安装放行判据、旧 TimeOS/FinOS 双安装迁移与三锚对账（历史流程）、Tailscale 远程访问与安全交付的确定性边界。
[POS]: lifeos Skill 的部署协议；只有部署、更新、启动、恢复或迁移任务才加载，不参与时段字段推断，也不参与账务字段推断。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-->

# LifeOS 本机部署与迁移协议

## 目标

把 LifeOS 装到用户可见目录，**一个进程、一个端口、一个 Token、两本永不合库的 SQLite**。固定监听 `127.0.0.1`；普通部署使用仓库内预构建前端，不需要 Node，也不上传任何数据。财务导出需要唯一的第三方依赖 `openpyxl`。

安装器的放行判据是**本机现状**，不是任何施工阶段：全局指针指向谁、目标端口上那个服务能否被本安装的 Token 认亲、`HOME` 是否真的被换离 passwd 家目录。首次安装到一台干净机器不需要任何环境变量。

开发与测试仍受一条独立纪律约束：**任何开发、演练、测试命令都不得默认连接 `59418` 或旧 TimeOS 的 `51440`**，回归一律用一次性回环端口。这条纪律由 CI 与部署门禁强制，与安装器的放行判据是两回事——前者防的是测试打到用户的活服务，后者防的是安装覆盖认不出来的东西。

## 1. 先找旧账本

1. 运行 `python3 "<SKILL_DIR>/scripts/timectl.py" locate`。
2. 核对 `~/.config/lifeos/install.json` 的 `installPath`。
3. 核对 `LIFEOS_INSTALL_PATH`（仅供无指针的隔离演练使用；有指针时**指针优先**，因为指针代表已认领的账本）。

找到 `server/runtime/time/` 与 `server/runtime/finance/` 时默认恢复该安装。只有用户明确要求新建账本才另选目录，并说明全局指针会改指新安装、旧数据仍保留。

**发现 `~/.config/timeos/install.json` 或 `~/.config/finos/install.json` 时，lifeconn 会直接报“旧系统指针”并拒绝工作。这是设计行为，不是故障**：旧指针指向的是旧世界的账本（其中 finos 指针还指着开发仓里那本 dev 账本），静默沿用就会写错账。此时进入第 9 节的迁移流程，绝不手工把旧指针改名成 lifeos 了事。

找到安装但服务未运行时，回到安装目录按第 4 节重启，脚本会保留既有 Token、端口与两本账本。

## 2. 检查环境

```bash
python3 --version
python3 -m pip --version
```

要求 Bash 与 Python 3.9+；当前支持 macOS/Linux，Windows 原生环境不在支持范围内。后端只有一个第三方依赖：

```bash
python3 -m pip install openpyxl
```

遇到受管 Python 或权限错误时，在安装目录创建 `.venv` 安装 `openpyxl` 并在激活环境中启动；不要为了装依赖去改系统 Python。缺少 `openpyxl` 时服务仍可运行，只有财务 xlsx 导出不可用。

## 3. 获取源码与安装目录

普通用户的正常路径有两条，都不需要你手工找源码：

1. 装了 `lifeos-install` Skill 时，交给它：`python3 <该 Skill 目录>/scripts/lifeos_bootstrap.py install`。它从 GitHub Release 取包、校验 sha256、部署、装自启并自证 health，失败会给出中文诊断。
2. 用户手上已有 `lifeos-<版本>.zip` 时，先用同目录的 `.sha256` 校验，再解压，然后按第 4 节安装。

只有在这两条都不适用时才回落到源码：优先使用当前 LifeOS 仓库或用户提供的发布包。未给出可信源码位置时先询问，不猜远程地址。目标目录已被其他内容占用时换一个明确目录名，绝不覆盖；若父目录属于其他 Git 仓库，把安装目录加入父仓库忽略规则，避免 runtime 密钥与两本账本被误提交。

## 4. 启动与端口纪律

普通安装（默认端口 `59418`，无需任何环境变量）：

```bash
bash <安装目录>/server/install_and_start_lifeos_node.sh
```

安装器在**第一次写盘之前**过两道状态判据，拒绝路径上不会留下半套安装：

| 判据 | 拒绝条件 | 覆盖方式 |
|---|---|---|
| 全局指针 | `~/.config/lifeos/install.json` 指向**别的**安装根 | `LIFEOS_REPLACE_POINTER=1`（旧安装的账本不会被动） |
| 端口占用 | 目标端口有人监听，且无法用本安装的 config 认亲出双 dbPath | 停掉占用方，或 `LIFEOS_PORT=<其它端口>` |

其余可选输入：

- `LIFEOS_INSTALL_PATH=<目录>`：不用脚本所在位置，指定安装根。
- `LIFEOS_SETUP_ONLY=1`：只生成配置、指针与账本目录，**不前台启动**。自动化安装必须用它，然后再装 LaunchAgent 让服务常驻——前台启动会一直占住调用方。
- `LIFEOS_ISOLATED_HOME=1`：声明这是隔离演练。声明了就会被核实（`HOME` 必须真的不是 passwd 家目录），没换 HOME 就退出；不声明则不做这项检查。

安装成功后脚本会把带 Token 的面板地址打到 stdout，只交付一次，见第 8 节。

端口被占用时先探测 `/v1/health`：401 或 LifeOS health 形态可能表示已有本安装的节点，应结合 locate 认领原安装，不杀进程、不覆盖配置。确认不是 LifeOS 后说明占用情况，优先换端口；未经用户同意不停止其他进程。

## 5. 写全局指针

启动脚本在健康检查前就会以 0600 权限原子写 `~/.config/lifeos/install.json`，内容只有绝对安装路径：

```json
{"installPath":"/absolute/path/to/LifeOS"}
```

指针不含 Token。**写指针是部署动作**：lifeconn 只读不写，发现指针缺失或指向旧系统时报错并把你送回本文件，绝不自动新建。演练用隔离 HOME 天然拿到独立指针，不要去动真实 HOME 里的那一份。

## 6. 安装 Hermes 强制路由

把整个 `skills/lifeos/` 同步到 `~/.hermes/skills/lifeos/` 后运行：

```bash
python3 ~/.hermes/skills/lifeos/scripts/install_lifeos_router.py
python3 ~/.hermes/skills/lifeos/scripts/install_lifeos_router.py --check
```

安装器只在 `SOUL.md` 中维护一块带 `LIFEOS_MANAGED_ROUTER` 标记的托管文本，保留块外既有人格，并会**显式扫描并整块删除旧 `TIMEOS_MANAGED_ROUTER` 块**——否则 SOUL.md 里会出现新旧双路由。标记残缺或出现多块时安装器硬失败，交人工处理，不猜该保留哪一块。

`--check` 返回四条断言：`single_block`、`no_legacy_timeos_block`、`version_match`、`line_count_within_limit`。四条全真才能声称微信自然语言路由已经生效。SOUL.md 每轮重新加载，这一步不需要重启网关。

## 7. 必须验证

```bash
python3 "<SKILL_DIR>/scripts/timectl.py" locate
python3 "<SKILL_DIR>/scripts/timectl.py" health
python3 "<SKILL_DIR>/scripts/timectl.py" configuration
python3 "<SKILL_DIR>/scripts/finctl.py" request GET /v1/fin/configuration
```

四条均成功、输出不含 Token 才算部署完成。`health` 的 `domains.time` 与 `domains.finance` 必须**同时**存在：单进程带两本账本，只有一域健康说明另一本没挂上。服务端还须验证无 Bearer 头返回 401、静态登录页可加载。做过 LaunchAgent 安装时，再用 health 的 `pid`、`buildId` 与两个 dbPath 确认应答者就是刚装的那个进程。

## 8. 安全交付

首次部署完成后只交付一次登录地址 `http://127.0.0.1:<port>/dashboard/?token=<TOKEN>`，提醒用户首次打开后前端会把 Token 存入 localStorage 并立即从 URL 删除。恢复或重复执行启动脚本时只回报 health 与不含 Token 的 `/dashboard/` 地址；需要重新登录时提示用户自行读取权限 0600 的 `server/runtime/connection-info.txt`，不要把密钥带回聊天。Token 不进入 Git、日志与命令行；端口不裸露公网。数据目录为 `<installPath>/server/runtime/`，其中 `time/` 与 `finance/` 各自持有一本 SQLite、各自 WAL、各自锁。

macOS 用 `LIFEOS_INSTALL_PATH=<安装根> bash server/install_launch_agent.sh` 设置开机自启（label `com.lifeos.node`）。三件事必须知道：

- 脚本在写 plist 之前先做端口占用与 health 认亲——plist 的 `KeepAlive=true` 会在端口冲突时无限重启并刷爆日志，这道护栏不能跳过。
- 它把安装期解析到的解释器绝对路径固化进 plist 的 `EnvironmentVariables.LIFEOS_PYTHON`。用户是用 PATH 上的 `python3`（Homebrew/pyenv 很常见）装的 `openpyxl`，而 launchd 默认拿到的往往是另一个解释器；不固化的表现是「昨天能导出、今天导出 503」，且没有任何线索指向解释器差异。要覆盖就显式传 `LIFEOS_PYTHON=<绝对路径>`。
- `HOME` 被换离真实家目录时，脚本**只产出 plist、绝不注册**。launchd 的 GUI 域按 UID 划分、不按 HOME，隔离对它无效；一次 `bootout` 会按 label 卸掉用户真正在用的服务。

退役用 `bash server/uninstall_lifeos.sh`：有终端时会当面问一次，非交互调用必须显式 `LIFEOS_CONFIRM_UNINSTALL=1`。它只卸载服务定义与全局指针，默认保留两本账本；`--purge-data` 被硬拒，数据删除必须由用户在场的人工流程处理。收尾会挑明 `runtime` 就在安装目录里面——**删掉安装目录等于永久销毁全部记录，本系统没有恢复入口**，完整备份步骤见发布物里的 `docs/备份与恢复.md`。

## 9. 旧双安装迁移（TimeOS + FinOS → LifeOS）

> **本节只对「本机装过旧 TimeOS 或旧 FinOS」的用户有意义。** 全新安装的用户跳过整节。
> 这套流程已在原作者机器上执行完毕，保留在此是为了让回滚有据可依，并给同样从旧双系统搬家的人一份可复核的剧本。

### 9.1 先演练，后生产

合成回滚演练是进入生产窗口的前置条件：

```bash
python3 <安装目录>/server/migration_rehearsal.py --synthetic-fixture <临时目录>/synthetic-fixture --create
```

该工具只接受目录名恰为 `synthetic-fixture`、且带固定标记文件的一次性夹具，依次完成：SQLite backup 封存 → 复制到 LifeOS 的 `time/` 与 `finance/` 域目录 → 以完整性/行数/总量三锚对账 → 故意制造财务差异 → 从封存副本回滚。**它没有生产 runtime、旧指针或端口参数，也不该被加上**。回滚没演练过的迁移不允许进生产窗口。

### 9.2 权威路径（实测认定，不按指针）

| 对象 | 权威路径 | 雷区 |
|---|---|---|
| TimeOS 生产账本 | `~/Library/Application Support/TimeOS/server/runtime/` | WAL 三件一体，`time.sqlite3` + `-shm` + `-wal` 必须同时搬 |
| FinOS 生产账本 | `~/FinOS/server/runtime/finance.sqlite3` | `~/.config/finos/install.json` 指向开发仓，那里另有一本 dev 账本——**按指针搬运必搬错** |
| FinOS 的 0.0.0.0 绑定 | 只存在于活动 plist 的 EnvironmentVariables 手工补丁 | 回滚要还原 plist 备份，重跑安装脚本产生不出这个补丁 |

### 9.3 三锚对账

| 锚 | 口径 |
|---|---|
| 结构 | `PRAGMA integrity_check` = ok |
| 行数 | 逐表 count（时间：segments/categories/projects/settings/runtime_state；财务：transactions/categories/accounts/ledger_settings/attachments/recurring_rules） |
| 总量 | 时间：未软删闭合段总分钟 + 软删段计数，SQL 与 API 双通道互证；财务：`SUM(amount) GROUP BY currency, kind`，附件表行数与文件一一对应 |

哈希只用于证明“搬运无损”：LifeOS 首启会把 `finance.sqlite3` 转成 WAL，那是预期写入，首启后哈希永久失效。写后对账走只读端点 + scratch SQL 双通道；纯查询不触发周期规则追平，对账窗口天然干净，对账通过后才允许打开面板。

### 9.4 生产切换顺序（严格线性，不可颠倒）

1. 隔离演练与回滚演练全绿，双 plist 已备份。
2. 冻结：确认时间账本没有 open 段（有就先自然收尾）。
3. 退役 TimeOS：**先卸载、后动 runtime**（卸载脚本靠现 config 对 health 认亲，顺序颠倒会直接失败）。
4. 退役旧 FinOS 并手工验尸（该脚本没有认亲防护），确认 51440 与 59418 均无监听后，才允许 LifeOS 占用 59418。
5. 取证搬运：整目录哈希清单 → `cp -Rp` → 副本重算 diff 零差异 → 三锚基线落盘。生产 runtime 全程只读一次，原件封存为回滚锚。
6. 安装 LifeOS + LaunchAgent，health 认亲：单 Token、双 dbPath、PID、清单式 buildId。
7. 写后三锚对账 + 面板肉眼复核两域历史数据；任一锚不中即回滚到封存副本。
8. Hermes 切换：装 `skills/lifeos` → 跑 `install_lifeos_router.py` 换 SOUL 块 → 旧 skill 目录改名归档 → 重扫 → 三类句子各冒烟一条（纯时间 / 纯记账 / 混合句），真实入账后立即 `timectl cancel` 与 `finctl void` 留下审计痕。

### 9.5 旧双指针归档

切换收尾时，旧的 `~/.config/timeos/install.json` 与 `~/.config/finos/install.json` 一律**改名为 `.migrated`，绝不删除**——它们是回滚时找回旧世界的唯一线索。开发仓里的 dev runtime 同样改名归档而不是删除。两份旧 `connection-info.txt` 等明文密钥文件在确认新 Token 可用后销毁，且严禁进入新仓 Git。

## 10. Tailscale 远程访问

跨设备访问只走 Tailscale 反代，节点本身**始终只监听 `127.0.0.1`**：

```bash
tailscale serve --bg 59418
```

把 ts.net hostname 写进 `runtime/config.json` 的 `allowedHosts`（Host 白名单是服务端的边界，不写就会被拒），手机改连 `https://<hostname>.ts.net/dashboard/` 并重新录入 Token。**禁止 Funnel**（那会把两本账本暴露到公网）。配置完成后用 `lsof` 复核节点仍然只监听回环——只要出现 `0.0.0.0`，立刻停下排查。

## 11. 防坑清单

1. FinOS 时代的 `docs/api.md` 已被实测认定失实（`?token=` 早已从代码移除、WAL 从未开启），契约以代码为准。
2. `~/.config/finos/install.json` 指向开发仓的 dev 账本，按指针搬运必搬错。
3. FinOS 的 `0.0.0.0` 绑定只在活动 plist 里，回滚要还原 plist 备份。
4. 不存在 `/v1/clock` 端点，`timectl clock` 打的是 `/v1/health`。
5. TimeOS v1.0 文档里的“五式回显模板”早已废除，display 由 timeview/finview 生成，禁止从旧文档复活。
6. 两本账本永不 ATTACH、JOIN 或跨库事务；`/v1/time/*` 与 `/v1/fin/*` 之外只共享一个只读 `GET /v1/health`。
7. **`${HERMES_SKILL_DIR}` 只在 Hermes 平台注入，其他平台（Claude Code、Codex 等）该变量为空。** 非 Hermes 平台的命令示例必须写成本 Skill 目录的绝对路径，否则命令会展开成 `/scripts/timectl.py` 而报 No such file。本协议与两份 references 里的 `<SKILL_DIR>` 就是这个占位符，执行前必须替换。
8. 旧 `TIMEOS_MANAGED_ROUTER` 块必须显式删除，只装新块会留下双路由。

## 更新已有安装

更新前确认代码工作区没有用户自定义变更，停止服务写入后备份整个 `server/runtime/`。**不要在线只复制 SQLite 主文件**：WAL 中可能仍有未合并的数据；必须在线备份时使用 SQLite backup API，或同时一致性保存主文件、WAL 与 SHM。只更新代码与预构建前端，不覆盖 runtime；更新后重新运行启动脚本、schema 增量迁移与第 7 节的验证，不生成新 Token。

`timezone` 留空只表示使用系统来源。服务首次解析系统 IANA 后会把具体 `resolvedTimezone` 冻结进时间账本；OS 时区变化时仍按旧值安全启动，并通过 health/configuration 暴露新的 `currentSystemTimezone`。只有用户在设置页明确选择后才重新采用当前系统区，部署脚本不得替用户自动迁移，更不得按升级当下的系统时区去猜历史记录属于哪个时区——不确定就停下询问，保留备份，不声称升级完成。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
