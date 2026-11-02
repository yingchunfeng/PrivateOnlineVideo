import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const fixtureSiteSettings = { version: 0, defaultTheme: "light", maxUploadBytes: 2147483648, maxConfigurableUploadBytes: 2621440000, partSizeBytes: 262144, persistenceAvailable: true };

export async function selectPersonalTheme(page: Page, theme: string) {
  // 从另一标签页操作正式入口，原页的未保存草稿、播放器与全局时间线不卸载。
  const settings = await page.context().newPage();
  try {
    await settings.goto(new URL("/pages", page.url()).href);
    await settings.getByRole("button", { name: "编辑个人外观", exact: true }).click();
    await settings.getByRole("radio", { name: theme === "dark" ? "深色" : "浅色", exact: true }).check();
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  } finally { await settings.close(); }
}

export async function openSpaceSettings(page: Page) {
  if (new URL(page.url()).pathname !== "/pages") {
    await page.locator('.side-nav-menu a[href="/pages"]:visible, .bottom-nav a[href="/pages"]:visible').first().click();
  }
  await page.getByRole("button", { name: "编辑动态星空", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "星空动效设置", exact: true })).toBeVisible();
}

export async function setSpaceEnabled(page: Page, next: boolean, inPlace = false) {
  const settings = inPlace ? page : await page.context().newPage();
  try {
    if (!inPlace) await settings.goto(new URL("/pages", page.url()).href);
    await openSpaceSettings(settings);
    await settings.getByRole("checkbox", { name: /^启用动态星空/ }).setChecked(next);
    await settings.getByRole("button", { name: "保存星空设置", exact: true }).click();
    await expect(settings.getByRole("dialog")).toHaveCount(0);
  } finally { if (!inPlace) await settings.close(); }
}
