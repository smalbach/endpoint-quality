import { NavLink, Outlet, useParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/format";
import { Button } from "@/components/ui";

/**
 * The tabs of a project, as absolute paths.
 *
 * They were relative — `to="runs"` — which react-router resolves against **the route the link is
 * rendered in**, not against the URL in the address bar. This layout is mounted at `/`, not under
 * `p/:projectId`, so every tab pointed at `/runs`, `/config`, `/environments`; those match no
 * route, fall through to the catch-all, and redirect to the project list. Three of the four tabs
 * silently did nothing but throw you out of the project you were in.
 *
 * It survived P5 because the screens were reached by the buttons that navigate with a full path —
 * launching a run goes straight to its detail — and nobody clicked the tabs.
 *
 * Exported so there is something to assert about without rendering a router.
 */
export function projectTabs(projectId: string | undefined) {
  if (!projectId) return [];
  const base = `/p/${projectId}`;
  return [
    { to: base, label: "Matriz", end: true },
    { to: `${base}/environments`, label: "Entornos", end: false },
    { to: `${base}/config`, label: "Configuración", end: false },
    { to: `${base}/runs`, label: "Corridas", end: false },
  ];
}

/** The chrome around every signed-in screen: who you are, which organization, and the tabs of
 * the project you are inside. The tabs disappear outside a project rather than pointing at one
 * that is not selected. */
export function AppLayout() {
  const { user, signOut } = useAuth();
  const { projectId } = useParams();

  const tabs = projectTabs(projectId);

  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <NavLink to="/" className="text-sm font-semibold text-slate-900">
            Endpoint Quality
          </NavLink>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <NavLink to="/settings/org" className="underline-offset-2 hover:underline">
              {user?.organizations[0]?.name}
            </NavLink>
            <span className="text-slate-300">·</span>
            <span>{user?.email}</span>
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => void signOut()}>
              Salir
            </Button>
          </div>
        </div>
        {projectId && (
          <nav className="mx-auto flex max-w-7xl gap-1 px-6">
            {tabs.map((tab) => (
              <NavLink
                key={tab.label}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  cn("border-b-2 px-3 py-2 text-xs font-medium transition-colors", isActive ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800")
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
