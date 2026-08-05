# runtime/
> L2 | 父级: ../CLAUDE.md

成员清单
config.json.example: 回环监听、59418、单 accessToken、Tailscale Host 白名单和时间域时区意图的无密钥模板。
time/: time.sqlite3、时间域审计与备份；可由迁移复制，但不可由财务代码打开。
finance/: finance.sqlite3、附件与财务审计；可由迁移复制，但不可由时间代码打开。
connection-info.txt: 安装期一次性交付的本地连接信息；真实文件永不进入 Git。

法则：runtime 是用户数据主权边界，版本库只保留模板和空目录占位。P6 前一切测试只能使用临时 runtime。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

