/**
 * The endpoint editor: a request, «Enviar», and what came back — the analyzer's editor in this
 * product's style.
 *
 * Differences worth knowing, all deliberate:
 * - **what is on screen is what is saved**: body type, form fields, path parameter values and
 *   switched-off rows survive a reload. A chosen file does not — only its field name.
 * - **«Enviar» sends the form as it is**, saved or not, and a new endpoint can be tried before it
 *   exists.
 * - **the credential is explicit**: inherit the project's, none, or a token for this request only.
 * - **unsaved changes are marked**, `Ctrl+S` saves and `Ctrl+Enter` sends.
 * - scripts run on «Enviar», each in a process of its own; «Consola» shows what they printed and tested,
 *   with every secret masked.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { useSessionToken } from "@/lib/session-token";
import { EndpointRoleAccess } from "@/components/endpoint-role-access";
import { Badge, Button, inputClass } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { AuthEditor } from "@/components/auth-editor";
import { CookieManager, CookiePanel } from "@/components/cookie-manager";
import { VariableSuggest } from "@/components/variable-suggest";
import { cn, formatBytes, formatDuration, httpStatusStyle, methodStyle } from "@/lib/format";
import {
  EMPTY_BODY,
  METHODS,
  NEW_ENDPOINT,
  NO_FILES,
  draftFrom,
  endpointCurl,
  fileProblem,
  isDirty,
  missingFiles,
  prettyBody,
  resolvedParts,
  savePayload,
  sendForm,
  variablesOf,
  withPath,
  type ChosenFiles,
  type EndpointDraft,
  type SendAuth,
} from "@/lib/endpoint-draft";
import type {
  EndpointBodyMode,
  EndpointFormFieldView,
  EndpointMethod,
  EndpointView,
  Environment,
  ProjectSummary,
  ScriptRunView,
  SentRequestView,
  SessionTokenView,
} from "@/lib/types";

const TABS = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "auth", label: "Auth" },
  { id: "scripts", label: "Scripts" },
  { id: "access", label: "Acceso" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const BODY_MODES: { value: EndpointBodyMode; label: string }[] = [
  { value: "none", label: "none" },
  { value: "json", label: "JSON" },
  { value: "raw", label: "raw" },
  { value: "form-data", label: "form-data" },
  { value: "x-www-form-urlencoded", label: "x-www-form-urlencoded" },
  { value: "binary", label: "binary" },
];

const PARAMETER_TYPES = ["string", "number", "boolean", "uuid", "array"] as const;

export function EndpointEditor({
  base,
  projectId,
  endpointId,
  layout,
  canEdit,
  onSaved,
  onDirtyChange,
  onOpenFull,
}: {
  base: string;
  projectId: string;
  /** `null` is a new endpoint. */
  endpointId: string | null;
  layout: "inline" | "full";
  canEdit: boolean;
  onSaved: (endpoint: EndpointView, created: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenFull?: () => void;
}) {
  const organization = useOrganization();
  const toast = useToast();
  const queryClient = useQueryClient();

  const endpoint = useQuery({
    queryKey: ["endpoint", projectId, endpointId],
    enabled: Boolean(organization && endpointId),
    queryFn: () => api<EndpointView>(`${base}/endpoints/${endpointId}`),
  });
  const project = useQuery({
    queryKey: ["project", projectId],
    enabled: Boolean(organization),
    queryFn: () => api<ProjectSummary>(base),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization),
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const [storedEnvironment, setActiveEnvironment] = useActiveEnvironment(projectId);
  const environment = resolveActive(storedEnvironment, environments.data ?? []);
  const variables = useMemo(() => variablesOf(environment), [environment]);
  const variableNames = useMemo(() => Object.keys(variables).sort(), [variables]);
  const sessionToken = useSessionToken(projectId);

  const [draft, setDraft] = useState<EndpointDraft>(NEW_ENDPOINT);
  const [saved, setSaved] = useState<EndpointDraft | null>(null);

  const [files, setFiles] = useState<ChosenFiles>(NO_FILES);
  const [tab, setTab] = useState<Tab>("params");
  const [showCurl, setShowCurl] = useState(false);
  const [showCookies, setShowCookies] = useState(false);

  // The loaded row becomes the draft once. Refetches after a save must not overwrite typing.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !endpoint.data) return;
    loaded.current = true;
    const next = draftFrom(endpoint.data);
    setDraft(next);
    setSaved(next);
  }, [endpoint.data]);

  const dirty = canEdit && (endpointId ? saved !== null && isDirty(draft, saved) : isDirty(draft, NEW_ENDPOINT));
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => onDirtyRef.current?.(dirty), [dirty]);

  const save = useMutation({
    mutationFn: () =>
      endpointId
        ? api<EndpointView>(`${base}/endpoints/${endpointId}`, { method: "PATCH", body: savePayload(draft) })
        : api<EndpointView>(`${base}/endpoints`, { method: "POST", body: savePayload(draft) }),
    onSuccess: async (view) => {
      const next = draftFrom(view);
      setDraft(next);
      setSaved(next);
      queryClient.setQueryData(["endpoint", projectId, view.id], view);
      await queryClient.invalidateQueries({ queryKey: ["endpoints", projectId] });
      toast.success(endpointId ? "Endpoint guardado" : "Endpoint creado");
      onSaved(view, !endpointId);
    },
  });

  const missing = missingFiles(draft.body, files);
  const send = useMutation({
    mutationFn: () =>
      api<SentRequestView>(`${base}/endpoints/send`, {
        method: "POST",
        body: sendForm(draft, environment?.id ?? null, files),
      }),
    onSuccess: async (result) => {
      // What the scripts wrote is already stored; the bar and the variable suggestions catch up.
      const updated = [
        ...(result.scripts.pre?.environmentUpdates ?? []),
        ...(result.scripts.post?.environmentUpdates ?? []),
      ];
      if (updated.length) await queryClient.invalidateQueries({ queryKey: ["environments", projectId] });
      if (result.sessionToken) {
        await queryClient.invalidateQueries({ queryKey: ["session-token", projectId] });
        toast.success(
          result.sessionToken === "login"
            ? "Token de sesión capturado del login"
            : "Token de sesión capturado por el script",
        );
      }
    },
  });

  const canSend = canEdit && draft.path.trim().length > 0 && missing.length === 0 && !send.isPending;
  const keyHandlers = useRef({ save: () => {}, send: () => {} });
  keyHandlers.current = {
    save: () => {
      if (dirty && !save.isPending) save.mutate();
    },
    send: () => {
      if (canSend) send.mutate();
    },
  };

  if (endpointId && endpoint.isLoading) return <p className="p-4 text-sm text-slate-500">Cargando endpoint…</p>;
  if (endpointId && endpoint.error)
    return <p className="m-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{endpoint.error.message}</p>;

  const set = (patch: Partial<EndpointDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const saveFields = save.error instanceof ApiError ? save.error.fields : [];
  const fieldError = (field: string) => saveFields.find((entry) => entry.field === field)?.detail;
  const parts = resolvedParts(draft.path, variables);
  const baseUrl = environment?.baseUrl || project.data?.baseUrl || "";

  const request = (
    <div className="min-w-0">
      <div className="flex border-b border-slate-200">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs font-medium",
              tab === entry.id
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {entry.label}
            {entry.id === "params" && draft.query.filter((row) => row.enabled && row.name).length > 0 && (
              <span className="ml-1 text-slate-400">{draft.query.filter((row) => row.enabled && row.name).length}</span>
            )}
            {entry.id === "headers" && draft.headers.filter((row) => row.enabled && row.name).length > 0 && (
              <span className="ml-1 text-slate-400">
                {draft.headers.filter((row) => row.enabled && row.name).length}
              </span>
            )}
            {entry.id === "body" && draft.body.mode !== "none" && <span className="ml-1 text-slate-400">•</span>}
          </button>
        ))}
      </div>

      <div className="py-3">
        {tab === "params" && (
          <div className="space-y-4">
            <Section title="Parámetros de ruta" hint="Salen de los {nombre} de la ruta. Admiten {{variables}}.">
              {draft.pathParameters.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  La ruta no tiene parámetros. Escribe /users/{"{id}"} o /users/:id.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  {draft.pathParameters.map((parameter, index) => (
                    <div
                      key={parameter.name}
                      className="grid grid-cols-[8rem_6rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1 border-b border-slate-100 px-2 py-1 last:border-b-0"
                    >
                      <span className="truncate font-mono text-[11px] text-slate-700">{`{${parameter.name}}`}</span>
                      <select
                        aria-label={`Tipo de ${parameter.name}`}
                        className="h-7 rounded-md border border-slate-200 bg-white px-1 text-[11px]"
                        value={parameter.type}
                        disabled={!canEdit}
                        onChange={(event) =>
                          set({
                            pathParameters: draft.pathParameters.map((row, position) =>
                              position === index ? { ...row, type: event.target.value as typeof row.type } : row,
                            ),
                          })
                        }
                      >
                        {PARAMETER_TYPES.map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                      <CellInput
                        label={`Valor de ${parameter.name}`}
                        value={parameter.value}
                        placeholder="valor o {{variable}}"
                        variables={variableNames}
                        disabled={!canEdit}
                        onChange={(value) =>
                          set({
                            pathParameters: draft.pathParameters.map((row, position) =>
                              position === index ? { ...row, value } : row,
                            ),
                          })
                        }
                      />
                      <CellInput
                        label={`Descripción de ${parameter.name}`}
                        value={parameter.description}
                        placeholder="descripción"
                        disabled={!canEdit}
                        onChange={(description) =>
                          set({
                            pathParameters: draft.pathParameters.map((row, position) =>
                              position === index ? { ...row, description } : row,
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </Section>
            <Section title="Query">
              <RowsEditor
                rows={draft.query}
                columns={["value", "description"]}
                variables={variableNames}
                disabled={!canEdit}
                blank={{ name: "", value: "", enabled: true, type: "string", required: false, description: "" }}
                onChange={(query) => set({ query })}
              />
            </Section>
          </div>
        )}

        {tab === "headers" && (
          <Section title="Cabeceras" hint="Una Authorization escrita aquí gana a la de la pestaña Auth.">
            <RowsEditor
              rows={draft.headers}
              columns={["value"]}
              variables={variableNames}
              disabled={!canEdit}
              blank={{ name: "", value: "", enabled: true }}
              onChange={(headers) => set({ headers })}
              problem={(row) => (/[\r\n]/.test(row.value) ? "Una cabecera no lleva saltos de línea" : null)}
            />
          </Section>
        )}

        {tab === "body" && (
          <BodyTab
            draft={draft}
            set={set}
            files={files}
            setFiles={setFiles}
            variables={variableNames}
            disabled={!canEdit}
          />
        )}

        {tab === "auth" && (
          <AuthTab
            auth={draft.auth}
            setAuth={(next) => setDraft({ ...draft, auth: next })}
            project={project.data}
            environment={environment}
            variables={variableNames}
            sessionToken={sessionToken.data ?? null}
            disabled={!canEdit}
          />
        )}

        {tab === "scripts" && (
          <div className="space-y-3">
            <ScriptReference />
            <ScriptField
              label="Pre-request"
              snippets={PRE_SNIPPETS}
              value={draft.preRequestScript}
              disabled={!canEdit}
              placeholder={"// Antes de la petición\n// pm.environment.set('timestamp', Date.now().toString());"}
              onChange={(preRequestScript) => set({ preRequestScript })}
            />
            <ScriptField
              label="Post-response"
              snippets={POST_SNIPPETS}
              value={draft.postResponseScript}
              disabled={!canEdit}
              placeholder={
                "// Después de la respuesta\n// const body = pm.response.json();\n// pm.environment.set('token', body.token);"
              }
              onChange={(postResponseScript) => set({ postResponseScript })}
            />
          </div>
        )}

        {tab === "access" && (
          <div className="space-y-4">
            <Section title="Visibilidad">
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { value: false, label: "Público", hint: "No pide autenticación" },
                  { value: true, label: "Autenticado", hint: "Pide un token válido" },
                ].map((option) => (
                  <button
                    key={option.label}
                    disabled={!canEdit}
                    onClick={() => set({ requiresAuth: option.value })}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left",
                      draft.requiresAuth === option.value
                        ? option.value
                          ? "border-sky-300 bg-sky-50"
                          : "border-emerald-300 bg-emerald-50"
                        : "border-slate-200 hover:bg-slate-50",
                    )}
                  >
                    <p className="text-xs font-semibold text-slate-800">{option.label}</p>
                    <p className="text-[11px] text-slate-500">{option.hint}</p>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                {draft.requiresAuth
                  ? "Las pruebas de seguridad marcarán este endpoint si responde 2xx sin autenticación."
                  : "Es público: una respuesta 2xx sin autenticación no se marcará."}
              </p>
            </Section>
            <Section title="Estado y etiquetas">
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                <select
                  aria-label="Estado"
                  className={cn(inputClass, "mt-0 h-8 py-1 text-xs")}
                  value={draft.status}
                  disabled={!canEdit}
                  onChange={(event) => set({ status: event.target.value as EndpointDraft["status"] })}
                >
                  <option value="active">Activo</option>
                  <option value="inactive">Inactivo</option>
                  <option value="archived">Archivado</option>
                </select>
                <input
                  aria-label="Etiquetas"
                  className={cn(inputClass, "mt-0 h-8 py-1 text-xs")}
                  placeholder="etiquetas, separadas, por comas"
                  value={draft.tags}
                  disabled={!canEdit}
                  onChange={(event) => set({ tags: event.target.value })}
                />
              </div>
            </Section>
            <Section title="Acceso por rol">
              <EndpointRoleAccess
                base={base}
                projectId={projectId}
                endpointId={endpointId}
                operationId={endpoint.data?.operationId ?? null}
                canEdit={canEdit}
              />
            </Section>
          </div>
        )}
      </div>
    </div>
  );

  const response = <ResponsePanel send={send} />;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        if (event.key === "s") {
          event.preventDefault();
          keyHandlers.current.save();
        } else if (event.key === "Enter") {
          event.preventDefault();
          keyHandlers.current.send();
        }
      }}
    >
      <div className="space-y-2 border-b border-slate-200 pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Método"
            className={cn("h-9 rounded-lg border px-2 font-mono text-xs font-bold", methodStyle(draft.method))}
            value={draft.method}
            disabled={!canEdit}
            onChange={(event) => set({ method: event.target.value as EndpointMethod })}
          >
            {METHODS.map((method) => (
              <option key={method}>{method}</option>
            ))}
          </select>
          <div className="min-w-48 flex-1">
            <VariableSuggest
              variables={variableNames}
              value={draft.path}
              onChange={(path) => setDraft((current) => withPath(current, path))}
            >
              {(suggest) => (
                <input
                  {...suggest}
                  aria-label="Ruta"
                  className="h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs outline-none focus:border-slate-900"
                  placeholder="/api/recurso/{id}"
                  disabled={!canEdit}
                  spellCheck={false}
                />
              )}
            </VariableSuggest>
          </div>
          <Button className="h-9 px-4 text-xs" disabled={!canSend} onClick={() => send.mutate()} title="Ctrl+Enter">
            {send.isPending ? "Enviando…" : "Enviar"}
          </Button>
          <Button variant="ghost" className="h-9 px-3 text-xs" onClick={() => setShowCurl(true)}>
            cURL
          </Button>
          {/* Como en Postman, al lado de «Enviar»: es donde se mira cuando algo contesta 401. */}
          <Button variant="ghost" className="h-9 px-3 text-xs" onClick={() => setShowCookies(true)}>
            Cookies
          </Button>
          {canEdit && (
            <Button
              variant="ghost"
              className="relative h-9 px-3 text-xs"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate()}
              title="Ctrl+S"
            >
              {dirty && (
                <span
                  className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500"
                  aria-label="Cambios sin guardar"
                />
              )}
              {save.isPending ? "Guardando…" : endpointId ? "Guardar" : "Crear"}
            </Button>
          )}
          {onOpenFull && endpointId && (
            <button
              title="Abrir a pantalla completa"
              aria-label="Abrir a pantalla completa"
              className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-800"
              onClick={onOpenFull}
            >
              <svg
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>
          )}
        </div>

        {parts.some((part) => part.kind !== "literal") && (
          <p className="flex flex-wrap items-center gap-0.5 font-mono text-[11px]">
            <span className="mr-1 font-sans text-slate-400">Resuelta:</span>
            {parts.map((part, index) => (
              <span
                key={index}
                className={cn(
                  part.kind === "literal" && "text-slate-500",
                  part.kind === "known" && "rounded bg-amber-50 px-1 text-amber-800",
                  part.kind === "secret" && "rounded bg-slate-100 px-1 text-slate-600",
                  part.kind === "unknown" && "rounded bg-rose-50 px-1 text-rose-700",
                )}
                title={part.kind === "unknown" ? "No está definida en el entorno activo" : undefined}
              >
                {part.text}
              </span>
            ))}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Descripción"
            className="h-8 min-w-48 flex-1 rounded-lg border border-slate-200 px-3 text-xs outline-none focus:border-slate-900"
            placeholder="Descripción (opcional)"
            value={draft.description}
            disabled={!canEdit}
            onChange={(event) => set({ description: event.target.value })}
          />
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            Entorno
            <select
              aria-label="Entorno"
              className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-700"
              value={environment?.id ?? ""}
              disabled={!environments.data?.length}
              onChange={(event) => setActiveEnvironment(event.target.value || null)}
            >
              {!environments.data?.length && <option value="">Sin entornos · URL base del proyecto</option>}
              {environments.data?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!baseUrl && !/^https?:\/\//i.test(draft.path) && (
          <p className="text-[11px] text-amber-700">
            No hay URL base: ponla en el entorno o en Settings del proyecto para poder enviar.
          </p>
        )}
        {missing.length > 0 && (
          <p className="text-[11px] text-amber-700">Falta elegir el fichero de: {missing.join(", ")}.</p>
        )}
        {save.error && (
          <p className="text-[11px] text-rose-600">
            {save.error.message}
            {saveFields.length > 0 && `: ${saveFields.map((entry) => `${entry.field} — ${entry.detail}`).join("; ")}`}
          </p>
        )}
        {fieldError("path") && <p className="text-[11px] text-rose-600">{fieldError("path")}</p>}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto", layout === "full" ? "grid gap-6 pt-1 lg:grid-cols-2" : "")}>
        {request}
        <div className={cn(layout === "inline" && "border-t border-slate-200 pt-3")}>{response}</div>
      </div>

      {showCurl && (
        <CurlModal
          command={endpointCurl(draft, { baseUrl, variables, files })}
          onClose={() => setShowCurl(false)}
        />
      )}
      {showCookies && (
        <CookieManager projectId={projectId} baseUrl={baseUrl} onClose={() => setShowCookies(false)} />
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-700">{title}</p>
      {hint && <p className="mb-1 text-[10px] text-slate-400">{hint}</p>}
      <div className={hint ? "" : "mt-1"}>{children}</div>
    </div>
  );
}

function CellInput({
  label,
  value,
  onChange,
  placeholder,
  variables,
  disabled,
  mono = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  variables?: string[];
  disabled?: boolean;
  mono?: boolean;
}) {
  const className = cn(
    "h-7 w-full rounded-md border-0 bg-transparent px-1.5 text-[11px] outline-none focus:bg-slate-50",
    mono && "font-mono",
  );
  if (!variables) {
    return (
      <input
        aria-label={label}
        className={className}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <VariableSuggest variables={variables} value={value} onChange={onChange}>
      {(suggest) => (
        <input
          {...suggest}
          aria-label={label}
          className={className}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
        />
      )}
    </VariableSuggest>
  );
}

type Row = { name: string; value: string; enabled: boolean; description?: string };

/** Rows with a switch each and a blank row at the bottom that becomes a row when typed in. */
function RowsEditor<T extends Row>({
  rows,
  columns,
  blank,
  onChange,
  variables,
  disabled,
  problem,
}: {
  rows: T[];
  columns: ("value" | "description")[];
  blank: T;
  onChange: (rows: T[]) => void;
  variables: string[];
  disabled: boolean;
  problem?: (row: T) => string | null;
}) {
  const shown = rows.length && !rows[rows.length - 1].name && !rows[rows.length - 1].value ? rows : [...rows, blank];
  const edit = (index: number, patch: Partial<T>) => {
    const next = shown.map((row, position) => (position === index ? { ...row, ...patch } : row));
    onChange(next.filter((row, position) => position < next.length - 1 || row.name || row.value));
  };
  const template =
    columns.length === 2
      ? "grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_1.25rem]"
      : "grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1.4fr)_1.25rem]";

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      {shown.map((row, index) => {
        const ghost = index === shown.length - 1 && !row.name && !row.value;
        const issue = !ghost && problem?.(row);
        return (
          <div key={index} className="border-b border-slate-100 last:border-b-0">
            <div className={cn("grid items-center gap-1 px-1 py-0.5", template)}>
              <input
                type="checkbox"
                className="justify-self-center"
                aria-label={`Enviar ${row.name || "fila"}`}
                checked={row.enabled}
                disabled={disabled || ghost}
                onChange={(event) => edit(index, { enabled: event.target.checked } as Partial<T>)}
              />
              <CellInput
                label="Nombre"
                value={row.name}
                placeholder={ghost ? "nombre" : ""}
                disabled={disabled}
                onChange={(name) => edit(index, { name } as Partial<T>)}
              />
              <CellInput
                label={`Valor de ${row.name || "fila"}`}
                value={row.value}
                placeholder={ghost ? "valor" : ""}
                variables={variables}
                disabled={disabled}
                onChange={(value) => edit(index, { value } as Partial<T>)}
              />
              {columns.includes("description") && (
                <CellInput
                  label={`Descripción de ${row.name || "fila"}`}
                  value={row.description ?? ""}
                  placeholder={ghost ? "descripción" : ""}
                  mono={false}
                  disabled={disabled}
                  onChange={(description) => edit(index, { description } as Partial<T>)}
                />
              )}
              {!ghost && !disabled ? (
                <button
                  aria-label={`Eliminar ${row.name || "fila"}`}
                  className="text-slate-400 hover:text-rose-600"
                  onClick={() =>
                    onChange(
                      shown.filter(
                        (_row, position) =>
                          position !== index && (position < shown.length - 1 || _row.name || _row.value),
                      ),
                    )
                  }
                >
                  ×
                </button>
              ) : (
                <span />
              )}
            </div>
            {issue && <p className="px-1 pb-1 pl-8 text-[10px] text-rose-600">{issue}</p>}
          </div>
        );
      })}
    </div>
  );
}

function BodyTab({
  draft,
  set,
  files,
  setFiles,
  variables,
  disabled,
}: {
  draft: EndpointDraft;
  set: (patch: Partial<EndpointDraft>) => void;
  files: ChosenFiles;
  setFiles: (files: ChosenFiles) => void;
  variables: string[];
  disabled: boolean;
}) {
  const toast = useToast();
  const body = draft.body ?? EMPTY_BODY;
  const setBody = (patch: Partial<typeof body>) => set({ body: { ...body, ...patch } });
  const jsonProblem = useMemo(() => {
    if (body.mode !== "json" || !body.text.trim()) return null;
    try {
      // Variables are placeholders until sent: `{"id": {{id}}}` is valid once substituted.
      JSON.parse(body.text.replace(/\{\{[^}]+\}\}/g, "0"));
      return null;
    } catch {
      return "No parece JSON válido";
    }
  }, [body.mode, body.text]);

  const choose = (file: File | undefined, apply: (file: File) => void) => {
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) toast.error(`${file.name}: ${problem}`);
    else apply(file);
  };

  const fields = body.fields;
  const setFields = (next: EndpointFormFieldView[]) => setBody({ fields: next });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {BODY_MODES.map((mode) => (
          <button
            key={mode.value}
            disabled={disabled}
            onClick={() => setBody({ mode: mode.value })}
            className={cn(
              "rounded-md px-2 py-1 font-mono text-[11px]",
              body.mode === mode.value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {body.mode === "none" && <p className="text-[11px] text-slate-500">Esta petición no lleva cuerpo.</p>}

      {(body.mode === "json" || body.mode === "raw") && (
        <div>
          {body.mode === "raw" ? (
            <input
              aria-label="Content-Type"
              className="mb-1 h-7 w-full rounded-md border border-slate-200 px-2 font-mono text-[11px] outline-none focus:border-slate-900"
              value={body.contentType}
              list="eq-endpoint-content-types"
              disabled={disabled}
              onChange={(event) => setBody({ contentType: event.target.value })}
            />
          ) : (
            <p className="mb-1 text-[10px] text-slate-400">Content-Type: application/json · admite {"{{variables}}"}</p>
          )}
          <datalist id="eq-endpoint-content-types">
            {["text/plain", "application/xml", "text/csv", "text/html", "application/x-ndjson"].map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <VariableSuggest variables={variables} value={body.text} onChange={(text) => setBody({ text })}>
            {(suggest) => (
              <textarea
                {...suggest}
                aria-label="Cuerpo"
                className="h-56 w-full rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100 outline-none focus:border-slate-900"
                placeholder={body.mode === "json" ? '{\n  "clave": "{{variable}}"\n}' : "<pedido>…</pedido>"}
                disabled={disabled}
                spellCheck={false}
              />
            )}
          </VariableSuggest>
          {jsonProblem && <p className="text-[11px] text-amber-700">{jsonProblem}</p>}
        </div>
      )}

      {body.mode === "x-www-form-urlencoded" && (
        <RowsEditor
          rows={fields.filter((field) => field.kind === "text")}
          columns={["value"]}
          variables={variables}
          disabled={disabled}
          blank={{ name: "", value: "", enabled: true, kind: "text" }}
          onChange={(next) => setFields([...next, ...fields.filter((field) => field.kind === "file")])}
        />
      )}

      {body.mode === "form-data" && (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_5rem_minmax(0,1.4fr)_1.25rem] gap-1 border-b border-slate-100 bg-slate-50 px-1 py-1 text-[10px] font-medium text-slate-500">
            <span />
            <span>Clave</span>
            <span>Tipo</span>
            <span>Valor</span>
            <span />
          </div>
          {[...fields, { name: "", value: "", kind: "text" as const, enabled: true }].map((field, index) => {
            const ghost = index === fields.length;
            const update = (patch: Partial<EndpointFormFieldView>) => {
              const next = ghost
                ? [...fields, { ...field, ...patch }]
                : fields.map((row, position) => (position === index ? { ...row, ...patch } : row));
              setFields(next);
            };
            const file = files.fields[field.name];
            return (
              <div
                key={index}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)_5rem_minmax(0,1.4fr)_1.25rem] items-center gap-1 border-b border-slate-100 px-1 py-0.5 last:border-b-0"
              >
                <input
                  type="checkbox"
                  className="justify-self-center"
                  aria-label={`Enviar ${field.name || "campo"}`}
                  checked={field.enabled}
                  disabled={disabled || ghost}
                  onChange={(event) => update({ enabled: event.target.checked })}
                />
                <CellInput
                  label="Clave"
                  value={field.name}
                  placeholder={ghost ? "clave" : ""}
                  disabled={disabled}
                  onChange={(name) => update({ name })}
                />
                <select
                  aria-label={`Tipo de ${field.name || "campo"}`}
                  className="h-7 rounded-md border border-slate-200 bg-white px-1 text-[11px]"
                  value={field.kind}
                  disabled={disabled}
                  onChange={(event) => update({ kind: event.target.value as "text" | "file", value: "" })}
                >
                  <option value="text">Texto</option>
                  <option value="file">Fichero</option>
                </select>
                {field.kind === "text" ? (
                  <CellInput
                    label={`Valor de ${field.name || "campo"}`}
                    value={field.value}
                    variables={variables}
                    disabled={disabled}
                    onChange={(value) => update({ value })}
                  />
                ) : (
                  <label className="flex h-7 cursor-pointer items-center gap-1 truncate rounded-md border border-dashed border-slate-300 px-2 text-[11px] text-slate-600 hover:bg-slate-50">
                    <input
                      type="file"
                      className="hidden"
                      aria-label={`Fichero de ${field.name || "campo"}`}
                      disabled={!field.name.trim()}
                      onChange={(event) =>
                        choose(event.target.files?.[0], (chosen) =>
                          setFiles({ ...files, fields: { ...files.fields, [field.name.trim()]: chosen } }),
                        )
                      }
                    />
                    {file
                      ? `${file.name} · ${formatBytes(file.size)}`
                      : field.name.trim()
                        ? "Elegir fichero…"
                        : "Pon antes la clave"}
                  </label>
                )}
                {!ghost && !disabled ? (
                  <button
                    aria-label={`Eliminar ${field.name || "campo"}`}
                    className="text-slate-400 hover:text-rose-600"
                    onClick={() => setFields(fields.filter((_row, position) => position !== index))}
                  >
                    ×
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
          <p className="px-2 py-1 text-[10px] text-slate-400">
            Hasta 10 ficheros de 10 MB. El fichero no se guarda: hay que elegirlo en cada sesión.
          </p>
        </div>
      )}

      {body.mode === "binary" && (
        <label className="grid cursor-pointer place-items-center rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-xs text-slate-600 hover:bg-slate-50">
          <input
            type="file"
            className="hidden"
            aria-label="Fichero binario"
            onChange={(event) => choose(event.target.files?.[0], (chosen) => setFiles({ ...files, binary: chosen }))}
          />
          {files.binary ? (
            <span>
              <span className="font-medium">{files.binary.name}</span> · {formatBytes(files.binary.size)} ·{" "}
              {files.binary.type || "application/octet-stream"}
            </span>
          ) : (
            "Haz clic para elegir el fichero que se envía como cuerpo"
          )}
        </label>
      )}
    </div>
  );
}

/**
 * La pestaña Auth: qué significa heredar aquí, y el editor con los trece tipos.
 *
 * «Heredar» se explica con lo que de verdad va a pasar —el token de sesión capturado si lo hay, y
 * si no la autenticación del proyecto, y si no la credencial del entorno— porque es la única opción
 * cuyo efecto no está escrito en la propia pantalla.
 */
function AuthTab({
  auth,
  setAuth,
  project,
  environment,
  variables,
  sessionToken,
  disabled,
}: {
  auth: SendAuth;
  setAuth: (auth: SendAuth) => void;
  project: ProjectSummary | undefined;
  environment: Environment | null;
  variables: string[];
  sessionToken: SessionTokenView | null;
  disabled?: boolean;
}) {
  const inherited = !project
    ? "…"
    : project.auth.type === "bearer"
      ? project.auth.loginUrl
        ? `Login del proyecto (${project.auth.loginMethod || "POST"} ${project.auth.loginUrl})`
        : "Bearer token del proyecto"
      : project.auth.type === "basic"
        ? `Basic auth del proyecto (${project.auth.username})`
        : project.auth.type === "api_key"
          ? `API key del proyecto en ${project.auth.headerName || "X-API-Key"}`
          : environment
            ? `El proyecto no tiene autenticación: se usa la credencial primary de «${environment.name}» si la hay`
            : "El proyecto no tiene autenticación";

  return (
    <div className="space-y-2">
      <AuthEditor
        auth={auth}
        onChange={setAuth}
        variables={variables}
        disabled={disabled}
        inheritHint={
          sessionToken && !sessionToken.expired
            ? `Token de sesión capturado ${sessionToken.source === "login" ? "del login" : "por un script"}. Sin él: ${inherited}`
            : inherited
        }
      />
      <p className="text-[11px] text-slate-400">Una cabecera Authorization escrita en Headers gana siempre.</p>
    </div>
  );
}

const PRE_SNIPPETS: { label: string; code: string }[] = [
  { label: "Marca de tiempo", code: 'pm.environment.set("timestamp", Date.now().toString());' },
  { label: "Id aleatorio", code: 'pm.variables.set("requestId", crypto.randomUUID());' },
  {
    label: "Cabecera",
    code: 'pm.request.headers.upsert({ key: "X-Request-Id", value: pm.variables.get("requestId") });',
  },
  {
    label: "Basic auth",
    code: 'pm.request.headers.upsert({\n  key: "Authorization",\n  value: "Basic " + btoa(pm.environment.get("user") + ":" + pm.environment.get("password")),\n});',
  },
];

const POST_SNIPPETS: { label: string; code: string }[] = [
  { label: "Estado 200", code: 'pm.test("responde 200", () => pm.response.to.have.status(200));' },
  {
    label: "Guardar token",
    code: 'const data = pm.response.json();\npm.environment.set("token", data.access_token);',
  },
  { label: "Guardar id", code: 'pm.environment.set("id", String(pm.response.json().id));' },
  {
    label: "Tiempo",
    code: 'pm.test("responde en menos de 500 ms", () => pm.expect(pm.response.responseTime).to.be.below(500));',
  },
  { label: "Imprimir", code: "console.log(pm.response.json());" },
];

/** The API a script has, on one strip — the analyzer's reference, with what this sandbox adds. */
function ScriptReference() {
  const members = [
    "pm.environment.get / set / unset",
    "pm.variables.get / set",
    "pm.request.headers.upsert / remove",
    "pm.response.json() · code · headers · responseTime",
    "pm.test(nombre, fn)",
    "pm.expect(x).to.equal(…)",
    "console.log",
    "btoa · atob · crypto.randomUUID()",
  ];
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-semibold text-slate-700">API de los scripts · sintaxis compatible con Postman</p>
      <p className="mt-1 flex flex-wrap gap-1">
        {members.map((member) => (
          <code
            key={member}
            className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600 ring-1 ring-slate-200"
          >
            {member}
          </code>
        ))}
      </p>
      <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
        Corren al enviar, cada uno en un proceso aislado y sin acceso al servidor, 3 s como mucho.{" "}
        <code>pm.environment.set</code> cambia el valor actual del entorno activo; guardar <code>token</code> captura el
        token de sesión. Si el previo falla, la petición no sale. La consola oculta los secretos.
      </p>
    </div>
  );
}

function ScriptField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  snippets,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  snippets: { label: string; code: string }[];
}) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <p className="mr-1 text-xs font-semibold text-slate-700">{label}</p>
        {!disabled &&
          snippets.map((snippet) => (
            <button
              key={snippet.label}
              type="button"
              className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-slate-400 hover:text-slate-800"
              onClick={() => onChange(value.trim() ? `${value.replace(/\s+$/, "")}\n${snippet.code}` : snippet.code)}
            >
              + {snippet.label}
            </button>
          ))}
      </div>
      <textarea
        aria-label={`Script ${label}`}
        className="h-36 w-full rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100 outline-none"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const RESPONSE_TABS = [
  { id: "body", label: "Cuerpo" },
  { id: "headers", label: "Cabeceras" },
  { id: "console", label: "Consola" },
  { id: "cookies", label: "Cookies" },
  { id: "request", label: "Petición" },
] as const;

function ResponsePanel({ send }: { send: { data?: SentRequestView; error: Error | null; isPending: boolean } }) {
  const [tab, setTab] = useState<(typeof RESPONSE_TABS)[number]["id"]>("body");
  const [copied, setCopied] = useState(false);
  const result = send.data;
  const body = result?.response ? prettyBody(result.response.body) : null;
  // A pre-request script that failed is why there is no response, and its console is the answer.
  useEffect(() => {
    if (result?.scripts.pre?.error) setTab("console");
  }, [result]);
  const runs = result
    ? [result.scripts.pre, result.scripts.post].filter((run): run is ScriptRunView => run !== null)
    : [];
  const tests = runs.flatMap((run) => run.tests);
  const consoleCount = runs.reduce((total, run) => total + run.logs.length + run.tests.length + (run.error ? 1 : 0), 0);
  const cookieCount = result ? result.cookies.sent.length + result.cookies.stored.length + result.cookies.rejected.length : 0;
  const headersText = result?.response
    ? Object.entries(result.response.headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n")
    : "";
  const requestText = result
    ? [
        `${result.request.method} ${result.request.url}`,
        ...Object.entries(result.request.headers).map(([name, value]) => `${name}: ${value}`),
        "",
        result.request.body ?? "",
      ].join("\n")
    : "";
  const shown =
    tab === "body" ? (body?.text ?? "") : tab === "headers" ? headersText : tab === "request" ? requestText : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-semibold text-slate-700">Respuesta</p>
        {result?.response && (
          <>
            <Badge className={httpStatusStyle(result.response.status)}>{result.response.status}</Badge>
            <span className="text-[11px] text-slate-500">{formatDuration(result.response.durationMs)}</span>
            <span className="text-[11px] text-slate-500">{formatBytes(result.response.sizeBytes)}</span>
          </>
        )}
        {tests.length > 0 && (
          <Badge
            className={
              tests.every((test) => test.passed)
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }
          >
            {tests.filter((test) => test.passed).length}/{tests.length} pruebas
          </Badge>
        )}
        {result && (
          <span className="ml-auto truncate text-[11px] text-slate-400" title={result.auth}>
            {result.environment ? `${result.environment.name} · ` : ""}
            {result.auth}
          </span>
        )}
      </div>

      {send.isPending && <p className="mt-3 text-xs text-slate-500">Enviando…</p>}
      {send.error && (
        <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
          <p>{send.error.message}</p>
          {send.error instanceof ApiError && send.error.fields.map((field, index) => <p key={index}>{field.detail}</p>)}
        </div>
      )}
      {!result && !send.isPending && !send.error && (
        <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
          Envía la petición para ver aquí la respuesta.
        </p>
      )}
      {result?.error && (
        <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-700">Sin respuesta: {result.error}</p>
      )}

      {result && (
        <div className="mt-2">
          <div className="flex items-center gap-1 border-b border-slate-200">
            {RESPONSE_TABS.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setTab(entry.id)}
                className={cn(
                  "-mb-px border-b-2 px-2 py-1 text-[11px]",
                  tab === entry.id
                    ? "border-slate-900 font-semibold text-slate-900"
                    : "border-transparent text-slate-500",
                )}
              >
                {entry.label}
                {entry.id === "console" && consoleCount > 0 && (
                  <span className="ml-1 text-slate-400">{consoleCount}</span>
                )}
                {entry.id === "cookies" && cookieCount > 0 && <span className="ml-1 text-slate-400">{cookieCount}</span>}
              </button>
            ))}
            {tab === "cookies" && cookieCount > 0 && <span className="sr-only">{cookieCount}</span>}
            {tab !== "console" && tab !== "cookies" && (
              <button
                className="ml-auto px-2 py-1 text-[11px] text-slate-500 hover:text-slate-900"
                onClick={() => void copy()}
              >
                {copied ? "copiado" : "copiar"}
              </button>
            )}
          </div>
          {tab === "console" ? (
            <ScriptConsole scripts={result.scripts} />
          ) : tab === "cookies" ? (
            <CookiePanel cookies={result.cookies} />
          ) : (
            <pre className="mt-2 max-h-96 min-h-24 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-slate-200">
              {shown || (tab === "body" ? "(sin cuerpo)" : "")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const LOG_TONE: Record<ScriptRunView["logs"][number]["level"], string> = {
  log: "text-slate-200",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-rose-300",
};

/** What each script printed, tested and saved — one block per script that ran. */
function ScriptConsole({ scripts }: { scripts: SentRequestView["scripts"] }) {
  const runs: [string, ScriptRunView][] = [];
  if (scripts.pre) runs.push(["Script previo", scripts.pre]);
  if (scripts.post) runs.push(["Script posterior", scripts.post]);
  if (runs.length === 0)
    return (
      <p className="mt-2 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
        Sin scripts. Lo que un script imprima con console.log y sus pm.test aparecen aquí.
      </p>
    );
  return (
    <div className="mt-2 space-y-3">
      {runs.map(([label, run]) => {
        const passed = run.tests.filter((test) => test.passed).length;
        return (
          <div key={label} className="overflow-hidden rounded-xl border border-slate-200">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-[11px]">
              <span className="font-semibold text-slate-700">{label}</span>
              <span className="text-slate-400">{formatDuration(run.durationMs)}</span>
              {run.tests.length > 0 && (
                <span className={passed === run.tests.length ? "text-emerald-700" : "text-rose-700"}>
                  {passed}/{run.tests.length} pruebas
                </span>
              )}
              {run.environmentUpdates.length > 0 && (
                <span className="ml-auto truncate text-slate-500" title={run.environmentUpdates.join(", ")}>
                  Guardó en el entorno: {run.environmentUpdates.join(", ")}
                </span>
              )}
            </div>
            {run.error && <p className="bg-rose-50 px-3 py-1.5 font-mono text-[11px] text-rose-700">{run.error}</p>}
            {run.tests.length > 0 && (
              <ul className="space-y-0.5 px-3 py-1.5">
                {run.tests.map((test, index) => (
                  <li key={index} className="text-[11px] text-slate-700">
                    <span className={test.passed ? "text-emerald-600" : "text-rose-600"}>
                      {test.passed ? "✓" : "✗"}
                    </span>{" "}
                    {test.name}
                    {test.message && <span className="text-rose-600"> — {test.message}</span>}
                  </li>
                ))}
              </ul>
            )}
            {run.logs.length > 0 && (
              <pre className="max-h-64 overflow-auto bg-slate-950 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap">
                {run.logs.map((log, index) => (
                  <div key={index} className={LOG_TONE[log.level]}>
                    {log.text}
                  </div>
                ))}
              </pre>
            )}
            {!run.error && run.tests.length === 0 && run.logs.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-slate-400">Sin salida.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CurlModal({ command, onClose }: { command: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      title="cURL"
      description="Las variables no secretas van sustituidas; las secretas se quedan como {{variable}}."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copiado" : "Copiar"}
          </Button>
        </>
      }
    >
      <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100 select-all">
        {command}
      </pre>
    </Modal>
  );
}
