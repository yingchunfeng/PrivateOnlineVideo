import { useEffect, useRef, useState } from "react";
import type { HomepageSettings, LibraryConfiguration } from "@online-video/shared";
import { api } from "../api";
import { ApiError } from "../api/client";
import { Empty, ErrorNotice, Loading, useLoad } from "../ui";
import { ReorderList } from "../reorder-list";
import { notifyLibraryChanged } from "../library";
import { useFeedback } from "../feedback";

export function HomepageOrder({ configuration }: { configuration: LibraryConfiguration | undefined }) {
  const load = useLoad(() => api.request<HomepageSettings>("/api/settings/homepage"));
  const [draft, setDraft] = useState<HomepageSettings>(); const [baseline, setBaseline] = useState<HomepageSettings>(); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(); const saving = useRef(false); const { toast } = useFeedback();
  useEffect(() => { if (load.data) { setDraft(load.data); setBaseline(load.data); setError(undefined); } }, [load.data]);
  const save = async () => {
    if (!draft || saving.current) return;
    saving.current = true; setBusy(true); setError(undefined);
    try {
      const saved = await api.request<HomepageSettings>("/api/settings/homepage", { method: "PUT", body: { version: draft.version, categoryRandomEnabled: draft.categoryRandomEnabled, videoOrder: draft.videos.map(video => video.id) } });
      setDraft(saved); setBaseline(saved); notifyLibraryChanged(); toast("首页算法与视频顺序已保存。");
    } catch (err) { setError(err); }
    finally { saving.current = false; setBusy(false); }
  };
  if (load.busy && !draft) return <Loading />;
  if (load.error) return <ErrorNotice error={load.error} retry={load.reload} />;
  if (!draft) return null;
  const dirty = draft.categoryRandomEnabled !== baseline?.categoryRandomEnabled || JSON.stringify(draft.videos.map(video => video.id)) !== JSON.stringify(baseline?.videoOrder);
  return <section className="taxonomy-section homepage-order">
    <div className="list-bar"><strong>首页算法与视频顺序</strong><div className="homepage-order-actions"><button className="secondary" disabled={busy || load.busy} onClick={load.reload}>重新加载最新排序</button><button disabled={busy || load.busy || !draft.persistenceAvailable || !dirty} onClick={() => void save()}>{busy ? "正在保存…" : "保存首页排序"}</button></div></div>
    {!draft.persistenceAvailable && <div className="notice warning">当前数据库尚未升级到 v9，首页排序只读。请先备份并单独授权增量迁移；不会自动修改已有数据库。</div>}
    <label className="check-row homepage-order-toggle"><input type="checkbox" checked={draft.categoryRandomEnabled} disabled={busy || !draft.persistenceAvailable} onChange={event => setDraft({ ...draft, categoryRandomEnabled: event.target.checked })} />每个分类随机选一个视频优先展示</label>
    <p className="homepage-order-note">开启时各分类代表视频优先，其余按手动顺序；关闭后全部按手动顺序。</p>
    <details className="homepage-order-help"><summary>查看抽选、筛选与新视频的排序规则</summary><p className="homepage-order-note">每次登录从各非空分类随机选一个视频，按分类顺序排在最前。同一次登录刷新、翻页不重新抽选；搜索与分类/标签筛选不随机前置。未排序的新视频接在已排序视频之后，按新到旧排列。重新抽选也可能再次选中同一视频。</p></details>
    {error !== undefined && <ErrorNotice error={error} />}
    {error instanceof ApiError && error.code === "CONFIG_VERSION_CONFLICT" && <div className="notice warning">配置或视频列表已有变化，草稿暂时保留。点击“重新加载最新排序”会放弃当前未保存调整，载入最新列表后请重新排序。</div>}
    <div className="list-bar"><strong>全部视频</strong><small>{draft.videos.length} 个 · {dirty ? "有未保存调整" : "当前顺序"}</small></div>
    {draft.videos.length ? <div className="reorder-scroll"><ReorderList items={draft.videos} onChange={videos => setDraft({ ...draft, videos })} label="全部视频排序" name={video => video.title} disabled={busy || !draft.persistenceAvailable} render={video => <><strong>{video.title}</strong><small>{configuration?.categories.find(category => category.id === video.categoryId)?.name ?? "未分类"}</small></>} /></div> : <Empty title="暂无视频">上传或登记视频后，可在此拖动调整首页顺序。</Empty>}
  </section>;
}
