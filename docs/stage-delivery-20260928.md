# 阶段性交付检查与交付审计

本次修改作用于 source-current（3.0.27），未发布更新包，未重启用户客户端。完整退出后重新打开测试客户端，才会加载新的主进程、渲染器和 Python 桥接文件。

## 行为

- 黑球原执行循环在工具返回后的下一次模型请求中附带交付检查。没有新增审查模型、定时造卡或重跑工具。
- 模型决定是否已有用户可以使用的阶段成果。有成果且还要继续执行时，先输出完整 stage_result，再调用下一项工具。
- 尚未形成成果，可在真实 action 中用 stageAssessment=pending 标明。已确认但尚未交付，用 ready 标明；后续继续提醒待交付目标。
- 未判断记录为 assessment_missing，不冒充“没有成果”。已确认目标缺少对应交付记录为 delivery_missing。cross 不替代阶段结果或交付判断。
- 简单问题和已经解决完整任务的工具结果可以直接输出最终答案。取消后停止检查；提醒不写入会话历史。
- 移除阶段成果经过解析和主进程时的 20000/800 字截断，保留换行、Markdown 源文及既有凭据脱敏。
- 维持原有三行执行窗口、阶段结果与执行步骤交替、永久结果保留以及表情和补充队列逻辑。

## 审计

沿用 logs/cross-reply-trace-进程号.jsonl，记录 producer、parsed、sent、persisted、received、painted。只记录轮次、事件/片段标识、字数与状态，不记录正文和密钥。字数统一使用 UTF-16 单位以匹配 JavaScript，避免 emoji 造成误报。

离线核对命令：

```text
node build/audit-stage-delivery.js TURN_ID TRACE.jsonl [其他TRACE.jsonl]
```

传输和存储按 eventId 核对；生产者诊断与首次解析按本轮 scoped segmentId 和长度关联。同片段同长度的多次产出仍可能关联不唯一，不能把这个报告当作语义正确性的证明。

报告中的 notObserved 表示该日志未观察到该环节，不直接断言丢失。需确认任务结束、日志完整、对应会话确实显示；未打开会话不应判为渲染失败。evidenceResolved 只证明引用的是本轮真实返回的工具 ID，不证明模型结论正确。

## 实测

使用用户当前配置的 DeepSeek / deepseek-flash、真实网络模型请求和原 Hermes 执行循环。工具被限制为隔离样例读取，使用临时 HERMES_HOME，不读取用户业务文件、不修改用户会话。未替换模型响应。

| 场景 | 实际结果 |
| --- | --- |
| 7+8，无需工具 | 4.19 秒，回答 15，无阶段卡 |
| 读取 A，再根据 A 内文件名读取 B | 6.53 秒，先交付 A 的 45+75=120，再执行 B 的读取；B 为 80+70=150，最终合计 270 |
| 读取不存在的 missing | 2.80 秒，说明缺少数据，无虚构阶段卡 |

真实输出保存在 work/stage-delivery-live.json。该实测是隔离的原生模型循环，不是用户正在运行的完整桌面会话，也不代表所有供应商已验收。随后将上述真实公开输出按 11 字符分片送入现有解析器，在隐藏 Electron 窗口中验证正文一致及恢复保留，结果通过。

测试记录：

- test_stage_delivery.py：8 项通过，包括原生循环、漏判断/漏交付、cross 隔离、取消、证据引用和 UTF-16 字数。
- test_protocol_recovery.py：7 项通过；test_context_on_demand.py：12 项通过。
- work/stage-delivery-final-node.log：35 项中 34 项通过，包含阶段保留、诊断、补充队列、取消存储和表情。
- work/stage-delivery-replay.log：31 项中 26 项通过，包含真实输出 Electron 回放、乱序、冲突事件、协议恢复和输出归属。
- work/stage-delivery-final-framing.log：6 项通过，覆盖实际主进程发送函数、长正文、嵌套持久化及离线审计。
- JavaScript/Python 语法检查通过，main.js 完整性哈希已同步。

既有测试限制：cancel-output-dom 的独立测试环境缺少 activeSendOwners；相关生命周期函数与本次修改前备份完全一致。persisted-stream-replay-regression 的 5 项测试缺少 executionSummaryEntry，使用修改前备份再次执行仍全部同样失败（work/stage-delivery-baseline-replay.log）。未将这些旧测试问题伪装成全部通过，也未修改无关产品逻辑。

## 能力边界与回退

这是运行时提醒与可观察的交付检查，不是模型语义判断的百分之百保证。模型持续不遵守时会留下可定位的漏判断/漏交付记录；白球不代写答案，也不额外调用模型强制重试。

本轮备份：C:/Users/Lenovo/Desktop/白球AI-客户端/.release-rollback/20260928-130443-stage-delivery。备份内是本轮开始时的源文件；回退时逐文件比较，保留其后其他工作。新增模块、审计脚本和测试仅服务本功能。用户数据和密钥不在该源码备份中。
