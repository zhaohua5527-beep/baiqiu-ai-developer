import { test, expect } from "@playwright/test";

test.describe("白球 AI marketing site", () => {
  test("home renders core sections and navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/白球 AI/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "把想法交给白球",
    );
    await expect(page.locator("#capabilities")).toBeVisible();
    await expect(page.locator("#usecases")).toBeVisible();
    await expect(page.locator("#product")).toBeVisible();
    await expect(page.locator("#faq")).toBeVisible();

    await page.getByRole("link", { name: "能力", exact: true }).first().click();
    await expect(page.locator("#capabilities")).toBeInViewport();
  });

  test("does not expose GitHub marketing links", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: /GitHub|查看项目/i })).toHaveCount(0);
    await expect(page.getByText(/在 GitHub 查看项目|查看 GitHub/)).toHaveCount(0);
  });

  test("faq accordion is keyboard operable", async ({ page }) => {
    await page.goto("/#faq");
    const first = page.locator("#faq button").first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("aria-expanded", /true|false/);
  });

  test("legal placeholder pages exist", async ({ page }) => {
    await page.goto("/privacy/");
    await expect(page.getByRole("heading", { name: "隐私政策" })).toBeVisible();
    await page.goto("/terms/");
    await expect(page.getByRole("heading", { name: "使用条款" })).toBeVisible();
  });
});
