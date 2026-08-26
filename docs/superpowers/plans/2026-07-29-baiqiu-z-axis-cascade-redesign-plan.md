# 白球 AI Z-Axis Cascade 重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将白球 AI 宣传站从普通浅色 Bento landing page 重构为 Soft Structuralism + Z-Axis Cascade 的高端产品叙事站，并移除所有 GitHub 营销入口。

**Architecture:** 保留 Next.js App Router、集中内容配置和现有 Three.js mascot 数据管线。通过 Floating Island 导航、Sticky Z-axis 任务轨道、Double-Bezel 视觉原语、浅色到深色执行内核过渡重组页面叙事；连续滚动动画隔离到 client leaf，使用 GSAP ScrollTrigger 并统一 cleanup，移动端和 reduced-motion 使用静态单列降级。

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, Tailwind CSS v4, native CSS variables, GSAP 3 + ScrollTrigger, Three.js, lucide-react（仅延续现有轻量图标）, Playwright.

## Global Constraints

- 视觉方向固定为 `Soft Structuralism + Z-Axis Cascade`，不能退回普通三列卡片或现有均匀 Bento。
- 所有主要容器使用 Double-Bezel：外层冷银托盘 + 内层珍珠白或深色核心。
- 页面浅色世界使用冷银白、珍珠灰、冰蓝；深色执行世界使用 `#070B10`, `#0E141C`, `#151C26`, `#1B2430`, `#2A3544`, `#E7EEF8`, `#93A0B4`, `#79C4FF`, `#4AD6B8`。
- 不使用纯黑、厚重灰色边框、黑色硬阴影、通用 AI 紫色渐变。
- 使用已有系统字体栈，不下载字体文件。
- 公开锚点 `#capabilities`, `#usecases`, `#product`, `#faq` 必须保留。
- 移除导航、Hero、FinalCTA、Footer 中所有 GitHub 入口；FAQ 与法律页也不得再把 GitHub 作为开始路径或行动入口。
- 不增加用户数、下载量、性能数字、奖项、合作品牌、评价或未确认下载链接。
- 动画仅修改 `transform` 和 `opacity`；不得用 `window.addEventListener('scroll')` 驱动视觉状态。
- 所有 GSAP effect 必须 `ctx.revert()`；所有 interval、requestAnimationFrame、visibility listener 必须 cleanup。
- `prefers-reduced-motion` 取消 pin、旋转、视差、自动循环；小于 768px 取消重叠、负 margin 和卡片旋转。
- 不修改 Electron 客户端代码或 `resources/brand/3d/` 原始模型。

## File Structure

- Modify `website/src/content/site.ts`: 新 Hero/CTA 文案、无 GitHub 的链接模型、导航标签。
- Modify `website/src/content/faq.ts`: 删除 GitHub 开始路径，改为产品内可验证说明。
- Modify `website/src/app/privacy/page.tsx`: 删除 GitHub 链接，保留中性法律占位。
- Modify `website/src/app/terms/page.tsx`: 删除 GitHub 链接，保留中性法律占位。
- Modify `website/src/app/globals.css`: 视觉令牌、Double-Bezel、Floating Island、Z-axis stack、深色执行内核、响应式和 reduced-motion。
- Modify `website/src/components/Header.tsx`: Floating Island 和流体移动菜单。
- Modify `website/src/components/Hero.tsx`: 单 CTA、Z-axis 产品预览、重写首屏。
- Modify `website/src/components/BrandStatement.tsx`: 仅保留大型宣言。
- Create `website/src/components/TaskJourney.tsx`: 独立 sticky-stack client leaf。
- Modify `website/src/components/Capabilities.tsx`: 中心能力 + 5 张层叠能力卡。
- Modify `website/src/components/WorkflowDemo.tsx`: 深色执行内核展示。
- Modify `website/src/components/UseCases.tsx`: 横向胶片轨道。
- Modify `website/src/components/DesktopAssistant.tsx`: 浅色到深色过渡章节。
- Modify `website/src/components/ProductShowcase.tsx`: Double-Bezel 产品窗口和透视进入。
- Modify `website/src/components/FinalCTA.tsx`: 单 CTA、无 GitHub。
- Modify `website/src/components/Footer.tsx`: 无 GitHub 的站内锚点和法律入口。
- Modify `website/src/app/page.tsx`: 使用独立 TaskJourney，调整四幕顺序。
- Modify `website/tests/home.spec.ts`: 新文案、无 GitHub、导航/移动菜单/FAQ/法律页断言。

---

### Task 1: 清理 GitHub 入口并锁定新内容模型

**Files:**
- Modify: `website/src/content/site.ts`
- Modify: `website/src/content/faq.ts`
- Modify: `website/src/app/privacy/page.tsx`
- Modify: `website/src/app/terms/page.tsx`
- Modify: `website/tests/home.spec.ts`

**Interfaces:**
- Produces: `site.hero.primaryCta: { label: string; href: string }`, `site.finalCta.primary: { label: string; href: string }`, `site.nav: ReadonlyArray<{label:string; href:string}>`。
- Removes from component contract: `site.githubUrl`, `site.hero.secondaryCta`, `site.finalCta.secondary`。

- [ ] **Step 1: 写失败的无 GitHub 行动入口测试**

在 `website/tests/home.spec.ts` 增加：

```ts
test("does not expose GitHub marketing links", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /GitHub|查看项目/i })).toHaveCount(0);
  await expect(page.getByText(/在 GitHub 查看项目|查看 GitHub/)).toHaveCount(0);
});
```

并将首页 H1 断言改为：

```ts
await expect(page.getByRole("heading", { level: 1 })).toContainText(
  "把想法交给白球",
);
```

- [ ] **Step 2: 运行目标测试确认失败**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "GitHub|home renders"
```

Expected: FAIL，因为当前 Header、Hero、FinalCTA、Footer 仍包含 GitHub，H1 仍为旧文案。

- [ ] **Step 3: 重写站点内容配置**

将 `site.ts` 的关键字段改为：

```ts
hero: {
  titleLines: ["把想法交给白球。", "让结果回到你手上。"],
  subtitle:
    "白球理解目标、组织信息、调用工具，把复杂任务推进到可验证的结果。",
  primaryCta: { label: "看看白球怎么完成", href: "#journey" },
},
brandStatement: {
  headline: "不是多聊几句，是继续往下做。",
  body: "从理解目标到调用本地能力，白球把一次请求变成可观察、可验证的执行过程。",
},
brandClose: {
  headline: "把复杂过程交给白球，把可用结果留给自己。",
  body: "桌面文件、表格、资料和计划，都能在同一条任务轨道里继续推进。",
},
finalCta: {
  title: "让白球从一个目标开始。",
  body: "先看看它如何理解任务、调用能力，再把结果带回你的桌面。",
  primary: { label: "探索白球 AI", href: "#product" },
  downloadLabel: "Windows 版本准备中",
},
nav: [
  { label: "能力", href: "#capabilities" },
  { label: "如何完成", href: "#journey" },
  { label: "使用场景", href: "#usecases" },
  { label: "产品界面", href: "#product" },
  { label: "常见问题", href: "#faq" },
],
```

删除 `githubUrl`、Hero secondary CTA 和 FinalCTA secondary CTA。FAQ 的“如何开始使用”改为：

```ts
answer:
  "当前产品以 Windows 桌面端为主。获得可公开使用的稳定版本后，网站会提供明确下载入口；在此之前不会展示失效下载链接。",
```

隐私和条款页面删除 GitHub 链接段落，保留现有法律占位说明。

- [ ] **Step 4: 运行目标测试确认内容层通过**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "GitHub|home renders"
```

Expected: GitHub 内容测试仍可能因组件引用旧字段而编译失败；错误应明确指向 `site.githubUrl` / `secondaryCta`，证明内容模型已收紧。

- [ ] **Step 5: 提交内容模型**

```bash
git add website/src/content/site.ts website/src/content/faq.ts website/src/app/privacy/page.tsx website/src/app/terms/page.tsx website/tests/home.spec.ts
git commit -m "refactor: remove github marketing entry points" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 建立 Soft Structuralism 视觉原语

**Files:**
- Modify: `website/src/app/globals.css`

**Interfaces:**
- Produces CSS primitives: `.shell-light`, `.shell-dark`, `.bezel`, `.bezel-core`, `.floating-nav`, `.island-cta`, `.island-cta__icon`, `.z-card`, `.film-rail`, `.orbital-window`。
- Consumed by all component tasks below。

- [ ] **Step 1: 写静态 CSS 契约测试**

在 `website/tests/home.spec.ts` 增加：

```ts
test("renders structural design primitives", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".floating-nav")).toBeVisible();
  await expect(page.locator(".bezel").first()).toBeVisible();
  await expect(page.locator(".z-card").first()).toBeVisible();
  await expect(page.locator(".orbital-window")).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "structural design primitives"
```

Expected: FAIL，选择器不存在。

- [ ] **Step 3: 重构全局令牌和 Double-Bezel 原语**

在 `globals.css` 保留品牌色，新增语义令牌：

```css
:root {
  --silver-0: #fbfcfd;
  --silver-1: #f2f5f8;
  --silver-2: #e5ebf1;
  --silver-3: #cfd9e4;
  --navy-0: #101720;
  --navy-1: #1b2835;
  --ice: #79c4ff;
  --signal: #4ad6b8;
  --ease-mass: cubic-bezier(0.32, 0.72, 0, 1);
  --ambient-shadow: 0 28px 80px rgba(45, 67, 91, 0.14);
}
```

新增外壳：

```css
.bezel {
  padding: 0.45rem;
  border-radius: 2rem;
  background: color-mix(in srgb, var(--silver-3) 24%, transparent);
  box-shadow: var(--ambient-shadow), inset 0 1px 0 rgba(255,255,255,.7);
}

.bezel-core {
  border-radius: calc(2rem - 0.45rem);
  background: rgba(251, 252, 253, 0.94);
  box-shadow: inset 0 1px 1px rgba(255,255,255,.9);
}
```

重写 section spacing 为 `clamp(6rem, 12vw, 10rem)`，加入固定低透明噪声 pseudo-element；不把 blur 放在滚动容器。

- [ ] **Step 4: 实现响应式和 reduced-motion CSS 契约**

添加：

```css
@media (max-width: 767px) {
  .z-card { transform: none !important; margin: 0 !important; }
  .z-stack { display: grid; gap: 1rem; }
  .section { padding-block: 5rem; }
}

@media (prefers-reduced-motion: reduce) {
  .z-card, .hero-product-peek { transform: none !important; opacity: 1 !important; }
}
```

- [ ] **Step 5: 运行 lint 和构建检查 CSS**

Run:

```bash
cd website && npm run lint && npm run build
```

Expected: 两者 PASS；静态导出生成 `out/`。

- [ ] **Step 6: 提交视觉原语**

```bash
git add website/src/app/globals.css website/tests/home.spec.ts
git commit -m "style: establish structuralist visual system" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 重构 Floating Island 导航和 Hero

**Files:**
- Modify: `website/src/components/Header.tsx`
- Modify: `website/src/components/Hero.tsx`
- Modify: `website/src/components/BrandMark.tsx`
- Modify: `website/tests/home.spec.ts`

**Interfaces:**
- Consumes: `site.nav`, `site.hero.primaryCta`, CSS `.floating-nav`, `.island-cta`, `.bezel`。
- Produces: 可访问的 Floating Island、移动覆盖菜单、Hero `.hero-product-peek`。

- [ ] **Step 1: 增加导航和单 CTA 交互测试**

```ts
test("floating nav and mobile overlay work", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".floating-nav")).toBeVisible();
  await expect(page.getByRole("link", { name: "开始探索" })).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "打开菜单" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("navigation", { name: "移动导航" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "floating nav"
```

Expected: FAIL，`.floating-nav` 和新 CTA 不存在。

- [ ] **Step 3: 实现 Floating Island Header**

将 Header 外层改为：

```tsx
<header className="nav-layer">
  <div className="floating-nav bezel">
    <div className="bezel-core floating-nav__core">
      <Link href="/" aria-label="白球 AI 首页"><BrandMark /></Link>
      <nav aria-label="主导航">...</nav>
      <a href="#journey" className="island-cta">
        <span>开始探索</span><span className="island-cta__icon" aria-hidden>↘</span>
      </a>
      <button aria-expanded={open} aria-controls="mobile-menu">...</button>
    </div>
  </div>
</header>
```

删除所有 GitHub JSX。移动按钮用两个 `<span className="menu-line">`，`data-open` 控制旋转成 X。覆盖菜单 `id="mobile-menu"`，打开时为 fixed 冷银玻璃层，每条链接使用 `style={{ transitionDelay: `${index * 70 + 100}ms` }}`。

导航当前章节高亮改用 `IntersectionObserver`，不保留 `window.addEventListener("scroll")`。

- [ ] **Step 4: 重构 Hero**

Hero 保持 dynamic Three.js mascot，DOM 改为：

```tsx
<section className="hero-cascade" aria-labelledby="hero-title">
  <div className="container hero-cascade__grid">
    <div className="hero-copy">...</div>
    <BaiqiuMascot className="hero-orb" />
    <div className="hero-product-peek bezel" aria-hidden="true">
      <div className="bezel-core">...</div>
    </div>
  </div>
</section>
```

删除版本 eyebrow、secondary CTA 和滚动提示。CTA 使用 Button-in-Button；标题严格两行。

- [ ] **Step 5: 运行导航/Hero 测试**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "floating nav|home renders|GitHub"
```

Expected: PASS。

- [ ] **Step 6: 提交 Header/Hero**

```bash
git add website/src/components/Header.tsx website/src/components/Hero.tsx website/src/components/BrandMark.tsx website/tests/home.spec.ts
git commit -m "feat: rebuild navigation and hero as floating cascade" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 实现 Sticky Z-Axis 任务轨道

**Files:**
- Modify: `website/src/components/BrandStatement.tsx`
- Create: `website/src/components/TaskJourney.tsx`
- Modify: `website/src/app/page.tsx`
- Modify: `website/tests/home.spec.ts`

**Interfaces:**
- Consumes: `journeySteps: JourneyStep[]`, `useMotionPrefs(): {reduceMotion:boolean; ready:boolean}`。
- Produces: `export function TaskJourney(): JSX.Element`, section `id="journey"`, `.z-stack`, `.z-card`。

- [ ] **Step 1: 写任务轨道结构测试**

```ts
test("task journey exposes four ordered cards", async ({ page }) => {
  await page.goto("/#journey");
  const cards = page.locator("#journey [data-journey-card]");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText("提出目标");
  await expect(cards.nth(3)).toContainText("交付结果");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "task journey"
```

Expected: FAIL，旧结构没有 `#journey` 和 `data-journey-card`。

- [ ] **Step 3: 简化 BrandStatement**

保留大型左对齐宣言，不再包含 TaskJourney export；使用 `.statement-stage` 和短正文，不做 split-header。

- [ ] **Step 4: 创建独立 TaskJourney client leaf**

`TaskJourney.tsx`：

```tsx
"use client";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { journeySteps } from "@/content/features";
import { useMotionPrefs } from "@/components/MotionProvider";

gsap.registerPlugin(ScrollTrigger);

export function TaskJourney() {
  const root = useRef<HTMLElement>(null);
  const { reduceMotion } = useMotionPrefs();
  useEffect(() => {
    if (reduceMotion || !root.current || window.matchMedia("(max-width: 767px)").matches) return;
    const ctx = gsap.context(() => {
      const cards = gsap.utils.toArray<HTMLElement>("[data-journey-card]");
      cards.forEach((card, index) => {
        if (index === cards.length - 1) return;
        ScrollTrigger.create({
          trigger: card,
          start: "top top+=112",
          endTrigger: cards[cards.length - 1],
          end: "top top+=112",
          pin: true,
          pinSpacing: false,
        });
        gsap.to(card, {
          scale: 0.92,
          opacity: 0.52,
          ease: "none",
          scrollTrigger: {
            trigger: cards[index + 1],
            start: "top bottom",
            end: "top top+=112",
            scrub: true,
          },
        });
      });
    }, root);
    return () => ctx.revert();
  }, [reduceMotion]);
  return <section id="journey" ref={root}>...</section>;
}
```

每张卡使用 `.bezel > .bezel-core`，桌面端允许 `rotate(-1.5deg)` / `rotate(1deg)`，移动端 CSS 取消。

- [ ] **Step 5: 更新页面导入和顺序**

`page.tsx` 从新文件导入 TaskJourney，顺序保持 Hero → BrandStatement → TaskJourney → Capabilities。

- [ ] **Step 6: 运行结构和 reduced motion 测试**

在测试中使用：

```ts
await page.emulateMedia({ reducedMotion: "reduce" });
await page.goto("/#journey");
await expect(page.locator("#journey [data-journey-card]")).toHaveCount(4);
```

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "task journey"
```

Expected: PASS。

- [ ] **Step 7: 提交任务轨道**

```bash
git add website/src/components/BrandStatement.tsx website/src/components/TaskJourney.tsx website/src/app/page.tsx website/tests/home.spec.ts
git commit -m "feat: add sticky z-axis task journey" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 重构能力、工作流和使用场景

**Files:**
- Modify: `website/src/components/Capabilities.tsx`
- Modify: `website/src/components/WorkflowDemo.tsx`
- Modify: `website/src/components/UseCases.tsx`
- Modify: `website/tests/home.spec.ts`

**Interfaces:**
- Consumes: `features`, `workflowDemo`, `useCases`, Double-Bezel CSS。
- Produces: `#capabilities .capability-orbit`, `.workflow-kernel`, `#usecases .film-rail`。

- [ ] **Step 1: 写三个章节的结构测试**

```ts
test("capability orbit, workflow kernel, and film rail render", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#capabilities .capability-orbit")).toBeVisible();
  await expect(page.locator(".workflow-kernel")).toBeVisible();
  await expect(page.locator("#usecases .film-rail")).toBeVisible();
  await expect(page.locator("#usecases article")).toHaveCount(6);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "capability orbit"
```

Expected: FAIL，新选择器不存在。

- [ ] **Step 3: 将 Capabilities 改成中心卡 + 5 张辅助卡**

使用 features[0] 为中心卡，其余 5 张围绕中心排布，所有卡都渲染，不留空槽。DOM：

```tsx
<div className="capability-orbit">
  <CapabilityFeature feature={features[0]} variant="core" />
  <div className="capability-orbit__satellites">
    {features.slice(1).map((feature, index) => (
      <CapabilityFeature key={feature.id} feature={feature} variant="satellite" index={index} />
    ))}
  </div>
</div>
```

桌面使用 CSS grid + translate/rotate 形成 Z 轴；移动端严格单列。每个 FeatureVisual 保留独立内容，不增加虚构指标。

- [ ] **Step 4: 重构 WorkflowDemo 为深色执行内核**

外层 `.workflow-kernel bezel bezel--dark`，内层 `.bezel-core workflow-kernel__core`。自动阶段轮播仅在非 reduced motion 下运行；点击阶段始终可用。动画切换只使用 `transform/opacity`。

- [ ] **Step 5: 重构 UseCases 为胶片轨道**

使用 `.film-rail`、`overflow-x:auto`、`scroll-snap-type:x mandatory`，卡片提供目标、结果形式和真实状态，例如：

```tsx
<p className="usecase-result">结果形式：整理后的文件夹</p>
<span className="usecase-state">可在桌面执行</span>
```

状态文案从实际能力推导，不写用户评价。

- [ ] **Step 6: 运行章节测试**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "capability orbit"
```

Expected: PASS。

- [ ] **Step 7: 提交中段叙事**

```bash
git add website/src/components/Capabilities.tsx website/src/components/WorkflowDemo.tsx website/src/components/UseCases.tsx website/tests/home.spec.ts
git commit -m "feat: rebuild capabilities and workflow narrative" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 重构桌面过渡、产品窗口和最终收束

**Files:**
- Modify: `website/src/components/DesktopAssistant.tsx`
- Modify: `website/src/components/ProductShowcase.tsx`
- Modify: `website/src/components/FinalCTA.tsx`
- Modify: `website/src/components/Footer.tsx`
- Modify: `website/src/components/FAQ.tsx`
- Modify: `website/tests/home.spec.ts`

**Interfaces:**
- Consumes: `site.desktop`, `site.brandClose`, `site.finalCta.primary`, `productUi`, `faqItems`。
- Produces: `.desktop-transition`, `.orbital-window`, 单 CTA FinalCTA，无 GitHub Footer。

- [ ] **Step 1: 写产品窗口和收束测试**

```ts
test("product window and final action use the new structure", async ({ page }) => {
  await page.goto("/#product");
  await expect(page.locator("#product .orbital-window")).toBeVisible();
  await expect(page.getByRole("link", { name: "探索白球 AI" })).toHaveCount(1);
  await expect(page.locator("footer").getByText("GitHub")).toHaveCount(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "product window"
```

Expected: FAIL，新产品窗口 class 不存在，旧 FinalCTA/Footer 仍有 GitHub 引用。

- [ ] **Step 3: DesktopAssistant 做浅到深过渡**

外层 `.desktop-transition` 使用冷银到 Ink 的背景变化，三点说明改为错位的 Double-Bezel 面板；不使用三个等宽卡片。

- [ ] **Step 4: ProductShowcase 使用 Double-Bezel 设备框架**

保留左会话、中执行、右运行态势。外层：

```tsx
<div data-product-frame className="orbital-window bezel bezel--dark">
  <div className="bezel-core orbital-window__core">...</div>
</div>
```

GSAP 入场从 `{ y: 80, scale: .92, rotateX: 7, opacity: .35 }` 到静态状态，ScrollTrigger scrub；reduced motion 时不创建 trigger。输入区保留 Orbit Ring。

- [ ] **Step 5: FinalCTA 和 Footer 删除 GitHub**

FinalCTA 只渲染 mascot、品牌收束、`site.finalCta.primary` 和 Windows 准备状态。Footer 只保留站内锚点、隐私、条款、年份、版本。FAQ 保持现有键盘逻辑，但调整外观为低边界列表而非卡片。

- [ ] **Step 6: 运行产品、FAQ、法律测试**

Run:

```bash
cd website && npm run test:e2e -- --project=desktop --grep "product window|faq|legal|GitHub"
```

Expected: PASS。

- [ ] **Step 7: 提交深色内核和收束**

```bash
git add website/src/components/DesktopAssistant.tsx website/src/components/ProductShowcase.tsx website/src/components/FinalCTA.tsx website/src/components/Footer.tsx website/src/components/FAQ.tsx website/tests/home.spec.ts
git commit -m "feat: finish orbital product showcase and closing" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 完整响应式、动效和浏览器验证

**Files:**
- Modify: `website/src/app/globals.css`
- Modify: `website/src/components/BaiqiuMascot.tsx`
- Modify: `website/src/components/OrbitRings.tsx`
- Modify: `website/tests/home.spec.ts`

**Interfaces:**
- Consumes: 全部重设计组件。
- Produces: 1440/1280/1024/768/430/390 可用布局、reduced-motion 静态路径、最终静态导出。

- [ ] **Step 1: 增加移动无溢出测试**

```ts
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
  { width: 390, height: 844 },
]) {
  test(`has no horizontal overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
}
```

- [ ] **Step 2: 增加 reduced-motion 测试**

```ts
test("reduced motion keeps all content visible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("#journey [data-journey-card]")).toHaveCount(4);
  await expect(page.locator("#capabilities article")).toHaveCount(6);
  await expect(page.locator("#product .orbital-window")).toBeVisible();
});
```

- [ ] **Step 3: 调整 3D 移动性能**

`BaiqiuMascot.tsx` 根据媒体查询限制像素比：

```ts
const compact = window.matchMedia("(max-width: 767px)").matches;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, compact ? 1.15 : 1.75));
```

移动端和 reduced motion 不注册 pointermove；页面隐藏时停止 RAF，恢复时只启动一个 RAF。

- [ ] **Step 4: 运行 lint、构建、全量 Playwright**

Run:

```bash
cd website && npm run lint
```

Expected: PASS。

Run:

```bash
cd website && npm run build
```

Expected: PASS，静态导出完成。

Run:

```bash
cd website && npm run test:e2e
```

Expected: desktop 和 mobile 项目全部 PASS。

- [ ] **Step 5: 使用 Browser pane 做视觉验证**

通过 `.claude/launch.json` 的 `baiqiu-website` 启动 `npm --prefix D:/Codex/baiqiu-ai-developer/website run dev -- --hostname 127.0.0.1 --port 3000`。

逐项检查：

1. `preview_console_logs(level="error")` 无错误。
2. `preview_logs(level="error")` 无服务器错误。
3. `preview_snapshot` 确认单一 Hero CTA、五个导航项、四张任务卡、六项能力、六个场景、FAQ 与法律链接。
4. `preview_inspect` 检查 `.floating-nav`, `.bezel`, `.orbital-window` 的 radius、background、shadow。
5. `preview_click` 打开/关闭移动菜单和 FAQ。
6. `preview_resize` 验证 desktop 1280、tablet 768、mobile 390，以及 dark color scheme 下的执行内核对比。
7. `preview_screenshot` 保存桌面和移动证明。

发现问题时读取对应组件/CSS，修复后从步骤 1 重新检查。

- [ ] **Step 6: 运行 anti-pattern 搜索**

Run:

```bash
cd website && rg -n "GitHub|查看项目|window\.addEventListener\(['\"]scroll|h-screen|transition:.*linear|ease-in-out" src tests
```

Expected: 无可见 GitHub 行动入口、无 scroll listener、无 `h-screen`、无禁用 easing。法律文本若保留“项目”普通名词不算失败。

- [ ] **Step 7: 最终提交**

```bash
git add website
git commit -m "test: verify responsive z-axis redesign" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: 最终状态报告**

报告：构建结果、Playwright 结果、验证宽度、Browser pane 截图、已移除的 GitHub 入口、未添加下载链接的原因。不得声称未运行的检查已经通过。
