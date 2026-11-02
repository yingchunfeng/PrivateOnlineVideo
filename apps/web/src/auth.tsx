import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AuthSession, GuestPermission, LoginRequest } from "@online-video/shared";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "./api";
import { ApiError } from "./api/client";
import { authApi } from "./api/auth";
import { Empty, ErrorNotice, Loading } from "./ui";
import { useTheme } from "./theme-context";
import { validateAuthSession } from "./api/auth";
import { hasPermission, landingPage } from "./authz";

interface AuthState { session: AuthSession | null; loading: boolean; error: unknown; expired: boolean; guestLogin: boolean; isAdmin: boolean; can: (permission: GuestPermission) => boolean; refresh: () => void; login: (body: LoginRequest) => Promise<void>; loginGuest: (password: string) => Promise<void>; logout: () => Promise<void>; revoked: () => void }
const AuthContext = createContext<AuthState | undefined>(undefined);
const guestHint = () => { try { return sessionStorage.getItem("ov.auth-kind") === "guest"; } catch { return false; } };
const rememberKind = (auth: AuthSession) => { try { sessionStorage.setItem("ov.auth-kind", auth.guest ? "guest" : "admin"); } catch { /* 非秘密提示不可写不影响登录。 */ } };
export function AuthProvider({ children }: { children: ReactNode }) {
  const { selectTheme } = useTheme();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [expired, setExpired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [guestLogin, setGuestLogin] = useState(location.pathname === "/guest/login" || guestHint());
  const current = useRef(session); current.current = session;
  const generation = useRef(0);
  const clear = () => { generation.current++; current.current = null; api.clearSession(); setSession(null); setExpired(true); };
  useEffect(() => { api.onUnauthorized(clear); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    authApi(api).me(controller.signal).then(auth => { if (controller.signal.aborted) return; rememberKind(auth); api.setSession(auth.csrfToken); setSession(auth); setGuestLogin(!!auth.guest); setExpired(false); }).catch(err => {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && (err.code === "AUTH_REQUIRED" || err.code === "SESSION_EXPIRED" || err.code === "GUEST_EXPIRED")) { setSession(null); if (err.code === "GUEST_EXPIRED") { setGuestLogin(true); setExpired(true); } } else setError(err);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const applyLogin = (auth: AuthSession) => { generation.current++; rememberKind(auth); selectTheme(auth.defaultTheme === "dark" ? "dark" : "light"); api.setSession(auth.csrfToken); setSession(auth); setGuestLogin(!!auth.guest); setError(undefined); setExpired(false); };
  const login = async (body: LoginRequest) => { applyLogin(await authApi(api).login(body)); };
  const loginGuest = async (password: string) => { applyLogin(validateAuthSession(await api.request<AuthSession>("/api/auth/guest/login", { method: "POST", body: { password } }))); };
  const logout = async () => { generation.current++; await authApi(api).logout(); clear(); setExpired(false); };
  useEffect(() => {
    if (!session?.guest) return;
    const controller = new AbortController(); const started = generation.current;
    let checking = false;
    const recheck = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try { const next = await authApi(api).me(controller.signal); if (!controller.signal.aborted && started === generation.current && current.current) { api.setSession(next.csrfToken); setSession(next); } }
      catch { /* API 的 401 回调负责退出；断网不推定凭证仍有效。 */ }
      finally { checking = false; }
    };
    const expiresIn = Date.parse(session.guest.expiresAt) - Date.parse(session.guest.serverTime);
    const deadline = setTimeout(() => { if (expiresIn <= 2_147_483_647) clear(); else void recheck(); }, Math.max(0, Math.min(2_147_483_647, expiresIn)));
    const poll = setInterval(() => void recheck(), 3000);
    const resume = () => void recheck();
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { controller.abort(); clearTimeout(deadline); clearInterval(poll); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [session?.guest?.id, session?.guest?.expiresAt, session?.guest?.serverTime]);
  return <AuthContext.Provider value={{ session, loading, error, expired, guestLogin, isAdmin: !!session && !session.guest, can: permission => hasPermission(session, permission), refresh: () => setRevision(r => r + 1), login, loginGuest, logout, revoked: clear }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error("Missing AuthProvider"); return value; }
export function Protected({ children, permission, adminOnly = false }: { children: ReactNode; permission?: GuestPermission; adminOnly?: boolean }) {
  const auth = useAuth(); const location = useLocation();
  if (auth.loading) return <Loading />;
  if (auth.error) return <ErrorNotice error={auth.error} retry={auth.refresh} />;
  if (!auth.session) return <Navigate to={auth.guestLogin ? "/guest/login" : "/login"} replace state={{ from: location.pathname + location.search }} />;
  if (adminOnly && !auth.isAdmin || permission && !auth.can(permission)) return <Empty title="无权访问此页面">当前访客未获得此页面权限，请联系管理员。<a className="text-link" href={landingPage(auth.session)}>返回可访问页面</a></Empty>;
  return children;
}
