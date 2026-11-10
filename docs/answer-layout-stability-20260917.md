# 完成时二次排版修复

## 原因与修改

流式答案已经通过 `renderProgressiveMarkdown` 解析 Markdown；但 `finalizeLiveChatStream` 在存在阶段回复时调用 `renderPersistedSegmentPairs`，该函数先 `replaceChildren`，再使用历史回放路径重建正文、阶段回复和分段容器。原有文字节点及选择区域因此丢失，段落边距和折行也可能改变。

移除此完成时整体重建。最终消息里的阶段事件仍先按事件身份合并并增量加入，历史回放函数继续用于重新打开会话。保留缺失尾部补齐，不允许空快照清除现有输出。

正文从流式阶段就同步外层的 prose/wide 布局，避免完成时才给外层设置宽度。助手气泡的 grid 和布局 containment 不再依赖临时 streaming-response 类，完成前后采用相同布局规则。

## 验证

- 独立 Electron 用相同完成提交代码测试普通文字、标题/粗体/列表、表格/代码，组合 480/1000px 宽度、1/1.25 字体倍率，共 12 组。答案和阶段回复节点、选择文字、字体、行高、宽高均不变。
- 同一检查运行修改前备份，明确失败：`Completion replaced the answer`。修改后全部通过。
- `test/stage-result-retention-dom.test.js` 两项通过，覆盖连续阶段回复、交叉回复、终态清理、缺省快照合并和历史重放。
- 完成提交边界的针对性检查通过；该文件另有原有小剧场类名断言过时，未改动产品来迎合该断言。
- JavaScript 语法检查和本次文件的 diff 空白检查通过。

本次不修改正文内容，也不将 Markdown 改为纯文本。新增内容或尚未闭合的 Markdown 在后续字符到达时仍可能正常改变当前段落；本次消除的是完成提交触发的整体替换和布局切换。

备份：`C:/Users/Lenovo/Desktop/白球AI-客户端/work/result-layout-stability-20260917/`。
