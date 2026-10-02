import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useState } from "react";
import { mockEnabled } from "./api";
import { AuthProvider, Protected, useAuth } from "./auth";
import { LoginPage } from "./pages/Login";
import { LibraryPage } from "./pages/Library";
import { CategoriesPage } from "./pages/Categories";
import { VideoPage } from "./pages/Video";
import { UploadPage } from "./pages/Upload";
import { SecurityPage } from "./pages/Security";
import { Icon, Empty, ErrorNotice } from "./ui";

export function App() {
  const [revision, setRevision] = useState(0);
  return <><a href="#main" className="skip">跳到内容</a><header className="topbar"><NavLink className="brand" to="/"><span className="brand-symbol"><Icon name="play" /></span><span>片刻<small>PRIVATE VIDEO LIBRARY</small></span></NavLink><span className="mode-chip">私有空间 · A 模式</span></header>{mockEnabled && <div className="mock-banner"><div role="status">开发 Mock · 所有业务为模拟数据，未连接真实 OSS</div><label className="mock-control">模拟场景<select aria-label="模拟场景" onChange={async e => {
    if (import.meta.env.DEV) { const module = await import("./api/mock"); module.setMockScenario(e.target.value as keyof typeof module.mockScenarios); setRevision(r => r + 1); }
  }}>{[["normal", "正常"], ["empty", "空视频库"], ["long", "长标题"], ["offline", "网络中断"], ["expired", "会话过期"], ["limit", "流量已达上限"], ["unconfigured", "限额未配置"], ["unlimited", "显式不限额"], ["storage", "存储不可用"], ["unknownUsage", "未知统计来源"], ["usageUnavailable", "用量不可用"], ["completeFailure", "完成失败一次"], ["finalizing", "遗留完成中任务"], ["uploadFailure", "分片失败一次"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>}<AuthProvider key={revision}><Content /></AuthProvider></>;
}

function Content() {
  const auth = useAuth(); const [logoutError, setLogoutError] = useState<unknown>(); const [loggingOut, setLoggingOut] = useState(false);
  const protectedPage = (page: React.ReactNode) => <Protected>{page}</Protected>;
  return <><main id="main">{auth.session && <div className="account-strip"><small>仅本人可见</small><button className="secondary" disabled={loggingOut} onClick={async () => { setLoggingOut(true); setLogoutError(undefined); try { await auth.logout(); } catch (err) { setLogoutError(err); } finally { setLoggingOut(false); } }}>{loggingOut ? "正在退出…" : "退出登录"}</button></div>}{logoutError !== undefined && <ErrorNotice error={logoutError} />}<Routes><Route path="/login" element={<LoginPage />} /><Route path="/" element={protectedPage(<LibraryPage />)} /><Route path="/videos/:videoId" element={protectedPage(<VideoPage />)} /><Route path="/upload" element={protectedPage(<UploadPage />)} /><Route path="/categories" element={protectedPage(<CategoriesPage />)} /><Route path="/security" element={protectedPage(<SecurityPage />)} /><Route path="*" element={<Empty title="页面不存在"><NavLink className="text-link" to="/">返回视频库</NavLink></Empty>} /></Routes></main>{auth.session && <nav className="bottom-nav" aria-label="主要导航">{[["/", "视频库", "library"], ["/upload", "上传", "upload"], ["/categories", "分类", "folder"], ["/security", "安全", "shield"]].map(([path, label, icon]) => <NavLink key={path} to={path!} end={path === "/"}><Icon name={icon as "library"} /><span>{label}</span></NavLink>)}</nav>}</>;
}
