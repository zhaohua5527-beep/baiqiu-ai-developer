# 交接包 · Claude 主力 → Codex 外部

> 生成时间：2026-08-01（Claude 作为主力，把已完成的内部修复 + 需要 Codex 做的外部工作交接清楚）
> 仓库：`C:\Users\Lenovo\Desktop\白球AI-正式软件仓库\source-current`

## 0. 协作分工（用户已确认）

| 环节 | Claude（主力） | Codex（外部） |
|---|---|---|
| 内部核心逻辑 services/、main.js | ✅ 已改 | ❌ 不碰 |
| 前端 renderer-v2/ | ❌ | ✅ |
| 打包构建 / 发布 | ❌ | ✅ |
| 真实环境 GUI 验证 | ❌ | ✅ |
| 代码审查 / 根因 | ✅ | 外部问题回报 |

## 1. Claude 已完成并验证的修复

### 阶段 A（两个用户可见 bug）
- **修复 A：计算器超时**（用户真实遇到「做一个计算器软件→90s 超时」）
  - 根因：`createCalculator` 的 HTML 走黑球浏览器，黑球未就绪时反复失败→超时
  - 改动：`services/verified-task-service.js` HTML 优先系统浏览器；`main.js:3594` openPath 注入直通
- **修复 B：NC3001 误报**（超时被翻成"没有安全地进入执行链"）
  - 改动：`tool-execution-service.js` 保留原始错误码；`user-facing-error-adapter.js` 正确分类

### 阶段 B（低风险融合第一波）
1. **降级假授权墙**：`services/permission-manager.js` `check()` 加注释明确是审计/诊断非授权门
2. **验证降为诊断**：`services/verified-task-service.js` `createFiles` 验证失败保留已写入文件为成功+诊断；`services/tool-verification/system-verifier.js` verifySkillInstall 加 diagnostic:true
3. **清理占位技能**：`skills/_manifest.json` 6 个占位（pdf/word/4 professional_skill/skill）设 `enabled:false`，保留 4 真（time/count/disk/cpu）
4. **删除死代码**：删 `services/agent-result-verifier.js`、`services/agents/verifier-agent.js`；`agent-registry.js` 移除 VerifierAgent 登记；`product-execution-services.js` 删 executeImageGuard/executeLlmTool
   - ⚠️ `tryHandleSkillShortcutLegacy` 保留（测试当定位锚点）

### 验证
- **完整测试 67/67 通过**（含阶段 A+B 所有改动）
- 语法检查全部通过

## 2. 需要 Codex 验证（打包后）

1. 安装版点「做一个计算器」→ 秒级打开系统浏览器，不再超时
2. 模拟超时 → 显示「网络或工具响应超时」而非"没有安全地进入执行链"
3. 技能列表不再显示 6 个占位技能
4. 创建文件流程正常（验证失败不覆盖已写入）

## 3. Claude 的 7 领域侦察结论（供 Codex 理解架构方向）
- **工具重叠**：白球已是"Hermes 受控能力后端"（Hermes 出动作→白球执行→证据回喂）。真正冗余只在纯文件生成类，建议收敛到白球本地工具。
- **技能重叠**：白球 6 占位已禁用；word.js 半实现停用；disk/cpu/time/count 保留本地。
- **权限门禁**：approval 和 permissionManager.check() 恒 true 是假授权墙（已降为诊断）；会员门 + 确认门 + Hermes 权限门是真门。
- **状态账本**：6 套会写的状态存储，TaskBrain 应是唯一权威（TerminalStates 守卫健全）。CEO 路径重复 complete 应收敛。
- **记忆系统**：Hermes 记忆（MEMORY.md/USER.md）应是唯一主存储；知识星球=沉淀展示、SQLite=搜索索引、意识中心=压缩恢复。
- **验证体系**：VerifierCenter + standardize 已纯诊断；死代码已删 2 处。

## 4. 需要 Codex 做（外部工作）

### 高优先
1. **打包验证**：`electron-builder --win` 重新打包，安装版复现「做一个计算器」，确认修复 A 生效。
2. **回归测试**：跑完整 Node 测试套件（当前 67/67 通过）。

### 中优先
3. **真实环境验收**（交接单 §4 的 7 项）：
   - 打开计算器 ✅（已由 Claude 修复）
   - 打开 WPS（本机无 WPS，需装或找机器）
   - 生成表格、桌面 XLSX、绝对盘符/盘根路径
   - 任务中切换会话、失败/成功状态
   - 附件预览和 AI 表格修改
4. **前端渲染**：renderer-v2/ 的改动（任务状态展示、流式、表格工作台）由你维护。

### 低优先（架构方向，等用户验收 3.0.7 后）
5. 状态账本统一、记忆单一来源、权限统一、路由单入口——融合第二/三波。

## 5. 重要提醒
- 工作树有多轮改动（含 Claude 刚做的阶段 B）。**不要 reset 或覆盖 Claude 的改动**。
- Claude 改的文件：`verified-task-service.js`、`tool-execution-service.js`、`user-facing-error-adapter.js`、`main.js`、`permission-manager.js`、`system-verifier.js`、`agent-registry.js`、`product-execution-services.js`、`skills/_manifest.json`；已删 `agent-result-verifier.js`、`verifier-agent.js`。
- 线上已是 3.0.7（用户决定不回退），不要再次发布 stable，不要开 forceUpdate。
- 用户验收前收集"很多问题"，按共享根因分组，不要凭猜测继续改。
