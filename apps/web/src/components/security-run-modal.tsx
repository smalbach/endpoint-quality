/**
 * «Nueva corrida de seguridad»: qué reglas, contra qué endpoints, con qué ajustes.
 *
 * No pide credenciales — las de cada rol viven en el entorno (Roles → credenciales). El modal solo
 * elige entorno, alcance, reglas y ajustes, y avisa de qué roles no tienen credencial, que es la
 * pregunta que de verdad decide qué se puede probar.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/format";
import { Button, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import {
  buildEndpointTree,
  endpointIdsOf,
  selectionState,
  toggleGroup,
  type EndpointFolder,
} from "@/lib/endpoint-tree";
import { DEFAULT_RULES, PRESETS, RULE_GROUPS, RULE_LABEL, type RuleKey } from "@/lib/security-runs";
import type { EndpointPage, Environment, RoleView } from "@/lib/types";

type Row = { id: string; method: string; path: string };

export function SecurityRunModal({
  base,
  projectId,
  onClose,
  onStarted,
}: {
  base: string;
  projectId: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const roles = useQuery({ queryKey: ["roles", projectId], queryFn: () => api<RoleView[]>(`${base}/roles`) });
  const endpoints = useQuery({
    queryKey: ["endpoints", projectId, "all", "", 1, "security"],
    queryFn: () => api<EndpointPage>(`${base}/endpoints?status=active&limit=500`),
  });

  const envList = environments.data ?? [];
  const active = envList.find((environment) => environment.active) ?? envList[0];
  const [environmentId, setEnvironmentId] = useState<string>("");
  const chosenEnv = envList.find((environment) => environment.id === (environmentId || active?.id));

  const [label, setLabel] = useState("");
  const [rules, setRules] = useState<Record<RuleKey, boolean>>(DEFAULT_RULES);
  const [rateLimitIterations, setRateLimitIterations] = useState(20);
  const [crossUser, setCrossUser] = useState(false);
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows: Row[] = (endpoints.data?.data ?? []).map((endpoint) => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
  }));
  const tree = useMemo(() => buildEndpointTree(rows), [rows]);
  const selectedCount = Object.values(rules).filter(Boolean).length;
  const rolesWithCredential = new Set((chosenEnv?.credentials ?? []).map((credential) => credential.role));
  const missingRoles = (roles.data ?? []).filter((role) => !rolesWithCredential.has(role.name));

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`${base}/security-runs`, {
        method: "POST",
        body: {
          environmentId: environmentId || active?.id,
          label: label.trim() || undefined,
          rules,
          rateLimitIterations,
          crossUserPermutations: crossUser,
          ...(scope === "selected" ? { endpointIds: [...selected] } : {}),
        },
      }),
    onSuccess: (result) => onStarted(result.runId),
  });

  const setRule = (key: RuleKey, value: boolean) => setRules((current) => ({ ...current, [key]: value }));
  const canStart = Boolean(environmentId || active?.id) && selectedCount > 0 && (scope === "all" || selected.size > 0);

  return (
    <Modal
      title="Nueva corrida de seguridad"
      description="Envía la matriz de ataques contra el entorno y clasifica lo que encuentra por severidad."
      size="xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!canStart || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? "Lanzando…" : "Lanzar corrida"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-slate-600">
            Entorno
            <select
              className={cn(inputClass, "mt-1 h-8 py-1 text-xs")}
              value={environmentId || active?.id || ""}
              onChange={(event) => setEnvironmentId(event.target.value)}
            >
              {envList.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                  {environment.authEnforced ? "" : " · sin autorización"}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-48 flex-1 text-xs text-slate-600">
            Etiqueta <span className="text-slate-400">(opcional)</span>
            <input
              className={cn(inputClass, "mt-1 h-8 py-1 text-xs")}
              value={label}
              placeholder="Antes del despliegue"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </div>

        {chosenEnv && !chosenEnv.authEnforced && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
            Este entorno no aplica autorización: los casos de permisos (BOLA, BFLA, entre usuarios) no se juzgan, porque
            un 200 no diría nada del endpoint. Actívalo en Settings → Entornos para probarlos.
          </p>
        )}
        {missingRoles.length > 0 && (
          <p className="text-[11px] text-slate-500">
            Sin credencial en este entorno: {missingRoles.map((role) => role.name).join(", ")}. Sus casos por rol no
            saldrán.{" "}
            <Link
              to={`/p/${projectId}/settings/environments`}
              onClick={onClose}
              className="underline underline-offset-2"
            >
              Añadirlas
            </Link>
            .
          </p>
        )}

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Reglas ({selectedCount}/17)
            </p>
            <span className="ml-auto flex flex-wrap gap-1">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-slate-400 hover:text-slate-800"
                  onClick={() => setRules(preset.rules)}
                >
                  {preset.label}
                </button>
              ))}
              <button
                className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-slate-400"
                onClick={() =>
                  setRules(
                    Object.fromEntries(Object.keys(rules).map((key) => [key, false])) as Record<RuleKey, boolean>,
                  )
                }
              >
                Ninguna
              </button>
            </span>
          </div>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {RULE_GROUPS.map((group) => (
              <div key={group.title} className="rounded-lg border border-slate-200 p-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group.title}</p>
                {group.keys.map((key) => (
                  <label key={key} className="flex items-center gap-2 py-0.5 text-[11px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={rules[key]}
                      onChange={(event) => setRule(key, event.target.checked)}
                    />
                    {RULE_LABEL[key]}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[11px] text-slate-700">
            <input type="checkbox" checked={crossUser} onChange={(event) => setCrossUser(event.target.checked)} />
            Permutaciones entre usuarios (más lento)
          </label>
          {rules.rate_limit && (
            <label className="flex items-center gap-2 text-[11px] text-slate-700">
              Iteraciones del límite
              <input
                type="number"
                min={5}
                max={50}
                className="h-7 w-16 rounded-md border border-slate-200 px-2 text-xs"
                value={rateLimitIterations}
                onChange={(event) => setRateLimitIterations(Number(event.target.value))}
              />
            </label>
          )}
        </div>

        <div>
          <div className="flex items-center gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Alcance</p>
            <label className="flex items-center gap-1 text-[11px] text-slate-700">
              <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> Todos los endpoints
              activos
            </label>
            <label className="flex items-center gap-1 text-[11px] text-slate-700">
              <input type="radio" checked={scope === "selected"} onChange={() => setScope("selected")} /> Elegidos
              {scope === "selected" && ` (${selected.size})`}
            </label>
          </div>
          {scope === "selected" && (
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-slate-200">
              {tree.map((folder) => (
                <ScopeFolder key={folder.id} folder={folder} selected={selected} onChange={setSelected} depth={0} />
              ))}
            </div>
          )}
        </div>

        {start.error && (
          <p className="text-xs text-rose-700">
            {start.error instanceof ApiError
              ? (start.error.fields[0]?.detail ?? start.error.message)
              : (start.error as Error).message}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ScopeFolder({
  folder,
  selected,
  onChange,
  depth,
}: {
  folder: EndpointFolder<Row>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  depth: number;
}) {
  const ids = endpointIdsOf(folder);
  const state = selectionState(ids, selected);
  return (
    <div>
      <label
        className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/60 py-1 pr-2 text-[11px] font-medium text-slate-600"
        style={{ paddingLeft: `${0.5 + depth}rem` }}
      >
        <input
          type="checkbox"
          ref={(node) => {
            if (node) node.indeterminate = state === "partial";
          }}
          checked={state === "all"}
          onChange={() => onChange(toggleGroup(ids, selected))}
        />
        {folder.label} <span className="text-slate-400">{ids.length}</span>
      </label>
      {folder.folders.map((child) => (
        <ScopeFolder key={child.id} folder={child} selected={selected} onChange={onChange} depth={depth + 1} />
      ))}
      {folder.endpoints.map((endpoint) => (
        <label
          key={endpoint.id}
          className="flex items-center gap-2 border-b border-slate-50 py-1 pr-2 text-[11px] text-slate-700 last:border-b-0"
          style={{ paddingLeft: `${1.25 + depth}rem` }}
        >
          <input
            type="checkbox"
            checked={selected.has(endpoint.id)}
            onChange={() => {
              const next = new Set(selected);
              if (next.has(endpoint.id)) next.delete(endpoint.id);
              else next.add(endpoint.id);
              onChange(next);
            }}
          />
          <span className="font-mono">{endpoint.method}</span>
          <span className="truncate">{endpoint.path}</span>
        </label>
      ))}
    </div>
  );
}
