export type Theme = "light" | "dark";
export const themeStorageKey = "ov.theme.v1";

export function normalizeTheme(value: unknown): Theme {
  return value === "dark" ? "dark" : "light";
}

export function readTheme(): Theme {
  try {
    return normalizeTheme(window.localStorage.getItem(themeStorageKey));
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#080c14" : "#ffffff");
}
