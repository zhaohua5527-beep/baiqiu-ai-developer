# 白球 AI 宣传站

独立于 Electron 客户端的产品宣传网站，静态导出优先，可部署到 Vercel / Cloudflare Pages / 常规静态服务器。

## 技术栈

- Next.js App Router + TypeScript
- Tailwind CSS v4
- GSAP + ScrollTrigger
- Three.js（仅白球吉祥物）
- lucide-react
- Playwright

## 开发

```bash
cd website
npm install
npm run dev
```

## 构建静态站

```bash
npm run build
```

产物在 `out/`。

## 测试

```bash
npx playwright install chromium
npm run test:e2e
```

## 说明

- 文案与能力描述来自仓库真实实现，未编造用户量或奖项。
- 3D 源文件保留在 `resources/brand/3d/`，网页使用 `public/brand/baiqiu-mascot.json`。
- 下载链接当前为 `null`，页面显示“Windows 版本准备中”。
