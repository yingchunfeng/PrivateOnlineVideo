import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "./api/client";
import { Icon } from "./ui";

type ToastKind = "success" | "error" | "info";
interface ToastMessage { id: string; message: string; kind: ToastKind }
interface ConfirmOptions { title: string; message: string; confirmLabel?: string; danger?: boolean }
interface PendingConfirm { options: ConfirmOptions; resolve: (result: boolean) => void; opener: HTMLElement | null }
interface Feedback { toast: (message: string, kind?: ToastKind) => void; toastError: (error: unknown) => void; confirm: (options: ConfirmOptions) => Promise<boolean> }
const Context = createContext<Feedback | undefined>(undefined);
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]); const [pending, setPending] = useState<PendingConfirm>(); const current = useRef<PendingConfirm | undefined>(undefined);
  const dismiss = useCallback((id: string) => setMessages(items => items.filter(item => item.id !== id)), []);
  const toast = useCallback((message: string, kind: ToastKind = "success") => setMessages(items => [...items.slice(-4), { id: crypto.randomUUID(), message, kind }]), []);
  const toastError = useCallback((error: unknown) => { const message = error instanceof Error ? error.message : "操作未成功，请稍后重试"; toast(error instanceof ApiError && error.requestId ? `${message}（请求编号：${error.requestId}）` : message, "error"); }, [toast]);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>(resolve => {
    if (current.current) { resolve(false); return; }
    const value = { options, resolve, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null }; current.current = value; setPending(value);
  }), []);
  const finish = useCallback((result: boolean) => { const value = current.current; if (!value) return; current.current = undefined; setPending(undefined); value.resolve(result); queueMicrotask(() => { if (value.opener?.isConnected) value.opener.focus(); }); }, []);
  useEffect(() => () => { current.current?.resolve(false); current.current = undefined; }, []);
  return <Context.Provider value={{ toast, toastError, confirm }}>{children}{createPortal(<><section className="toast-stack" aria-label="操作消息">{messages.map(item => <FloatingToast key={item.id} item={item} dismiss={dismiss} />)}</section>{pending && <ConfirmDialog options={pending.options} finish={finish} />}</>, document.body)}</Context.Provider>;
}
function FloatingToast({ item, dismiss }: { item: ToastMessage; dismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => { if (paused) return; const timer = setTimeout(() => dismiss(item.id), item.kind === "error" ? 6000 : 3500); return () => clearTimeout(timer); }, [item.id, item.kind, paused, dismiss]);
  return <div className={`floating-toast ${item.kind}`} role={item.kind === "error" ? "alert" : "status"} aria-atomic="true" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}><span className="toast-symbol"><Icon name={item.kind === "success" ? "check" : item.kind === "error" ? "shield" : "sparkles"} /></span><span className="toast-message">{item.message}</span><button className="toast-close secondary" aria-label="关闭消息" onClick={() => dismiss(item.id)}>×</button></div>;
}
function ConfirmDialog({ options, finish }: { options: ConfirmOptions; finish: (result: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const cancel = useRef<HTMLButtonElement>(null); const titleId = useId(); const descriptionId = useId();
  useEffect(() => { const node = dialog.current; node?.showModal(); cancel.current?.focus(); return () => { if (node?.open) node.close(); }; }, []);
  return <dialog ref={dialog} className="feedback-confirm panel" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); finish(false); }} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")]; const first = buttons[0]; const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div className="sci-section-title" id={titleId}>{options.title}</div><p className="confirm-description" id={descriptionId}>{options.message}</p><div className="actions"><button ref={cancel} className="secondary" onClick={() => { dialog.current?.close(); finish(false); }}>取消</button><button className={options.danger ? "confirm-danger" : "button"} onClick={() => { dialog.current?.close(); finish(true); }}>{options.confirmLabel ?? "确认保存"}</button></div></dialog>;
}
export function useFeedback() { const feedback = useContext(Context); if (!feedback) throw new Error("Missing FeedbackProvider"); return feedback; }
