# 长任务协议异常提前结束修复（2026-09-17）

## 已确认的故障

截图对应请求在 16:32:34—16:33:03 运行。Hermes 会话为 `56da9c05-e661-4a13-b1bd-aa897067b05c`，白球会话为 `local-b9ffd02d-5c1c-49eb-94bc-e74ae9d30d40`。

`state.db` 消息 4788—4795 显示：最后一条阶段结果 JSON 完整，但 `<baiqiu-progress>` 后接 DSML 关闭标签，没有正确关闭公开协议；没有原生工具调用，供应商返回 `finish_reason=stop`，ACP 随后返回 `end_turn`。白球已经记录 `protocolError:true`，却因为之前有正文而最终标为完成。不是凭“继续”一词推测任务失败。

证据来源：

- `D:/白球AI/data/user-data-dev/data/runtime/hermes-home/state.db`
- `D:/白球AI/data/user-data-dev/logs/cross-reply-trace-23704.jsonl`
- `D:/白球AI/data/user-data-dev/data/logs/conversation/conversation-trace.jsonl`
- trace：`conversation-product-ad141c7c-4844-4234-b8cf-60d99ebf91d8`

## 实现

1. 黑球原生执行循环识别上述损坏协议，在原会话内恢复，每个白球 turn 最多两次。恢复前保存实际输出、恢复次数和已执行工具 ID；ACP 内部续问、数据库重载不会重置同一 turn 的上限。恢复指令不落入用户聊天历史。
2. 恢复时只复用同名、相同 JSON 参数、已有实际结果的工具调用；未确定副作用的调用必须先核查。有尚未结算的调用或检查点写入失败时停止自动恢复。
3. 白球保留已接收正文和阶段结果。只从本次观察到的 DSML 尾部恢复经过验证的完整公开 JSON，不补写缺失正文，不把工具协议当答案。
4. `protocolError` 不再因前面有文字而被判成功。失败保存原会话绑定，并显示独立失败提示和“继续任务”按钮。手动继续在原会话提交续问，不重放原指令。
5. 恢复事件带唯一 ID 和序号，重复投递幂等；冲突/缺失序号明确失败。用户取消优先，不触发自动续跑。
6. Python 补丁由应用启动时复制安装，只修改进程内函数，不改用户安装的 Hermes 源码。当前验证版本为 Hermes 0.20.0。

## 验证

本轮相关测试合计 98 项通过（JavaScript/Electron DOM 75，Python 23）；另通过 JavaScript 语法检查和限定文件 diff 检查。

- 精确故障内容的所有分片边界：阶段结果恢复一次，DSML 不泄露。
- 真实 AIAgent 执行循环，供应商响应替身：异常后恢复、连续异常上限、普通成功、完成工具后重复调用（实际工具执行次数为 1）。
- SQLite 关闭再打开：恢复次数和工具结果仍可读取；新 turn 不继承旧 turn 的恢复预算。
- 检查点写入失败、取消、事件重复/冲突/丢失、原会话继续和按钮防重复点击。
- Electron DOM：正文/阶段结果保留，失败提示和继续按钮正确；既有取消及阶段结果保留回归通过。
- ACP initialize 握手已成功，返回 Hermes 0.20.0，无真实模型调用。

主要命令：

```powershell
node --test test/protocol-recovery.test.js test/protocol-recovery-dom.test.js test/hms-progress.test.js test/hms-stream-failure.test.js test/hermes-acp-client-timeout.test.js test/cancel-output-persistence.test.js test/cancel-output-dom.test.js test/stage-result-retention-dom.test.js
python -m unittest discover -s test -p 'test_protocol_recovery.py'
python -m unittest discover -s test -p 'test_tool_generation_bridge.py'
```

Python 验证使用配套运行时，`PYTHONPATH` 包含 Hermes 根目录及 `venv/Lib/site-packages`，`HERMES_HOME` 指向隔离临时目录。

## 边界

- 仍不能确定损坏 DSML 是模型生成还是第三方代理转换导致；本次修复处理客户端错误判定与运行时恢复。
- 没有对所有供应商做在线验收，也未重跑用户原任务。原生循环测试中的模型请求使用替身。
- 相同参数复用不等于所有外部副作用全局恰好执行一次；不同写法表达同一动作需要工具自身的幂等支持。
- 本次不更换供应商、协议或推理强度；不把所有无工具的自然结束都判为异常，不承诺消除其他超时故障。

## 加载与回滚

目标为桌面 `白球AI-测试-11.lnk`，实际源码 `C:/Users/Lenovo/Desktop/白球AI-正式软件仓库/source-current`，当前包版本 3.0.26。本轮未改版本、客户配置或桌面快捷方式。

加载状态：2026-09-17 17:10 在确认无运行任务、无输入草稿后正常退出并通过上述快捷方式重启。主进程从 23704 更换为 7036，启动日志确认版本 3.0.26、开发数据目录不变。CDP 确认页面来自目标源码，`ensureProtocolContinueAction` 已加载；两路 ACP 进程已启动，执行/前台兼容目录中的恢复模块 SHA-256 均与源码一致，`api.prewarmChat` 返回 true。未提交真实模型任务。

修复前文件保存在 `C:/Users/Lenovo/Desktop/白球AI-客户端/work/protocol-recovery-20260917/before/`。由于工作区有其他并行修改，回滚应按本次协议恢复改动逐块撤销，不能整文件覆盖或重置整个仓库。回滚后同样须在空闲时重启主进程与 ACP。
