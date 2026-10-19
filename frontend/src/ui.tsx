import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { ApiError, Priority, Status } from './api';
type Toast = { id: number; kind: 'ok' | 'err'; text: string };
const ToastCtx = createContext<(kind: 'ok' | 'err', text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function Toasts({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: 'ok' | 'err', text: string) => {
    const id = Date.now() + Math.random(); setList((l) => [...l, { id, kind, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 5000);
  }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div></ToastCtx.Provider>;
}
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const StatusBadge = ({ s }: { s: Status }) => <span className={`badge s-${s}`}>{label(s)}</span>;
export const PriorityTag = ({ p }: { p: Priority }) => <span className={`prio p-${p}`}><i aria-hidden />{label(p)}</span>;
export const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); const a = Math.abs(m);
  const t = a < 60 ? `${a}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  return m >= 0 ? `${t} ago` : `in ${t}`;
};
export const isOverdue = (due: string | null, s: Status) => !!due && new Date(due) < new Date() && s !== 'RESOLVED' && s !== 'CLOSED';
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  const title = e?.status === 404 ? 'Not found' : e?.status === 403 ? 'You don’t have access' : e?.status === 0 ? 'API unavailable' : 'Something went wrong';
  return <div className="state" role="alert"><h2>{title}</h2><p>{e?.message ?? 'Unexpected error'}</p>{retry && e?.status !== 404 && e?.status !== 403 && <button className="btn" onClick={retry}>Try again</button>}</div>;
}
export const Empty = ({ title, hint }: { title: string; hint?: string }) => <div className="state"><h2>{title}</h2>{hint && <p>{hint}</p>}</div>;
export const Skeleton = ({ rows = 6 }: { rows?: number }) => <div aria-busy="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" />)}</div>;
export function Confirm({ open, title, body, onYes, onNo, busy }: { open: boolean; title: string; body: string; onYes: () => void; onNo: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return <dialog ref={ref} onClose={onNo} aria-labelledby="ctitle"><h2 id="ctitle">{title}</h2><p>{body}</p>
    <div className="row end"><button className="btn" onClick={onNo}>Cancel</button><button className="btn primary" onClick={onYes} disabled={busy}>{busy ? 'Working…' : 'Confirm'}</button></div></dialog>;
}
