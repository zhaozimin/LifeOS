# LifeOS - 会说话，就会记录人生

Python 3.9+ 标准库多模块服务 + 两本 SQLite WAL 账本 + React 19/TypeScript/Vite 统一仪表盘 + 单一 LifeOS Skill。一个进程只监听 `127.0.0.1:59418`；时间与财务共享入口但不共享数据库。

<directory>
server/ - 单进程 HTTP 服务、双账本领域包、部署脚本、测试与预构建仪表盘（4 子目录：core、domains、runtime、web-dashboard）
skills/ - LifeOS 的 Agent 接入层：lifeos 路由时间/财务/部署意图，lifeos-install 从 GitHub Release 引导安装（2 子目录：lifeos、lifeos-install）
docs/ - 面向普通用户的安装、备份恢复与已知问题；随发布 ZIP 交付，是用户手上唯一的中文手册
</directory>

<config>
VERSION - 发布版本真源；发布物命名、校验和与引导 skill 的版本判据都取自这里
make_release.sh - 公开发布边界；按根 VERSION 打主包与引导 skill 小包，解包目录与 ZIP 各扫一遍私货后出 sha256
.gitignore - 排除双账本、附件、Token、连接信息（含两者原子写入的 `.<name>.<pid>.tmp` 中间态）与 LaunchAgent 运行日志；`server/web/` 是随源码提交的面板发布物
README.md - 产品定位、隐私边界、三条安装路径入口与已知问题索引
LICENSE - MIT；随发布物与公开仓库一同交付
</config>

架构法则：数据主权优先；time.sqlite3 与 finance.sqlite3 永不 ATTACH、JOIN 或跨库事务；每账本独立锁、WAL 与审计快照。HTTP 以 Host 白名单、静态旁路和单一 Bearer Token 为边界；路由契约由领域 `ROUTES` 常量集中声明。

部署法则：安装、自启与卸载的放行判据一律取自**本机现状**而非施工阶段——全局指针指向谁、目标端口上那个服务能否被本安装的 Token 认亲、HOME 是否真的被换离 passwd 家目录。阶段闸门（P7 窗口、保留端口）已随生产切换完成而拆除：它保护的是施工期的开发机，对首发用户完全反向。任何拒绝都必须发生在第一次写盘之前，否则失败路径会留下半套安装。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
