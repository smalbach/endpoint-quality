/**
 * El cuerpo GraphQL del editor: la operación, sus variables, y el esquema a un lado.
 *
 * Se carga aparte del editor (ver `BodyTab`): trae `graphql`, que solo hace falta a quien abre este
 * modo.
 *
 * El esquema no es del endpoint, es **de la URL**: dos endpoints que apuntan a la misma API lo
 * comparten mientras la pestaña esté abierta, y nada de él se guarda (ver `lib/graphql-schema`).
 */
import { useMemo, useState } from "react";

import { useToast } from "@/components/toast";
import { VariableSuggest } from "@/components/variable-suggest";
import { graphqlVariablesProblem } from "@/lib/graphql-draft";
import {
  INTROSPECTION_QUERY,
  operationFor,
  queryProblems,
  rootFields,
  schemaFromIntrospection,
  schemaFromText,
  typeCount,
  type GraphQLSchema,
  type RootField,
  type SchemaRead,
} from "@/lib/graphql-schema";
import { cn } from "@/lib/format";
import type { SentRequestView } from "@/lib/types";

type Loaded = { schema: GraphQLSchema; source: string };

/** Los esquemas cargados en esta pestaña, por URL. Una variable de módulo: vive lo que la pestaña. */
const loadedSchemas = new Map<string, Loaded>();

/** Para las pruebas: cada una empieza sin esquemas de la anterior. */
export const forgetSchemas = () => loadedSchemas.clear();

const OPERATION_LABEL: Record<RootField["operation"], string> = {
  query: "Consultas",
  mutation: "Mutaciones",
  subscription: "Suscripciones",
};

export default function GraphqlBodyEditor({
  query,
  variables,
  onChange,
  variableNames,
  disabled,
  method,
  schemaKey,
  introspect,
}: {
  query: string;
  variables: string;
  onChange: (patch: { text?: string; variables?: string }) => void;
  variableNames: string[];
  disabled: boolean;
  method: string;
  /** La URL de la petición: de quién es el esquema. */
  schemaKey: string;
  /** Manda la consulta de introspección por el mismo camino que «Enviar». */
  introspect: (query: string) => Promise<SentRequestView>;
}) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<Loaded | null>(() => loadedSchemas.get(schemaKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const keep = (read: SchemaRead, source: string) => {
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    const next = { schema: read.schema, source };
    loadedSchemas.set(schemaKey, next);
    setLoaded(next);
    setProblem(null);
  };

  const fromServer = async () => {
    setLoading(true);
    try {
      const sent = await introspect(INTROSPECTION_QUERY);
      if (!sent.response) setProblem(sent.error ?? "La introspección no llegó al servidor");
      else if (sent.response.status < 200 || sent.response.status >= 300)
        setProblem(`El servidor contestó ${sent.response.status} a la introspección`);
      else keep(schemaFromIntrospection(sent.response.body), "introspección");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "La introspección falló");
    } finally {
      setLoading(false);
    }
  };

  const fromFile = async (file: File | undefined) => {
    if (!file) return;
    keep(schemaFromText(await file.text()), file.name);
  };

  const schema = loaded?.schema ?? null;
  const problems = useMemo(() => queryProblems(schema, query), [schema, query]);
  const variablesProblem = useMemo(() => graphqlVariablesProblem(variables), [variables]);
  const fields = useMemo(() => (schema ? rootFields(schema) : []), [schema]);
  const shown = fields.filter((field) => field.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const use = (field: RootField) => {
    if (!schema) return;
    const generated = operationFor(schema, field.operation, field.name);
    if (!generated) return;
    onChange({ text: generated.query, variables: generated.variables });
    toast.success(`Operación «${field.name}» escrita: revisa las variables antes de enviar`);
  };

  const overGet = method === "GET" || method === "HEAD";
  const mutationOverGet = overGet && /^\s*mutation\b/.test(query);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-2">
        <p className="text-[10px] text-slate-400">
          {overGet
            ? "Por GET: la operación y las variables van en la query de la URL, como dice GraphQL sobre HTTP."
            : "Content-Type: application/json · se envía {query, variables}"}
        </p>
        <VariableSuggest variables={variableNames} value={query} onChange={(text) => onChange({ text })}>
          {(suggest) => (
            <textarea
              {...suggest}
              aria-label="Operación GraphQL"
              className="h-56 w-full rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100 outline-none focus:border-slate-900"
              placeholder={"query Usuario($id: ID!) {\n  user(id: $id) {\n    name\n  }\n}"}
              disabled={disabled}
              spellCheck={false}
            />
          )}
        </VariableSuggest>
        {mutationOverGet && (
          <p className="text-[11px] text-amber-700">
            Una mutación por GET: muchos servidores la rechazan. Cambia el método a POST.
          </p>
        )}
        {problems.length > 0 && (
          <ul aria-label="Problemas de la operación" className="space-y-0.5 text-[11px] text-amber-700">
            {problems.slice(0, 5).map((entry, index) => (
              <li key={index}>
                {entry.line !== null ? `Línea ${entry.line}:${entry.column} · ` : ""}
                {entry.message}
              </li>
            ))}
          </ul>
        )}
        <div>
          <p className="mb-1 text-[10px] font-medium text-slate-500">Variables (JSON) · admite {"{{variables}}"}</p>
          <VariableSuggest
            variables={variableNames}
            value={variables}
            onChange={(text) => onChange({ variables: text })}
          >
            {(suggest) => (
              <textarea
                {...suggest}
                aria-label="Variables GraphQL"
                className="h-24 w-full rounded-lg border border-slate-200 bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-100 outline-none focus:border-slate-900"
                placeholder={'{\n  "id": "{{userId}}"\n}'}
                disabled={disabled}
                spellCheck={false}
              />
            )}
          </VariableSuggest>
          {variablesProblem && <p className="text-[11px] text-amber-700">{variablesProblem}</p>}
        </div>
      </div>

      <aside aria-label="Esquema" className="min-w-0 space-y-2 rounded-lg border border-slate-200 p-2">
        <div className="flex flex-wrap items-center gap-1">
          <button
            className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-200 disabled:opacity-50"
            disabled={disabled || loading}
            onClick={() => void fromServer()}
          >
            {loading ? "Cargando…" : loaded ? "Recargar esquema" : "Cargar esquema"}
          </button>
          <label className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">
            <input
              type="file"
              className="hidden"
              aria-label="Esquema desde fichero"
              accept=".graphql,.graphqls,.gql,.json,.txt"
              onChange={(event) => void fromFile(event.target.files?.[0])}
            />
            Desde fichero…
          </label>
        </div>
        {problem && <p className="text-[11px] text-rose-700">{problem}</p>}
        {!loaded && !problem && (
          <p className="text-[11px] text-slate-500">
            Con el esquema, la operación se valida mientras se escribe y las operaciones se eligen de una lista. Se pide
            por introspección con el entorno y la autenticación de la petición, o se lee de un SDL.
          </p>
        )}
        {loaded && (
          <>
            <p className="text-[10px] text-slate-400">
              {typeCount(loaded.schema)} tipos · de {loaded.source} · no se guarda
            </p>
            <input
              aria-label="Buscar operación"
              className="h-7 w-full rounded-md border border-slate-200 px-2 text-[11px] outline-none focus:border-slate-900"
              placeholder="Buscar operación"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {(["query", "mutation", "subscription"] as const).map((operation) => {
                const list = shown.filter((field) => field.operation === operation);
                if (!list.length) return null;
                return (
                  <div key={operation}>
                    <p className="text-[10px] font-medium text-slate-500">{OPERATION_LABEL[operation]}</p>
                    <ul>
                      {list.map((field) => (
                        <li key={field.name}>
                          <button
                            className={cn(
                              "w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-slate-100 disabled:hover:bg-transparent",
                              field.deprecated ? "text-slate-400 line-through" : "text-slate-700",
                            )}
                            title={[field.description, `→ ${field.type}`].filter(Boolean).join("\n")}
                            disabled={disabled}
                            onClick={() => use(field)}
                          >
                            {field.name}
                            {field.args.length ? (
                              <span className="text-slate-400">
                                ({field.args.map((arg) => `${arg.name}${arg.required ? "!" : ""}`).join(", ")})
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
