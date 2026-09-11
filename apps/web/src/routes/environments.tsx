import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiError } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { cn, formatDate } from "@/lib/format";
import type { ConfigView, Environment } from "@/lib/types";
import { VariablesEditor } from "@/components/variables-editor";
import { credentialRoleOptions, declaredRoles, mapsFrom, problemsWith, rowsFrom } from "@/lib/env-variables";

/**
 * Where a contract is exercised, and with what.
 *
 * One environment at a time, picked from a rail — the shape Postman settled on, and for the same
 * reason: the variables are the part people come here to edit, they are a table, and a table
 * folded into an accordion inside a stacked card is a table nobody scrolls to. Everything else on
 * the screen belongs to whichever environment is selected.
 */
export function EnvironmentsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const queryClient = useQueryClient();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });

  /**
   * The roles this project declared, so a credential can be created for one.
   *
   * Read here and not in the form, because the form is drawn once per environment and the answer
   * is the project's. Its own query rather than a field on the environment: «esta API tiene estos
   * roles» is true of the project, and putting it on every environment would be the same fact
   * repeated and free to disagree with itself.
   */
  const config = useQuery({
    queryKey: ["config", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ConfigView>(`${base}/config`),
  });
  const roles = useMemo(() => declaredRoles(config.data?.sections.access?.data), [config.data]);

  const list = useMemo(() => environments.data ?? [], [environments.data]);
  // The selection survives a refetch and follows a deletion. Left alone it would point at a row
  // that is gone and the pane would render nothing with no way back.
  useEffect(() => {
    if (list.length === 0) setSelected(null);
    else if (!list.some((environment) => environment.id === selected)) setSelected(list[0].id);
  }, [list, selected]);

  const current = list.find((environment) => environment.id === selected) ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["environments", projectId] });

  if (list.length === 0 && !creating) {
    return (
      <Empty
        title="Sin entornos"
        hint="Un entorno es una URL base, las variables que se sustituyen al llamarla y las credenciales que se presentan."
        action={canEdit ? <Button onClick={() => setCreating(true)}>Nuevo entorno</Button> : undefined}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Entornos</p>
          {canEdit && (
            <button
              className="text-xs font-medium text-slate-600 hover:text-slate-950"
              onClick={() => setCreating(true)}
            >
              + Nuevo
            </button>
          )}
        </div>
        {creating && (
          <NewEnvironment
            base={base}
            onDone={(environmentId) => {
              setCreating(false);
              if (environmentId) setSelected(environmentId);
              void invalidate();
            }}
          />
        )}
        <nav className="space-y-1">
          {list.map((environment) => (
            <button
              key={environment.id}
              onClick={() => setSelected(environment.id)}
              className={cn(
                "block w-full rounded-xl border px-3 py-2 text-left transition-colors",
                environment.id === selected
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
              )}
            >
              <span className="block truncate text-sm font-medium">{environment.name}</span>
              <span
                className={cn(
                  "mt-0.5 block truncate font-mono text-[11px]",
                  environment.id === selected ? "text-slate-300" : "text-slate-400",
                )}
              >
                {environment.baseUrl}
              </span>
              <span
                className={cn(
                  "mt-1 block text-[11px]",
                  environment.id === selected ? "text-slate-400" : "text-slate-400",
                )}
              >
                {Object.keys(environment.variables).length} variables
                {Object.keys(environment.disabledVariables).length > 0 &&
                  ` · ${Object.keys(environment.disabledVariables).length} apagadas`}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {current && (
        <EnvironmentDetail key={current.id} base={base} environment={current} roles={roles} onSaved={invalidate} />
      )}
    </div>
  );
}

/**
 * One environment, whole.
 *
 * Everything is a draft until «Guardar»: the name, the URL, the table and the two switches go in
 * a single `PATCH`, and until then the bar at the bottom says there are unsaved changes. Saving
 * field by field as you type is what makes an environment editor feel like it is fighting you —
 * half a URL is a valid string and would be stored as one.
 */
function EnvironmentDetail({
  base,
  environment,
  roles,
  onSaved,
}: {
  base: string;
  environment: Environment;
  /** The roles this project declared. Passed down rather than fetched here: it is the project's
   * answer, and this component is drawn once per environment. */
  roles: string[];
  onSaved: () => void;
}) {
  const canEdit = useCan("editor");
  const canManageCredentials = useCan("admin");
  const saved = useMemo(
    () => ({
      name: environment.name,
      baseUrl: environment.baseUrl,
      specUrl: environment.specUrl ?? "",
      writesAllowed: environment.writesAllowed,
      authEnforced: environment.authEnforced,
      rows: rowsFrom(environment.variables, environment.disabledVariables),
    }),
    [environment],
  );
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);

  // A refetch brings the server's version, which is the one that went through `normalizeVariables`
  // and `normalizeBaseUrl` — a trimmed key or a dropped trailing slash would otherwise look like a
  // lost keystroke.
  useEffect(() => setDraft(saved), [saved]);

  const problems = problemsWith(draft.rows);
  const dirty =
    JSON.stringify({ ...draft, rows: draft.rows.filter((row) => row.name.trim()) }) !==
    JSON.stringify({ ...saved, rows: saved.rows.filter((row) => row.name.trim()) });

  const save = useMutation({
    mutationFn: () => {
      setError(null);
      return api<void>(`${base}/environments/${environment.id}`, {
        method: "PATCH",
        body: {
          name: draft.name.trim(),
          baseUrl: draft.baseUrl.trim(),
          specUrl: draft.specUrl.trim() || null,
          writesAllowed: draft.writesAllowed,
          authEnforced: draft.authEnforced,
          ...mapsFrom(draft.rows),
        },
      });
    },
    onSuccess: onSaved,
    onError: (caught: ApiError) => setError(caught.fields?.[0]?.detail ?? caught.message),
  });

  const remove = useMutation({
    mutationFn: () => api<void>(`${base}/environments/${environment.id}`, { method: "DELETE" }),
    onSuccess: onSaved,
  });

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Nombre">
          <input
            className={`${inputClass} w-44`}
            value={draft.name}
            disabled={!canEdit}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
          />
        </Field>
        <Field label="URL base" hint="Solo http o https. Se comprueba la dirección resuelta antes de cada petición.">
          <input
            className={`${inputClass} w-96 font-mono text-xs`}
            value={draft.baseUrl}
            disabled={!canEdit}
            onChange={(event) => setDraft((value) => ({ ...value, baseUrl: event.target.value }))}
          />
        </Field>
        <Field label="URL del OpenAPI" hint="Vacío significa ${baseUrl}/openapi.json.">
          <input
            className={`${inputClass} w-72 font-mono text-xs`}
            value={draft.specUrl}
            disabled={!canEdit}
            placeholder="(por defecto)"
            onChange={(event) => setDraft((value) => ({ ...value, specUrl: event.target.value }))}
          />
        </Field>
      </div>

      <div className="mt-5">
        <VariablesEditor
          rows={draft.rows}
          problems={problems}
          disabled={!canEdit}
          onChange={(rows) => setDraft((value) => ({ ...value, rows }))}
          // Only for `admin`, and by *absence* rather than a disabled button: reading somebody's
          // staging token is not a thing the interface should offer and then refuse.
          onReveal={
            canManageCredentials
              ? () => api<Record<string, string>>(`${base}/environments/${environment.id}/variables/reveal`)
              : undefined
          }
        />
      </div>

      <div className="mt-5 border-t border-slate-100 pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Permisos de la corrida</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Switch
            checked={draft.writesAllowed}
            disabled={!canEdit}
            onChange={(checked) => setDraft((value) => ({ ...value, writesAllowed: checked }))}
            label="Permitir escrituras"
            badge={
              <Badge
                className={
                  draft.writesAllowed
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-slate-200 bg-slate-50 text-slate-500"
                }
              >
                {draft.writesAllowed ? "escrituras permitidas" : "solo lectura"}
              </Badge>
            }
            hint={
              draft.writesAllowed
                ? "Los POST, PUT, PATCH y DELETE de la matriz se ejecutarán contra este destino."
                : "Los casos no idempotentes no saldrán a la red: quedan marcados como no ejecutados."
            }
          />
          <Switch
            checked={draft.authEnforced}
            disabled={!canEdit}
            onChange={(checked) => setDraft((value) => ({ ...value, authEnforced: checked }))}
            label="Ejecutar casos de autorización"
            badge={
              <Badge
                className={
                  draft.authEnforced
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-slate-50 text-slate-500"
                }
              >
                {draft.authEnforced ? "aplica autorización" : "sin autorización"}
              </Badge>
            }
            hint={
              draft.authEnforced
                ? "Los casos 401 y 403 se ejecutan: hacen falta las credenciales primary e insufficient."
                : "Los casos 401 y 403 no se generan: contra un destino que concede todo a todos fallarían por un motivo ajeno al endpoint."
            }
          />
        </div>
      </div>

      <Credentials
        base={base}
        environment={environment}
        roles={roles}
        canManage={canManageCredentials}
        onSaved={onSaved}
      />

      {canEdit && (
        <div className="sticky bottom-0 -mx-4 -mb-4 mt-5 flex flex-wrap items-center gap-3 rounded-b-2xl border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
          <Button disabled={!dirty || problems.length > 0 || save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
          <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
            Descartar
          </Button>
          <span className="text-xs text-slate-500">
            {problems.length > 0 ? "Hay variables con problemas" : dirty ? "Cambios sin guardar" : "Todo guardado"}
          </span>
          <button
            className="ml-auto text-xs text-rose-600 hover:text-rose-700"
            onClick={() => {
              if (window.confirm(`¿Eliminar «${environment.name}» y sus credenciales?`)) remove.mutate();
            }}
          >
            Eliminar entorno
          </button>
          {(error || remove.error) && (
            <p className="w-full text-xs text-rose-700">{error ?? (remove.error as Error).message}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
  label,
  hint,
  badge,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  label: string;
  hint: string;
  badge: React.ReactNode;
}) {
  return (
    <label className="block rounded-xl border border-slate-200 p-3">
      <span className="flex items-center gap-2">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="text-xs font-medium text-slate-700">{label}</span>
        <span className="ml-auto">{badge}</span>
      </span>
      <span className="mt-2 block text-[11px] leading-5 text-slate-500">{hint}</span>
    </label>
  );
}

function Credentials({
  base,
  environment,
  roles,
  canManage,
  onSaved,
}: {
  base: string;
  environment: Environment;
  /** The roles this project declared, beside the three the engine reserves. */
  roles: string[];
  canManage: boolean;
  onSaved: () => void;
}) {
  // A declared role with no credential here is a permission case that cannot run: it stops as
  // `config`, which is correct and says nothing about the endpoint. Named now rather than
  // discovered in a run, because this is the screen where it is fixed.
  const missing = roles.filter((role) => !environment.credentials.some((credential) => credential.role === role));
  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Credenciales</p>
      <p className="mt-1 text-[11px] text-slate-500">
        Lo que el motor presenta al destino. Una credencial se guarda cifrada y no vuelve nunca, en ninguna forma; una
        variable marcada como secreta se guarda igual de cifrada, pero se puede revelar, porque hay que poder comprobar
        lo que vale. Un token va aquí.
      </p>
      {environment.credentials.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-400">Ninguna guardada.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {environment.credentials.map((credential) => (
            <li key={credential.id} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">{credential.role}</span>
              <span>{credential.name}</span>
              <span className="text-slate-400">{credential.kind}</span>
              {credential.headerName && <span className="font-mono text-slate-400">{credential.headerName}</span>}
              {/* The secret is never shown, in any form. A product that can display a token you
                  saved last month is a product whose database dump is a set of live credentials. */}
              <span className="text-slate-300">actualizada {formatDate(credential.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-700">
          Faltan las de {missing.join(", ")}: sin ellas, los casos de permisos de esos roles se quedan en «config».
        </p>
      )}
      {canManage && <CredentialForm base={base} environmentId={environment.id} roles={roles} onSaved={onSaved} />}
    </div>
  );
}

function NewEnvironment({ base, onDone }: { base: string; onDone: (environmentId?: string) => void }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api<{ environmentId: string }>(`${base}/environments`, { method: "POST", body: { name, baseUrl } }),
    onSuccess: (created) => onDone(created?.environmentId),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <Card className="p-3">
      <form className="space-y-2" onSubmit={submit}>
        <Field label="Nombre">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e2e"
            autoFocus
            required
          />
        </Field>
        <Field label="URL base">
          <input
            className={`${inputClass} font-mono text-xs`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.ejemplo.com"
            required
          />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" className="h-8 text-xs" disabled={create.isPending}>
            Crear
          </Button>
          <Button type="button" variant="ghost" className="h-8 text-xs" onClick={() => onDone()}>
            Cancelar
          </Button>
        </div>
      </form>
      {create.error && (
        <p className="mt-2 text-xs text-rose-700">
          {(create.error as ApiError).fields[0]?.detail ?? (create.error as Error).message}
        </p>
      )}
    </Card>
  );
}

/** What the three reserved names are for, said next to each one. A declared role needs no hint:
 * whoever wrote it down knows what it is. */
const RESERVED_ROLE_HINT: Record<string, string> = {
  primary: " · la credencial que funciona",
  insufficient: " · autentica y no alcanza el scope (el 403)",
  alternate: " · un esquema que la operación no declara (el 401)",
};

function CredentialForm({
  base,
  environmentId,
  roles,
  onSaved,
}: {
  base: string;
  environmentId: string;
  roles: string[];
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
          {credentialRoleOptions(roles).map((option) => (
            <option key={option} value={option}>
              {option}
              {RESERVED_ROLE_HINT[option] ?? " · un rol de este proyecto"}
            </option>
          ))}
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
