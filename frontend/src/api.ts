import type { Role, Status } from "./types";

const BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8000").replace(/\/$/, "");
export const API_ORIGIN = new URL(BASE).origin;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
let csrfToken: string | undefined;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export const setUnauthorizedHandler = (handler: () => void) => {
  onUnauthorized = handler;
};
export const resetApiClient = () => {
  csrfToken = undefined;
};

type Opts = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch(`${BASE}/api/v1/auth/csrf`, { credentials: "include" });
  if (!response.ok) throw new ApiError(response.status, "CSRF_FAILED", "Could not initialize request protection.");
  const data = await response.json() as { csrfToken: string };
  csrfToken = data.csrfToken;
  return csrfToken;
}

export async function api<T>(path: string, options: Opts = {}): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const queryString = query.toString();
  const method = options.method ?? "GET";
  let response: Response;
  try {
    const csrfHeaders: Record<string, string> = safeMethods.has(method.toUpperCase())
      ? {}
      : { "X-CSRF-Token": await getCsrfToken() };
    response = await fetch(`${BASE}/api/v1${path}${queryString ? `?${queryString}` : ""}`, {
      method,
      signal: options.signal,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "include",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...csrfHeaders,
        ...options.headers,
      },
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "NETWORK", "Cannot reach the API. Check your connection and try again.");
  }

  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") onUnauthorized();
    if (response.status === 403 && data?.error?.code === "CSRF_FAILED") csrfToken = undefined;
    throw new ApiError(
      response.status,
      data?.error?.code ?? "ERROR",
      data?.error?.message ?? "Request failed",
      data?.error?.details,
    );
  }
  return data as T;
}

export type {
  Role,
  Status,
  Priority,
  Item,
  ItemList,
  Me,
  Team,
  Member,
  Activity,
  Comment,
  DashboardSummary,
} from "./types";

const RANK: Record<Role, number> = { VIEWER: 1, MEMBER: 2, LEAD: 3, ADMIN: 4 };
export const atLeast = (role: Role | undefined, minimum: Role) =>
  !!role && RANK[role] >= RANK[minimum];

export const NEXT: Record<Status, Partial<Record<Status, Role>>> = {
  OPEN: { IN_PROGRESS: "MEMBER" },
  IN_PROGRESS: { OPEN: "MEMBER", AWAITING_APPROVAL: "MEMBER" },
  AWAITING_APPROVAL: { RESOLVED: "LEAD", IN_PROGRESS: "LEAD" },
  RESOLVED: { CLOSED: "MEMBER", IN_PROGRESS: "LEAD" },
  CLOSED: {},
};
