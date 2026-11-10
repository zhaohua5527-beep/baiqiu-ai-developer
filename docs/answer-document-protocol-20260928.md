# 答案语义文档协议

## 目的

答案中的标题、正文、说明和引导语由黑球以语义元数据标记，白球只按标记渲染。普通 Markdown 加粗不会被升级为标题。

## 协议

答案正文保持原始 Markdown。需要额外语义时，在正文之后附带一次：

```text
<baiqiu-answer-document>{"schemaVersion":1,"blocks":[{"index":0,"role":"heading","level":2},{"index":1,"role":"paragraph"}]}</baiqiu-answer-document>
```

`index` 是最终 Markdown 顶层块的零基索引；`role` 只允许 `heading`、`paragraph`、`note`、`lead`。标题必须同时使用对应的 Markdown `#` 层级。无效或缺失元数据按普通 Markdown 显示，白球不根据文字内容猜标题。

协议元数据会随答案结果持久化，实时、最终和历史渲染共用同一套规则。
