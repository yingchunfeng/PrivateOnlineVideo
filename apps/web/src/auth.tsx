import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AuthSession, LoginRequest } from "@online-video/shared";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "./api";
import { ApiError } from "./api/client";
import { authApi } from "./api/auth";
import { ErrorNotice, Loading } from "./ui";

interface AuthState { session: AuthSession | null; loading: boolean; error: unknown; expired: boolean; refresh: () => void; login: (body: LoginRequest) => Promise<void>; logout: () => Promise<void>; revoked: () => void }
const AuthContext = createContext<AuthState | undefined>(undefined);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [expired, setExpired] = useState(false);
  const [revision, setRevision] = useState(0);
  const clear = () => { api.clearSession(); setSession(null); setExpired(true); };
  useEffect(() => { api.onUnauthorized(clear); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined);
    authApi(api).me(controller.signal).then(auth => { api.setSession(auth.csrfToken); setSession(auth); setExpired(false); }).catch(err => {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && (err.code === "AUTH_REQUIRED" || err.code === "SESSION_EXPIRED")) setSession(null); else setError(err);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const login = async (body: LoginRequest) => { const auth = await authApi(api).login(body); api.setSession(auth.csrfToken); setSession(auth); setError(undefined); setExpired(false); };
  const logout = async () => { await authApi(api).logout(); clear(); setExpired(false); };
  return <AuthContext.Provider value={{ session, loading, error, expired, refresh: () => setRevision(r => r + 1), login, logout, revoked: clear }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error("Missing AuthProvider"); return value; }
export function Protected({ children }: { children: ReactNode }) {
  const auth = useAuth(); const location = useLocation();
  if (auth.loading) return <Loading />;
  if (auth.error) return <ErrorNotice error={auth.error} retry={auth.refresh} />;
  if (!auth.session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}
