# 黑球运行完成状态与白球投递核对

## 问题与边界

本次核对的会话为 `local-a71fffde-38b4-489f-9dcb-1a22b1f8e718`，轮次为
`chat-local-a71fffde-38b4-489f-9dcb-1a22b1f8e718-7230ad4e-4bc0-4998-b283-c6b33757a6f9`。
已出现的 `stage_result/completed` 是阶段结果，当时仍有工具未结束。白球的两分钟静默
看门狗发送了 timeout abort；这不能证明黑球已经失败，也不能用阶段结束证明整轮完成。

此次修改不改变 DOM、CSS、Markdown、字体、动画或布局。renderer-v2/app.js 仅调整
静默看门狗及 unknown 状态映射，继续使用现有提示呈现方式。

## 状态权威与数据流

1. Python ACP 包装器捕获真实 `run_conversation` 的 completed、failed、interrupted、error。
   工具仍有 pending 状态或原生 completed 不为 true 时不能提交 completed。
   某个工具曾失败但随后恢复，不单独导致整轮失败。
2. 运行层输出 `black_ball_runtime` 状态，绑定 sessionId、turnId、eventId 和 sequence。
   阶段结果与运行终态分别处理。这里的 completed 表示原生执行轮正常结束，
   不代表对任意业务目标进行独立质量验收；模型判断内容仍可能有误。
3. 公开 ACP 更新按事件身份和序号记录，完成时与状态一起原子写入
   `HERMES_HOME/baiqiu-runs/<session-and-turn-sha256>.json`。不保存隐藏思考更新。
   写入成功后释放该轮内存记录；后续查询读取终态文件。
4. 客户端运行期间每 15 秒检查是否静默，必要时查询 `_baiqiu/run_status`。
   每次查询最多等待 5 秒，合并并发查询。后台会话也能核对，不依赖当前可见界面。
5. 缺失更新经原来的事件处理链补回；同 eventId 的相同事件只处理一次，
   内容冲突、终态身份不匹配、非法终态元数据会报协议错误。不会重新调用模型或工具。
6. ACP 断开后读取已落盘终态；没有终态证据则保留 unknown 和已有内容。
   SDK、普通对话、任务状态与持久化不得仅凭有文字将 unknown 改为成功或失败。
7. 同轮已提交的权威完成结果不会被迟到的超时写入覆盖。

## 时限与停止

- 界面两分钟静默不再取消黑球，不再自行判定执行失败；改为状态核对。
- 手动停止仍有效，并保持既有输出保留逻辑。
- 现有 30 分钟执行硬时限保留。到点先查询运行终态；已结束则同步结果。
  未确认结束时仍按原有资源时限策略终止，避免无限执行。
- unknown 不等于运行中，也不等于失败；进程崩溃且尚未写入终态时，
  无法证明任务完成，不自动重跑可能已经产生副作用的操作。
- 本轮未实现跨桌面应用重启的自动执行恢复，也未迁移历史错误状态。

## 验证

本地隔离回归，无收费模型调用、无用户会话测试消息、无运行中应用重启：

```powershell
node --test test/runtime-status.test.js test/hermes-acp-client-timeout.test.js test/hms-outcome-contract.test.js test/request-run-contract.test.js test/request-lifecycle-regressions.test.js test/request-lifecycle-fix.test.js test/structured-task-presentation.test.js
```

JavaScript：68 项，66 通过；两条既有渲染源码正则断言失败：

- request-lifecycle-regressions：旧断言仍要求 finalize 中的旧条件表达式。
- structured-task-presentation：旧断言仍要求 addMessage 中直接赋值 renderMarkdown。

对应 addMessage/finalizeLiveChatStream 函数与修改前备份逐段比较相同，
不为满足这些断言修改本次范围外的 UI 渲染。

Python `test/test_run_state.py`：7 项通过，包括真实 ACP 子类包装器与实际 ACP 消息类型。
覆盖阶段完成但工具待定、取消、失败、工具失败后恢复、事件落盘后恢复、思考隔离。
JavaScript 覆盖缺失终态、后台核对、乱序补发、重复及冲突事件、未知状态贯穿 SDK、
错误轮次隔离、手动取消、迟到超时、硬时限与换轮竞态。主程序及修改的 JS 通过语法检查。
测试输出位于 `work/runtime-status-20260929-203039/regression.log`。

## 生效与回退

修改位于正式软件仓库 source-current；当前已启动的 Electron 仍使用已加载的旧代码。
未打包、上传或自动重启，需结束当前任务后重新启动测试客户端才加载本次修改。
运行态还未经过用户真实模型端到端验证。

修改前主要文件备份位于 `work/runtime-status-20260929-203039`。仓库有其他未提交工作，
回退应撤销本次差异，不能执行整个仓库 reset 或覆盖用户数据。
