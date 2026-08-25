# 白球-HMS 融合方案（Claude 主力版）

> 版本：v1 · 2026-08-01 · Claude 基于 7 领域侦察完成
> 目标：把「产品外壳 + Hermes 内核」的双系统重叠，融合为 **一个真相、一条链路、一套权限、一份记忆**

---

## 一、现状：七重重叠（每条有证据）

### 1. 路由 — 4 个执行引擎在竞争
`chat:send` 本地短路（main.js:13028-13187）、产品窗快捷前置（main.js:2696-2714）、ProductExecutionRouter 策略链（main.js:13301）、UIAdapter.submitUIInput —— 四个引擎按窗口/布尔值抢同一个请求。四策略的 `canHandle` 判定完全相同（都 = `Boolean(understanding)`），纯靠数组顺序级联，**没有真正的选择逻辑**。

### 2. 状态 — 6 套会写的存储
TaskBrain（tasks.json）、TaskQueue（db.queue）、ProjectRunLedger（project-runs.json）、Hermes state.db、ProductSDK 任务文件、会话/Context 镜像。同一个请求写多份，靠 `delegationRecoveredFromState` 事后补救。

### 3. 权限 — 5 层门，2 层是假墙
会员门（真）、审批门（恒 true 空转）、权限门（恒 allowed:true 假授权墙）、确认门（真）、验证门（已诊断）。Hermes 走另一套 `requestHermesPermission`。

### 4. 工具 — 白球已是 Hermes 的"受控能力后端"
Hermes 出动作 → 白球执行 → 证据回喂（browser 回环、web 桥）。真正冗余只在纯文件生成类（写文件/Excel/Word/PDF）。

### 5. 技能 — 6 个占位 + word 半实现
白球 `professional_skill_*` + `skill.js` + `pdf.js` 纯回显规则文本；Hermes 有 80+ 完整 SKILL.md（pdf/docx/xlsx）。

### 6. 验证 — 已诊断，但残留改写
`VerifiedTaskService` 内部校验失败会 `failTasks` 覆盖已成功写入；`system-verifier.js` 的 verifySkillInstall 用 verified 当硬判据。死代码 2 处。

### 7. 记忆 — 7 套存储
Hermes 记忆（真主存储）、KnowledgeVault、SQLite、ConsciousCenter、MemoryCenter、memory-architecture。双写路径：名字写 3 处。

---

## 二、融合目标：单一权威

| 领域 | 单一权威 | 其余降级为 |
|---|---|---|
| 路由 | 一条链路：`理解层 → 确定性本地门 → Hermes/CEO` | 删 3 个竞争引擎 |
| 状态 | **TaskBrain** | db.queue/ProductSDK/镜像只读 |
| 权限 | 单一 `PermissionPolicy`（会员=授权，三档=确认，验证=诊断） | 假授权墙改 logger |
| 工具 | 文件生成类收敛白球本地；浏览器/搜索/命令/委派保留分工 | Hermes 专注规划/内容 |
| 技能 | Hermes SKILL.md（真能力）；白球本地只留 disk/cpu/time/count | 删 6 占位，停用 word.js |
| 验证 | VerifierCenter + standardize 纯诊断 | VerifiedTaskService 校验降为诊断字段 |
| 记忆 | Hermes MEMORY.md/USER.md | 知识星球=沉淀层、SQLite=索引、意识中心=压缩 |

---

## 三、分阶段执行（每阶段独立可交付、可回退）

### 阶段 A：已完成的修复（✅ Claude 已做）
1. **计算器超时**：HTML 走系统浏览器，黑球只用于网页浏览（verified-task-service.js + main.js openPath 注入）
2. **NC3001 误报**：保留原始错误码，超时/权限正确分类（tool-execution-service.js + user-facing-error-adapter.js）
- 测试：25 项通过

### 阶段 B：融合第一波（低风险，Claude 做，Codex 打包验证）
1. **删除假授权墙**：`PermissionManager.check()` 显式改为 logger（保留审计），`ToolSelector.approveToolCall` 降为诊断
2. **验证降为诊断**：`VerifiedTaskService` 校验失败不覆盖已成功写入（改 `failTasks`）；`system-verifier.js` 加"诊断不改写"注释
3. **删占位技能**：6 个纯回显技能（pdf + 4 professional_skill + skill）从 manifest 移除
4. **删死代码**：agent-result-verifier.js、VerifierAgent、tryHandleSkillShortcutLegacy、executeLlmTool/executeImageGuard

### 阶段 C：融合第二波（中风险，需规划）
1. **路由单入口**：chat:send 与产品窗共用 `understand()`；四策略合并为「确定性本地门（先执行）+ Hermes（兜底）」
2. **本地路由修正**：`classifyTiming`/`taskTypeFor` 真正驱动本地门——local_create/local_launch 先查 verified-task-service，不中才 Hermes
3. **状态统一**：TaskBrain 唯一权威，砍 db.queue/ProductSDK 独立写，CEO 重复 complete 收敛

### 阶段 D：融合第三波（高风险，大重构）
1. **权限统一**：会员 + 三档 + Hermes 合成单一 `PermissionPolicy`，用户只见一套确认卡片
2. **记忆单一来源**：Hermes 记忆为主，双写路径收敛为单向派生
3. **ACP 薄适配层**：monkey-patch 收进协议层，文件证据类型化

---

## 四、Codex 工作包（外部）

### 立即做（配合阶段 B）
1. **打包验证修复 A/B**：`electron-builder --win` 重打包，安装版复现「做一个计算器」不再超时
2. **回归测试**：完整 Node 套件确认没破坏功能
3. **真实环境验收**：计算器/WPS/表格/路径/会话切换/附件

### 保持（前端）
- renderer-v2/ 的任务状态展示、流式、表格工作台由 Codex 维护

### 不做
- 不覆盖 Claude 改的 4 个文件
- 不 reset 工作树（56 项改动无基线）
- 不再发布 stable、不开 forceUpdate

---

## 五、验证矩阵

| 能力 | 改前 | 改后（目标） |
|---|---|---|
| 做计算器 | 90s 超时 | 秒级打开系统浏览器 |
| 工具超时提示 | "没有安全地进入执行链" | "网络或工具响应超时" |
| 任务状态 | 6 套存储各写各的 | TaskBrain 唯一 |
| 权限 | 5 层门 2 层假 | 单一策略入口 |
| 技能 | 6 个占位污染 | 只留真实能力 |
| 记忆 | 名字存 3 处 | Hermes 唯一 |

---

## 六、风险与依赖

- **依赖**：Codex 打包验证是阶段 B 的前置；用户「很多问题」清单是阶段 C/D 的输入
- **风险**：阶段 C 的路由合并可能改行为，需真实环境回归
- **顺序**：A（已完成）→ B（低风险先行）→ C → D
