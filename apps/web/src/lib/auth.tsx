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
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; name: string; organizationName?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [user, setUser] = useState<CurrentUser | null>(null);

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
    }),
    [status, user, load],
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
export function useOrganization(): { id: string; name: string; role: Role } | null {
  const { user } = useAuth();
  const organization = user?.organizations[0];
  return organization ? { id: organization.id, name: organization.name, role: organization.role } : null;
}

/** Whether the signed-in member reaches a given rung. The server enforces it; this only decides
 * whether to render a button that would come back 403. The ladder itself lives in `./roles`, once
 * — two copies of it is how «admin» ends up outranking «owner» on one screen and not the other. */
export function useCan(required: Role): boolean {
  return atLeast(useOrganization()?.role, required);
}
