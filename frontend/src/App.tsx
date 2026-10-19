import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, Activity, Comment, DashboardSummary, Item, ItemList, Me, Member, NEXT, Priority, Status, Team, atLeast, setUnauthorizedHandler } from './api';
import { Confirm, Empty, ErrorState, PriorityTag, Skeleton, StatusBadge, Toasts, ago, isOverdue, useToast } from './ui';
import { CommandPalette } from './CommandPalette';

function useMe() { return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false, staleTime: 60_000 }); }
// Demo credentials are shown/prefilled only in development, or when a demo deployment sets VITE_SHOW_DEMO_HINT=true at build time.
const DEMO_HINT = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_HINT === 'true';
const STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];
const PRIOS: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const TYPES = ['TASK', 'INCIDENT', 'REQUEST'];

export default function App() {
  return <Toasts><Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<Shell />}>
      <Route path="/" element={<Dashboard />} /><Route path="/items/new" element={<CreateItem />} />
      <Route path="/items/:id" element={<ItemDetail />} /><Route path="/teams" element={<Teams />} />
      <Route path="*" element={<ErrorState error={new ApiError(404, 'NOT_FOUND', 'That page does not exist.')} />} />
    </Route>
  </Routes></Toasts>;
}

function Login() {
  const nav = useNavigate(); const qc = useQueryClient(); const [sp] = useSearchParams();
  const [email, setEmail] = useState(DEMO_HINT ? 'member@demo.test' : ''); const [password, setPassword] = useState(''); const [show, setShow] = useState(false);
  const m = useMutation({
    mutationFn: () => api<{ user: { id: number; name: string } }>('/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['me'] }); nav('/'); },
  });
  const err = m.error as ApiError | null;
  return <main className="login min-h-screen"><form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }} noValidate>
    <div className="brand"><span className="logo" aria-hidden>N</span>Newtonite Ops</div>
    <h1>Operations under pressure</h1><p className="muted">Investigate, assign, approve and resolve work reliably.</p>
    {sp.get('expired') && <p className="alert warn" role="alert">Your session expired. Please sign in again.</p>}
    {err && <p className="alert err" role="alert">{err.status === 401 ? 'Invalid email or password.' : err.status === 429 ? 'Too many failed sign-in attempts. Please wait a few minutes and try again.' : err.status === 0 ? err.message : 'The server had a problem. Try again shortly.'}</p>}
    <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
    <div className="field"><label htmlFor="pw">Password</label><span className="pw"><input id="pw" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      <button type="button" className="link" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button></span></div>
    <button className="btn primary wide" disabled={m.isPending || !email || !password}>{m.isPending ? 'Signing in…' : 'Sign in'}</button>
    {DEMO_HINT && <p className="muted small">Local demo accounts: admin@, lead@, member@, viewer@demo.test — password <code>demo-local-only</code></p>}
  </form></main>;
}

function Shell() {
  const me = useMe(); const nav = useNavigate(); const qc = useQueryClient(); const loc = useLocation();
  const toast = useToast();
  useEffect(() => setUnauthorizedHandler(() => { qc.clear(); nav('/login?expired=1', { replace: true }); }), [qc, nav]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (paletteOpen) {
          setPaletteOpen(false);
          window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.focus(), 0);
        } else setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [paletteOpen]);
  if (me.isLoading) return <main className="pad"><Skeleton /></main>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.error) return <main className="pad"><ErrorState error={me.error} retry={() => me.refetch()} /></main>;
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); qc.clear(); nav('/login'); }
    catch { toast('err', 'Could not sign out. Check your connection and try again.'); }
  };
  const canCreate = me.data!.memberships.some((m) => atLeast(m.role, 'MEMBER'));
  return <div className="shell min-h-screen">
    <aside aria-label="Sidebar"><div className="brand"><span className="logo" aria-hidden>N</span>Newtonite Ops</div>
      <nav aria-label="Main"><NavLink to="/" end>Work</NavLink><NavLink to="/teams">Teams</NavLink></nav>
      <div className="me"><span className="eyebrow">Signed in</span><strong>{me.data!.user.name}</strong><span className="muted small">{[...new Set(me.data!.memberships.map((m) => m.role))].join(' · ')}</span><button className="link" onClick={logout}>Sign out</button></div></aside>
    <main className="workspace" key={loc.pathname.startsWith('/items/') ? loc.pathname : 'x'}>
      <header className="topbar"><div className="topbar-context"><span className="status-light" aria-hidden />Newtonite operations</div>
        <div className="topbar-actions"><button className="command-trigger" data-command-trigger onClick={() => setPaletteOpen(true)} aria-haspopup="dialog"><span aria-hidden>⌕</span>Search or jump to…<kbd>Ctrl/Cmd K</kbd></button>
            {canCreate && <Link className="btn primary topbar-create" to="/items/new" aria-label="Create a work item">＋ New work</Link>}
          <span className="avatar" aria-label={`Signed in as ${me.data!.user.name}`}>{me.data!.user.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span></div></header>
      <OutletBridge />
    </main>
    <CommandPalette open={paletteOpen} canCreate={canCreate} onClose={() => setPaletteOpen(false)} />
  </div>;
}
import { Outlet } from 'react-router-dom';
const OutletBridge = () => <Outlet />;

function Dashboard() {
  const me = useMe().data!; const [sp, setSp] = useSearchParams(); const nav = useNavigate(); const toast = useToast();
  const [savedViews, setSavedViews] = useState<{ id: string; name: string; filters: string }[]>([]);
  const [viewName, setViewName] = useState(''); const [selectedView, setSelectedView] = useState('');
  const f = { q: sp.get('q') ?? '', status: sp.get('status') ?? '', teamId: sp.get('teamId') ?? '', overdue: sp.get('overdue') ?? '', assigneeId: sp.get('assigneeId') ?? '', unassigned: sp.get('unassigned') ?? '', priority: sp.get('priority') ?? '', type: sp.get('type') ?? '', active: sp.get('active') ?? '', approvable: sp.get('approvable') ?? '' };
  const assigneeSel = f.unassigned === 'true' ? 'unassigned' : f.assigneeId === String(me.user.id) ? 'me' : f.assigneeId ? 'other' : '';
  const setAssignee = (v: string) => setSp((prev) => { const n = new URLSearchParams(prev); n.delete('assigneeId'); n.delete('unassigned'); if (v === 'me') n.set('assigneeId', String(me.user.id)); if (v === 'unassigned') n.set('unassigned', 'true'); return n; }, { replace: true });
  const [qText, setQText] = useState(f.q);
  // Functional updates always start from the CURRENT URL, so a debounced search can never overwrite a filter changed in the meantime.
  const set = (k: string, v: string) => setSp((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const setRef = useRef(set); setRef.current = set; // timers must call the LATEST setter: React Router's `prev` is the URL of the render that created it
  const pushed = useRef(f.q); // the q value this component last wrote to the URL
  useEffect(() => { if (f.q !== pushed.current) { pushed.current = f.q; setQText(f.q); } }, [f.q]); // URL changed elsewhere (tile click, reset, back button)
  useEffect(() => { if (qText === pushed.current) return; const t = setTimeout(() => { pushed.current = qText; setRef.current('q', qText); }, 300); return () => clearTimeout(t); }, [qText]);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ data: Team[] }>('/teams') });
  const sum = useQuery({ queryKey: ['summary'], queryFn: () => api<DashboardSummary>('/dashboard/summary') });
  const list = useInfiniteQuery({
    queryKey: ['items', f], initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => api<ItemList>('/items', { signal, query: { ...f, limit: 20, cursor: pageParam } }),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? []; const filtered = Object.values(f).some(Boolean);
  const canCreate = me.memberships.some((m) => atLeast(m.role, 'MEMBER'));
  const viewStorageKey = `newtonite:saved-work-views:${me.user.id}`;
  useEffect(() => {
    try {
      const stored = localStorage.getItem(viewStorageKey);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (!Array.isArray(parsed) || parsed.some((view) => !view || typeof view.id !== 'string' || typeof view.name !== 'string' || typeof view.filters !== 'string')) throw new Error('Saved view data has an invalid format.');
        setSavedViews(parsed);
      }
    } catch (error) {
      toast('err', error instanceof Error ? error.message : 'Saved views could not be loaded from this browser.');
    }
  }, [toast, viewStorageKey]);
  const persistViews = (next: typeof savedViews) => {
    try {
      localStorage.setItem(viewStorageKey, JSON.stringify(next));
      setSavedViews(next);
      return true;
    } catch {
      toast('err', 'Saved views could not be stored in this browser.');
      return false;
    }
  };
  const saveView = (event: FormEvent) => {
    event.preventDefault();
    const name = viewName.trim();
    if (!name || !filtered) return;
    const next = [...savedViews, { id: crypto.randomUUID(), name, filters: sp.toString() }];
    if (persistViews(next)) {
      setViewName('');
      toast('ok', `Saved “${name}” on this browser`);
    }
  };
  return <div className="pad">
    <header className="head"><div><p className="eyebrow">Command center / Work</p><h1>Operational overview</h1><p className="muted">Your team’s live work queue, scoped to your access.</p></div>{canCreate && <Link className="btn primary" to="/items/new">＋ Create work item</Link>}</header>
    <section className="metrics" aria-label="Summary">{sum.isLoading ? <Skeleton rows={1} /> : sum.error ? <ErrorState error={sum.error} retry={() => sum.refetch()} /> : <>
      <button onClick={() => setSp({ assigneeId: String(me.user.id), active: 'true' })}><b>{sum.data!.assignedToMe}</b>Assigned to me</button>
      <button onClick={() => setSp({ approvable: 'true' })}><b>{sum.data!.awaitingMyApproval}</b>Awaiting my approval</button>
      <button className={sum.data!.unassignedUrgent ? 'hot' : ''} onClick={() => setSp({ unassigned: 'true', priority: 'URGENT', active: 'true' })}><b>{sum.data!.unassignedUrgent}</b>Unassigned urgent</button>
      <button className={sum.data!.overdue ? 'hot' : ''} onClick={() => setSp({ overdue: 'true' })}><b>{sum.data!.overdue}</b>Overdue</button></>}</section>
    <div className="filters" role="search">
      <span className="filter-label">Filter work</span>
      <input aria-label="Search work items" placeholder="Search title, description or OPS-00001" value={qText} onChange={(e) => setQText(e.target.value)} />
      <select aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select>
      <select aria-label="Team" value={f.teamId} onChange={(e) => set('teamId', e.target.value)}><option value="">All teams</option>{teams.data?.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <select aria-label="Priority" value={f.priority} onChange={(e) => set('priority', e.target.value)}><option value="">All priorities</option>{PRIOS.map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}</select>
      <select aria-label="Type" value={f.type} onChange={(e) => set('type', e.target.value)}><option value="">All types</option>{TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}</select>
      <select aria-label="Assignee" value={assigneeSel} onChange={(e) => setAssignee(e.target.value)}><option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>{assigneeSel === 'other' && <option value="other" disabled>Specific user</option>}</select>
      <label className="check"><input type="checkbox" checked={f.overdue === 'true'} onChange={(e) => set('overdue', e.target.checked ? 'true' : '')} />Overdue</label>
      {filtered && <button className="link" onClick={() => { setQText(''); setSp({}); }}>Reset filters</button>}</div>
    <section className="saved-views" aria-label="Saved work views"><div className="saved-view-select"><span className="eyebrow">Saved views</span>
      <select aria-label="Saved views" value={selectedView} onChange={(event) => { const id = event.target.value; setSelectedView(id); const saved = savedViews.find((view) => view.id === id); if (saved) setSp(new URLSearchParams(saved.filters), { replace: true }); }}>
        <option value="">Choose a saved view…</option>{savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select>
      {selectedView && <button className="icon-button" aria-label="Remove selected saved view" onClick={() => { const next = savedViews.filter((view) => view.id !== selectedView); if (persistViews(next)) { setSelectedView(''); toast('ok', 'Saved view removed'); } }}>×</button>}
      <span className="muted small">Stored only in this browser</span></div>
      {filtered && <form className="save-view-form" onSubmit={saveView}><label className="sr-only" htmlFor="saved-view-name">Name this filter view</label><input id="saved-view-name" maxLength={40} placeholder="Name this view" value={viewName} onChange={(event) => setViewName(event.target.value)} required /><button className="btn" disabled={!viewName.trim()}>Save current filters</button></form>}
    </section>
    {(f.active || f.approvable) && <div className="chips">{f.active && <button className="chip" aria-label="Remove filter: open items only" onClick={() => set('active', '')}>Open items only ×</button>}{f.approvable && <button className="chip" aria-label="Remove filter: awaiting my approval" onClick={() => set('approvable', '')}>Awaiting my approval ×</button>}</div>}
    {list.isLoading ? <Skeleton /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : rows.length === 0 ? <Empty title="No work items match" hint={filtered ? 'Try clearing a filter.' : 'Create the first item to get started.'} /> :
      <div className="tablewrap"><table><thead><tr><th>Ref</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Due</th><th>Updated</th></tr></thead><tbody>
        {rows.map((i) => <tr key={i.id} tabIndex={0} onClick={() => nav(`/items/${i.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/items/${i.id}`)}>
          <td className="mono">{i.reference}</td><td><Link to={`/items/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.title}</Link></td><td><StatusBadge s={i.status} /></td>
          <td><PriorityTag p={i.priority} /></td><td>{i.assignee_name ?? <span className={i.priority === 'URGENT' ? 'flag' : 'muted'}>Unassigned</span>}</td>
          <td>{i.due_at ? <span className={isOverdue(i.due_at, i.status) ? 'flag' : ''}>{isOverdue(i.due_at, i.status) ? 'Overdue ' : ''}{ago(i.due_at)}</span> : '—'}</td><td className="muted">{ago(i.updated_at)}</td></tr>)}
      </tbody></table>{list.hasNextPage && <div className="row center"><button className="btn" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>}</div>}
  </div>;
}

function CreateItem() {
  const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const key = useRef(crypto.randomUUID());
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ data: Team[] }>('/teams') });
  const writable = teams.data?.data.filter((t) => atLeast(t.role, 'MEMBER')) ?? [];
  const [v, setV] = useState({ title: '', description: '', priority: 'MEDIUM' as Priority, teamId: '', due: '', type: 'TASK' });
  const m = useMutation({
    mutationFn: () => api<Item>('/items', { method: 'POST', headers: { 'Idempotency-Key': key.current }, body: { title: v.title, description: v.description, priority: v.priority, type: v.type, teamId: Number(v.teamId || writable[0]?.id), dueAt: v.due ? new Date(v.due).toISOString() : null } }),
    onSuccess: (i) => { qc.invalidateQueries({ queryKey: ['items'] }); qc.invalidateQueries({ queryKey: ['summary'] }); toast('ok', `${i.reference} created`); nav(`/items/${i.id}`); },
    onError: (e) => toast('err', (e as ApiError).message),
  });
  const fe = (m.error as ApiError | null)?.details as Record<string, string[]> | undefined;
  return <div className="pad narrow"><h1>New work item</h1>
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="form">
      {fe && <div className="alert err" role="alert">Please fix: {Object.keys(fe).join(', ')}</div>}
      <label>Title<input value={v.title} maxLength={200} onChange={(e) => setV({ ...v, title: e.target.value })} required aria-invalid={!!fe?.title} />{fe?.title && <small className="errtext">{fe.title[0]}</small>}</label>
      <label>Description<textarea rows={5} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></label>
      <div className="grid2"><label>Team<select value={v.teamId || writable[0]?.id || ''} onChange={(e) => setV({ ...v, teamId: e.target.value })}>{writable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>Priority<select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value as Priority })}>{PRIOS.map((p) => <option key={p}>{p}</option>)}</select></label></div>
      <div className="grid2"><label>Type<select value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>Due date<input type="datetime-local" value={v.due} onChange={(e) => setV({ ...v, due: e.target.value })} /></label></div>
      <div className="row end"><Link className="btn" to="/">Cancel</Link><button className="btn primary" disabled={m.isPending || !v.title.trim() || writable.length === 0}>{m.isPending ? 'Creating…' : 'Create'}</button></div>
    </form></div>;
}

const pretty = (v: unknown) => String(v ?? '—').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const describe = (a: Activity) => {
  const pv = a.previous_value, nv = a.new_value; const t = a.event_type;
  if (t === 'CREATED') return 'created this item'; if (t === 'CLAIMED') return 'claimed this item'; if (t === 'COMMENTED') return 'commented';
  if (t === 'APPROVED') return 'approved and resolved this item'; if (t === 'APPROVAL_REJECTED') return 'sent this back for more work';
  if (t === 'STATUS_CHANGED') return `moved status ${pretty(pv)} → ${pretty(nv)}`;
  if (t === 'ASSIGNEE_ID_CHANGED') return nv ? 'reassigned this item' : 'unassigned this item';
  const fmt = t === 'PRIORITY_CHANGED' ? pretty : (x: unknown) => String(x ?? '—');
  return `changed ${t.replace('_CHANGED', '').toLowerCase().replace(/_/g, ' ')}: ${fmt(pv)} → ${fmt(nv)}`;
};

function ItemDetail() {
  const { id } = useParams(); const qc = useQueryClient(); const toast = useToast(); const me = useMe().data!;
  const item = useQuery({ queryKey: ['item', id], queryFn: ({ signal }) => api<Item>(`/items/${id}`, { signal }), retry: (n, e) => !(e instanceof ApiError) && n < 2 });
  const act = useQuery({ queryKey: ['activity', id], queryFn: () => api<{ data: Activity[] }>(`/items/${id}/activity`), enabled: !!item.data });
  const com = useQuery({ queryKey: ['comments', id], queryFn: () => api<{ data: Comment[] }>(`/items/${id}/comments`), enabled: !!item.data });
  const members = useQuery({ queryKey: ['members', item.data?.team_id], queryFn: () => api<{ data: Member[] }>(`/teams/${item.data!.team_id}/members`), enabled: !!item.data });
  const teamsQ = useQuery({ queryKey: ['teams'], queryFn: () => api<{ data: Team[] }>('/teams') });
  const [form, setForm] = useState<{ title: string; description: string; priority: Priority; assigneeId: string } | null>(null);
  const [conflict, setConflict] = useState(false); const [confirm, setConfirm] = useState<Status | null>(null); const [body, setBody] = useState('');
  const i = item.data; const role = me.memberships.find((m) => m.team_id === i?.team_id)?.role;
  const f = form ?? (i ? { title: i.title, description: i.description, priority: i.priority, assigneeId: i.assignee_id ? String(i.assignee_id) : '' } : null);
  const refresh = () => { ['items', 'summary', 'activity'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const run = useMutation({
    mutationFn: ({ fn }: { fn: () => Promise<Item | Comment>; ok: string }) => fn(),
    onSuccess: (r, { ok }) => { if ('version' in r) qc.setQueryData(['item', id], r); setForm(null); setConfirm(null); setConflict(false); refresh(); toast('ok', ok); },
    onError: (e) => {
      const er = e as ApiError; setConfirm(null);
      if (er.code === 'STALE_VERSION') setConflict(true); else toast('err', er.message);
      if (er.status === 409 || er.status === 403) { item.refetch(); refresh(); } // never leave stale state on screen
    },
  });
  if (item.isLoading) return <div className="pad"><Skeleton /></div>;
  if (item.error || !i || !f) return <div className="pad"><ErrorState error={item.error} retry={() => item.refetch()} /></div>;
  const canEdit = atLeast(role, 'MEMBER'); const canClaim = canEdit && !i.assignee_id && (i.status === 'OPEN' || i.status === 'IN_PROGRESS');
  const nextOpts = (Object.entries(NEXT[i.status]) as [Status, 'MEMBER' | 'LEAD'][]).filter(([, r]) => atLeast(role, r));
  const patch = () => run.mutate({ ok: 'Changes saved', fn: () => api<Item>(`/items/${i.id}`, { method: 'PATCH', body: { expectedVersion: i.version, title: f.title, description: f.description, priority: f.priority, ...(atLeast(role, 'LEAD') ? { assigneeId: f.assigneeId ? Number(f.assigneeId) : null } : {}) } }) });
  const assignee = members.data?.data.find((m) => m.id === i.assignee_id)?.name;
  return <div className="pad detail">
    <p className="muted"><Link to="/">Work</Link> / <span className="mono">{i.reference}</span></p>
    <header className="head"><div><h1>{i.title}</h1><div className="row gap"><StatusBadge s={i.status} /><PriorityTag p={i.priority} />{isOverdue(i.due_at, i.status) && <span className="flag">Overdue</span>}{!i.assignee_id && <span className="muted">Unassigned</span>}</div></div>
      <div className="row gap">{canClaim && <button className="btn primary" disabled={run.isPending} onClick={() => run.mutate({ ok: 'You claimed this item', fn: () => api<Item>(`/items/${i.id}/claim`, { method: 'POST' }) })}>Claim</button>}
        {nextOpts.map(([to]) => <button key={to} className={`btn ${to === 'RESOLVED' ? 'primary' : ''}`} disabled={run.isPending} onClick={() => setConfirm(to)}>{i.status === 'AWAITING_APPROVAL' ? (to === 'RESOLVED' ? 'Approve' : 'Request changes') : `Move to ${to.replace(/_/g, ' ').toLowerCase()}`}</button>)}</div></header>
    {!canEdit && <p className="alert warn">You have read-only access to this team.</p>}
    {conflict && <div className="alert err" role="alert">This item was changed by someone else, so your edit was not saved. Your text is still below. <button className="link" onClick={() => { item.refetch(); act.refetch(); setConflict(false); setForm(null); }}>Reload latest (discards your edits)</button></div>}
    <div className="cols"><section>
      <form className="form" onSubmit={(e) => { e.preventDefault(); patch(); }}>
        <label>Title<input value={f.title} disabled={!canEdit} onChange={(e) => setForm({ ...f, title: e.target.value })} /></label>
        <label>Description<textarea rows={6} value={f.description} disabled={!canEdit} onChange={(e) => setForm({ ...f, description: e.target.value })} /></label>
        <div className="grid2"><label>Priority<select value={f.priority} disabled={!canEdit} onChange={(e) => setForm({ ...f, priority: e.target.value as Priority })}>{PRIOS.map((p) => <option key={p}>{p}</option>)}</select></label>
          {atLeast(role, 'LEAD') && <label>Assignee<select value={f.assigneeId} onChange={(e) => setForm({ ...f, assigneeId: e.target.value })}><option value="">Unassigned</option>{members.data?.data.filter((m) => atLeast(m.role, 'MEMBER')).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}</div>
        {canEdit && <div className="row end"><button className="btn primary" disabled={!form || run.isPending || !f.title.trim()}>{run.isPending ? 'Saving…' : 'Save changes'}</button></div>}
      </form>
      <h2>Comments</h2>{com.data?.data.length === 0 && <p className="muted">No comments yet.</p>}
      <ul className="comments">{com.data?.data.map((c) => <li key={c.id}><b>{members.data?.data.find((m) => m.id === c.author_id)?.name ?? 'Member'}</b> <span className="muted small">{ago(c.created_at)}</span><p>{c.body}</p></li>)}</ul>
      {canEdit && <form className="form" onSubmit={(e) => { e.preventDefault(); run.mutate({ ok: 'Comment added', fn: async () => { const r = await api<Comment>(`/items/${i.id}/comments`, { method: 'POST', body: { body } }); setBody(''); qc.invalidateQueries({ queryKey: ['comments', id] }); return r; } }); }}>
        <label>Add a comment<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label><div className="row end"><button className="btn" disabled={!body.trim() || run.isPending}>Comment</button></div></form>}
    </section>
    <aside className="side" aria-label="Item details"><dl><dt>Team</dt><dd>{teamsQ.data?.data.find((t) => t.id === i.team_id)?.name ?? `#${i.team_id}`}</dd><dt>Assignee</dt><dd>{assignee ?? (i.assignee_id ? '—' : 'Unassigned')}</dd><dt>Due</dt><dd>{i.due_at ? new Date(i.due_at).toLocaleString() : '—'}</dd><dt>Created</dt><dd>{new Date(i.created_at).toLocaleString()}</dd><dt>Updated</dt><dd>{ago(i.updated_at)} (v{i.version})</dd></dl>
      <h2>Activity</h2>{act.isLoading ? <Skeleton rows={3} /> : act.error ? <ErrorState error={act.error} retry={() => act.refetch()} /> :
        <ol className="timeline">{act.data!.data.map((a) => <li key={a.id}><b>{a.actor_name}</b> {describe(a)}{a.metadata?.note && <em> — “{a.metadata.note}”</em>}<span className="muted small">{ago(a.created_at)}</span></li>)}</ol>}</aside></div>
    <Confirm open={!!confirm} busy={run.isPending} title={confirm === 'RESOLVED' ? 'Approve and resolve?' : `Move to ${confirm?.replace(/_/g, ' ').toLowerCase()}?`} body={`This changes the status of ${i.reference} and is recorded in its activity history.`}
      onNo={() => setConfirm(null)} onYes={() => confirm && run.mutate({ ok: 'Status updated', fn: () => api<Item>(`/items/${i.id}/transition`, { method: 'POST', body: { to: confirm, expectedVersion: i.version } }) })} />
  </div>;
}

function Teams() {
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api<{ data: Team[] }>('/teams') });
  const [open, setOpen] = useState<number | null>(null);
  const members = useQuery({ queryKey: ['members', open], queryFn: () => api<{ data: Member[] }>(`/teams/${open}/members`), enabled: open !== null });
  const first = useMemo(() => teams.data?.data[0]?.id ?? null, [teams.data]); useEffect(() => { if (open === null && first) setOpen(first); }, [first, open]);
  if (teams.isLoading) return <div className="pad"><Skeleton /></div>; if (teams.error) return <div className="pad"><ErrorState error={teams.error} retry={() => teams.refetch()} /></div>;
  return <div className="pad"><h1>Teams</h1><div className="teams-cols">
    <ul className="teamlist">{teams.data!.data.map((t) => <li key={t.id}><button className={open === t.id ? 'on' : ''} onClick={() => setOpen(t.id)}><b>{t.name}</b><span className="muted small">Your role: {t.role}</span></button></li>)}</ul>
    <section>{members.isLoading ? <Skeleton rows={3} /> : members.error ? <ErrorState error={members.error} /> : <div className="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>{members.data?.data.map((m) => <tr key={m.id}><td>{m.name}</td><td className="muted">{m.email}</td><td>{m.role}</td></tr>)}</tbody></table></div>}</section></div></div>;
}
