import { useEffect, useState } from "react";

const eventName = "site-settings-changed";
const revisionKey = "ov.site-settings-revision.v1";

export function notifySiteSettingsChanged() {
  window.dispatchEvent(new Event(eventName));
  try { localStorage.setItem(revisionKey, `${Date.now()}:${Math.random()}`); } catch { /* 存储不可用时仍由服务端校验最新上限。 */ }
}

export function useSiteSettingsRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision(value => value + 1);
    const storage = (event: StorageEvent) => { if (event.key === revisionKey || event.key === null) refresh(); };
    window.addEventListener(eventName, refresh); window.addEventListener("storage", storage); window.addEventListener("focus", refresh);
    return () => { window.removeEventListener(eventName, refresh); window.removeEventListener("storage", storage); window.removeEventListener("focus", refresh); };
  }, []);
  return revision;
}
