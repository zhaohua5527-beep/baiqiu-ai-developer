# 默认中转站模型配置设计

## 目标

让白球 AI 的全新安装默认使用用户指定的 OpenAI 兼容中转站，同时保留现有供应商供用户切换。

## 默认值

- 内部供应商 ID：`relay`
- 显示名：`默认中转站`
- Base URL：`https://sub2.hhlai.xyz/v1`
- 模型：`gpt-5.5`
- API Key：空；由每位用户在设置界面自行填写

应用会在 Base URL 后追加 `/chat/completions`，因此默认请求地址为 `https://sub2.hhlai.xyz/v1/chat/completions`。

## 范围

1. 在模型预设和首次运行默认配置中加入 `relay`。
2. 将全新安装的 `defaultProvider` 设置为 `relay`。
3. 保留 `deepseek`、`openai`、`kimi`、`anthropic`、`qwen`、`baidu`、`zhipu`、`ollama` 与 `openclaw` 配置。
4. 现有用户的已保存 `defaultProvider` 和 API Key 不被迁移或覆盖。
5. 设置界面显示新供应商的名称、Base URL、模型和空 API Key 输入框。

## 非目标

- 不在仓库、安装包或默认数据库中保存 API Key。
- 不验证或代管用户的 API Key。
- 不删除或重命名现有供应商 ID。
- 不修改 OpenClaw 网关提供商。

## 实现设计

在 `services/model-adapter.js` 中新增 `relay` 预设，使用 OpenAI 兼容协议并要求 API Key。在 `main.js` 的 `defaultDb()` 中新增对应 provider，并将首次默认 provider 改为 `relay`。

现有数据库继续通过合并默认设置的方式加载：已有 `defaultProvider` 会被保留；仅没有该字段的全新数据库使用 `relay`。渲染层继续从 providers 配置动态呈现选项，无需把密钥或中转站参数写入 HTML。

## 错误处理

- API Key 为空时，模型适配器给出“请先在设置中填写默认中转站的 API Key”。
- 中转站返回非成功状态时，保留当前用户可读错误处理路径。
- Base URL 会去掉末尾斜杠，避免生成双斜杠的请求地址。

## 验证

1. 新默认值测试：断言 `relay` 是首次默认 provider，Base URL 和模型精确匹配。
2. 模型适配器测试：使用 mock fetch，断言 URL 为 `https://sub2.hhlai.xyz/v1/chat/completions`，并使用 Bearer 授权头。
3. 现有高频验收测试与 `npm run check` 保持通过。

## 安全边界

API Key 只保存在用户本机已有的设置存储中；不得记录到 Git、日志、安装包、产品默认配置或本规格以外的任何静态文件。
