# core/
> L2 | 父级: ../CLAUDE.md

成员清单
errors.py: 统一 DomainError；将机器码、人类消息、HTTP 状态与可选上下文锁为单一错误契约。
config.py: runtime/config.json 的 fail-closed 读取与原子写入；只保存连接性与安全字段。
clock.py: 记录时区的进程级真源；把 config.json 的一个 IANA 名称冻结成两域共用的时区事实，并区分 utc_now_iso（机器时刻，审计与 created_at）与 now_record_iso（用户墙钟，任何会被读作「几点」的字段）。时区状态只能经 record_timezone / record_timezone_state 读取——按名导入会把值绑死在导入那一刻。
build.py: 对 server Python 源码排序哈希，生成随进程固化的清单式 buildId。
httpd.py: Host/Bearer/路由/脱敏日志总边界；响应头在写出第一个字节前统一校验可编码性与控制字符，避免「状态行已发出才失败」产出一个响应两个状态码；静态旁路后才进入认证 API。回环 Host 同时接受 127.0.0.1 与 localhost；每条路由自带请求体上限；routes_from_contract 按域 ROUTES 装配路由，契约与实现漂移即拒绝启动；未预期异常打 traceback 到 stderr。
validation.py: JSON 对象、未知字段和基本类型的共享白名单校验；体积上限由调用方按路由传入，不再持有覆盖不到的第二上限。
static_files.py: 单一 web 根的防穿越静态托管、gzip 与 history SPA fallback。
audit.py: 每域独立审计事件、统一的业务记录版本与不可覆盖 SQLite 快照；记录版本完整保存 before/after，不允许原地覆盖历史。提交后的快照失败一律走 checkpoint_or_warn 降级为回执警告，绝不把已落库的写入回成 500。
sqlite.py: Ledger 值对象；封装每账本 RLock、WAL 连接、BEGIN IMMEDIATE 与审计根。

法则：core 不理解领域业务字段；它只提供可复用的安全、时间与事务基础。记录时区是 config.json 的事实而非业务字段，因此归 core：任一域自行解释系统时区，两本账本的日界就会脱钩。任何跨域需求都必须留在 HTTP 编排层，绝不可通过共享 SQLite 连接实现。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
