import { test, expect } from "@playwright/test";

test.describe("白球 AI marketing site", () => {
  test("home renders core sections and navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/白球 AI/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "帮你把事情真正做完",
    );
    await expect(page.locator("#capabilities")).toBeVisible();
    await expect(page.locator("#usecases")).toBeVisible();
    await expect(page.locator("#product")).toBeVisible();
    await expect(page.locator("#faq")).toBeVisible();

    await page.getByRole("link", { name: "产品能力" }).first().click();
    await expect(page.locator("#capabilities")).toBeInViewport();
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
