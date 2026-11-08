import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./reorder-list.css";

export function ReorderList<T extends { id: string }>({ items, onChange, label, name, render, disabled = false }: {
  items: T[]; onChange: (items: T[]) => void; label: string; name: (item: T) => string; render: (item: T) => ReactNode; disabled?: boolean;
}) {
  const hint = useId(); const list = useRef<HTMLOListElement>(null);
  const active = useRef<string | undefined>(undefined); const latest = useRef(items); latest.current = items;
  const [dragging, setDragging] = useState<string>(); const [announcement, setAnnouncement] = useState("");
  const move = (id: string, target: string) => {
    const values = latest.current; const from = values.findIndex(item => item.id === id); const to = values.findIndex(item => item.id === target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...values]; next.splice(to, 0, next.splice(from, 1)[0]!); latest.current = next; onChange(next);
    setAnnouncement(`${name(values[from]!)} 已移到第 ${to + 1} 位`);
  };
  const finish = () => { active.current = undefined; setDragging(undefined); };
  return <div className="reorder-panel"><p id={hint} className="muted reorder-hint">拖动左侧手柄调整顺序；也可聚焦手柄后按上、下方向键。调整后点击保存才会生效。</p>
    <ol ref={list} className="reorder-list" aria-label={label} onPointerMove={event => {
      if (!active.current || disabled) return;
      const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-sort-id]");
      if (row && list.current?.contains(row) && row.dataset.sortId) move(active.current, row.dataset.sortId);
      const scroller = list.current?.closest<HTMLElement>(".reorder-scroll");
      if (scroller) { const viewport = scroller.getBoundingClientRect(); if (event.clientY < viewport.top + 48) scroller.scrollBy(0, -18); else if (event.clientY > viewport.bottom - 48) scroller.scrollBy(0, 18); }
    }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>{items.map((item, index) => <li key={item.id} data-sort-id={item.id} className={dragging === item.id ? "reorder-row is-dragging" : "reorder-row"}>
      <button type="button" className="secondary reorder-handle" disabled={disabled} aria-label={`拖动排序 ${name(item)}`} aria-describedby={hint} onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault(); const target = items[index + (event.key === "ArrowUp" ? -1 : 1)]; if (target) move(item.id, target.id);
      }} onPointerDown={event => {
        if (event.button !== 0 || disabled) return;
        active.current = item.id; setDragging(item.id);
        // 行会在拖动时移动，捕获必须绑定到不会被重排的列表容器。
        list.current?.setPointerCapture(event.pointerId);
      }}><span aria-hidden="true">⋮⋮</span></button>
      <span className="reorder-position" aria-hidden="true">{index + 1}</span><div className="reorder-content">{render(item)}</div>
    </li>)}</ol><span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
