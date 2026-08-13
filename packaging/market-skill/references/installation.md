<!--
[INPUT]: 依赖本 Skill 自带的 payload/（LifeOS 完整发布树的可逆镜像）、scripts/lifeos_setup.py，
         以及用户本机 Bash 与 Python 3.9+。全程零网络。
[OUTPUT]: 对外提供市场形态的离线安装协议：装/看/卸三分意图、执行纪律与失败转达规则。
[POS]: zzm-lifeos-full 的安装协议；只覆盖「从包内 payload 到一个跑起来的服务」这一段。
       已装好的系统要迁移、远程访问或排查部署疑难，见同目录 deployment.md。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-->

# LifeOS 离线安装协议（市场形态）

本 Skill 自带 LifeOS 的完整发布树，安装**不需要网络**：不下载、不遥测、不上传任何本机数据。安装器会逐文件对拍 sha256 清单，任何一条不一致都在触碰安装目标之前中止。

先判断意图，再执行对应命令。**所有命令都必须真实执行，禁止凭空描述结果。**

| 用户在说什么 | 执行 |
|---|---|
| 装一个 / 部署 / 搭建 LifeOS | `python3 "<SKILL_DIR>/scripts/lifeos_setup.py" install` |
| 装好了吗 / 装在哪 / 在不在跑 | `python3 "<SKILL_DIR>/scripts/lifeos_setup.py" status` |
| 更新 / 升级（保留账本与密钥） | `python3 "<SKILL_DIR>/scripts/lifeos_setup.py" install --upgrade` |
| 卸载 / 不想用了 | `python3 "<SKILL_DIR>/scripts/lifeos_setup.py" uninstall` |

常用参数：`--install-path <目录>` 换安装位置（默认 `~/Library/Application Support/LifeOS/app`），`--port <端口>` 换端口（默认 59418），`--replace-pointer` 在全局指针指向别的安装时改指本次。

`<SKILL_DIR>` 是本 Skill 在用户机器上的绝对目录（本文件所在目录的上一级）。执行前必须替换成真实路径；有的平台会注入自己的变量，没有就自己解析。

## 执行纪律

1. **先 `status` 再 `install`**：已有安装时如实说明装在哪、跑没跑，不要重复安装；确需重装用 `--upgrade`，它保留账本与访问密钥。
2. **安装是有副作用的动作**：写入用户的应用目录（默认 `~/Library/Application Support/LifeOS/app`）并注册开机自启（macOS LaunchAgent，label `com.lifeos.node`）。执行前说清楚这两件事，得到用户同意再跑。
3. **退出码 0 才算成功**，非 0 一律视为未安装。脚本的每一条失败都带「下一步」，逐字转达给用户，不要改写成你自己的猜测，也不要自作主张重试。
4. **逐字转达脚本输出**，尤其是最后那行面板地址。没有看到面板地址就不能声称安装成功。
5. **面板地址含访问密钥，只交付给用户本人一次**。绝不把它写进对话摘要、笔记、日志、任何文件或任何网络请求。用户下次要看，让他自己去读安装目录下的 `server/runtime/connection-info.txt`（权限 0600）。
6. **卸载前必须确认**。卸载只移除服务定义与全局指针，不删除任何账本数据；但要明确告诉用户：数据留在安装目录的 `server/runtime/` 里，删除安装目录等于永久销毁全部记录，本系统没有恢复入口。

## 环境要求

- macOS（Apple Silicon 或 Intel）；Linux 可运行服务但无自启脚本；Windows 原生环境不支持。
- Bash 与 Python 3.9+（macOS 自带即满足）。
- 唯一可选的第三方依赖 `openpyxl`：缺失时一切功能正常，只有财务 xlsx 导出返回 503。装法：`python3 -m pip install openpyxl`。安装器缺依赖时只提醒、不中止。

## 边界

- 目标目录已有内容时脚本会拒绝并要求 `--upgrade`；不要用 `rm -rf` 之类的手段替用户「清出位置」。
- 端口被无法认亲的服务占用时脚本会拒绝；不要杀死未确认归属的进程，改用 `--port` 或让用户处理占用方。
- payload 校验不过就是中止，不存在「先装上再说」；此时请用户重新从市场下载安装本 Skill。
- 安装完成后的记录、查询、修改一律走本 Skill 的 timectl/finctl（见 SKILL.md 路由），不要用安装脚本去碰账本。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
