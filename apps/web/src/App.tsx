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
import { TasksPage } from "./pages/Tasks";
import { InstallationSettingsPage } from "./pages/InstallationSettings";
import { SetupGate } from "./setup";
import { UploadQueueProvider } from "./upload-context";
import { FeedbackProvider, useFeedback } from "./feedback";
import { Icon, Empty, ErrorNotice } from "./ui";
import { PageManagementPage } from "./pages/PageManagement";
import { OrbitalMark, SpaceBackdrop, SpaceMeteors } from "./space-console";
import { PageEntrance, SideNavigationOrbit } from "./space-enhancements";
import type { GuestPermission } from "@online-video/shared";
import { GuestLoginPage } from "./pages/GuestLogin";
import { GuestsPage } from "./pages/Guests";
import { landingPage } from "./authz";

export function App() {
  const [revision, setRevision] = useState(0);
  return (
    <>
      <SpaceBackdrop />
      <SpaceMeteors layer="foreground" />
      <a href="#main" className="skip">跳到内容</a>
      <FeedbackProvider><SetupGate><AuthProvider key={revision}>
        <UploadQueueProvider><AppLayout revision={revision} setRevision={setRevision} /></UploadQueueProvider>
      </AuthProvider></SetupGate></FeedbackProvider>
    </>
  );
}

function AppLayout({ revision, setRevision }: { revision: number; setRevision: React.Dispatch<React.SetStateAction<number>> }) {
  const auth = useAuth();
  const { toast, toastError } = useFeedback();
  const [loggingOut, setLoggingOut] = useState(false);
  const protectedPage = (page: React.ReactNode, permission?: GuestPermission, adminOnly = false) => <Protected {...(permission ? { permission } : {})} adminOnly={adminOnly}>{page}</Protected>;

  return (
    <div className={`app-shell ${auth.session ? "has-sidebar" : "no-sidebar"}`}>
      {/* 科技感左侧导航栏 (Sci-Fi Side Dock) */}
      {auth.session && (
        <aside className="side-dock" aria-label="侧边控制台">
          <div className="side-dock-brand">
            <NavLink className="side-logo-group" to={landingPage(auth.session)}>
              <div className="side-logo-symbol">
                <OrbitalMark />
              </div>
              <div className="side-logo-text">
                <span className="side-logo-title">云影匣</span>
              </div>
            </NavLink>
          </div>

          <nav className="side-nav-menu" aria-label="系统主菜单">
            <SideNavigationOrbit />
            <div className="side-nav-group-label">控制中心</div>
            {auth.can("library") && <NavLink to="/" end className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="home" />
              <span>高光时刻</span>
            </NavLink>}
            {auth.can("upload") && <NavLink to="/upload" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="upload" />
              <span>上传视频</span>
            </NavLink>}
            {auth.can("configuration") && <NavLink to="/categories" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="settings" />
              <span>配置管理</span>
            </NavLink>}
            {auth.can("tasks") && <NavLink to="/tasks" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}><Icon name="history" /><span>任务列表</span></NavLink>}
            {auth.isAdmin && <NavLink to="/settings" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}><Icon name="settings" /><span>系统设置</span></NavLink>}
            {auth.can("pages") && <NavLink to="/pages" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}><Icon name="sparkles" /><span>页面管理</span></NavLink>}
            {auth.isAdmin && <NavLink to="/guests" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}><Icon name="shield" /><span>访客管理</span></NavLink>}
            {auth.isAdmin && <NavLink to="/security" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="shield" />
              <span>账户安全</span>
            </NavLink>}
          </nav>

          {/* 左下角：存储空间仪表盘 HUD Widget */}
          <div className="side-storage-widget">
            <div className="storage-widget-header">
              <span className="storage-widget-title">媒体存储</span>
              <span className="storage-widget-val">OSS</span>
            </div>
            <div className="storage-widget-body">
              <div className="storage-circle-gauge">
                <span className="storage-pct-num">OSS</span>
              </div>
              <div className="storage-desc-text">
                <strong>视频公共地址</strong>
                <small>HTTPS 直连播放</small>
              </div>
            </div>
          </div>

          {/* 用户与登出 */}
          <div className="side-dock-footer">
            <div className="user-profile-badge">
              <div className="user-avatar-dot" />
              <span className="user-disp-name">{auth.session.user.displayName || "私有主用户"}</span>
            </div>
            <button
              className="side-logout-btn"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                try {
                  await auth.logout();
                  toast("已退出登录");
                } catch (err) {
                  toastError(err);
                } finally {
                  setLoggingOut(false);
                }
              }}
              title="退出登录"
            >
              {loggingOut ? "…" : "退出"}
            </button>
          </div>
        </aside>
      )}

      {/* 主工作区 */}
      <div className="main-content-wrapper">
        {mockEnabled && (
          <div className="mock-banner">
            <div role="status">开发 Mock · 所有业务为模拟数据，未连接真实 OSS</div>
            <label className="mock-control">模拟场景
              <select
                aria-label="模拟场景"
                onChange={async e => {
                  if (import.meta.env.DEV) {
                    const module = await import("./api/mock");
                    module.setMockScenario(e.target.value as keyof typeof module.mockScenarios);
                    setRevision(r => r + 1);
                  }
                }}
              >
                {[
                  ["normal", "正常"], ["empty", "空高光时刻"], ["long", "长标题"], ["offline", "网络中断"],
                  ["expired", "会话过期"], ["limit", "流量已达上限"], ["unconfigured", "限额未配置"],
                  ["unlimited", "显式不限额"], ["storage", "存储不可用"], ["unknownUsage", "未知统计来源"],
                  ["usageUnavailable", "用量不可用"], ["completeFailure", "完成失败一次"],
                  ["finalizing", "遗留完成中任务"], ["uploadFailure", "分片失败一次"]
                ].map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <main id="main">
          <PageEntrance />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/guest/login" element={<GuestLoginPage />} />
            <Route path="/" element={protectedPage(<LibraryPage />, "library")} />
            <Route path="/videos/:videoId" element={protectedPage(<VideoPage />, "library")} />
            <Route path="/upload" element={protectedPage(<UploadPage />, "upload")} />
            <Route path="/tasks" element={protectedPage(<TasksPage />, "tasks")} />
            <Route path="/categories" element={protectedPage(<CategoriesPage />, "configuration")} />
            <Route path="/settings" element={protectedPage(<InstallationSettingsPage />, undefined, true)} />
            <Route path="/pages" element={protectedPage(<PageManagementPage />, "pages")} />
            <Route path="/guests" element={protectedPage(<GuestsPage />, undefined, true)} />
            <Route path="/security" element={protectedPage(<SecurityPage />, undefined, true)} />
            <Route path="/access" element={protectedPage(<Empty title="尚无可访问页面">请联系管理员授予页面权限。</Empty>)} />
            <Route path="*" element={<Empty title="页面不存在"><NavLink className="text-link" to="/">返回高光时刻</NavLink></Empty>} />
          </Routes>
        </main>
      </div>

      {/* 手机触控端：底部便携 Dock 导航栏 */}
      {auth.session && (
        <nav className="bottom-nav" aria-label="主要导航">
          {[
            ["/", "高光时刻", "library"],
            ["/upload", "上传", "upload"],
            ["/tasks", "任务", "history"],
            ["/categories", "配置", "settings"],
            ["/settings", "系统", "settings"],
            ["/pages", "页面", "sparkles"],
            ["/security", "安全", "shield"],
            ["/guests", "访客", "shield"]
          ].filter(([path]) => {
            const permission = ({ "/": "library", "/upload": "upload", "/tasks": "tasks", "/categories": "configuration", "/pages": "pages" } as Record<string, GuestPermission>)[path!];
            return permission ? auth.can(permission) : auth.isAdmin;
          }).map(([path, label, icon]) => (
            <NavLink key={path} to={path!} end={path === "/"}>
              <Icon name={icon as "library"} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
