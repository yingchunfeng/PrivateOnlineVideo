import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { applyTheme, normalizeTheme, readTheme, themeStorageKey } from "./theme";
import type { Theme } from "./theme";

const ThemeContext = createContext<{ theme: Theme; selectTheme: (theme: Theme) => void } | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(readTheme);
  const selectTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
    try {
      window.localStorage.setItem(themeStorageKey, next);
    } catch {
      // Keep switching functional even when the preference cannot be persisted.
    }
  };
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== themeStorageKey && event.key !== null) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      const next = normalizeTheme(event.newValue);
      applyTheme(next);
      setTheme(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return <ThemeContext.Provider value={{ theme, selectTheme }}>{children}</ThemeContext.Provider>;
}

export function ThemeSwitcher() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("Missing ThemeProvider");
  return <div className="theme-switcher" role="group" aria-label="显示主题">
    {(["light", "dark"] as const).map(value => <button key={value} type="button" className="theme-option" aria-pressed={context.theme === value} onClick={() => context.selectTheme(value)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {value === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z" />}
      </svg>
      {value === "light" ? "浅色" : "深色"}
    </button>)}
  </div>;
}
