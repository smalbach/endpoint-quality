/**
 * «Acceso por rol» inside the endpoint editor: every role of the project against this endpoint.
 *
 * Saved on its own button, not with the endpoint: it is another resource with its own permission
 * rows, and a failed permission save must not make the endpoint's own save look failed.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { ACCESS_LABEL, SCOPE_LABEL } from "@/lib/role-permissions";
import { Button } from "@/components/ui";
import { useToast } from "@/components/toast";
import type { DataScope, EndpointRoleAccessView, RoleAccess } from "@/lib/types";

export function EndpointRoleAccess({
  base,
  projectId,
  endpointId,
  operationId,
  canEdit,
}: {
  base: string;
  projectId: string;
  endpointId: string | null;
  operationId: string | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const access = useQuery({
    queryKey: ["role-access", projectId, endpointId],
    enabled: Boolean(endpointId),
    queryFn: () => api<{ roles: EndpointRoleAccessView[] }>(`${base}/endpoints/${endpointId}/role-access`),
  });
  const saved = useMemo(() => access.data?.roles ?? [], [access.data]);
  const [draft, setDraft] = useState<EndpointRoleAccessView[]>([]);
  useEffect(() => setDraft(saved), [saved]);

  const changes = draft.filter((row) => {
    const before = saved.find((entry) => entry.roleId === row.roleId);
    return (
      before && (before.access !== row.access || (row.access !== "undecided" && before.dataScope !== row.dataScope))
    );
  });

  const save = useMutation({
    mutationFn: () =>
      api(`${base}/endpoints/${endpointId}/role-access`, {
        method: "PUT",
        body: { permissions: changes.map(({ roleId, access, dataScope }) => ({ roleId, access, dataScope })) },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["role-access", projectId, endpointId] }),
        queryClient.invalidateQueries({ queryKey: ["roles", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["config", projectId] }),
      ]);
      toast.success("Permisos por rol guardados");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const edit = (roleId: string, patch: { access?: RoleAccess; dataScope?: DataScope }) =>
    setDraft((rows) => rows.map((row) => (row.roleId === roleId ? { ...row, ...patch } : row)));

  if (!endpointId)
    return <p className="text-[11px] text-slate-400">Guarda el endpoint para decidir qué roles lo alcanzan.</p>;
  if (access.isLoading) return <p className="text-[11px] text-slate-400">Cargando roles…</p>;
  if (!saved.length)
    return (
      <p className="text-[11px] text-slate-500">
        Este proyecto no tiene roles.{" "}
        <Link to={`/p/${projectId}/roles`} className="underline underline-offset-2">
          Créalos en Roles
        </Link>
        .
      </p>
    );

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <div className="grid grid-cols-[minmax(0,1fr)_9rem_9rem] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
          <span>Rol</span>
          <span>Acceso</span>
          <span>Datos</span>
        </div>
        {draft.map((row) => (
          <div
            key={row.roleId}
            className="grid grid-cols-[minmax(0,1fr)_9rem_9rem] items-center gap-2 border-b border-slate-100 px-3 py-1.5 last:border-b-0"
          >
            <span className="flex min-w-0 items-center gap-2 text-xs text-slate-800">
              <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
              <span className="truncate font-mono">{row.name}</span>
            </span>
            <select
              aria-label={`Acceso de ${row.name}`}
              className={cn(
                "h-7 rounded-md border border-slate-200 bg-white px-1 text-[11px]",
                row.access === "allow" && "text-emerald-700",
                row.access === "deny" && "text-rose-700",
              )}
              value={row.access}
              disabled={!canEdit}
              onChange={(event) => edit(row.roleId, { access: event.target.value as RoleAccess })}
            >
              {(["undecided", "allow", "deny"] as const).map((value) => (
                <option key={value} value={value}>
                  {ACCESS_LABEL[value]}
                </option>
              ))}
            </select>
            <select
              aria-label={`Datos de ${row.name}`}
              className="h-7 rounded-md border border-slate-200 bg-white px-1 text-[11px] disabled:text-slate-300"
              value={row.dataScope}
              disabled={!canEdit || row.access !== "allow"}
              onChange={(event) => edit(row.roleId, { dataScope: event.target.value as DataScope })}
            >
              {(["all", "own", "none"] as const).map((value) => (
                <option key={value} value={value}>
                  {SCOPE_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        «Sin decidir» no genera ningún caso.{" "}
        {operationId ? (
          <>
            Permitido y denegado se convierten en casos de la matriz del contrato para{" "}
            <span className="font-mono">{operationId}</span>.
          </>
        ) : (
          "Este endpoint no está en el contrato: el permiso queda guardado para las pruebas de seguridad."
        )}
      </p>
      {canEdit && (
        <div className="mt-2 flex items-center gap-2">
          <Button className="h-8 text-xs" disabled={!changes.length || save.isPending} onClick={() => save.mutate()}>
            Guardar permisos
          </Button>
          {changes.length > 0 && (
            <>
              <Button variant="ghost" className="h-8 text-xs" onClick={() => setDraft(saved)}>
                Descartar
              </Button>
              <span className="text-[11px] text-slate-500">
                {changes.length} {changes.length === 1 ? "cambio" : "cambios"}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
