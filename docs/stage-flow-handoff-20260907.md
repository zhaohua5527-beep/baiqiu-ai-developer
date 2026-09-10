# 普通阶段执行流程改动与待验收项（2026-09-07）

## 范围

- 修改 source-current 的 renderer-v2/app.js、renderer-v2/styles.css 和相关回归用例。
- 不修改 Producer、baiqiu-progress 协议、Event Aggregator 或最终答案渲染器。
- Cross 仍使用真实事件原文和原有文本呈现，不增加标题、证据编号或替代结论。
- 不部署、不启动应用、不修改快捷方式、版本号、API 配置或用户数据。

## 实现

- 以 stageId、afterEventId、sourceEventId 和事件序列关联执行阶段，保留独立阶段结果容器。
- 不添加“执行流程 N / 阶段结果 N”标题、框线或底色：流程保持弱化日志样式，真实阶段结果使用更清晰的正文字色与字号，组间留出 20px 间距，维持“流程 → 结果 → 流程 → 结果”的顺序；Cross 原文与呈现不变。
- 每阶段保留所有执行事件 DOM；默认仅露出最新三条，仅保留顶部一个总箭头，统一向下展开或收起所有阶段，不再显示阶段内箭头。
- thinking/action 仅接受明确的 blackball_public 公开事件；工具沿用既有主视图内容规则。
- 成功、失败、超时、空结果与中断使用事件自带状态，不从文本推断。
- 主视图不再为 completed、success、running 等正常状态单独显示状态行；失败、超时、空结果和中断等提示保留，事件原始状态不删除。
- 真实 final 到达后只收起过程；阶段 DOM 保留，最终答案容器不清空、不复制。
- 完成标题只取最后一个真实 action 的 payload.text；缺失时不生成替代标题。
- 增量保留阶段数据，旧快照执行日志按 eventId 合并；冲突报告而不覆盖既有事件。

## 待授权后运行

本次未运行测试、构建或桌面验收。代码审阅不能替代运行结果。

在 source-current 目录使用 Node.js 执行：

~~~powershell
node --test test/stage-flow-contract.test.js test/execution-summary-boundary.test.js test/cross-visual-boundary.test.js test/event-aggregator.test.js test/persisted-replay-boundary.test.js
~~~

新增阶段回归使用现有 cheerio 进行 DOM 容器检查，不新增依赖；不替代真实 Electron 布局和动画验收。

随后仍需明确授权桌面测试，覆盖需求中的十项验收：单阶段、双阶段、同阶段合并、三条与展开、真实异常状态、Cross 去重、答案独立、乱序与重连、历史恢复、移动端无横向溢出。

## 运行来源与备份

- 检查时没有运行中的白球/Electron 进程，不能声称已验证实际加载窗口。
- 正式快捷方式指向 E:/白球AI开发者版/builds/r26-session-switch-fix-10/win-unpacked/白球AI.exe；测试 11 指向 source-current。
- 检查到源码与上述安装目录版本均为 3.0.22，显示版本配置为“白球AI max V1”。本次未更新安装目录。
- 改动前四个已有文件备份位于 C:/Users/Lenovo/Desktop/白球AI-客户端/work/stage-flow-rollback-20260907-061908。
- 仓库原本存在大量未提交改动；不要通过整体 git reset 或清理未跟踪文件回滚本次工作。
- 若黑球未发出 stage_result 或阶段关联字段，白球只能按已收到的真实事件显示，不能补造阶段结果；上游协议缺口需另行授权处理。
