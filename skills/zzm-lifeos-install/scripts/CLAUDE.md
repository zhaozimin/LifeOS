# skills/zzm-lifeos-install/scripts/
> L2 | 父级: ../CLAUDE.md

成员清单
lifeos_bootstrap.py: 引导安装的编排层，Python 3.9+ 标准库、零第三方依赖；损坏指针在备料前 fail-closed，只有显式 `--replace-pointer` 能改指。安装编排遵循「预检→备料→停服/原子交换→常驻→自证」：新版 health 未通过前旧目录不退役，配置、LaunchAgent 或双 dbPath 认亲失败都回滚并恢复旧服务。发布树的来源只在备料一步分叉：默认走 GitHub，`--payload <目录>`（市场 Skill 形态）改走随包清单，两条路在 assert_release_layout 合流；`--exclude-host` 让市场形态跳过承载自己的宿主，避免同一句话挂两个触发面。它 re-export 来源层全部判据，调用方与金样只认这一个门面。
lifeos_source.py: 发布树来源层，不 import 编排层；网络路径的域白名单、禁代理下载、sha256、压缩包顶层裁定与权限还原，离线路径的 manifest 裁定（越界路径、涂改清单整体拒绝）与逐文件 sha256 还原，以及 BootstrapError 本体。两条来源共用同一套拒绝语义：任何校验不过都发生在触碰安装目标之前。
lifeos_deploy.py: 升级文件系统事务；新发布物先落到目标同级 incoming，仅白名单带入旧 `server/runtime`，再用目录改名交换。复制失败时服役树字节不变；中断重跑或 health 失败恢复 backup，只有认证 health 通过才 commit 删除旧树。
test_lifeos_bootstrap.py: 标准库金样；不发网络、不碰真实家目录，在临时目录故障注入损坏指针、磁盘写失败与未通过 health 的升级，并继续锁定 GitHub 域/校验和/ZIP 越界、目标认亲、双 dbPath 归属与 Token 掩码。

法则：`Secret` 是访问密钥在本进程内的唯一形态，`str()`/`repr()` 恒为掩码，明文只能从 `reveal()` 出去；所有子进程输出在转发给用户之前必须过 `scrub`——安装脚本会把含 Token 的面板地址打到 stdout，原样转发就是泄漏。

失败必须带「下一步」：`BootstrapError` 的 `advice` 不是可选装饰，没有它就等于把一个不懂技术的用户丢在原地。校验和不匹配这一类失败必须在任何写盘之前发生，并明确告诉用户「什么都没有被写进你的电脑」。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
