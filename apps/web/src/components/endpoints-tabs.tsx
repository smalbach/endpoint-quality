import { NavLink } from "react-router-dom";
import { cn } from "@/lib/format";

/**
 * The views of Endpoints: the list with its editor, the matrix the contract generates, and the
 * channels.
 *
 * The matrix used to be the whole section. It stays, one tab away, because the cases it derives
 * from a contract are still the fastest way to know what a run will do tonight.
 *
 * Los canales —WebSocket— van aquí y no en otra sección aunque sean otra tabla: son lo mismo para
 * quien prueba una API, «lo que se le manda», y un canal en otro menú es un canal que nadie
 * encuentra.
 */
export function EndpointsTabs({ projectId }: { projectId: string }) {
  const tabs = [
    { to: `/p/${projectId}`, label: "Lista y editor", end: true },
    { to: `/p/${projectId}/matrix`, label: "Matriz del contrato", end: false },
    { to: `/p/${projectId}/channels`, label: "Canales", end: false },
  ];
  return (
    <div className="mb-4">
      <h1 className="text-base font-semibold text-slate-900">Endpoints</h1>
      <nav className="mt-3 flex gap-1 border-b border-slate-200">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                isActive ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
