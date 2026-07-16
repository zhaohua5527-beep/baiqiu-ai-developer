# 白球 AI 全套设计系统 · Orbital Operator

日期：2026-07-14  
产品：白球 AI（Windows 本地执行型个人 AI 助理）  
受众：需要“真正把事做完”的桌面用户 / 开发者 / 运营者  
界面任务：让人立刻感到这是一台**可靠的本地执行控制台**，不是通用聊天壳。

## 设计立场

拒绝三类模板默认：

1. 奶油底 + 衬线 + 陶土色  
2. 纯黑 + 酸绿终端黑客风  
3. 报纸细线零圆角排版  

白球的世界来自：**球体、轨道、冷光、精密面板**。  
签名元素是 **Orbit Ring（轨道环）**：状态徽章、主按钮、输入区与选中卡片都带一层冷静的椭圆光晕，暗示“白球在轨、任务可控”。

## 令牌

| 名称 | Hex | 用途 |
|---|---|---|
| Void | `#070B10` | 最底层背景 |
| Ink | `#0E141C` | 主壳背景 |
| Panel | `#151C26` | 面板 |
| Panel Soft | `#1B2430` | 次级面板 / 悬浮 |
| Line | `#2A3544` | 边框 |
| Pearl | `#E7EEF8` | 主文字 |
| Mist | `#93A0B4` | 次级文字 |
| Ice | `#79C4FF` | 主强调 / 轨道光 |
| Signal | `#4AD6B8` | 成功 / 就绪 |
| Amber | `#E8B15A` | 警告 / 试用 |
| Danger | `#FF6B7A` | 错误 / 中止 |
| User Tint | `#1A2A3A` | 用户气泡底 |

### 字体

- Display / UI：`"Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif`
- Mono / 数据：`"Cascadia Mono", "Consolas", "Microsoft YaHei UI", monospace`

中文场景优先清晰可读，不使用花哨展示字体。

### 圆角与阴影

- Radius sm `10px` / md `14px` / lg `18px` / pill `999px`
- Shadow：冷色低对比，`0 12px 32px rgba(0,0,0,.34)` + 轻微 Ice 外光

## 布局概念

```text
┌ titlebar: brand + orbit-status + actions ──────────────┐
│ sessions │ chat stage (empty / messages) │ ops rail     │
│  new     │  orbit empty card             │ task/status  │
│  list    │  orbit composer               │ cockpit      │
└─────────────────────────────────────────────────────────┘
```

结构信息：

- 左：工作记忆（会话）
- 中：执行舞台（对话/结果）
- 右：运行态势（状态、压缩、开发者驾驶舱）

## 签名元素

**Orbit Ring**：

- 内核状态胶囊左侧有脉动光点  
- 主发送按钮外环  
- 选中会话 / 输入卡片外沿冷光  

只在这三处大胆使用，其他区域保持克制。

## 全套覆盖范围

1. 主壳（titlebar / sessions / chat / terminal）  
2. 空状态与消息气泡  
3. 输入合成器  
4. 设置中心（分组标题 / 卡片头 / 页脚保存）  
5. 许可/会员遮罩（兑换优先 + 套餐层级）  
6. 确认弹层 / Toast  
7. 任务看板边缘入口  

## 设置中心信息架构

每个设置页统一为：

```text
Section Head
  kicker + title + one-line purpose
Card Stack
  card head (title + chip)
  fields / actions
  helper note
Footer
  save reminder + primary save
```

原则：

- 先解释“这页做什么”，再给控件
- 主路径卡片带 chip（优先设置 / 官方线路 / 管理员）
- 次要说明放 helper note，不与标题抢层级

## 会员页信息架构

```text
Title block: 状态 + 行动目标
Redeem card: 最快路径（兑换码）
Plan section: 套餐比较（推荐卡高亮）
Optional identity fields
Status line
``` 

## 文案语气

- 直接、可执行、不卖弄  
- 空状态给行动，不给鸡汤  
- 错误说明原因与下一步  
