/**
 * Who is signed in, and the boot sequence that decides it.
 *
 * On load the app has no access token — it lives in memory and the page just reloaded — but it
 * may still hold a valid refresh cookie. So the first thing it does is **try to refresh**, and
 * only then decide whether to show the login screen. Rendering `/login` before that answer comes
 * back would sign people out on every refresh of the page.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, login as apiLogin, logout as apiLogout, refreshOnce, register as apiRegister } from "./api";
import { atLeast } from "./roles";
import type { CurrentUser, Role } from "./types";

type AuthState = {
  status: "loading" | "authenticated" | "anonymous";
  user: CurrentUser | null;
  /** Which of the user's organizations the app is acting in. */
  organizationId: string | null;
  selectOrganization: (organizationId: string) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; name: string; organizationName?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

const ORGANIZATION_KEY = "eq.organization";

function readStoredOrganization(): string | null {
  try {
    return window.localStorage.getItem(ORGANIZATION_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [user, setUser] = useState<CurrentUser | null>(null);
  /**
   * Which organization the app is acting in.
   *
   * It used to be `organizations[0]`, which is fine right up until somebody belongs to two — and
   * accepting an invitation is exactly how that happens, since registering also founds one. The
   * second organization was then unreachable: no screen could name it and every query keyed off
   * the first.
   *
   * Remembered across reloads because it is a working context, not a preference: coming back to
   * a bookmarked project in the wrong organization is a 404 with no explanation.
   */
  const [organizationId, setOrganizationId] = useState<string | null>(() => readStoredOrganization());

  const load = useCallback(async () => {
    const me = await api<CurrentUser>("/auth/me");
    setUser(me);
    setStatus("authenticated");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const renewed = await refreshOnce();
      if (cancelled) return;
      if (!renewed) {
        setStatus("anonymous");
        return;
      }
      try {
        await load();
      } catch {
        if (!cancelled) setStatus("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  /** The stored choice only counts while it is still one of the user's. Being removed from an
   * organization must not leave the app pointing at it and every request answering 403. */
  const resolved =
    user?.organizations.find((entry) => entry.id === organizationId)?.id ?? user?.organizations[0]?.id ?? null;

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      signIn: async (email, password) => {
        await apiLogin(email, password);
        await load();
      },
      signUp: async (input) => {
        await apiRegister(input);
        await load();
      },
      signOut: async () => {
        await apiLogout();
        setUser(null);
        setStatus("anonymous");
      },
      reload: load,
      organizationId: resolved,
      selectOrganization: (next: string) => {
        setOrganizationId(next);
        try {
          window.localStorage.setItem(ORGANIZATION_KEY, next);
        } catch {
          // Private browsing, or storage denied. The choice still holds for this session.
        }
      },
    }),
    [status, user, load, resolved],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth fuera de AuthProvider");
  return context;
}

/** The organization the app is acting in. Everything below a project hangs off it, so it is
 * resolved once here rather than threaded through every query key. */
/**
 * The organization in context, as a **stable** object.
 *
 * The memo is not a micro-optimisation. Without it this built a new object literal on every
 * render, so anything that put the result in a dependency array had a dependency that changed
 * every time — and the run screen did: its `useEffect` opened an SSE stream, the stream's first
 * event set state, the state re-rendered, the effect re-ran, and it opened another. One tab left
 * on a run made a hundred thousand requests and spent the rest of its life reading 429s.
 *
 * Returning the row itself is not enough either: `user` is replaced wholesale on every refresh of
 * the session, so the identity has to hang off the values that actually decide it.
 */
export function useOrganization(): { id: string; name: string; role: Role } | null {
  const { user, organizationId } = useAuth();
  const organization = user?.organizations.find((entry) => entry.id === organizationId);
  const { id, name, role } = organization ?? {};
  return useMemo(() => (id && name && role ? { id, name, role } : null), [id, name, role]);
}

/** Whether the signed-in member reaches a given rung. The server enforces it; this only decides
 * whether to render a button that would come back 403. The ladder itself lives in `./roles`, once
 * — two copies of it is how «admin» ends up outranking «owner» on one screen and not the other. */
export function useCan(required: Role): boolean {
  return atLeast(useOrganization()?.role, required);
}
