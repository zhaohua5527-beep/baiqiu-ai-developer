# 白球 AI 宣传站重设计规格

日期：2026-07-29
状态：已确认，待规格审阅
方向：C · 轨道卡片级联

## 1. 目标与范围

本次工作重构 `website/` 的视觉表达与页面编排，不改变 Electron 客户端，也不改变站点的 Next.js 路由结构。目标是让白球 AI 看起来像有完整品牌语言的个人桌面 AI 助理，而不是普通 AI landing page。

核心设计组合：

- Vibe：Soft Structuralism
- Layout：Z-Axis Cascade
- Motion：高强度但有叙事目的
- Visual density：低到中等，保留大量留白
- 品牌：珍珠白、冷银、冰蓝、Orbital Operator 深色执行内核

明确移除：

- 导航中的 GitHub
- Hero 中的 GitHub CTA
- Final CTA 中的 GitHub CTA
- 页脚 GitHub 链接
- 任何“在 GitHub 查看项目”“查看 GitHub”“查看项目”营销入口

保留：真实功能文案、Windows 桌面定位、白球 3D、产品界面结构、FAQ、SEO、法律占位页。

## 2. 信息架构

首页仍为单页，但按四幕叙事重排：

1. 认识白球：Floating Island 导航 + Hero + 3D 吉祥物
2. 一次任务怎样完成：品牌主张 + Sticky Z-axis 任务轨道
3. 进入执行内核：真实能力、工作流和深色产品界面
4. 回到结果：使用场景、品牌收束、FAQ、最终行动

稳定锚点保留并继续支持：

- `#capabilities`
- `#usecases`
- `#product`
- `#faq`

允许新增内部锚点，但不删除上述公开锚点。

## 3. 视觉系统

### 3.1 色彩

浅色世界：

- 背景：冷银白、珍珠灰、淡冰蓝
- 文字：深蓝黑，不使用纯黑
- 强调：`#79C4FF`
- 成功状态：`#4AD6B8`
- 边缘：透明冷灰，避免通用灰色 1px 边框观感

深色世界：

- `#070B10` Void
- `#0E141C` Ink
- `#151C26` Panel
- `#1B2430` Panel Soft
- `#2A3544` Line
- `#E7EEF8` Pearl
- `#93A0B4` Mist
- `#79C4FF` Ice
- `#4AD6B8` Signal

### 3.2 形态

主要容器采用 Double-Bezel：

- 外层：冷银色托盘、宽留白、柔和环境阴影、较大圆角
- 内层：珍珠白或深色玻璃核心、内高光、略小圆角

形态规则：

- 页面容器和卡片采用 24-32px 软圆角
- 交互按钮使用 full pill
- CTA 的箭头必须位于独立圆形内核
- 不使用大量普通平铺卡片
- 不使用厚重边框或黑色投影

### 3.3 字体

继续使用系统字体栈，不下载字体：

```css
-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable",
"Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif
```

数字和状态使用 Cascadia Mono / Consolas。

## 4. 组件与页面结构

### 4.1 Header

重构为 Floating Island：

- 桌面端脱离顶部边缘，顶部留出空间
- 透明冷银玻璃材质
- 品牌标志、锚点导航、单一 `开始探索` CTA
- 移除 GitHub
- 移动端使用流体 Hamburger，菜单变为覆盖层
- 菜单链接使用 staggered translate/opacity 入场
- 保持 Escape 关闭和 aria-expanded

### 4.2 Hero

- 左侧大标题：`把想法交给白球。让结果回到你手上。`
- 副标题控制在短段落内，明确“理解目标、组织信息、调用工具、推进结果”
- 只保留一个主 CTA：`看看白球怎么完成`
- 右侧使用当前 3D 吉祥物与 Orbit Ring
- 底部提前露出一张产品工作卡片，形成第一层 Z 轴
- 删除版本标签和滚动提示
- 首屏使用 `min-height: 100dvh`，不使用 `h-screen`

### 4.3 BrandStatement / TaskJourney

- BrandStatement 做成一段大型左对齐宣言，避免 split-header
- TaskJourney 改成真正的 sticky stack
- 四张任务卡顺序：
  1. 理解目标
  2. 组织步骤
  3. 调用工具
  4. 交付结果
- 卡片在滚动时进入、堆叠、缩小和淡出
- 移动端取消重叠和旋转，转换为单列正常流
- reduced motion 下静态展示四张卡

### 4.4 Capabilities

- 不再使用六张相同 Bento 卡
- 改成 1 张中心能力卡 + 4 张 Z 轴辅助卡
- 每张卡保留独立视觉表达：对话、文件、工具、规划、表格、Skills
- 可将六项真实能力组织为中心卡 + 5 张辅助卡，但布局不能出现空槽
- 使用 Double-Bezel
- 滚动过程中辅助卡按顺序进入

### 4.5 WorkflowDemo

- 保留真实任务：整理资料并生成总结
- 左侧为任务阶段列表，右侧为执行舞台
- 每个阶段切换时使用 opacity/transform 过渡
- 视觉上增加深色执行内核材质
- 不添加虚假精确耗时或性能数字

### 4.6 UseCases

- 改为横向滚动胶片轨道
- 不做无限 marquee
- 每张场景卡展示一个真实目标、一个结果形式和轻量状态标签
- 移动端支持触摸滚动和 scroll-snap
- 不出现虚假用户姓名、头像或评价

### 4.7 DesktopAssistant / ProductShowcase

- DesktopAssistant 作为浅色到深色的过渡章节
- ProductShowcase 使用三栏产品窗口结构：左会话、中执行舞台、右运行态势
- 采用大尺寸 Double-Bezel 设备框架
- 滚动时窗口轻微进入、展开、校正透视
- 输入区保留 Orbit Ring
- 产品界面内容必须与现有 Electron renderer 结构一致

### 4.8 FinalCTA / FAQ / Footer

- FinalCTA 恢复珍珠白，使用中央白球和单一 `探索白球 AI` CTA
- 移除 GitHub 按钮与相关文本
- FAQ 保留 4-6 个真实问题，维持键盘可操作手风琴
- Footer 只保留品牌描述、产品锚点、法律入口、年份和版本信息
- Footer 不再出现 GitHub

## 5. 动效规范

所有动画仅修改 transform 和 opacity，使用自定义 cubic-bezier 或 GSAP scrub。

动画目的：

- Hero：建立层级与品牌记忆
- TaskJourney：解释任务推进顺序
- Capabilities：展示能力从中心向外展开
- ProductShowcase：展示从外观进入执行内核
- FAQ：表达状态转换和内容展开

实现约束：

- 不使用 `window.addEventListener('scroll')` 驱动布局计算
- GSAP ScrollTrigger 仅放在 client leaf 组件，并在 effect cleanup 中 revert
- 不对大面积滚动容器使用 backdrop blur
- 页面隐藏时暂停持续动画
- `prefers-reduced-motion` 取消 pin、旋转、视差和自动循环
- 移动端关闭鼠标跟随和高成本 3D 效果

## 6. 真实内容边界

文案来源继续限定为仓库中已验证的产品能力：

- Desktop Assistant
- File Agent
- Spreadsheet Agent
- Browser Agent
- 文件写入、文件夹创建、桌面整理
- Excel 生成、联网搜索、安全命令
- 长期记忆、模型切换、推理等级、Skills
- OpenClaw / Hermes 运行路径

不得增加用户数、下载量、性能指标、奖项、合作品牌、评价或未确认下载地址。

## 7. 可访问性与响应式

- 保留语义化标题层级
- 保留 Skip Link
- 所有图标按钮有 aria-label
- FAQ 可键盘操作
- 3D 吉祥物有文本替代说明
- 移动端小于 768px 时所有异形布局单列化
- 取消旋转与负 margin 重叠
- 触控目标不小于常规可用尺寸
- 检查 1440、1280、1024、768、430、390 宽度

## 8. 实施文件范围

主要调整：

- `src/app/globals.css`
- `src/components/Header.tsx`
- `src/components/Hero.tsx`
- `src/components/BrandStatement.tsx`
- `src/components/Capabilities.tsx`
- `src/components/TaskJourney.tsx`（必要时从现有文件拆出）
- `src/components/WorkflowDemo.tsx`
- `src/components/UseCases.tsx`
- `src/components/DesktopAssistant.tsx`
- `src/components/ProductShowcase.tsx`
- `src/components/FinalCTA.tsx`
- `src/components/Footer.tsx`
- `src/content/site.ts`
- 相关 Playwright 测试文案断言

不修改 Electron 客户端代码和原始 3D 资源。
