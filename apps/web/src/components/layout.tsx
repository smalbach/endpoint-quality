import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth, useCan, useOrganization } from "@/lib/auth";
import { cn } from "@/lib/format";
import type { ProjectSummary } from "@/lib/types";
import { Button } from "@/components/ui";
import { HelpTooltip } from "@/components/overlay";
import { useHelp } from "@/components/help-panel";
import { ImportProvider, useImport } from "@/components/import-provider";
import { EnvironmentButton } from "@/components/environment-button";
import { ForkBadge, ProjectMenu } from "@/components/project-fork-menu";
import { BackendSwitcher } from "@/components/backend-switcher";

/** The menu of the bar across the top, for a signed-in person. */
export const GLOBAL_NAV = [
  { to: "/dashboard", label: "Panel" },
  { to: "/projects", label: "Proyectos" },
  { to: "/history", label: "Historial" },
] as const;

/**
 * The sections of a project, as absolute paths, in the analyzer's order.
 *
 * Absolute on purpose. They were relative once — `to="runs"` — and react-router resolves those
 * against **the route the link is rendered in**, not the URL in the address bar, so three of the
 * original tabs threw you out of the project instead of navigating within it.
 *
 * Exported so there is something to assert about without rendering a router.
 */
export function projectSections(projectId: string | undefined) {
  if (!projectId) return [];
  const base = `/p/${projectId}`;
  return [
    {
      to: base,
      label: "Endpoints",
      help: "endpoints",
      end: true,
      also: [`${base}/matrix`, `${base}/endpoints`],
      tooltip: "Los endpoints del proyecto: lista, editor para probarlos y la matriz del contrato.",
    },
    {
      to: `${base}/roles`,
      label: "Roles",
      help: "roles",
      end: false,
      also: [] as string[],
      tooltip: "Qué roles tiene la API y a qué operación puede llegar cada uno.",
    },
    {
      to: `${base}/security`,
      label: "Test Runs",
      help: "test-runs",
      end: false,
      also: [`${base}/runs`],
      tooltip: "Corridas de seguridad con las 17 reglas, y las corridas de la matriz del contrato.",
    },
    {
      to: `${base}/collections`,
      label: "Colecciones",
      help: "collections",
      end: false,
      also: [] as string[],
      tooltip: "Las colecciones de Postman: su árbol, sus tests y el runner que las corre en orden.",
    },
    {
      to: `${base}/workflows`,
      label: "Flow Testing",
      help: "flow-testing",
      end: false,
      also: [] as string[],
      tooltip: "Flujos de pasos encadenados que se pasan valores, con datos y suites.",
    },
    {
      to: `${base}/performance`,
      label: "Performance",
      help: "performance",
      end: false,
      also: [] as string[],
      tooltip: "Planes de carga (constant/ramp/spike), corridas en vivo, percentiles y umbrales.",
    },
    {
      to: `${base}/code-scan`,
      label: "Escáner",
      help: "code-scan",
      end: false,
      also: [] as string[],
      tooltip: "Escanea el código NestJS (por GitHub o subida), compara con el proyecto e importa.",
    },
    {
      to: `${base}/mocks`,
      label: "Mocks",
      help: "mocks",
      end: false,
      also: [] as string[],
      tooltip: "Una URL que contesta con los ejemplos guardados, para montar el front sin la API.",
    },
    {
      to: `${base}/doc-sites`,
      label: "Docs",
      help: "doc-sites",
      end: false,
      also: [] as string[],
      tooltip: "Publica los endpoints como una página que se puede mandar a otro equipo.",
    },
    {
      to: `${base}/monitors`,
      label: "Monitores",
      help: "monitors",
      end: false,
      also: [] as string[],
      tooltip: "Corridas que se lanzan solas cada tanto y avisan cuando se ponen en rojo.",
    },
    {
      to: `${base}/settings`,
      label: "Settings",
      help: "settings",
      end: false,
      also: [] as string[],
      tooltip: "Nombre del proyecto, contrato, configuración y entornos.",
    },
  ];
}

const SECTION_ICONS: Record<string, string> = {
  Endpoints: "M4 6h16M4 12h16M4 18h10",
  Roles:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  "Test Runs": "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  "Flow Testing": "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9",
  // Una carpeta: lo que una colección es por dentro.
  Colecciones: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z",
  Performance: "M3 3v18h18M7 15l4-6 4 3 5-8",
  Escáner: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  // Un servidor: lo que un mock imita.
  Mocks: "M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3H2zM2 15a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM6 7h.01M6 17h.01",
  // Un documento con renglones: la página que se publica.
  Docs: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
  // Un reloj: lo que un monitor mira.
  Monitores: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  Settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 7 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3.6 15a1.65 1.65 0 0 0-1.51-1H2a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 3.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.34.45.6.82.68H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};

function Icon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      className={cn("size-4 shrink-0", className)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function useProject(projectId: string | undefined) {
  const organization = useOrganization();
  return useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ProjectSummary>(`/orgs/${organization!.id}/projects/${projectId}`),
  });
}

/** The chrome around every signed-in screen: the menu, where you are, the active environment and
 * who you are. */
export function AppLayout() {
  const { user, signOut, selectOrganization } = useAuth();
  const organization = useOrganization();
  const navigate = useNavigate();
  const { projectId } = useParams();
  const project = useProject(projectId);
  const canEdit = useCan("editor");

  return (
    // El provider envuelve **también la cabecera**, y no solo el `Outlet`: el botón «Importar»
    // vive ahí arriba, y dejarlo fuera del contexto es un botón que no hace nada.
    <ImportProvider projectId={projectId}>
      <div className="min-h-dvh bg-slate-50">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex items-center justify-between gap-4 px-6 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <NavLink to="/projects" className="shrink-0 text-sm font-semibold text-slate-900">
                Endpoint Quality
              </NavLink>
              <span className="h-4 w-px bg-slate-200" />
              <nav className="flex items-center gap-0.5">
                {GLOBAL_NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        "rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                        isActive || (item.to === "/projects" && projectId)
                          ? "bg-slate-100 text-slate-900"
                          : "text-slate-500 hover:text-slate-900",
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              {/* «Importar» vive aquí por lo mismo que en Postman está junto a «New»: traer lo que
                ya tienes es de las primeras cosas que se hacen, no pertenece a ninguna pantalla
                concreta, y hasta ahora estaba en un botón fantasma dentro de la barra de un
                proyecto — invisible, y además inexistente en la lista de proyectos. */}
              {canEdit && <ImportButton />}
              {projectId && (
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  <span className="text-slate-300">/</span>
                  <Link
                    to={`/p/${projectId}`}
                    className="truncate font-medium text-slate-700"
                    title={project.data?.name}
                  >
                    {project.data?.name ?? "…"}
                  </Link>
                </div>
              )}
            </div>

            {/* Sin `shrink-0`: era lo que hacía que este lado no cediera nunca y el izquierdo se
              comiera el recorte — con «Importar» partido por la mitad en una ventana de 1024. */}
            <div className="flex min-w-0 items-center gap-3 text-xs text-slate-500">
              {/* Quién contesta, a la vista en todo momento: en una demo con tres backends, una
                  pantalla que no dice con cuál habla no demuestra nada. */}
              <BackendSwitcher />
              {projectId && <EnvironmentButton projectId={projectId} />}
              {/* A switcher only when there is something to switch to. Registering founds an
                organization and accepting an invitation joins another, so two is common. */}
              {user && user.organizations.length > 1 ? (
                <select
                  aria-label="Organización"
                  className="h-7 rounded border border-slate-200 bg-white px-1 text-xs text-slate-600"
                  value={organization?.id ?? ""}
                  onChange={(event) => {
                    selectOrganization(event.target.value);
                    // Out of the project: its id belongs to the organization being left.
                    void navigate("/projects", { replace: true });
                  }}
                >
                  {user.organizations.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <NavLink to="/settings/org" className="whitespace-nowrap underline-offset-2 hover:underline">
                {user && user.organizations.length > 1 ? "ajustes" : organization?.name}
              </NavLink>
              <span className="text-slate-300">·</span>
              <span className="hidden max-w-40 truncate sm:inline">{user?.email}</span>
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => void signOut()}>
                Salir
              </Button>
            </div>
          </div>
        </header>
        <Outlet />
      </div>
    </ImportProvider>
  );
}

/** El botón de la cabecera. Con borde y no fantasma, porque lo de antes se leía como un pie de foto. */
function ImportButton() {
  const { open } = useImport();
  return (
    <button
      onClick={() => open()}
      title="Importar una colección de Postman, un OpenAPI, un entorno o un proyecto exportado (Cmd+O)"
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
    >
      <Icon path="M12 3v12M7 10l5 5 5-5M5 21h14" className="size-3.5" />
      Importar
    </button>
  );
}

/** A screen outside any project: centred, same width as before. */
export function PageLayout() {
  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <Outlet />
    </main>
  );
}

const COLLAPSED_KEY = "eq.sidebar-collapsed";

/**
 * A project: its sidebar, and the section that is open.
 *
 * The sidebar folds to icons and remembers it, because the editors inside — the flow canvas, the
 * permission grid — want every pixel of width and somebody who knows the icons does not need the
 * words.
 */
export function ProjectLayout() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const { openHelp } = useHelp();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage denied: the choice lasts this tab.
    }
  }, [collapsed]);

  const sections = projectSections(projectId);
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-[calc(100dvh-49px)]">
      <aside
        className={cn(
          "sticky top-[49px] flex h-[calc(100dvh-49px)] shrink-0 flex-col border-r border-slate-200 bg-white transition-[width]",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <div className={cn("border-b border-slate-100", collapsed ? "px-2 py-3" : "px-4 py-4")}>
          <button
            onClick={() => void navigate("/projects")}
            title="Todos los proyectos"
            className={cn(
              "flex items-center gap-1.5 rounded-lg text-[11px] font-medium text-slate-500 hover:text-slate-900",
              collapsed && "mx-auto grid size-8 place-items-center hover:bg-slate-50",
            )}
          >
            <Icon path="M19 12H5M12 19l-7-7 7-7" className="size-3.5" />
            {!collapsed && <span>Todos los proyectos</span>}
          </button>
          {!collapsed && (
            <>
              <div className="mt-3 mb-2 h-0.5 w-8 rounded-full bg-slate-900" />
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900" title={project.data?.name}>
                  {project.data?.name ?? "…"}
                </p>
                {project.data && <ProjectMenu project={project.data} />}
              </div>
              {project.data && <ForkBadge project={project.data} />}
              {project.data?.contract ? (
                <p className="mt-0.5 truncate text-[11px] text-slate-500" title={project.data.contract.title}>
                  {project.data.contract.title} <span className="font-mono">v{project.data.contract.version}</span>
                </p>
              ) : (
                project.data && <p className="mt-0.5 text-[11px] text-amber-600">Sin contrato todavía</p>
              )}
            </>
          )}
        </div>

        <nav aria-label="Secciones del proyecto" className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {!collapsed && (
            <p className="px-2 pb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Navegación</p>
          )}
          {sections.map((section) => (
            <div key={section.label} className="flex items-center gap-1">
              <NavLink
                to={section.to}
                end={section.end}
                title={collapsed ? section.label : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors",
                    collapsed && "justify-center",
                    isActive || sectionMatches(section, pathname)
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                  )
                }
              >
                <Icon path={SECTION_ICONS[section.label]} />
                {!collapsed && <span className="flex-1">{section.label}</span>}
              </NavLink>
              {!collapsed && <HelpTooltip content={section.tooltip} side="right" />}
            </div>
          ))}
        </nav>

        <div className={cn("flex items-center border-t border-slate-100 p-2", collapsed ? "flex-col gap-1" : "gap-1")}>
          <button
            onClick={() => openHelp(helpTopicFor(sections, window.location.pathname))}
            title="Ayuda y documentación"
            className={cn(
              "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900",
              collapsed ? "justify-center" : "flex-1",
            )}
          >
            <Icon path="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
            {!collapsed && <span>Ayuda y documentación</span>}
          </button>
          <button
            onClick={() => setCollapsed((current) => !current)}
            title={collapsed ? "Expandir barra lateral" : "Plegar barra lateral"}
            className="grid size-7 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-700"
          >
            <Icon path={collapsed ? "M9 18l6-6-6-6" : "M15 18l-6-6 6-6"} />
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-6 py-6">
        {project.error ? (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(project.error as Error).message}</p>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}

/** Whether a section is the one being looked at, counting the extra addresses it owns. */
export function sectionMatches(section: ReturnType<typeof projectSections>[number], pathname: string): boolean {
  if (section.end ? pathname === section.to : pathname.startsWith(section.to)) return true;
  return section.also.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** The help topic of the section being looked at, so the panel opens on the relevant page. */
export function helpTopicFor(sections: ReturnType<typeof projectSections>, pathname: string): string {
  const match = [...sections]
    .filter((section) => sectionMatches(section, pathname))
    .sort(
      (a, b) => Number(b.also.length > 0 && !b.end) - Number(a.also.length > 0 && !a.end) || b.to.length - a.to.length,
    )[0];
  return match?.help ?? "primeros-pasos";
}
