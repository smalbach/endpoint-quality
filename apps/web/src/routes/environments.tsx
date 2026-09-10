import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { formatDate } from "@/lib/format";
import type { Environment } from "@/lib/types";
import { jsonFrom, parseVariables, recordFrom, rowsFrom, type VariableRow } from "@/lib/env-variables";

/**
 * Where a contract is exercised, and with what credentials.
 *
 * The two switches get more explanation than anything else on this screen, because they are the
 * two decisions that can affect a system outside this one. Both start off, and the page says what
 * turning each on means rather than leaving it to a tooltip.
 */
export function EnvironmentsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const canManageCredentials = useCan("admin");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["environments", projectId] });

  return (
    <div className="space-y-4">
      {canEdit && <NewEnvironment base={base} onCreated={invalidate} />}

      {environments.data?.length === 0 && (
        <Empty
          title="Sin entornos"
          hint="Un entorno es una URL base y las credenciales que el motor presenta al llamarla."
        />
      )}

      {environments.data?.map((environment) => (
        <Card key={environment.id} className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-slate-900">{environment.name}</p>
            <span className="font-mono text-[11px] text-slate-500">{environment.baseUrl}</span>
            <span className="ml-auto flex gap-2">
              <Badge
                className={
                  environment.writesAllowed
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-slate-200 bg-slate-50 text-slate-500"
                }
              >
                {environment.writesAllowed ? "escrituras permitidas" : "solo lectura"}
              </Badge>
              <Badge
                className={
                  environment.authEnforced
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-slate-50 text-slate-500"
                }
              >
                {environment.authEnforced ? "aplica autorización" : "sin autorización"}
              </Badge>
            </span>
          </div>

          <p className="mt-2 text-[11px] leading-5 text-slate-500">
            {environment.writesAllowed
              ? "Los POST, PUT, PATCH y DELETE de la matriz se ejecutarán contra este destino."
              : "Los casos no idempotentes no saldrán a la red: quedan marcados como no ejecutados."}{" "}
            {environment.authEnforced
              ? "Los casos 401 y 403 se ejecutan: hacen falta las credenciales primary e insufficient."
              : "Los casos 401 y 403 no se generan: contra un destino que concede todo a todos fallarían por un motivo ajeno al endpoint."}
          </p>

          {canEdit && <EnvironmentSettings base={base} environment={environment} onSaved={invalidate} />}

          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-[11px] font-medium text-slate-600">Credenciales</p>
            {environment.credentials.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-400">Ninguna guardada.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {environment.credentials.map((credential) => (
                  <li key={credential.id} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">{credential.role}</span>
                    <span>{credential.name}</span>
                    <span className="text-slate-400">{credential.kind}</span>
                    {credential.headerName && <span className="font-mono text-slate-400">{credential.headerName}</span>}
                    {/* The secret is never shown, in any form. A product that can display a token
                        you saved last month is a product whose database dump is a set of live
                        credentials. */}
                    <span className="text-slate-300">actualizada {formatDate(credential.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            {canManageCredentials && <CredentialForm base={base} environmentId={environment.id} onSaved={invalidate} />}
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * The environment's own settings: its `{{variables}}`, and the two switches that decide what a run
 * against it is allowed to do.
 *
 * Rows or JSON, because both are the same document and neither is the better editor for every
 * shape: two values are faster as rows, twenty pasted from somewhere else are faster as JSON. The
 * secrets are **not** here — they stay in encrypted credentials, and mixing them into a map that
 * the interface prints would undo that in one render.
 */
function EnvironmentSettings({
  base,
  environment,
  onSaved,
}: {
  base: string;
  environment: Environment;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [asJson, setAsJson] = useState(false);
  const [rows, setRows] = useState<VariableRow[]>(() => rowsFrom(environment.variables));
  const [json, setJson] = useState(() => jsonFrom(rowsFrom(environment.variables)));
  const [error, setError] = useState<string | null>(null);
  const [writesAllowed, setWritesAllowed] = useState(environment.writesAllowed);
  const [authEnforced, setAuthEnforced] = useState(environment.authEnforced);

  // A refetch after saving brings the server's version, which is the one that went through
  // `normalizeVariables` — a trimmed key would otherwise look like a lost keystroke.
  useEffect(() => {
    setRows(rowsFrom(environment.variables));
    setJson(jsonFrom(rowsFrom(environment.variables)));
    setWritesAllowed(environment.writesAllowed);
    setAuthEnforced(environment.authEnforced);
  }, [environment]);

  const save = useMutation({
    mutationFn: () => {
      let variables: Record<string, string>;
      if (asJson) {
        const parsed = parseVariables(json);
        if (!parsed.ok) {
          setError(parsed.error);
          return Promise.reject(new Error(parsed.error));
        }
        variables = recordFrom(parsed.rows);
      } else {
        variables = recordFrom(rows);
      }
      setError(null);
      return api<void>(`${base}/environments/${environment.id}`, {
        method: "PATCH",
        body: { variables, writesAllowed, authEnforced },
      });
    },
    onSuccess: onSaved,
  });

  /** Switching views carries the edits across, in both directions. */
  function switchView() {
    if (!asJson) {
      setJson(jsonFrom(rows));
      setError(null);
      setAsJson(true);
      return;
    }
    const parsed = parseVariables(json);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setRows(parsed.rows);
    setError(null);
    setAsJson(false);
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <button
        className="text-xs font-medium text-slate-700 hover:text-slate-950"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Ocultar configuración" : `Configurar variables (${Object.keys(environment.variables).length})`}
      </button>
      {open && (
        <div className="mt-3 rounded-xl bg-slate-50 p-3">
          <div className="flex items-start justify-between gap-3">
            <p className="max-w-2xl text-[11px] leading-5 text-slate-500">
              Usa <span className="font-mono">{"{{variable}}"}</span> en parámetros, rutas y cuerpos JSON. Las capturas
              de un flujo solo cambian la copia de estas variables durante esa corrida. Los secretos siguen en
              credenciales cifradas y nunca se mezclan aquí.
            </p>
            <Button variant="ghost" className="h-7 px-2 text-xs" onClick={switchView}>
              {asJson ? "Editor visual" : "Editar JSON"}
            </Button>
          </div>
          {asJson ? (
            <textarea
              className={`${inputClass} h-40 font-mono text-xs`}
              value={json}
              onChange={(event) => setJson(event.target.value)}
              spellCheck={false}
            />
          ) : (
            <div className="mt-2 space-y-2">
              {rows.map(([name, value], index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-2">
                  <input
                    aria-label="Nombre de variable"
                    className={inputClass}
                    value={name}
                    placeholder="userId"
                    onChange={(event) =>
                      setRows((items) =>
                        items.map((item, position) => (position === index ? [event.target.value, item[1]] : item)),
                      )
                    }
                  />
                  <input
                    aria-label="Valor de variable"
                    className={inputClass}
                    value={value}
                    placeholder="123"
                    onChange={(event) =>
                      setRows((items) =>
                        items.map((item, position) => (position === index ? [item[0], event.target.value] : item)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    className="mt-1"
                    aria-label="Eliminar variable"
                    onClick={() => setRows((items) => items.filter((_item, position) => position !== index))}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <Button variant="ghost" className="h-8 text-xs" onClick={() => setRows((items) => [...items, ["", ""]])}>
                + Variable
              </Button>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={writesAllowed}
                onChange={(event) => setWritesAllowed(event.target.checked)}
              />{" "}
              Permitir escrituras
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={authEnforced}
                onChange={(event) => setAuthEnforced(event.target.checked)}
              />{" "}
              Ejecutar casos de autorización
            </label>
          </div>
          {(error || save.error) && (
            <p className="mt-2 text-xs text-rose-700">{error ?? (save.error as Error).message}</p>
          )}
          <Button className="mt-3" disabled={save.isPending} onClick={() => save.mutate()}>
            Guardar entorno
          </Button>
        </div>
      )}
    </div>
  );
}

function NewEnvironment({ base, onCreated }: { base: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const create = useMutation({
    mutationFn: () => api(`${base}/environments`, { method: "POST", body: { name, baseUrl } }),
    onSuccess: () => {
      setName("");
      setBaseUrl("");
      onCreated();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Card className="p-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <Field label="Nombre">
          <input
            className={`${inputClass} w-40`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e2e"
            required
          />
        </Field>
        <Field label="URL base" hint="Solo http o https. Se comprueba la dirección resuelta antes de cada petición.">
          <input
            className={`${inputClass} w-80`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.ejemplo.com"
            required
          />
        </Field>
        <Button type="submit" disabled={create.isPending}>
          Añadir
        </Button>
      </form>
      {create.error && (
        <p className="mt-2 text-xs text-rose-700">
          {(create.error as ApiError).fields[0]?.detail ?? (create.error as Error).message}
        </p>
      )}
    </Card>
  );
}

function CredentialForm({
  base,
  environmentId,
  onSaved,
}: {
  base: string;
  environmentId: string;
  onSaved: () => void;
}) {
  const [role, setRole] = useState("primary");
  const [kind, setKind] = useState("bearer");
  const [headerName, setHeaderName] = useState("");
  const [secret, setSecret] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api(`${base}/environments/${environmentId}/credentials`, {
        method: "PUT",
        body: { name: role, role, kind, secret, ...(kind === "api_key" ? { headerName } : {}) },
      }),
    onSuccess: () => {
      setSecret("");
      onSaved();
    },
  });

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label className="text-[11px] text-slate-600">
        Rol
        <select
          className="mt-1 block h-8 rounded-lg border border-slate-200 px-2 text-xs"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="primary">primary · la credencial que funciona</option>
          <option value="insufficient">insufficient · autentica y no alcanza el scope (el 403)</option>
          <option value="alternate">alternate · un esquema que la operación no declara (el 401)</option>
        </select>
      </label>
      <label className="text-[11px] text-slate-600">
        Tipo
        <select
          className="mt-1 block h-8 rounded-lg border border-slate-200 px-2 text-xs"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="bearer">bearer</option>
          <option value="api_key">api_key</option>
          <option value="basic">basic</option>
        </select>
      </label>
      {kind === "api_key" && (
        <label className="text-[11px] text-slate-600">
          Cabecera
          <input
            className="mt-1 block h-8 w-40 rounded-lg border border-slate-200 px-2 text-xs"
            value={headerName}
            onChange={(event) => setHeaderName(event.target.value)}
            placeholder="X-API-Key"
          />
        </label>
      )}
      <label className="text-[11px] text-slate-600">
        Secreto
        <input
          className="mt-1 block h-8 w-64 rounded-lg border border-slate-200 px-2 text-xs"
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          required
        />
      </label>
      <Button variant="ghost" className="h-8" type="submit" disabled={save.isPending || !secret}>
        Guardar
      </Button>
      {save.error && (
        <p className="w-full text-xs text-rose-700">
          {(save.error as ApiError).fields[0]?.detail ?? (save.error as Error).message}
        </p>
      )}
    </form>
  );
}
