import { useEffect, useMemo, useRef, useState } from "react";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { AssertionRow, Badge, Button, Card, Empty, Json } from "@/components/ui";
import { cn, methodStyle } from "@/lib/format";
import type { CoverageView, Environment, OperationScenarios, ScenariosView, ScenarioView } from "@/lib/types";

/**
 * The screen the coupled dashboard was, rebuilt on data.
 *
 * Every number here comes from the API: the operations from an imported contract, the cases from
 * the project's configuration, and which of them will run tonight from the selected environment.
 * There is not one endpoint, parameter name or latency budget in this file — that is the point
 * of the phase, and it is checked by a test that greps the built bundle.
 */
export function MatrixPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canRun = useCan("editor");
  const navigate = useNavigate();

  const [environmentId, setEnvironmentId] = useState<string>("");
  const [tag, setTag] = useState("Todos");
  const [labelFilter, setLabelFilter] = useState("Todas");
  const [search, setSearch] = useState("");
  const [selectedOperation, setSelectedOperation] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [order, setOrder] = useState<"safe" | "contract">("safe");

  const base = `/orgs/${organization?.id}/projects/${projectId}`;

  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });

  // Start from the project's active environment, once. «Ninguno» stays a choice somebody can make
  // afterwards, and choosing one here makes it the active one everywhere else.
  const [activeEnvironment, setActiveEnvironment] = useActiveEnvironment(projectId);
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !environments.data) return;
    preselected.current = true;
    const active = resolveActive(activeEnvironment, environments.data);
    if (active) setEnvironmentId(active.id);
  }, [environments.data, activeEnvironment]);

  const scenarios = useQuery({
    queryKey: ["scenarios", projectId, environmentId, order],
    enabled: Boolean(organization && projectId),
    queryFn: () =>
      api<ScenariosView>(`${base}/scenarios?order=${order}${environmentId ? `&environmentId=${environmentId}` : ""}`),
    retry: false,
  });

  /**
   * Coverage is asked for without an environment, on purpose: it is a property of the contract and
   * the configuration. A read-only target blocks the write cases it would run, and folding that
   * into the number would report "the contract is untested" when somebody merely picked a safe
   * target to run against tonight.
   */
  const coverage = useQuery({
    queryKey: ["coverage", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<CoverageView>(`${base}/coverage`),
    retry: false,
  });

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`${base}/runs`, {
        method: "POST",
        body: {
          environmentId,
          order,
          ...(selection.length ? { operationIds: selection } : {}),
          // What is on screen is what gets run. Resolving the filter into the ids it matches today
          // would record «estas treinta» where somebody meant «lo crítico», and the two stop being
          // the same thing the next time an operation is added.
          ...(labelFilter === "Todas" ? {} : { labels: [labelFilter] }),
        },
      }),
    onSuccess: (result) => navigate(`/p/${projectId}/runs/${result.runId}`),
  });

  // Memoised, and not merely tidier: `?? []` builds a new array on every render, so every `useMemo`
  // below it had `operations` in its dependency list and recomputed every time anyway. Three
  // filtered lists over forty-six operations is cheap; a dependency that is never equal to itself
  // is the kind of thing that stops being cheap silently.
  const operations = useMemo(() => scenarios.data?.operations ?? [], [scenarios.data]);
  const tags = useMemo(
    () => ["Todos", ...new Set(operations.map((operation) => operation.tag).filter(Boolean))],
    [operations],
  );
  /** The team's own words, kept in their own control and never merged into the tag list: they
   * answer different questions, and one dropdown holding both would make «Pedidos» and «crítico»
   * look like alternatives. Drawn only when the project has written some. */
  const labels = useMemo(
    () => [...new Set(operations.flatMap((operation) => operation.labels ?? []))].sort(),
    [operations],
  );
  const visible = useMemo(
    () =>
      operations.filter(
        (operation) =>
          (tag === "Todos" || operation.tag === tag) &&
          // Both filters narrow together, exactly as they do when a run is selected by them.
          (labelFilter === "Todas" || (operation.labels ?? []).includes(labelFilter)) &&
          `${operation.method} ${operation.path} ${operation.summary}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [operations, tag, labelFilter, search],
  );

  const current = operations.find((operation) => operation.id === selectedOperation) ?? visible[0];
  const currentCase = current?.scenarios.find((scenario) => scenario.id === selectedCase) ?? current?.scenarios[0];
  const selectedCases = selection.length
    ? operations
        .filter((operation) => selection.includes(operation.id))
        .reduce((sum, operation) => sum + operation.scenarios.length, 0)
    : (scenarios.data?.totals.cases ?? 0);

  if (scenarios.isLoading) return <p className="text-sm text-slate-500">Cargando la matriz…</p>;

  if (scenarios.error) {
    // The one error worth its own screen: a project with no contract has no matrix, and an empty
    // grid would read as full coverage of nothing.
    return (
      <Empty
        title="Este proyecto todavía no tiene contrato"
        hint="Importa un documento OpenAPI y la matriz aparece sola. Lo que el contrato declara —los estados, los parámetros, las respuestas de error— no hay que escribirlo a mano."
        action={<Button onClick={() => navigate(`/p/${projectId}/config`)}>Ir a configuración</Button>}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs text-slate-600">
              Entorno
              <select
                className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-sm"
                value={environmentId}
                onChange={(event) => {
                  setEnvironmentId(event.target.value);
                  if (event.target.value) setActiveEnvironment(event.target.value);
                }}
              >
                {/* Without an environment the matrix shows what the contract declares. That is the
                    honest answer to "what could be tested", as opposed to "what will run tonight". */}
                <option value="">Ninguno · todo el contrato</option>
                {environments.data?.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-slate-600">
              Orden
              <select
                className="mt-1 block h-9 rounded-lg border border-slate-200 px-2 text-sm"
                value={order}
                onChange={(event) => setOrder(event.target.value as "safe" | "contract")}
              >
                <option value="safe">Lecturas primero</option>
                <option value="contract">Orden del contrato</option>
              </select>
            </label>
          </div>

          <div className="flex items-end gap-3">
            <div className="text-right text-xs text-slate-500">
              <p>
                <span className="font-mono text-sm text-slate-900">{scenarios.data?.totals.operations}</span>{" "}
                operaciones · <span className="font-mono text-sm text-slate-900">{scenarios.data?.totals.cases}</span>{" "}
                casos
              </p>
              {scenarios.data?.totals.blocked ? (
                <p className="text-amber-600">{scenarios.data.totals.blocked} no se ejecutarán en este entorno</p>
              ) : null}
              {coverage.data ? (
                <p
                  className={coverage.data.totals.uncovered ? "text-amber-600" : "text-emerald-600"}
                  // The gaps are named in the tooltip rather than only counted: "one response has
                  // no case" is a number, "the 503 of GET /health has no case" is a decision
                  // somebody can look at and either accept or fix.
                  title={
                    coverage.data.gaps.length
                      ? coverage.data.gaps.map((gap) => `${gap.status} · ${gap.method} ${gap.path}`).join("\n")
                      : "todas las respuestas declaradas tienen caso"
                  }
                >
                  {coverage.data.totals.covered}/{coverage.data.totals.declaredResponses} respuestas del contrato con
                  caso
                </p>
              ) : null}
            </div>
            {canRun && (
              <Button
                disabled={!environmentId || start.isPending}
                onClick={() => start.mutate()}
                title={environmentId ? undefined : "Elige un entorno para ejecutar"}
              >
                Ejecutar {selection.length ? `${selection.length} operaciones` : "todo"} · {selectedCases} casos
              </Button>
            )}
          </div>
        </div>
        {order === "safe" && (
          <p className="mt-3 text-[11px] leading-5 text-slate-500">
            GET, POST, PUT, PATCH y por último DELETE. Un DELETE que borra de más no puede dejar en rojo a los casos que
            vienen después, porque ya no queda ninguno.
          </p>
        )}
        {start.error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{(start.error as Error).message}</p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <div className="flex gap-2 border-b border-slate-100 p-3">
            <input
              className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-900"
              placeholder="Buscar operación"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Etiqueta del contrato"
              className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
            >
              {tags.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
            {labels.length > 0 && (
              <select
                aria-label="Etiqueta propia"
                className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                value={labelFilter}
                onChange={(event) => setLabelFilter(event.target.value)}
              >
                {["Todas", ...labels].map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            )}
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {visible.map((operation) => (
              <OperationRow
                key={operation.id}
                operation={operation}
                active={current?.id === operation.id}
                checked={selection.includes(operation.id)}
                onToggle={() =>
                  setSelection((current) =>
                    current.includes(operation.id)
                      ? current.filter((id) => id !== operation.id)
                      : [...current, operation.id],
                  )
                }
                onSelect={() => {
                  setSelectedOperation(operation.id);
                  setSelectedCase(null);
                }}
              />
            ))}
          </div>
        </Card>

        {current && <OperationDetail operation={current} scenario={currentCase} onSelectCase={setSelectedCase} />}
      </div>
    </div>
  );
}

function OperationRow({
  operation,
  active,
  checked,
  onToggle,
  onSelect,
}: {
  operation: OperationScenarios;
  active: boolean;
  checked: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const blocked = operation.scenarios.filter((scenario) => !scenario.runnable).length;
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0",
        active && "bg-slate-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3.5 shrink-0 accent-slate-900"
        aria-label={`Seleccionar ${operation.id}`}
      />
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect}>
        <Badge className={cn("w-14 shrink-0 justify-center", methodStyle(operation.method))}>{operation.method}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700">{operation.path}</span>
        <span className="shrink-0 text-[10px] text-slate-400">{operation.scenarios.length}</span>
        {/* `implemented` is a fact about the code, not the contract: an operation the API does not
            route yet is pending, not failing. */}
        {!operation.implemented && (
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] text-slate-500">pendiente</span>
        )}
        {blocked > 0 && (
          <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700">{blocked}⃠</span>
        )}
      </button>
    </div>
  );
}

function OperationDetail({
  operation,
  scenario,
  onSelectCase,
}: {
  operation: OperationScenarios;
  scenario: ScenarioView | undefined;
  onSelectCase: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={cn("justify-center", methodStyle(operation.method))}>{operation.method}</Badge>
          <span className="font-mono text-xs text-slate-800">{operation.path}</span>
          <span className="ml-auto font-mono text-[10px] text-slate-400">{operation.id}</span>
        </div>
        {operation.summary && <p className="mt-2 text-xs text-slate-500">{operation.summary}</p>}
        <p className="mt-1 text-[11px] text-slate-400">
          Envelope esperado: <span className="font-mono">{operation.responseShape}</span>
        </p>
      </div>

      <div className="grid gap-0 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <div className="max-h-[52vh] overflow-y-auto border-b border-slate-100 md:border-b-0 md:border-r">
          {operation.scenarios.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelectCase(item.id)}
              className={cn(
                "block w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0",
                scenario?.id === item.id && "bg-slate-50",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "font-mono text-[10px]",
                    item.expectedStatus < 400 ? "text-emerald-600" : "text-rose-600",
                  )}
                >
                  {item.expectedStatus}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">{item.name}</span>
                {!item.runnable && <span className="text-[10px] text-amber-600">⃠</span>}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4">
          {scenario ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-slate-900">{scenario.name}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{scenario.description}</p>
              </div>

              {/* Blocked is not the same as absent: the case is listed, with which of the two
                  switches it is waiting on, because hiding it would make the matrix look smaller
                  than the contract. */}
              {!scenario.runnable && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{scenario.blockedReason}</p>
              )}

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
                <dt className="text-slate-400">Petición</dt>
                <dd className="truncate font-mono text-slate-700">
                  {operation.method} {scenario.requestPath}
                </dd>
                <dt className="text-slate-400">Espera</dt>
                <dd className="font-mono text-slate-700">{scenario.expectedStatus}</dd>
                <dt className="text-slate-400">Flujo</dt>
                <dd className="font-mono text-slate-700">{scenario.flow}</dd>
                {scenario.auth && (
                  <>
                    <dt className="text-slate-400">Credencial</dt>
                    <dd className="font-mono text-slate-700">{scenario.auth}</dd>
                  </>
                )}
                <dt className="text-slate-400">Presupuesto</dt>
                <dd className="text-slate-700">
                  {/* No published budget means no assertion, and saying so is more honest than a
                      dash that could be read as "met". */}
                  {scenario.budget
                    ? `${scenario.budget.label} (${scenario.budget.source})`
                    : "Sin presupuesto publicado: no se afirma nada sobre la latencia"}
                </dd>
              </dl>

              {scenario.body && <Json value={scenario.body} />}
            </div>
          ) : (
            <p className="text-xs text-slate-500">Esta operación no genera casos.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

export { AssertionRow };
