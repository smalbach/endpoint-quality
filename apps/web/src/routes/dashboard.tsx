/**
 * The organization at a glance: one card per project with its health, and a few totals on top.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Card, Empty } from "@/components/ui";
import { cn } from "@/lib/format";
import type { DashboardProjectView, DashboardView } from "@/lib/types";

const scoreColor = (score: number | null) =>
  score == null
    ? "text-slate-400"
    : score >= 80
      ? "text-emerald-600"
      : score >= 50
        ? "text-amber-600"
        : "text-rose-600";

export function DashboardPage() {
  const organization = useOrganization();
  const dashboard = useQuery({
    queryKey: ["dashboard", organization?.id],
    enabled: Boolean(organization),
    queryFn: () => api<DashboardView>(`/orgs/${organization!.id}/dashboard`),
  });

  if (dashboard.isLoading) return <p className="text-sm text-slate-500">Cargando…</p>;
  const data = dashboard.data;
  if (!data) return null;
  const active = data.projects.filter((project) => !project.archived);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Panel</h1>
        <p className="mt-0.5 text-xs text-slate-500">La salud de cada proyecto de la organización, de un vistazo.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Total label="Proyectos" value={String(data.totals.projects)} />
        <Total label="Endpoints" value={String(data.totals.endpoints)} />
        <Total
          label="Score medio"
          value={data.totals.avgSecurityScore == null ? "—" : `${data.totals.avgSecurityScore}`}
          tone={scoreColor(data.totals.avgSecurityScore)}
        />
      </div>

      {active.length === 0 ? (
        <Empty title="Sin proyectos" hint="Crea uno para verlo aquí." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {active.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

function Total({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card className="p-3">
      <p className="text-[10px] tracking-wide text-slate-400 uppercase">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold", tone ?? "text-slate-900")}>{value}</p>
    </Card>
  );
}

function ProjectCard({ project }: { project: DashboardProjectView }) {
  return (
    <Link to={`/p/${project.id}`} className="block">
      <Card className="p-4 transition-colors hover:border-slate-300">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-slate-900">{project.name}</span>
          <span className={cn("text-lg font-semibold", scoreColor(project.securityScore))}>
            {project.securityScore == null ? "—" : project.securityScore}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-y-2 text-xs text-slate-500">
          <Metric label="Endpoints" value={String(project.endpoints)} />
          <Metric label="Flujos" value={String(project.flows)} />
          <Metric
            label="Tasa de paso"
            value={project.passRate == null ? "—" : `${Math.round(project.passRate * 100)}%`}
          />
          <Metric label="p95 carga" value={project.perfP95Ms == null ? "—" : `${Math.round(project.perfP95Ms)} ms`} />
        </div>
      </Card>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[10px] text-slate-400">{label}</span>
      <span className="font-medium text-slate-700">{value}</span>
    </div>
  );
}
