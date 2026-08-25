# Agent Runtime 抽象与 Hermes 接入

状态：Runtime 骨架已落地；HermesRuntime 已接入（可切换，默认仍 OpenClaw）  
日期：2026-07-14

## 目标

让白球产品层依赖统一 Runtime 接口，不写死 OpenClaw。  
OpenClaw / Hermes 作为可插拔 Agent 内核并行存在。

## 结构

```text
resources/app/services/runtime/
  runtime-port.js        # 接口约定 / ID / 校验
  openclaw-runtime.js    # OpenClaw 实现
  hermes-runtime.js      # Hermes 实现
  hermes-client.js       # Hermes 通信客户端（HTTP 兼容 + 内存降级）
  runtime-factory.js     # create/get/resolve runtime
  index.js               # 导出入口
```

## 设置项

```js
settings.agentRuntime = "openclaw" | "hermes" | "local"
settings.hermes = {
  enabled: false,
  baseURL: "http://127.0.0.1:18791/v1",
  host: "127.0.0.1",
  port: 18791,
  model: "hermes-default",
  apiKey: "",
  command: "",   // 可选：自定义启动命令
  args: [],
  autoStart: true
}
settings.providers.hermes = {
  name: "Hermes",
  enabled: false,
  baseURL: "http://127.0.0.1:18791/v1",
  apiKey: "",
  model: "hermes-default"
}
```

默认：

- `defaultProvider = relay`
- `agentRuntime = openclaw`（兼容现网）
- Hermes 默认不启用，需显式切换

## 切换方式

### UI（推荐）

设置中心 → **模型** 页：

1. **Agent 内核**：`OpenClaw` / `Hermes`
2. 若选 Hermes，可配置：
   - Base URL
   - 模型版本
   - API Key（可选）
   - 启动命令（可选）
   - 自动启动开关
3. 点 **保存**

也可直接把模型选成 `Hermes`，会自动把 `agentRuntime` 设为 `hermes`。

### 手动改配置

在 `heiqiu-db.json` 设置中写入：

```json
{
  "settings": {
    "agentRuntime": "hermes",
    "defaultProvider": "hermes",
    "hermes": {
      "baseURL": "http://127.0.0.1:18791/v1",
      "model": "hermes-default",
      "autoStart": true
    }
  }
}
```

或设置环境变量：

- `HERMES_HOME`
- `HERMES_BASE_URL`
- `HERMES_PORT`
- `HERMES_MODEL`
- `HERMES_API_KEY`
- `HERMES_COMMAND`

## 当前接线

- `main.js`
  - `ensureAgentRuntime()` 根据 settings 选择 runtime
  - `ensureGatewayRunning()` → `runtime.ensureStarted()`
  - `wireGateway` / `sendWithOpenClaw` / `pollForResult` / abort 走 runtime
- `agent-services.js`
  - `canUseOpenClaw` 对 openclaw **和** hermes 返回 true
  - `executeOpenClaw` 实际是 external runtime 执行路径

## Hermes 实现说明

1. 优先探测本地端口 / 启动 `~/.hermes` 下可执行文件  
2. 通信默认按 OpenAI 兼容 `POST {baseURL}/chat/completions`  
3. 若 HTTP 不可用，内存传输可降级返回诊断文本（便于桌面壳联调）  
4. 远程 `baseURL`（非 localhost）在无本地二进制时仍视为可启动  

> 注意：Hermes 官方协议未内置在本仓库。若你的 Hermes 不是 OpenAI 兼容 HTTP，请改 `hermes-client.js` 的传输层，或通过 `settings.hermes.command/args` 对接实际启动方式。

## 测试

```bash
node scripts/verify-runtime-skeleton.js
# 或
node resources/app/tests/agent-runtime-skeleton-test.js
```

## 下一步

1. UI 增加“Agent 内核”下拉（openclaw / hermes）  
2. 按真实 Hermes 协议替换/收紧 `hermes-client.js`  
3. 双轨验收后考虑开发者版默认 Hermes  
4. 稳定后再评估是否退役 OpenClaw 打包体  
