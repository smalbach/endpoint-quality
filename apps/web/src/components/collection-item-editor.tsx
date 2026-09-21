/**
 * Lo que hay a la derecha del árbol: la petición, la carpeta o la colección que se está mirando.
 *
 * Las pestañas son las de Postman —Params, Headers, Body, Auth, Scripts— porque es lo que alguien
 * que trae una colección de allí ya sabe usar, y porque cada una es una cosa distinta que se edita
 * sin perder las demás. Las tablas son las mismas que el editor de endpoints (`RequestFieldsEditor`)
 * y el bloque de autenticación es el mismo componente: dos editores distintos para «una petición»
 * serían dos sitios donde arreglar el mismo fallo.
 *
 * Nada se guarda aquí. Todo sube por `onChange`, y la página decide cuándo mandar el documento —
 * que es lo que permite mover una petición de carpeta y renombrarla antes de guardar nada.
 */
import { useState } from "react";

import { AuthEditor } from "@/components/auth-editor";
import { RequestFieldsEditor } from "@/components/request-fields-editor";
import { Badge, Button, Field, inputClass } from "@/components/ui";
import { cn, formatBytes } from "@/lib/format";
import { METHODS, METHOD_CLASS, statusClass } from "@/lib/collections";
import { fieldProblems, type FieldRow } from "@/lib/request-fields";
import type {
  CollectionItemView,
  CollectionRequestView,
  CollectionVariableView,
  EndpointBodyView,
  EndpointMethod,
  SentRequestView,
} from "@/lib/types";

const REQUEST_TABS = ["params", "headers", "body", "auth", "scripts"] as const;
type RequestTab = (typeof REQUEST_TABS)[number];
const TAB_LABEL: Record<RequestTab, string> = {
  params: "Params",
  headers: "Headers",
  body: "Body",
  auth: "Auth",
  scripts: "Scripts",
};

/** Los modos de cuerpo que esta pantalla sabe mandar. `binary` no está: no hay fichero que subir. */
const BODY_MODES: { value: EndpointBodyView["mode"]; label: string }[] = [
  { value: "none", label: "none" },
  { value: "json", label: "JSON" },
  { value: "raw", label: "raw" },
  { value: "form-data", label: "form-data" },
  { value: "x-www-form-urlencoded", label: "x-www-form-urlencoded" },
  { value: "graphql", label: "GraphQL" },
];

const toRows = (rows: { name: string; value: string; enabled?: boolean }[]): FieldRow[] =>
  rows.map((row) => ({ name: row.name, value: row.value, enabled: row.enabled !== false }));

export function CollectionRequestEditor({
  item,
  onChange,
  variables,
  canEdit,
  onSend,
  send,
}: {
  item: CollectionItemView;
  onChange: (item: CollectionItemView) => void;
  variables: string[];
  canEdit: boolean;
  onSend: () => void;
  send: { data?: SentRequestView; error: Error | null; isPending: boolean };
}) {
  const [tab, setTab] = useState<RequestTab>("params");
  // Un nodo de tipo petición siempre trae su petición: lo exige el esquema al guardar.
  const request = item.request as CollectionRequestView;
  const set = (patch: Partial<CollectionRequestView>) => onChange({ ...item, request: { ...request, ...patch } });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <input
          aria-label="Nombre de la petición"
          className={cn(inputClass, "max-w-xs font-medium")}
          value={item.name}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...item, name: event.target.value })}
        />
      </div>

      <div className="flex gap-2">
        <select
          aria-label="Método"
          className={cn(inputClass, "w-28 font-bold", METHOD_CLASS[request.method])}
          value={request.method}
          disabled={!canEdit}
          onChange={(event) => set({ method: event.target.value as EndpointMethod })}
        >
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
        <input
          aria-label="URL"
          className={cn(inputClass, "flex-1 font-mono text-xs")}
          placeholder="{{baseUrl}}/v1/products"
          value={request.url}
          disabled={!canEdit}
          onChange={(event) => set({ url: event.target.value })}
        />
        <Button type="button" onClick={onSend} disabled={send.isPending || !request.url.trim()}>
          {send.isPending ? "Enviando…" : "Enviar"}
        </Button>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {REQUEST_TABS.map((id) => (
          <button
            key={id}
            type="button"
            className={cn(
              "border-b-2 px-3 py-1.5 text-sm",
              tab === id ? "border-sky-500 font-medium text-sky-700" : "border-transparent text-slate-500",
            )}
            onClick={() => setTab(id)}
          >
            {TAB_LABEL[id]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === "params" && (
          <div className="space-y-4">
            <RequestFieldsEditor
              label="Query"
              hint="Lo que va detrás de la ? Una fila apagada se guarda y no se manda."
              rows={toRows(request.query)}
              problems={fieldProblems(toRows(request.query), "parameter")}
              namePlaceholder="limit"
              valuePlaceholder="20"
              disabled={!canEdit}
              variables={variables}
              onChange={(rows) =>
                set({
                  query: rows
                    .filter((row) => row.name.trim())
                    .map((row) => ({
                      name: row.name.trim(),
                      type: "string",
                      required: false,
                      description: "",
                      value: row.value,
                      enabled: row.enabled,
                    })),
                })
              }
            />
            <RequestFieldsEditor
              label="Variables de ruta"
              hint="Los {{:id}} que Postman guarda con la URL."
              rows={toRows(request.pathParameters)}
              problems={fieldProblems(toRows(request.pathParameters), "parameter")}
              namePlaceholder="id"
              valuePlaceholder="{{productId}}"
              disabled={!canEdit}
              variables={variables}
              onChange={(rows) =>
                set({
                  pathParameters: rows
                    .filter((row) => row.name.trim())
                    .map((row) => ({ name: row.name.trim(), type: "string", description: "", value: row.value })),
                })
              }
            />
          </div>
        )}

        {tab === "headers" && (
          <RequestFieldsEditor
            label="Cabeceras"
            rows={toRows(request.headers)}
            problems={fieldProblems(toRows(request.headers), "header")}
            namePlaceholder="Accept"
            valuePlaceholder="application/json"
            disabled={!canEdit}
            variables={variables}
            onChange={(rows) =>
              set({ headers: rows.filter((row) => row.name.trim()).map((row) => ({ ...row, name: row.name.trim() })) })
            }
          />
        )}

        {tab === "body" && <BodyEditor body={request.body} disabled={!canEdit} onChange={(body) => set({ body })} />}

        {tab === "auth" && (
          <AuthEditor
            auth={request.auth}
            variables={variables}
            disabled={!canEdit}
            inheritHint="Hereda de la carpeta, y si no, de la colección; y si tampoco, del proyecto."
            onChange={(auth) => set({ auth })}
          />
        )}

        {tab === "scripts" && (
          <Scripts
            item={item}
            disabled={!canEdit}
            onChange={(patch) => onChange({ ...item, ...patch })}
            hint="Corren después de los de la colección y los de las carpetas de encima, como en Postman."
          />
        )}
      </div>

      <ResponsePanel send={send} />
    </div>
  );
}

/** El cuerpo. Sin `binary`: aquí no hay fichero que subir, y una corrida tampoco podría mandarlo. */
export function BodyEditor({
  body,
  disabled,
  onChange,
}: {
  body: EndpointBodyView;
  disabled: boolean;
  onChange: (body: EndpointBodyView) => void;
}) {
  const rows = toRows(body.fields);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {BODY_MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            disabled={disabled}
            className={cn(
              "rounded border px-2 py-1 text-xs",
              body.mode === mode.value ? "border-sky-500 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600",
            )}
            onClick={() => onChange({ ...body, mode: mode.value })}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {(body.mode === "json" || body.mode === "raw" || body.mode === "graphql") && (
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {body.mode === "graphql" ? "Operación" : "Contenido"}
          </span>
          <textarea
            aria-label={body.mode === "graphql" ? "Operación GraphQL" : "Cuerpo"}
            className={cn(inputClass, "h-56 font-mono text-xs")}
            value={body.text}
            disabled={disabled}
            onChange={(event) => onChange({ ...body, text: event.target.value })}
          />
        </label>
      )}

      {body.mode === "graphql" && (
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Variables</span>
          <textarea
            aria-label="Variables GraphQL"
            className={cn(inputClass, "h-28 font-mono text-xs")}
            value={body.variables ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...body, variables: event.target.value })}
          />
        </label>
      )}

      {body.mode === "raw" && (
        <Field label="Content-Type">
          <input
            className={inputClass}
            value={body.contentType}
            disabled={disabled}
            onChange={(event) => onChange({ ...body, contentType: event.target.value })}
          />
        </Field>
      )}

      {(body.mode === "form-data" || body.mode === "x-www-form-urlencoded") && (
        <RequestFieldsEditor
          label="Campos"
          rows={rows}
          problems={fieldProblems(rows, "parameter")}
          namePlaceholder="campo"
          valuePlaceholder="valor"
          disabled={disabled}
          onChange={(next) =>
            onChange({
              ...body,
              fields: next
                .filter((row) => row.name.trim())
                .map((row) => ({ name: row.name.trim(), value: row.value, kind: "text", enabled: row.enabled })),
            })
          }
        />
      )}

      {body.mode === "none" && <p className="text-sm text-slate-500">Esta petición no manda cuerpo.</p>}
    </div>
  );
}

/** Los dos scripts de un nodo, con la misma forma en la petición, la carpeta y la colección. */
export function Scripts({
  item,
  disabled,
  onChange,
  hint,
}: {
  item: Pick<CollectionItemView, "preRequestScript" | "postResponseScript">;
  disabled: boolean;
  onChange: (patch: { preRequestScript: string; postResponseScript: string }) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-4">
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Pre-request
        </span>
        <textarea
          aria-label="Script previo"
          className={cn(inputClass, "h-40 font-mono text-xs")}
          value={item.preRequestScript}
          disabled={disabled}
          onChange={(event) =>
            onChange({ preRequestScript: event.target.value, postResponseScript: item.postResponseScript })
          }
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Tests</span>
        <textarea
          aria-label="Tests"
          className={cn(inputClass, "h-56 font-mono text-xs")}
          value={item.postResponseScript}
          disabled={disabled}
          onChange={(event) =>
            onChange({ preRequestScript: item.preRequestScript, postResponseScript: event.target.value })
          }
        />
      </label>
    </div>
  );
}

/** Una carpeta: su nombre, su descripción, de qué se autentica y sus scripts. */
export function CollectionFolderEditor({
  item,
  onChange,
  variables,
  canEdit,
}: {
  item: CollectionItemView;
  onChange: (item: CollectionItemView) => void;
  variables: string[];
  canEdit: boolean;
}) {
  return (
    <div className="space-y-4 overflow-y-auto">
      <Field label="Nombre">
        <input
          className={inputClass}
          value={item.name}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...item, name: event.target.value })}
        />
      </Field>
      <Field label="Descripción">
        <textarea
          className={cn(inputClass, "h-24")}
          value={item.description}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...item, description: event.target.value })}
        />
      </Field>
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Autenticación de la carpeta</h3>
        <AuthEditor
          auth={item.auth ?? { type: "inherit", params: {} }}
          variables={variables}
          disabled={!canEdit}
          inheritHint="Hereda de la colección, y si tampoco, del proyecto."
          onChange={(auth) => onChange({ ...item, auth })}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-medium text-slate-700">Scripts de la carpeta</h3>
        <Scripts
          item={item}
          disabled={!canEdit}
          onChange={(patch) => onChange({ ...item, ...patch })}
          hint="Corren antes y después de cada petición de dentro."
        />
      </div>
    </div>
  );
}

/** Las variables de la colección: lo que `pm.collectionVariables` lee y escribe en la corrida. */
export function CollectionVariablesEditor({
  variables,
  disabled,
  onChange,
}: {
  variables: CollectionVariableView[];
  disabled: boolean;
  onChange: (variables: CollectionVariableView[]) => void;
}) {
  const rows: FieldRow[] = variables.map((variable) => ({
    name: variable.key,
    value: variable.value,
    enabled: variable.enabled,
  }));
  return (
    <RequestFieldsEditor
      label="Variables de la colección"
      hint="Su valor inicial. Durante una corrida, lo que pm.collectionVariables.set escriba manda."
      rows={rows}
      problems={fieldProblems(rows, "parameter")}
      namePlaceholder="baseUrl"
      valuePlaceholder="valor inicial"
      disabled={disabled}
      onChange={(next) =>
        onChange(
          next
            .filter((row) => row.name.trim())
            .map((row) => ({ key: row.name.trim(), value: row.value, enabled: row.enabled })),
        )
      }
    />
  );
}

const RESPONSE_TABS = ["body", "headers", "tests", "console"] as const;
type ResponseTab = (typeof RESPONSE_TABS)[number];

/** Lo que contestó: el cuerpo, las cabeceras, los `pm.test` y lo que la consola dejó. */
export function ResponsePanel({
  send,
}: {
  send: { data?: SentRequestView; error: Error | null; isPending: boolean };
}) {
  const [tab, setTab] = useState<ResponseTab>("body");
  if (send.isPending) return <p className="border-t border-slate-200 pt-2 text-sm text-slate-500">Enviando…</p>;
  if (send.error)
    return <p className="border-t border-slate-200 pt-2 text-sm text-rose-600">{send.error.message}</p>;
  const result = send.data;
  if (!result) return null;

  const tests = [...(result.scripts.pre?.tests ?? []), ...(result.scripts.post?.tests ?? [])];
  const logs = [...(result.scripts.pre?.logs ?? []), ...(result.scripts.post?.logs ?? [])];
  const failed = tests.filter((test) => !test.passed).length;

  return (
    <section className="border-t border-slate-200 pt-2">
      <div className="flex items-center gap-3 text-xs">
        {result.response ? (
          <>
            <span className={cn("font-bold", statusClass(result.response.status))}>{result.response.status}</span>
            <span className="text-slate-500">{result.response.durationMs} ms</span>
            <span className="text-slate-500">{formatBytes(result.response.sizeBytes)}</span>
          </>
        ) : (
          <span className="font-medium text-rose-600">{result.error ?? "Sin respuesta"}</span>
        )}
        {tests.length > 0 && (
          <Badge className={failed ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}>
            {tests.length - failed}/{tests.length} tests
          </Badge>
        )}
        <span className="ml-auto flex gap-1">
          {RESPONSE_TABS.map((id) => (
            <button
              key={id}
              type="button"
              className={cn("rounded px-2 py-0.5", tab === id ? "bg-slate-200 text-slate-800" : "text-slate-500")}
              onClick={() => setTab(id)}
            >
              {id === "body" ? "Cuerpo" : id === "headers" ? "Cabeceras" : id === "tests" ? "Tests" : "Consola"}
            </button>
          ))}
        </span>
      </div>

      <div className="mt-2 max-h-64 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs">
        {tab === "body" && <pre className="whitespace-pre-wrap">{result.response?.body ?? "—"}</pre>}
        {tab === "headers" && (
          <pre className="whitespace-pre-wrap">
            {Object.entries(result.response?.headers ?? {})
              .map(([name, value]) => `${name}: ${value}`)
              .join("\n") || "—"}
          </pre>
        )}
        {tab === "tests" && (
          <ul className="space-y-1">
            {tests.map((test, index) => (
              <li key={`${test.name}-${index}`} className={test.passed ? "text-emerald-700" : "text-rose-700"}>
                {test.passed ? "✓" : "✕"} {test.name}
                {test.message ? ` — ${test.message}` : ""}
              </li>
            ))}
            {!tests.length && <li className="text-slate-500">Esta petición no trae tests.</li>}
          </ul>
        )}
        {tab === "console" && (
          <pre className="whitespace-pre-wrap">{logs.map((log) => `[${log.level}] ${log.text}`).join("\n") || "—"}</pre>
        )}
      </div>
    </section>
  );
}
