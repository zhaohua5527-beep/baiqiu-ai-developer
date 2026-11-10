# 会话引用修复（2026-09-24）

引用原来只把消息文字拼入当前请求，缺少原消息附件和来源解析。现在渲染层传递独立的 quote，主进程按来源会话、消息 ID 恢复原文、选中片段、文件和图片，复用现有附件解析与黑球运行通道。

引用上下文包含目标问答及紧邻的上一轮；后续无关用户消息不加入。遇到原消息中已有引用时沿明确引用恢复原始资料，循环引用按来源身份终止。来源缺失时明确标记使用快照，附件读取失败保留真实 analysisError。文件不会仅以文件名冒充已读取。

普通聊天分支显式传递恢复后的 attachments。引用附件按路径、ID 或内嵌数据摘要合并，避免同一图片以 attachments 和 images 两种形式重复提交。源会话 ID 不再被目标会话覆盖；任务队列和请求幂等判断包含引用身份与选中内容。

主进程请求的恢复快照也保留引用后的输入和缓存附件。可见用户消息保持当前指令与 raw.quote 分离，未将整段引用上下文写入用户正文。新增计时日志只含附件数量，不记录引用正文或图片数据。

## 验证

以下本地测试合计 33 项通过：

```powershell
node --test test/quote-context.test.js test/quoted-progress-boundary.test.js test/attachment-canonical-route.test.js test/conversation-local-routing.test.js test/turn-integrity-and-whiteball-boundary.test.js
```

其中集成测试执行源码中的 submitProductWithTaskBrain 和 productLayerChatRuntime，用临时文本文件与 PNG 验证真实附件正文、完整图片 data URL 到达 runHermesSessionPromptWithRecovery 调用边界。外部模型在此边界被替身替代，因此此结果不代表供应商实际看图回答已验收。覆盖跨会话、历史反序列化、嵌套引用、缺失来源、失效文件、附件去重、队列选中内容和幂等身份。

扩展执行 request-lifecycle-regressions.test.js 时，既有的 durable final text cannot replace a mismatched live answer that is already visible 测试失败。它依赖旧的源码表达式；对照本次修改前备份，finalizeLiveChatStream 未变化，旧断言在备份中也不匹配。本次未修改该渲染行为或该断言。

main.js、renderer-v2/app.js、renderer-v2/session-task-queue.js、services/quote-context.js 的 Node 语法检查通过。

## 加载与回滚

桌面“白球AI-测试-11”快捷方式指向 source-current，--dev 使用 D:\白球AI\data\user-data-dev。版本保持 3.0.26。本次中途曾重启开发实例，之后又补齐了附件透传等逻辑，因此最终代码需要完全退出再重新启动后生效；尚未完成最终桌面端真实模型验收。

修改前 main.js 与 app.js 位于 work/quote-fix-backup-20260924-170552。该目录还保存修改前 session-task-queue.js；测试文件副本保存的是本次已调整过断言的中间状态。回滚时应按本次差异处理，避免覆盖其他既有修改。用户设置、模型凭据、聊天数据库、桌面快捷方式和发布包未被本次代码补丁修改。
