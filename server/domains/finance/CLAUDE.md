# domains/finance/
> L2 | 父级: ../CLAUDE.md

成员清单
constants.py: 财务默认主数据、来源反转白名单、有限状态枚举、重复提交窗口与 MVP 功能边界；当前只写 CNY 且暂停周期账目。DUPLICATE_WINDOW_SECONDS 的取值本身就是判据：一次操作被提交两遍必然相隔秒级，真实的第二杯咖啡总是隔着数十分钟，窗口太小挡不住超时重发、太大就会把用户真实的第二笔误判成重复。
currency.py: 汇率抓取、1/v 反转与交易本位币快照；换算在 finance 单连接内固定历史金额。编辑金额时按 rescale_base_snapshot 缩放而非重算，以保住记账当时的汇率；只有换币种才回落到当前汇率。
importer.py: 账单表头嗅探、金额符号/收支归类、三类建议与两步导入；commit 保留基线无查库去重语义。
recurring.py: advance_due_date 与连接内周期交易追平；E9 规定由 service/routes 决定触发点，模块本身不会在读取时运行，规则 create/update 只即时追平一次。月/年规则的「几号」是规则的锚点而非游标的属性：建规则时固化进 day_of_period，推进时由它决定日期，否则 1/31 被二月 clamp 一次就永久变成每月 28/29 号。
reimbursement.py: 报销状态机的连接内原语；一对多核销、删除回款级联退回与防串账 SQL，事务边界由 service 持有。已被**别的**回款核销过的支出拒绝改挂（同一回款重复提交仍幂等放行）——改挂会让前一笔的核销事实无声消失，随后删除新回款还会把已报销的支出退回 draft。
views.py: 个人/公司双视图、账户归属推断、资产/负债余额口径、跨币种换算原语与 category 形状投影，以及对账差额的「余额调整」交易 payload 构造。账户余额恒以账户自己的币种表达，因此一笔转账的两端要各自换算——交易只有一个 amount，收款端若不按到账币种折算，净资产会随每次换汇凭空蒸发。category 的形状口径也收在这里，护栏与报告共用，避免同一份 isinstance 兜底写三遍。
guardrails.py: 人工/系统来源白名单、agent 引用校验、主数据确认闸、主数据重名闸与新建路径的重复提交时间窗闸；确认类失败为 422，重名为 409 duplicate_master_name，重复提交为 409 duplicate_record。重复闸之所以必须存在：时间域因 overlap 不变量意外免疫，财务域没有任何天然不变量——同一个 body 连发两次就落成两条不同 uuid 的行，¥25 的午饭变成 ¥50，而两条记录一字不差，用户几天后认不出该删哪条。判据只有时间窗，没有内容黑名单，因此它永远不会退化成「同一天不许记两笔同样的钱」；occurred_at 参与判定但按窗口容差而非逐字相等，因为面板新建 payload 根本不带 occurredAt、由服务端现填，逐字相等会让护栏恰好在最需要它的那条路径上恒不触发。逃生阀 allowDuplicate 只负责逼出用户的一次明确确认，不替用户决定。重名之所以必须拒绝：余额按账户名聚合，两条同名账户会各自算出同一笔钱，净资产直接翻倍。校验语句本身必须扛得住形状错位的输入——它一旦抛异常，422 unknown_master_data 回执就退化成 internal_error，「AI 先问后写」赖以运转的 issues/valid/agentInstruction 整条消失。
reports.py: 月度、预算双键、0.98^days 习惯投影与 dashboard 只读聚合；不触发周期记账。「本月」按记录时区判定而非宿主机器——记录时区 Asia/Shanghai、宿主 America/Los_Angeles 时，北京每月 1 号 0–8 点宿主还停在上个月，汇总/预算/趋势会整块查到上个月。所有跨账户合计（月汇总、12 个月趋势、净资产）一律按 amount_in_base_currency 结算，裸加原币会把 1000 元 + 1000 美元算成 2000。
export_xlsx.py: 所有写行收口在 _append——导出是账本唯一的出网面，而标题/商户/备注是陌生人可填的字段（微信转账附言、支付宝对方昵称都进得来），以 = + - @ 开头的字符串必须钉成 data_type='s'+quotePrefix 才允许离开本机，否则报税表转给会计时一点就把同行金额回传给攻击者域名。原职责： 明细/月度/分类/账户与五表税务 XLSX 导出；延迟导入 openpyxl，缺库时转为 DomainError。跨账户合计（月度、分类、账户流水、税务）一律按本位币结算，明细逐行仍显示原币——两种口径并存是刻意的：明细是流水的原样，汇总是可加的量。账户汇总的期末余额与 views 的资产/负债口径同源：负债账户是 期初 − 流入 + 流出，套资产公式会让信用卡欠款少算两倍刷卡额。
store.py: finance.sqlite3 的连接内 schema 兼容迁移、行投影和读写原语；可将 P0 最小表安全升级为完整账本。默认主数据只在表为空时补种，因此新增的默认项对既有账本永远不生效——「未分类」这一条例外，由 ensure_fallback_category_in_connection 每次启动幂等补回：它是 service 行构造与分类归一的缺省值（:202、:464），缺席时一笔归不进任何现有分类的消费无论传不传 category 都会撞 unknown_master_data 被拒，而这正是新账本分类还不够用时最常发生的情形。只补这一条且按名字判存，其余分类仍守「AI 不得静默创建主数据」——这一条不是 AI 想建的，是系统在保证兜底通道可用。insert_transaction 把主键撞车收成 409 duplicate_record 而非放裸 IntegrityError 上行——httpd 的兜底会把它变成 500，而 lifeconn 将一切 5xx 翻译成「写入结果未知，禁止重试」，于是**最确定**的一种失败（那一行原封不动，本次一个字节都没写）被降级成最不确定的一种；只有主键确实已存在才改判，NOT NULL 之类的约束破裂是代码缺陷，仍应原样炸成 500。reimbursed_by 不在 TRANSACTION_COLUMNS 内，其「只有 reimbursed 状态才配持有」的不变量由 update_transaction 在唯一写入口兜住。
service.py: 财务事务编排、新建路径独占的重复提交闸（update 是用户指名改哪一笔，导入 commit 天然有同额同日多笔且已有自己的重复判据，两处套上都会拒掉正常操作）、导入落库前套上与单笔写入相同的金额闸与 AI 引用护栏（source=import 的真实账单仍按 source_requires_guardrail 豁免未知账户）、显式 accountName 压过库里残留方向字段、schema/health 投影、附件路径归一化（无法定位的行跳过并告警，绝不因此拒绝启动）、配置写入的账户改名传播与余额补差；MVP 只允许 CNY 金额写入并让所有 E9 catchup 稳定返回暂停，既有外币数据不删除且仍可修改非金额字段；账目新增、修改和删除完整保存 before/after 版本并各留不可覆盖快照；所有写入只占 finance Ledger 锁。
routes_read.py: 11 条财务读取 API 和未注册 build_routes；附件名走 RFC 6266（ASCII 兜底 + filename*），MIME 只放行合法 token，二者都收口在本文件；附件二进制与两种 Excel 导出从此返回，dashboard overview 的 E9 兼容调用在 MVP 中不写数据。
routes_write.py: 16 条财务写入 API 与由 ROUTES 契约驱动装配的 build_routes；附件与两条导入路由按 base64 膨胀声明各自请求体上限，常规写入仍经过 E9 兼容接线，但当前只会收到 paused 回执，周期规则增改删统一拒绝。

法则：finance.sqlite3 是唯一财务真源。occurredAt 是用户墙钟时刻，取自 core.clock.now_record_iso；created_at/updated_at 是机器时刻，保持 UTC。二者曾共用 utc_now_iso，导致北京 19:43 记的账落库成 11:43+00:00，且北京 00:00–08:00 的账退到前一天、跨月记错月份。附件名与 MIME 是用户可控输入，Content-Disposition 按 RFC 6266 编码后才出网。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
