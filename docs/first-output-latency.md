# 首次真实输出延迟

## 早期工具事件

内置 HMS 0.20.0 的 `_fire_tool_gen_started` 在原生流解析到工具名称时触发。
客户端随源码发布 `services/baiqiu_acp_entry.py`，启动时同步到 Python 兼容目录，
由 ACP 子类为当前会话绑定 `tool_gen_callback`；提示结束或取消后恢复原回调。
不修改安装目录内的 Agent / Tool 源码。外部 `HERMES_ACP_PATH` 仍使用原启动入口。

真实回调生成带 UUID、生产时间和工具名的 `tool_generating` 事件，
通过 ACP 空文本消息的 `_meta.baiqiu_execution` 扩展传输。空文本不是答案或思考内容，
不触发原生 `streamed_message`，不计入工具调用次数，也不重置无答案工具预算。
展示文字为“正在生成 terminal 调用参数”等，由原生回调中的真实工具名产生。
它不表示工具已经开始执行，不拥有 `toolCallId`，不构成执行成功证据。

实时和历史入口均经过 `HmsProgressMapper`，保留生产端事件 ID、时间以及原有顺序。
之后的真实工具调用、命令、Python、参数、返回内容继续走原路径。
没有原生回调则没有该事件；不补充交叉验证或阶段结果。
普通对话不调用工具时，此修改不会凭空显示工具过程，也不承诺缩短模型生成答案的时间。

## 耗时记录

记录位于用户数据目录 `logs/cross-reply-trace-<pid>.jsonl`，phase 前缀为 `output:`。
仅记录标识、事件类型、时间与耗时，不记录答案、私有思考、命令、参数或密钥。

| 阶段 | 含义 |
| --- | --- |
| promptDispatched | ACP 已下发提示，不代表供应商已开始生成 |
| firstUpdate | ACP 的第一条通知，可能只是状态，不能作为首字 |
| firstThoughtTextUpdate | 第一条原生思考文本，仅记录时间，不作为公开过程 |
| firstMessageTextUpdate | 第一条原生消息文本，可能含协议，还不等于答案首字 |
| firstToolGenerationUpdate | 收到原生工具参数生成事件 |
| firstToolExecutionUpdate | 收到真实工具执行开始事件 |
| firstProcessEmitted / firstAnswerEmitted | 主进程首次发出公开过程 / 已分流答案 |
| firstProcessReceived / firstAnswerReceived | 渲染进程首次接受过程 / 非空答案增量 |
| firstProcessDomText / firstAnswerDomText | 连接且非隐藏的节点中首次写入非空文字 |

主进程的公开首字耗时以 `runHermesSessionPrompt` 开始时间为基准；ACP 阶段以
`client.prompt` 开始为基准；前端以 `requestStartedAt`（用户发出请求）为基准。
跨层比较应按同一个 `turnId` 的 `observedAt` 比较，不能直接相减不同基准的 `elapsedMs`。
ACP 重试/续轮可能有多个 promptDispatched；主进程和前端的公开首字每轮各记一次。
DOM 时间是写入可见节点的近似上屏时间，不是操作系统实际呈现像素的测量。
阶段结果、交叉结论、等待动画和历史回放不算执行过程首字。
没有对应输出就没有对应指标；未经过流式答案路径的最终整段回填不算答案增量首字。

## 当前验证状态

2026-09-08 用户授权继续测试和修复后，已运行隔离的原生 ACP 请求与回归检查。
本轮 JS 119 项通过；另 12 项历史回放 / Electron DOM 旧测试因隔离环境缺少
`persistedReplay` / `blackBallPublicEvents` 等依赖而失败，修改前备份同样复现。
Python 回调、同请求重试、错误脱敏和回调恢复检查 4 项通过。

本地故障注入分别验证了首字前过载和部分答案后过载；这两组是测试夹具，不是真实供应商事件。
真实配置接口的一次独立请求成功，ACP 下发至首消息约 5.88 秒；后一次请求返回 HTTP 429，
客户端准确报告供应商限流。没有测得稳定提速比例，不能承诺“第一秒回复”。
未构建发行包、未重启正式应用，详细证据见本次工作目录的修复验证报告。

## 流失败与重试

源码管理的 ACP 桥接器观察当前 Agent 的原生错误入口，发送空消息上的
`_meta.baiqiu_diagnostic`。诊断仅包含错误分类和安全时间字段，不进入过程或答案正文。
除了原有错误 / 重试回调，还观察 `_is_provider_stream_parse_error`：原生运行时在部分正文后
断流时可能直接返回部分结果，绕过后续错误回调。桥接器保留该方法的原返回值，并在请求结束后恢复绑定。

过载、限流和鉴权失败立即取消当前提示并释放本地会话句柄；其余网络错误保留原生恢复路径。
失败结果带回已接收的工具信息、执行事件、阶段结果和答案段；产品适配器在原答案后追加失败提示。
前端分别传递首事件 30 秒超时和后续 2 分钟无进展超时，避免显示错误时长。

仅在原生会话空闲、两份提示均包含运行上下文包装且用户请求全文相同、没有附件时，
清除原生暂存的重复中断提示。不同请求、纠正指令和其他提示继续走原恢复逻辑；不删除会话历史。
对已观察到的 `</baiu-progress>` 拼写错误，仅恢复其中可完整解析的真实阶段 JSON。
这一兼容处理不生成阶段正文，也不改变工具代码、输出、字体、布局或小剧场。

扩展诊断依赖内置 HMS 0.20.0 的现有方法；外部 ACP 入口不保证发出此扩展，仍使用原错误路径。
