---
name: zzm-lifeos-install
description: 把 LifeOS 人生记录系统装到用户本机。用户说要安装、部署、下载、更新、升级、重装 LifeOS，或问「LifeOS 怎么装」「帮我装一下 LifeOS」「LifeOS 装好了吗」「LifeOS 在哪」「LifeOS 坏了/打不开/连不上/修一下」「怎么卸载 LifeOS」时加载本 Skill，用 scripts/lifeos_bootstrap.py 从 GitHub Release 完成真实安装、体检、修复或卸载。安装完成后记录与查询请改用 zzm-lifeos Skill。
---

<!--
[INPUT]: 依赖用户本机 shell 与 Python 3.9+；一切网络、校验、部署与自检下沉给 scripts/lifeos_bootstrap.py。
[OUTPUT]: 对外提供 LifeOS 的引导安装入口：四分意图（装/看/卸/换宿主），并把脚本回执逐字转达给用户。
[POS]: skills/zzm-lifeos-install 的薄入口。它只判断用户想干什么，不判断任何正确性——
       域白名单、sha256、目标占用、双 dbPath 归属与 Token 边界全部由脚本裁定。
       它与 lifeos Skill 是先后关系而非并列：本 Skill 只负责把 LifeOS 装上，装完即退场。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-->

# 安装 LifeOS

先判断意图，再执行对应命令。**所有命令都必须真实执行，禁止凭空描述结果。**

| 用户在说什么 | 执行 |
|---|---|
| 装一个 / 部署 / 下载 LifeOS | `python3 scripts/lifeos_bootstrap.py install` |
| 更新 / 升级到新版 | `python3 scripts/lifeos_bootstrap.py install --upgrade` |
| 装好了吗 / 装在哪 / 在不在跑 | `python3 scripts/lifeos_bootstrap.py status` |
| 卸载 / 不想用了 | `python3 scripts/lifeos_bootstrap.py uninstall` |
| 我的 AI 客户端没被识别 | `python3 scripts/lifeos_bootstrap.py detect`，再按需 `install --skill-host <目录>` |

常用参数：`--version <标签>` 装指定版本，`--install-path <目录>` 换安装位置，`--port <端口>` 换端口。

## 执行纪律

1. **先 `detect` 再 `install`**：让用户看见 skill 会被装进哪些 Agent 宿主，再动手。一个宿主都没探到时，脚本会给出建议，把它原样转达，不要自己猜目录。
2. **退出码 0 才算成功**，非 0 一律视为未安装。脚本的每一条失败都带「下一步」，逐字转达给用户，不要改写成你自己的猜测，也不要自作主张重试。
3. **逐字转达脚本输出**，尤其是最后那行面板地址。没有看到面板地址就不能声称安装成功。
4. **面板地址含访问密钥，只交付给用户本人一次**。绝不把它写进对话摘要、笔记、日志、任何文件或任何网络请求。用户下次要看，让他自己去读安装目录下的 `server/runtime/connection-info.txt`。
5. **安装是有副作用的动作**，会写入用户的应用目录并注册开机自启。执行前说清楚要装到哪里，得到用户同意再跑。
6. **卸载前必须确认**。脚本不会删除任何账本数据，但要明确告诉用户：数据留在原地，而删除安装目录等于永久销毁全部记录。

## 边界

- 本 Skill 只做安装、体检与卸载。**装完之后的记录、查询、修改一律交给 `lifeos` Skill**，不要用本 Skill 的脚本去碰账本。
- 只从 `zhaozimin/LifeOS` 的 GitHub Release 取安装包，且必须 sha256 校验通过才落盘。校验不过就是中止，不存在「先装上再说」。
- 不读屏幕、不采集系统信息、不上传任何本机数据。整个安装过程唯一的出网行为是从 GitHub 下载发布物。
- 目标目录已有内容时脚本会拒绝并要求 `--upgrade`；不要用 `rm -rf` 之类的手段替用户「清出位置」。
- 本 Skill 由 LifeOS 项目维护；运行时不得自行修改或增补它，发现缺陷报告给用户。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
