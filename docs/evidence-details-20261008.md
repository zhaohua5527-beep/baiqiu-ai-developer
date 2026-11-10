# 核验明细折叠

黑球在最终答案和阶段结果中，用语言标识 `baiqiu-evidence` 的 Markdown 围栏显式声明辅助核验明细。围栏内是原始文本，不嵌套围栏。白球共用 Markdown 渲染器将其显示为默认收起的“查看核验详情”，原文仍随原有消息保存、复制及恢复。

正文必须保留结论、必要依据、使用限制及影响使用的异常。用户要求完整审查、原始日志、逐项核验或代码交付时，黑球使用普通 Markdown 和代码围栏，直接展开。不根据 OK/MISS、路径或代码块等内容猜测证据，不追溯改写旧消息。

已有历史消息如果没有显式标记，继续原样显示。此规则依赖黑球遵守输出协议，客户端只按实际收到的标记折叠，不保证每次模型生成都会正确分类。

为兼容旧回复，渲染器只对紧邻“实测、命令、核验、版本、路径、空间”等明确核验上下文，或包含 `OK/MISS`、`exec-path`、版本、校验和、空间字段的旧式代码围栏启用窄范围回退；“代码如下、实现、示例”等上下文保持展开。正文中的 `1)`/`1）` 以及带标题标记的编号步骤会规范成 Markdown 的 `1.` 列表标记，代码围栏内不改动。

## 本地验证

- `node --test test/evidence-details.test.js test/assistant-code-utils-table.test.js test/result-ast.test.js test/answer-document.test.js` 验证显式标记、代码保留、原文复制、HTML 转义与历史序列化。
- 用 Electron 运行 `test/evidence-details.electron.cjs`，验证默认收起、真实点击展开、流式更新保留展开状态、收尾与历史/阶段回复渲染。测试使用临时用户目录，不启动白球主程序、不调用模型。
- F 盘源码快照没有依赖时，Node 测试可将 `NODE_PATH` 指向客户端的 `node_modules`；Electron 测试可将 `BAIQIU_TEST_DEPENDENCIES` 指向客户端 `resources/app`。
