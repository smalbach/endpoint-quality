/**
 * The two kinds of run under «Test Runs»: the security matrix and the contract matrix.
 *
 * The analyzer's Test Runs was only the security run; here the contract runs already existed, so the
 * section holds both and a tab strip says which one is on screen.
 */
import { NavLink } from "react-router-dom";

import { cn } from "@/lib/format";

export function RunsTabs({ projectId }: { projectId: string }) {
  const tabs = [
    { to: `/p/${projectId}/security`, label: "Seguridad", end: false },
    { to: `/p/${projectId}/runs`, label: "Contrato", end: false },
  ];
  return (
    <div className="mb-4 flex gap-1 border-b border-slate-200">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              isActive ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-800",
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </div>
  );
}
