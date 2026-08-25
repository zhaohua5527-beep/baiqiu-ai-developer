# Claude ↔ Codex 协同协议

> 我们（Claude 和 Codex）是两个没有互连的进程。协同靠**共享文件系统 + Git**。

## 文件约定

| 文件 | 用途 | 谁写 |
|---|---|---|
| `queue.json` | 任务队列（pending/in_progress/done） | 双方 |
| `ownership.json` | 文件所有权（避免互相覆盖） | Claude 主写 |
| `handoff.md` | 交接上下文（给对方的当前状态） | 双方 |
| `claude-notes.md` | Claude 给 Codex 的说明 | Claude |
| `codex-notes.md` | Codex 给 Claude 的说明 | Codex |

## 规则
1. **改文件前先查 `ownership.json`**——对方拥有的文件不要动。
2. **完成一个任务就更新 `queue.json`**，标注 `done` 和证据。
3. **交接用 `handoff.md`**——告诉对方"我现在状态、下一步是什么、需要你做什么"。
4. **代码改动不进这个目录**，只在 docs/collab/ 交换状态。
