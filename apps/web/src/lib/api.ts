/**
 * The client for the API, and the only place that knows how a session is held.
 *
 * The access token lives **in memory**, never in `localStorage`. That is the whole reason the
 * refresh token is an httpOnly cookie the SPA cannot read: an XSS on this page can call the API
 * as the user for as long as the tab is open, and it cannot walk away with a thirty-day
 * credential. Storing the access token where script can read it would give back exactly what the
 * cookie was protecting.
 *
 * A 401 triggers **one** refresh, shared by every request that was in flight. Without that, a
 * page that fires six queries on load and finds the token expired sends six refreshes, five of
 * which present a token the first one has already rotated — and the server, correctly, reads
 * that as reuse and closes the session.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.detail || problem.title || `HTTP ${status}`);
    this.name = "ApiError";
  }

  /** The field-level messages, for a form to render next to the input that caused them. */
  get fields(): { field: string; detail: string }[] {
    return this.problem.errors ?? [];
  }
}

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: { field: string; detail: string }[];
};

export type Session = { userId: string; accessToken: string; expiresIn: number };

const BASE = import.meta.env.VITE_API_URL ?? "/api";

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  for (const listener of listeners) listener(token);
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function onAccessTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type RequestOptions = { method?: string; body?: unknown; signal?: AbortSignal; retryOnUnauthorized?: boolean };

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // A form goes as it is: the browser writes the multipart boundary into the Content-Type, and
  // setting the header by hand would send one without it.
  const form = options.body instanceof FormData;
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined || form ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    // Always, because the refresh cookie is the session and a request without it cannot renew.
    credentials: "include",
    ...(options.body === undefined ? {} : { body: form ? (options.body as FormData) : JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 401 && (options.retryOnUnauthorized ?? true)) {
    // Once per expiry, not once per request: the refresh chain treats a replayed token as theft.
    const renewed = await refreshOnce();
    if (renewed) return api<T>(path, { ...options, retryOnUnauthorized: false });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      (parsed as ProblemDetails) ?? { type: "", title: response.statusText, status: response.status, detail: "" },
    );
  }
  return parsed as T;
}

/** The single in-flight refresh. Concurrent callers await the same promise. */
export function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        setAccessToken(null);
        return false;
      }
      const session = (await response.json()) as Session;
      setAccessToken(session.accessToken);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function login(email: string, password: string): Promise<Session> {
  const session = await api<Session>("/auth/login", {
    method: "POST",
    body: { email, password },
    retryOnUnauthorized: false,
  });
  setAccessToken(session.accessToken);
  return session;
}

export async function register(input: {
  email: string;
  password: string;
  name: string;
  organizationName?: string;
}): Promise<void> {
  await api("/auth/register", { method: "POST", body: input, retryOnUnauthorized: false });
  await login(input.email, input.password);
}

export async function logout(): Promise<void> {
  try {
    await api("/auth/logout", { method: "POST", body: {} });
  } finally {
    // Cleared even if the call failed: leaving a token the server has revoked in memory only
    // produces confusing 401s on the next action.
    setAccessToken(null);
  }
}

/**
 * The live stream of a run.
 *
 * `EventSource` cannot send an `Authorization` header, and the access token is deliberately not
 * a cookie — so this uses `fetch` with a streaming body and parses SSE by hand. Twenty lines,
 * against either putting the token in the URL where it lands in every access log, or making the
 * access token a cookie and reopening CSRF on every authenticated route.
 */
export async function streamRun(
  path: string,
  handlers: { onEvent: (event: { type: string; data: unknown }) => void; signal: AbortSignal },
): Promise<void> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "text/event-stream", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    credentials: "include",
    signal: handlers.signal,
  });
  if (!response.ok || !response.body)
    throw new ApiError(response.status, {
      type: "",
      title: "stream",
      status: response.status,
      detail: "No se pudo abrir el stream",
    });

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    // Events are separated by a blank line; a chunk can split one in half, so the tail stays in
    // the buffer until its terminator arrives.
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const type = /^event:\s*(.*)$/m.exec(part)?.[1]?.trim() ?? "message";
      const raw = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!raw) continue;
      try {
        handlers.onEvent({ type, data: JSON.parse(raw) as unknown });
      } catch {
        // A malformed frame is skipped rather than tearing the stream down: the run is still
        // going, and the polling fallback would show the same thing a moment later anyway.
      }
    }
  }
}
