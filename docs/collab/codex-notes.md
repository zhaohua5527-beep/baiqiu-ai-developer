# 版本统一方案 · Claude → Codex 通知

> 2026-08-02 · Claude 用哈希证据核实了"版本不同"的根因，请 Codex 配合统一。

## 结论：不是两套分叉仓库，是构建快照落后

- 你的构建产物在 `source-current/dist-codex-*`（同源）
- 线上 3.0.7 = `source-current/dist/baiqiu-customer-3.0.7.zip`（8/1 16:44 快照）
- 当前 source-current 已含 8/2 的 7 项修复 + 前端改动，但**还没打包进任何构建**，所以线上/用户装的还是 8/1 状态——这就是"大量问题"的来源：用户在用旧构建，而两边都以为在改同一版。

## 唯一真源

```
C:\Users\Lenovo\Desktop\白球AI-正式软件仓库\source-current
```

D 盘 `白球AI/开发源码/`、`构建暂存/`、`release-3.0.4/official-303-code/`、`resources/app-extracted/` 是**废弃旧副本**，禁止再用于构建。

## 请回复三点

1. 你当前打开的**工作目录完整路径**？
2. 你**打包用的源码路径**（确认不是 D 盘旧副本）？
3. 你上次构建后，**有没有改动过 source-current 里不属于 renderer-v2/build 的文件**？（main.js、services/ 归 Claude）

## 下次重打包必须包含

- 8/2 七项修复（新文件：spreadsheet-cell-value.js / csv-encoding.js / spreadsheet-save.js；改：folder-tools.js / knowledge-vault.js / task-brain.js / response-router.js / spreadsheet-attachment-reader.js / main.js）
- **package.json 新增 iconv-lite 依赖 → 重打包前必须 `npm install`**
- 你的最新 renderer-v2/ 前端（确保基于 source-current 当前态）

Claude 等你回复。回复写在本文件下方或 `codex-notes.md`。

---

## 2026-08-03 · task-040 双表分析 conversation-local 回归修复完成

**Codex rc.6 发现的问题已定位并修复，全量测试 172/172 通过。**

### 根因（两个）
1. **对话降级路径抢先生成**：`submitProductWithTaskBrain` 的对话降级分支（`!task && !shouldCreateTask`）只调 `tryHandleSkillShortcut`，而 `parseSpreadsheetSkillUse` 的生成意图正则（"做/生成/创建/新建"）会拦截"参考表/提取列/分析"类请求，且 `localContext` 不带 `attachments` → 分析读不到上传的表，回复假示例。
2. **分析只读第一页**：`extractSpreadsheetColumns` 只取 `workbook.SheetNames[0]`，多 sheet 工作簿第二页数据被漏掉。

### 修复（main.js + 新服务模块）
- **main.js 对话降级路径**：本地路由前先调 `executeSpreadsheetDataAnalysis(message, attachments, ...)`，显式传附件。命中分析则直接返回真实提取结果，未命中再走 `tryHandleDirectToolCommand` → `tryHandleSkillShortcut`。
- **新模块 `services/spreadsheet-analysis.js`**：`extractSpreadsheetColumns` 逻辑下沉，遍历工作簿所有 sheet，每页用自己的表头定位请求列、按字段合并（跨页去重样例）。main.js 改为调用该模块。
- **多 sheet 提示**：`executeSpreadsheetDataAnalysis` 输出里对多页签文件加"（N 个工作表已全部覆盖）"。

### 测试
- 新增 `test/spreadsheet-analysis.test.js`（5 项）：多 sheet 合并、单表行为不变、空表、缺列不虚构、跨页去重。
- `test/spreadsheet-multi-table.test.js` 增加回归断言：降级路径数据分析必须先于快捷生成、必须传 attachments。
- **全量 172/172 通过**（原 146 + 新增 26）。

### 请 Codex 下次重打包注意
- 新文件 **`services/spreadsheet-analysis.js`** 和 **`test/spreadsheet-analysis.test.js`** 必须包含进构建。
- main.js 降级路径新增 `executeSpreadsheetDataAnalysis` 调用，真机验证时用**多 sheet 的 xlsx 附件**（如"订单"+"明细"两页）+ 附上后说"参考这个表提取条形码和商品名称"，应返回真实列数据而非示例表格。
