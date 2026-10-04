import { useState } from "react";
import type { Category, LibraryGroup, Tag } from "@online-video/shared";
import { api } from "../api";
import { loadOrganizations } from "../organization";
import { Empty, ErrorNotice, Icon, Loading, useLoad } from "../ui";

export { ConfigurationPage as CategoriesPage } from "./Configuration";

export function LegacyCategoriesPage() {
  const list = useLoad(loadOrganizations);
  const [kind, setKind] = useState<"categories" | "tags">("categories");
  const labels = { categories: "分类", tags: "标签" };
  const label = labels[kind];
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const items = list.data?.[kind === "categories" ? "categories" : "tags"];

  const filteredItems = items?.filter(item =>
    !searchFilter.trim() || item.name.toLowerCase().includes(searchFilter.trim().toLowerCase())
  );

  return (
    <>
      <div className="sci-cat-header-row">
        <div className="sci-cat-header-info">
          <div className="eyebrow">SYSTEM TAXONOMY & CONFIGURATION</div>
          <h1 className="sci-cat-title">配置管理</h1>
          <p className="muted">维护媒体视频的分类索引与内容检索标签，实现灵活的组织架构与多维检索。</p>
        </div>
      </div>

      {/* 选项卡 + 搜索 */}
      <div className="cfg-hero-bar">
        <div className="cfg-tabs" role="tablist" aria-label="配置管理模式">
          {(["categories", "tags"] as const).map(value => {
            const count = list.data?.[value]?.length ?? 0;
            return (
              <button
                key={value}
                role="tab"
                className={`cfg-tab-pill ${kind === value ? "active" : ""}`}
                aria-selected={kind === value}
                onClick={() => {
                  setKind(value);
                  setName("");
                  setError(undefined);
                  setMessage("");
                  setSearchFilter("");
                }}
              >
                <Icon name={value === "categories" ? "folder" : "sparkles"} />
                <span className="cfg-tab-name">{labels[value]}配置</span>
                <span className="cfg-tab-num">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="cfg-search-box">
          <Icon name="filter" />
          <input
            type="search"
            placeholder={`快速检索已建${label}…`}
            value={searchFilter}
            onChange={e => setSearchFilter(e.target.value)}
          />
        </div>
      </div>

      {/* 系统通知 */}
      {error !== undefined && <ErrorNotice error={error} />}
      {message && <div className="notice completed-sci-notice" role="status">{message}</div>}

      {/* 新建条目（行内表单） */}
      <form
        className="cfg-list-create-bar"
        onSubmit={async event => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          setMessage("");
          try {
            await api.request<Category | LibraryGroup | Tag>(`/api/${kind}`, {
              method: "POST",
              body: { name: name.trim() }
            });
            setMessage(`${label}“${name.trim()}”已成功创建`);
            setName("");
            list.reload();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          className="sci-input"
          placeholder={`输入新${label}名称（如：科幻、2026）`}
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={100}
          required
          disabled={busy}
          aria-label={`新建${label}名称`}
        />
        <button className="button" disabled={busy || !name.trim()} type="submit">
          <Icon name="check" />
          <span>{busy ? "正在写入…" : `添加${label}`}</span>
        </button>
      </form>

      {/* 列表 */}
      <section className="cfg-data-section">
        <div className="cfg-section-bar">
          <span className="cfg-section-title">已有{label}条目</span>
          <small className="muted">
            {searchFilter ? `匹配到 ${filteredItems?.length ?? 0} 项` : `共 ${items?.length ?? 0} 个条目`}
          </small>
        </div>

        {list.busy ? (
          <Loading />
        ) : list.error ? (
          <ErrorNotice error={list.error} retry={list.reload} />
        ) : filteredItems?.length === 0 ? (
          <Empty title={searchFilter ? `未找到包含“${searchFilter}”的${label}` : `暂无${label}数据`}>
            {searchFilter ? "请检查搜索词或清除筛选。" : "使用上方输入框即可立刻添加新条目。"}
          </Empty>
        ) : (
          <table className="cfg-list-table">
            <thead>
              <tr>
                <th className="cfg-col-name">名称</th>
                {kind !== "tags" && <th className="cfg-col-sort">权重</th>}
                <th className="cfg-col-state">状态</th>
                <th className="cfg-col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems
                ?.slice()
                .sort((a, b) => ("sortOrder" in a ? a.sortOrder : 0) - ("sortOrder" in b ? b.sortOrder : 0))
                .map(item => (
                  <ConfigItemRow
                    key={`${kind}:${item.id}:${item.name}:${item.archivedAt}`}
                    item={item}
                    kind={kind}
                    onSaved={list.reload}
                  />
                ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function ConfigItemRow({
  item,
  kind,
  onSaved
}: {
  item: Category | LibraryGroup | Tag;
  kind: "categories" | "tags";
  onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [sortOrder, setSortOrder] = useState("sortOrder" in item ? item.sortOrder : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const isDefault = "isDefault" in item && item.isDefault;

  const update = async (body: unknown) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.request<Category | LibraryGroup | Tag>(`/api/${kind}/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const changed =
    name.trim() !== item.name ||
    ("sortOrder" in item && sortOrder !== item.sortOrder);

  return (
    <tr className={item.archivedAt ? "archived" : ""}>
      <td className="cfg-col-name">
        <input
          aria-label={`重命名 ${item.name}`}
          className="sci-input cfg-name-input"
          value={name}
          maxLength={100}
          onChange={e => setName(e.target.value)}
          required
          disabled={busy || !!isDefault}
          placeholder="条目名称"
        />
        {isDefault && <div className="cfg-default-tip">系统内置默认（不可变更）</div>}
        {error !== undefined && <ErrorNotice error={error} />}
      </td>

      {kind !== "tags" && (
        <td className="cfg-col-sort">
          <input
            type="number"
            className="sci-input cfg-sort-input"
            min={0}
            step={1}
            value={sortOrder}
            onChange={e => setSortOrder(Number(e.target.value))}
            disabled={busy || !!isDefault}
            required
            title="数值越小越靠前显示"
            aria-label={`${item.name} 排序权重`}
          />
        </td>
      )}

      <td className="cfg-col-state">
        {item.archivedAt ? (
          <span className="cfg-state-tag archived">已归档</span>
        ) : isDefault ? (
          <span className="cfg-state-tag default">默认</span>
        ) : (
          <span className="cfg-state-tag active">活跃</span>
        )}
      </td>

      <td className="cfg-col-actions">
        <button
          className="secondary sci-card-btn cfg-save-btn"
          type="button"
          disabled={busy || !changed || !name.trim() || !!isDefault}
          onClick={() =>
            void update({
              name: name.trim(),
              ...(kind !== "tags" ? { sortOrder } : {})
            })
          }
        >
          {busy ? "…" : "保存"}
        </button>

        {!isDefault && (
          <button
            className={`secondary sci-card-btn ${item.archivedAt ? "cfg-restore-btn" : "cfg-archive-btn"}`}
            type="button"
            disabled={busy}
            onClick={() => void update({ archived: !item.archivedAt })}
          >
            {item.archivedAt ? "恢复" : "归档"}
          </button>
        )}
      </td>
    </tr>
  );
}
