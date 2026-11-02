import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium, expect } from "@playwright/test";

const evidence = fileURLToPath(new URL(`../../../.local/acceptance/management-primitives-${randomUUID()}/`, import.meta.url));
const fixture = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Modal, TableContainer } from "/src/ui.tsx";
import "/src/styles.css";
import "/src/theme-light.css";
import "/src/management-ui.css";
const h = React.createElement;
function Demo() {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  window.finishDemoSave = () => setBusy(false);
  return h("main", { style: { padding: 12, width: "100%", maxWidth: 960, margin: "auto" } },
    h("button", { onClick: () => setOpen(true) }, "新增示例"),
    h(TableContainer, { label: "示例列表" }, h("table", { className: "management-table", style: { minWidth: 720 } },
      h("thead", null, h("tr", null, ...["名称", "当前值", "说明", "操作"].map(value => h("th", { key: value }, value)))),
      h("tbody", null, h("tr", null, ...["示例配置", "只读内容", "宽表格在容器内滚动", "编辑"].map(value => h("td", { key: value }, value)))))),
    open && h(Modal, { title: "编辑示例", description: "标题与保存按钮固定，中间表单单独滚动。", busy, onClose: () => setOpen(false),
      footer: h(React.Fragment, null,
        h("button", { className: "secondary", disabled: busy, onClick: () => setOpen(false) }, "取消"),
        h("button", { form: "demo-form", type: "submit", disabled: busy }, busy ? "保存中" : "保存")) },
      h("form", { id: "demo-form", className: "management-form", onSubmit: event => { event.preventDefault(); setBusy(true); } },
        ...Array.from({ length: 28 }, (_, index) => h("label", { className: "management-field", key: index }, "字段 " + index,
          h("input", { name: "field-" + index, defaultValue: "示例值 " + index, disabled: busy }))))));
}
createRoot(document.getElementById("root")).render(h(StrictMode, null, h(Demo)));
</script></body></html>`;

test("公共弹窗与表格：键盘、保存锁定、焦点恢复和窄屏滚动", { timeout: 90000 }, async t => {
  const server = await createServer({
    configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: `${evidence}/vite-cache`, plugins: [react(), {
      name: "management-primitives-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/__primitives") return next();
          void server.transformIndexHtml("/__primitives", fixture).then(html => {
            response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html);
          }).catch(next);
        });
      }
    }], server: { host: "127.0.0.1", port: 0 }
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(evidence, { recursive: true }); await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("隔离测试服务未启动");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/__primitives`);
    const opener = page.getByRole("button", { name: "新增示例", exact: true });
    const modal = page.getByRole("dialog", { name: "编辑示例", exact: true });
    await t.test("StrictMode不重复打开，Escape与取消均恢复入口焦点", async () => {
      await opener.click(); await expect(modal).toBeVisible();
      await expect(page.getByLabel("字段 0", { exact: true })).toBeFocused();
      await page.keyboard.press("Escape"); await expect(modal).toHaveCount(0); await expect(opener).toBeFocused();
      await opener.click(); await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(modal).toHaveCount(0); await expect(opener).toBeFocused();
    });
    await t.test("Tab留在弹窗，保存中禁止关闭和重复提交", async () => {
      await opener.click();
      await page.getByRole("button", { name: "保存", exact: true }).focus(); await page.keyboard.press("Tab");
      assert.equal(await modal.evaluate(node => node.contains(document.activeElement)), true);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(modal).toHaveAttribute("aria-busy", "true");
      await expect(page.getByRole("button", { name: "保存中", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "关闭弹窗", exact: true })).toBeDisabled();
      await page.keyboard.press("Escape"); await expect(modal).toBeVisible();
      await page.evaluate(() => (window as Window & { finishDemoSave?: () => void }).finishDemoSave?.());
      await expect(modal).toHaveAttribute("aria-busy", "false");
      await page.keyboard.press("Escape"); await expect(modal).toHaveCount(0); await expect(opener).toBeFocused();
    });
    for (const theme of ["light", "dark"]) for (const [width, height] of [[1440, 900], [1024, 768], [375, 667], [320, 568], [667, 375]]) {
      await t.test(`${theme} ${width}x${height}：表格不撑宽，长表单头尾可操作`, async () => {
        await page.setViewportSize({ width: width!, height: height! });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await opener.click(); await expect(modal).toBeVisible();
        const geometry = await page.evaluate(() => {
          const body = document.querySelector(".management-modal-body")!;
          const footer = document.querySelector(".management-modal-footer")!.getBoundingClientRect();
          const header = document.querySelector(".management-modal-header")!.getBoundingClientRect();
          const table = document.querySelector(".management-table-scroll")!;
          return { page: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight, headerTop: header.top, footerBottom: footer.bottom, overflow: body.scrollHeight > body.clientHeight, tableWidth: table.clientWidth, tableScroll: table.scrollWidth };
        });
        assert.ok(geometry.page <= geometry.width, JSON.stringify(geometry));
        assert.ok(geometry.headerTop >= 0 && geometry.footerBottom <= geometry.height, JSON.stringify(geometry));
        assert.ok(geometry.overflow, "长表单未在中间区域滚动");
        if (width! < 720) assert.ok(geometry.tableScroll > geometry.tableWidth, "宽表格未在容器内滚动");
        await modal.locator(".management-modal-body").evaluate(node => { node.scrollTop = node.scrollHeight; });
        await expect(page.getByRole("button", { name: "保存", exact: true })).toBeInViewport();
        await page.screenshot({ path: `${evidence}/${theme}-${width}x${height}.png` });
        await page.getByRole("button", { name: "取消", exact: true }).click();
      });
    }
    assert.deepEqual(errors, []); t.diagnostic(`公共组件截图：${evidence}`);
  } finally { await browser?.close(); await server.close(); }
});
