# 交接笔记 · 2026-08-02

> 这是 Claude 和 Codex 的共享交接文件。Claude 写，Codex 读；Codex 也可在 `codex-notes.md` 里回复。

## Claude 当前状态（2026-08-02）

按交接单 §5 完成**五条主链内部逻辑审查** + **7 项数据安全/状态正确性修复**。

### 已完成修复（全量测试 132/132 通过）
1. **F3 文件夹路径逃逸**（tools/folder-tools.js）：相对路径 `../` 逃逸到工作区外，desktop 前缀也防逃逸
2. **F7 知识库回收站保护**（knowledge-vault.js）：confirmed/pinned 进回收站不被自动永久删除；无 lastUsedAt 的历史笔记不按创建时间误判
3. **F2 大数字精度**（spreadsheet-cell-value.js）：UPC/条码 18 位数字不再被 Number() 溢出
4. **F6 快照恢复归一化**（task-brain.js）：意识快照恢复不再把 executing 任务复活为"无活动运行的幽灵"
5. **F5 澄清误标 completed**（response-router.js + main.js）：模糊需求澄清不再产生"未执行但已完成"的幽灵任务
6. **F4 CSV 编码对称**（csv-encoding.js + main.js）：GBK CSV 保存后仍是 GBK；**顺带修读侧 UTF-8 BOM bug**
7. **F1 表格增量写回**（spreadsheet-save.js + main.js）：保存不再整表重建，公式/合并单元格/样式/其它 sheet 全部保留

新增 7 个测试文件/扩充 3 个，共 **132/132 通过**。关键：**不删任何现有用户数据**，只改行为逻辑。知识星球数据（`%APPDATA%\Baiqiu AI\data\knowledge\`）无数据被删。

### 线上状态（已核实，用户决定先不动）
- `http://47.108.191.67/update.json` 返回 **3.0.7**（forceUpdate=false），ZIP/安装器均可达
- `latest.json` 404；更新清单由 server.py 从 updates.json 动态生成
- **baiqiu-deploy 只能发布新版本，无法撤销**。撤线需用户提供 root

### 待办（Codex 你来 / 用户决定）
1. **打包验证**：本次修复涉及 main.js、多个 services、新模块、package.json（新增 iconv-lite 依赖）。需重新打包验证，确认 iconv-lite 被正确打包（已在 dist 出现过）
2. **真实环境验收**（交接单 §4 的 7 项，task-004/005）
3. 前端 renderer-v2/ 相关发现（见下"给 Codex 的发现"）

### 给 Codex 的发现（前端，我不改）
- `renderer-v2/app.js` 更新提示去重缺"完成状态"键：更新完成后重启仍会亮"新版本"badge（main.js:6766 + app.js:11435）
- 前端 `spreadsheetSave` 在 `mode==="export"` 时不更新 `draft.dirty`，导出后点保存仍整表覆盖原文件（app.js:12379）

### 记录未修（low 级，后续）
- `needs_user_confirmation` 状态无生产者（死代码）
- `requestConfirmation` 死代码无条件放行（permission-manager.js:159）
- `isHighRiskHermesToolCall` 死代码；Hermes 与本地工具权限判定不一致
- 根目录 `updater.js` 旧版死代码
- 更新断点续传进度用服务器 totalSize 而非清单 size

## Codex 回复区
- （Codex 在这里回复当前状态、阻塞点、需要 Claude 做什么）
