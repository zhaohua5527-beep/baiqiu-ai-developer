# 微信同步、启动与搜索进度修复记录（2026-09-28）

## 证据与修复

- **微信漏同步**：原镜像挂在消息处理器返回处，忙碌队列中的消息绕过该入口；附件消息又被空正文判断排除。现改为在原生适配器接收消息、成功发送正文及文件时记录，使用平台消息身份去重，SQLite 日志按序补收。不同消息即使文字相同也保留；先提交桌面数据，再推进补收游标。
- **微信后续消息打断当前任务**：原生忙碌策略为 interrupt。微信默认改为 queue，原生显式停止命令仍有效。
- **实际执行停顿**：对当时网关 PID 24264 的只读栈采样显示，一个线程卡在 `_bash_starts → subprocess.run → communicate`，另一个等文件操作初始化锁。Windows 超时杀掉父进程后，子进程仍持有输出管道，导致收集输出继续等待。仅替换 Bash 探测调用为文件承接输出和有界等待，超时清理该探测进程树。该证据解释这次停顿，不能解释所有历史超时。
- **反复启动黑球**：本轮新增 Python 探测模块后，ACP 入口已引用，但兼容目录复制列表遗漏模块，造成启动退出。已补齐复制列表，并在 Git Bash 预检之前安装保护；增加所有本地 Python 桥接依赖的分发检查。
- **解绑后无二维码**：清理旧二维码、重定向地址与冷却状态，解绑成功后重新申请二维码。主进程和页面拒绝过期状态回调；并发解绑只执行一次；刷新失败仍能继续刷新。启动停止竞态也已阻断。
- **文件显示为原始提示**：微信文件呈现名称、类型、大小、打开和所在位置操作。发送临时文件先留存副本供桌面查看；历史原生文档信封仅对受信缓存内确实存在的文件恢复附件，保留用户附言。
- **两三行相同的“正在搜索”**：受影响回合存在不同工具调用 ID，例如 `tc-1f3e706287fa` 搜索撤销、`tc-c76bfab058f8` 搜索中止，均有对应结束事件。原生 ACP 构建开始事件时遗漏 rawInput，导致目标信息丢失。生产端现在保留搜索及读文件的公开参数白名单；旧记录只有通用搜索摘要时展示上游 title。并行任务及其结束状态仍独立保留，不按文字合并。

## 验证

- JavaScript：微信契约、生命周期、ACP 超时、启动桥接、进度映射合计 68 项通过，1 项可选联网测试本轮跳过。
- 原生 Python：微信投递 11 项、工具执行进度 14 项通过，包含队列附件、重复身份、临时文件、二维码重试、子进程持有输出管道的超时复现、并行搜索参数。
- Electron 隔离窗口：微信文件卡及解绑状态检查通过；执行区 201 条事件、中文输入、三行限制、并行搜索不同标题和分别结束检查通过。
- 实际捆绑运行时完成 ACP 握手；此前本任务已使用隔离会话连续询问两道算术题，分别收到 15、17，运行时只启动一次。未向真实微信联系人发送测试消息。
- 当前三个 Python 兼容目录同步最新桥接文件。已经运行的 Python 进程不会热导入这些改动，已打开的主进程和页面也不会自动加载磁盘修改；完整改动需下一次正常启动加载。

## 验证边界与剩余建议

- 未执行真实手机扫码、解绑与双端收发闭环；自动测试使用隔离数据，不能替代真实微信验证。日志还出现过 DNS 失败，代码修复不保证网络故障消失。
- 工具协议片段 `<parameter name="code">` 进入正文属于另一项输出边界缺陷，不能仅凭截图认定为隐藏思考泄露。本轮未扩大修改该协议。建议在生产端明确识别失配的工具协议、与公开答案分流，受限恢复且避免重跑已提交工具；保留用户主动要求展示的代码，不用正文关键词过滤遮掩。
- 未发布安装包、改线上更新源、清理用户历史或重启正在工作的客户端。

## 复现命令

在仓库根目录运行：

```powershell
$env:BAIQIU_TEST_RUNTIME='D:/白球AI/data/user-data-dev/data/runtime/hms-0.20.0'
node --test test/wechat-gateway-contract.test.js test/wechat-lifecycle.test.js test/hermes-acp-client-timeout.test.js test/hermes-startup-bridge.test.js test/hms-progress.test.js
$env:PYTHONUTF8='1'
$env:PYTHONPATH="$env:BAIQIU_TEST_RUNTIME/hermes/hermes-agent"
& "$env:BAIQIU_TEST_RUNTIME/hermes/hermes-agent/venv/Scripts/python.exe" -m unittest discover -s test -p test_wechat_delivery.py
& "$env:BAIQIU_TEST_RUNTIME/hermes/hermes-agent/venv/Scripts/python.exe" -m unittest discover -s test -p test_tool_execution_progress.py
```
