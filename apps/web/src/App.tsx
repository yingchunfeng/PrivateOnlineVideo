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

export function App() {
  const [revision, setRevision] = useState(0);
  return (
    <>
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
  const protectedPage = (page: React.ReactNode) => <Protected>{page}</Protected>;

  return (
    <div className={`app-shell ${auth.session ? "has-sidebar" : "no-sidebar"}`}>
      {/* 科技感左侧导航栏 (Sci-Fi Side Dock) */}
      {auth.session && (
        <aside className="side-dock" aria-label="侧边控制台">
          <div className="side-dock-brand">
            <NavLink className="side-logo-group" to="/">
              <div className="side-logo-symbol">
                <Icon name="play" />
              </div>
              <div className="side-logo-text">
                <span className="side-logo-title">云影匣</span>
                <span className="side-logo-badge">CLOUD VAULT</span>
              </div>
            </NavLink>
          </div>

          <nav className="side-nav-menu" aria-label="系统主菜单">
            <div className="side-nav-group-label">控制中心</div>
            <NavLink to="/" end className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="home" />
              <span>首页库</span>
            </NavLink>
            <NavLink to="/upload" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="upload" />
              <span>上传视频</span>
            </NavLink>
            <NavLink to="/categories" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="settings" />
              <span>配置管理</span>
            </NavLink>
            <NavLink to="/tasks" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}><Icon name="history" /><span>任务列表</span></NavLink>
            <NavLink to="/settings" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}><Icon name="settings" /><span>系统设置</span></NavLink>
            <NavLink to="/security" className={({ isActive }) => `side-nav-item ${isActive ? "active" : ""}`}>
              <Icon name="shield" />
              <span>账户安全</span>
            </NavLink>
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
                  ["normal", "正常"], ["empty", "空视频库"], ["long", "长标题"], ["offline", "网络中断"],
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
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={protectedPage(<LibraryPage />)} />
            <Route path="/videos/:videoId" element={protectedPage(<VideoPage />)} />
            <Route path="/upload" element={protectedPage(<UploadPage />)} />
            <Route path="/tasks" element={protectedPage(<TasksPage />)} />
            <Route path="/categories" element={protectedPage(<CategoriesPage />)} />
            <Route path="/settings" element={protectedPage(<InstallationSettingsPage />)} />
            <Route path="/security" element={protectedPage(<SecurityPage />)} />
            <Route path="*" element={<Empty title="页面不存在"><NavLink className="text-link" to="/">返回视频库</NavLink></Empty>} />
          </Routes>
        </main>
      </div>

      {/* 手机触控端：底部便携 Dock 导航栏 */}
      {auth.session && (
        <nav className="bottom-nav" aria-label="主要导航">
          {[
            ["/", "视频库", "library"],
            ["/upload", "上传", "upload"],
            ["/tasks", "任务", "history"],
            ["/categories", "配置", "settings"],
            ["/settings", "系统", "settings"],
            ["/security", "安全", "shield"]
          ].map(([path, label, icon]) => (
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
