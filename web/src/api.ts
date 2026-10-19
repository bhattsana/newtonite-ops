const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000').replace(/\/$/, '');
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };
// Token lives in sessionStorage: readable by any XSS on this origin. See docs/KNOWN_LIMITATIONS.md.
export const getToken = () => sessionStorage.getItem('token');
export const setToken = (t: string | null) => (t ? sessionStorage.setItem('token', t) : sessionStorage.removeItem('token'));
type Opts = { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string>; signal?: AbortSignal };
export async function api<T>(path: string, o: Opts = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
  const q = qs.toString(); const tok = getToken(); let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1${path}${q ? `?${q}` : ''}`, {
      method: o.method ?? 'GET', signal: o.signal, body: o.body ? JSON.stringify(o.body) : undefined,
      headers: { ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...o.headers },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Cannot reach the API. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'Request failed', data?.error?.details);
  }
  return data as T;
}
import type { Role, Status } from '../../shared/types';
export type { Role, Status, Priority, Item, ItemList, Me, Team, Member, Activity, Comment, DashboardSummary } from '../../shared/types';
const RANK: Record<Role, number> = { VIEWER: 1, MEMBER: 2, LEAD: 3, ADMIN: 4 };
export const atLeast = (r: Role | undefined, m: Role) => !!r && RANK[r] >= RANK[m];
// UI hint only. The server owns the real transition rules and permission checks.
export const NEXT: Record<Status, Partial<Record<Status, Role>>> = {
  OPEN: { IN_PROGRESS: 'MEMBER' }, IN_PROGRESS: { OPEN: 'MEMBER', AWAITING_APPROVAL: 'MEMBER' },
  AWAITING_APPROVAL: { RESOLVED: 'LEAD', IN_PROGRESS: 'LEAD' }, RESOLVED: { CLOSED: 'MEMBER', IN_PROGRESS: 'LEAD' }, CLOSED: {},
};
