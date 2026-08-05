# skills/lifeos-install/scripts/
> L2 | 父级: ../CLAUDE.md

成员清单
lifeos_bootstrap.py: 引导安装的唯一实现，Python 3.9+ 标准库、零第三方依赖（装它的时候 pip 还不一定可用）。四条子命令 detect/install/status/uninstall 之下是一层刻意做成纯函数的裁定层：地址白名单、Release 附件挑选、校验和解析、压缩包顶层目录、安装目标裁定、宿主探测与 health 判据都不碰网络也不碰磁盘，因此能被金样逐条锁死；副作用只集中在 `_download`/`_extract`/`deploy`/`run_step` 四处。安装编排遵循「备料→常驻→自证」：先 `LIFEOS_SETUP_ONLY=1` 生成配置与指针，再装 LaunchAgent 让服务后台常驻，最后用 config 里的 Token 对 health 认亲，确认双 dbPath 都落在本次安装内才算成功。
test_lifeos_bootstrap.py: 纯函数金样；不发网络、不碰真实家目录，全部临时目录内完成。锁定的是那些「放行一次就无法挽回」的判据——非 GitHub 域被拒、校验和文件名对不上视同没找到、压缩包越界成员与散落顶层被拒、非空目标不许覆盖、升级目标必须真的是 LifeOS、health 的 dbPath 必须落在本安装内、Token 不出 `Secret`。

法则：`Secret` 是访问密钥在本进程内的唯一形态，`str()`/`repr()` 恒为掩码，明文只能从 `reveal()` 出去；所有子进程输出在转发给用户之前必须过 `scrub`——安装脚本会把含 Token 的面板地址打到 stdout，原样转发就是泄漏。

失败必须带「下一步」：`BootstrapError` 的 `advice` 不是可选装饰，没有它就等于把一个不懂技术的用户丢在原地。校验和不匹配这一类失败必须在任何写盘之前发生，并明确告诉用户「什么都没有被写进你的电脑」。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
