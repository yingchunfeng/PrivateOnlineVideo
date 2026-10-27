import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { normalizeTheme, readTheme, themeStorageKey } from "../src/theme";

test("theme defaults to light and only accepts explicit dark", () => {
  for (const value of [null, undefined, "", "system", "DARK", "broken", "light", {}]) assert.equal(normalizeTheme(value), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(readTheme(), "light");
});

test("pre-paint bootstrap uses the same preference, handles storage failures and updates browser chrome", async () => {
  const source = await readFile(new URL("../public/theme-init.js", import.meta.url), "utf8");
  for (const stored of [null, "light", "dark", "invalid", "blocked"]) {
    const documentElement = { dataset: { theme: "" }, style: { colorScheme: "" } };
    let color = "";
    runInNewContext(source, {
      localStorage: { getItem(key: string) { assert.equal(key, themeStorageKey); if (stored === "blocked") throw new Error("Storage denied"); return stored; } },
      document: { documentElement, querySelector: () => ({ setAttribute: (_key: string, value: string) => { color = value; } }) }
    });
    assert.equal(documentElement.dataset.theme, normalizeTheme(stored));
    assert.equal(documentElement.style.colorScheme, normalizeTheme(stored));
    assert.equal(color, stored === "dark" ? "#080c14" : "#ffffff");
  }
});

test("light theme text and primary button endpoints meet 4.5:1 contrast", async () => {
  const source = (await readFile(new URL("../src/theme.css", import.meta.url), "utf8")).split(':root[data-theme="dark"]')[0]!;
  const palette = Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map(match => [match[1]!, match[2]!]));
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  const check = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    const ratio = (values[1]! + .05) / (values[0]! + .05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  };
  for (const text of ["text", "text-secondary", "muted", "accent", "accent-secondary"]) {
    for (const surface of ["background", "surface-high", "surface-elevated"]) check(palette[text]!, palette[surface]!);
  }
  for (const state of ["error", "warning", "success", "energy-purple"]) check(palette[state]!, palette[`${state}-surface`]!);
  for (const gradient of source.matchAll(/--gradient-[\w-]+:([^;]+);/g)) {
    for (const color of gradient[1]!.match(/#[0-9a-f]{6}/g) ?? []) check(palette["on-accent"]!, color);
  }
});
