import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Card } from "@/components/ui";
import { SectionEditor } from "@/routes/config";
import { declaredRoles } from "@/lib/env-variables";
import { cn } from "@/lib/format";
import type { ConfigView, Environment, ProjectSummary } from "@/lib/types";

/**
 * The roles of the API and what each one may reach.
 *
 * Its own section, as in the analyzer, because «who can do what» is the question a security
 * review opens with and it was buried as the ninth accordion of the configuration. The data is the
 * same `access` section — one source, edited from here — and the credentials that make a role
 * runnable stay on each environment, which is where a token belongs.
 */
export function RolesPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId);

  const project = useQuery({
    queryKey: ["project", projectId],
    enabled,
    queryFn: () => api<ProjectSummary>(base),
  });
  const config = useQuery({
    queryKey: ["config", projectId],
    enabled,
    queryFn: () => api<ConfigView>(`${base}/config`),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled,
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const operationIds = useQuery({
    queryKey: ["operation-ids", projectId, project.data?.contract?.versionId],
    enabled: enabled && Boolean(project.data?.contract),
    queryFn: async () =>
      (await api<{ operations: { id: string }[] }>(`${base}/operations`)).operations.map((operation) => operation.id),
  });

  const access = config.data?.sections.access;
  const roles = useMemo(() => declaredRoles(access?.data), [access]);
  const envList = environments.data ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h1 className="text-base font-semibold text-slate-900">Roles</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
          Declara los roles de la API y decide, por operación, cuáles deben pasar y cuáles deben recibir un rechazo.
          Cada celda decidida es un caso. La credencial de cada rol se guarda en cada entorno.
        </p>
      </Card>

      {roles.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Credenciales por entorno</p>
            <Link
              to={`/p/${projectId}/settings/environments`}
              className="text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
            >
              Gestionar entornos
            </Link>
          </div>
          {envList.length === 0 ? (
            <p className="px-4 py-3 text-xs text-slate-500">
              Sin entornos todavía: un rol no se puede ejercitar hasta que un entorno tenga su credencial.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-100 text-[11px] text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Rol</th>
                    {envList.map((environment) => (
                      <th key={environment.id} className="px-4 py-2 font-medium">
                        {environment.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {roles.map((role) => (
                    <tr key={role}>
                      <td className="px-4 py-2 font-mono text-slate-800">{role}</td>
                      {envList.map((environment) => {
                        const has = environment.credentials.some((credential) => credential.role === role);
                        return (
                          <td key={environment.id} className="px-4 py-2">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                has ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
                              )}
                            >
                              {has ? "con credencial" : "sin credencial"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {config.isLoading && <p className="text-sm text-slate-500">Cargando…</p>}
      {access && (
        <SectionEditor
          base={base}
          section="access"
          title="Permisos"
          defaultOpen
          data={access}
          disabled={!canEdit}
          operationIds={operationIds.data ?? []}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ["config", projectId] })}
        />
      )}
    </div>
  );
}
