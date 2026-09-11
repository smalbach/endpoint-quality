/**
 * The configuration, edited as what it means rather than as JSON.
 *
 * Every section was a textarea. That is honest — the document is the truth and the schema is
 * strict — but it puts the burden of knowing the shape on whoever is editing, and the shape is
 * not obvious: a budget rule is `{ id, methods, thresholdMs, label, source }` and nothing on the
 * screen said so. The first configuration written for the demo got it wrong in exactly that way.
 *
 * Two things these editors are careful about:
 *
 * - **Order is data.** Budget rules and envelope rules match first-hit, so the arrows that move a
 *   row are not a display convenience; they decide which rule wins.
 * - **An empty optional is not an absent one.** `pathSuffix: ""` matches every path that ends in
 *   nothing, which is every path, and the schema accepts it. Everything here goes through
 *   `compact` before it is saved.
 *
 * `scenarios` keeps its textarea on purpose: its entries are whole scenario templates — id, name,
 * expected status, flow, auth, body — and a form for that is a worse JSON editor than a JSON
 * editor.
 */
import { useState, type ReactNode } from "react";

import { compact, HTTP_METHODS, move, removeAt, replaceAt, slugId, type HttpMethod } from "@/lib/config-draft";
import { Button } from "@/components/ui";

type Draft = Record<string, unknown>;
type EditorProps = { value: Draft; onChange: (next: Draft) => void; disabled: boolean; operationIds: string[] };

const field =
  "h-8 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-900 disabled:bg-slate-50";
const label = "text-[10px] uppercase tracking-wide text-slate-400";

/** A row of rules with the controls that make order visible. */
function RuleRows({
  rows,
  onChange,
  disabled,
  render,
  onAdd,
  addLabel,
  empty,
}: {
  rows: Record<string, unknown>[];
  onChange: (next: Record<string, unknown>[]) => void;
  disabled: boolean;
  render: (row: Record<string, unknown>, update: (patch: Record<string, unknown>) => void) => ReactNode;
  onAdd: () => Record<string, unknown>;
  addLabel: string;
  empty: string;
}) {
  return (
    <div>
      {rows.length === 0 && <p className="py-2 text-xs text-slate-400">{empty}</p>}
      {rows.map((row, index) => (
        <div key={String(row.id ?? index)} className="flex flex-wrap items-end gap-2 border-b border-slate-100 py-2">
          <span className="w-5 shrink-0 pb-1 text-[10px] text-slate-400">{index + 1}</span>
          {render(row, (patch) => onChange(replaceAt(rows, index, { ...row, ...patch })))}
          <span className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              className="h-7 w-7 p-0 text-xs"
              disabled={disabled || index === 0}
              title="Subir"
              onClick={() => onChange(move(rows, index, -1))}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              className="h-7 w-7 p-0 text-xs"
              disabled={disabled || index === rows.length - 1}
              title="Bajar"
              onClick={() => onChange(move(rows, index, 1))}
            >
              ↓
            </Button>
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs text-rose-600"
              disabled={disabled}
              onClick={() => onChange(removeAt(rows, index))}
            >
              Quitar
            </Button>
          </span>
        </div>
      ))}
      <Button
        variant="ghost"
        className="mt-2 h-7 px-2 text-xs"
        disabled={disabled}
        onClick={() => onChange([...rows, onAdd()])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

/** Which methods a rule names. None selected means «any», which is what the schema's absent
 * `methods` means — so the control says so instead of leaving it blank. */
function Methods({
  value,
  onChange,
  disabled,
}: {
  value: HttpMethod[];
  onChange: (next: HttpMethod[]) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <p className={label}>
        Métodos {value.length === 0 && <span className="normal-case text-slate-400">· cualquiera</span>}
      </p>
      <div className="flex flex-wrap gap-1">
        {HTTP_METHODS.map((method) => {
          const on = value.includes(method);
          return (
            <button
              key={method}
              type="button"
              disabled={disabled}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${on ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}
              onClick={() => onChange(on ? value.filter((entry) => entry !== method) : [...value, method])}
            >
              {method}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A `Record<string, string>`, edited as pairs. Keys are free text because they are whatever the
 * contract calls a parameter. */
function StringMap({
  value,
  onChange,
  disabled,
  keyLabel,
  valueLabel,
  empty,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled: boolean;
  keyLabel: string;
  valueLabel: string;
  empty: string;
}) {
  const entries = Object.entries(value);
  const write = (next: [string, string][]) => onChange(Object.fromEntries(next.filter(([key]) => key.trim() !== "")));

  return (
    <div>
      {entries.length === 0 && <p className="py-1 text-xs text-slate-400">{empty}</p>}
      {entries.map(([key, entry], index) => (
        <div key={index} className="flex items-end gap-2 py-1">
          <div>
            <p className={label}>{keyLabel}</p>
            <input
              className={`${field} w-52 font-mono`}
              value={key}
              disabled={disabled}
              onChange={(event) =>
                write(
                  entries.map((pair, position) => (position === index ? [event.target.value, entry] : pair)) as [
                    string,
                    string,
                  ][],
                )
              }
            />
          </div>
          <div className="flex-1">
            <p className={label}>{valueLabel}</p>
            <input
              className={`${field} w-full font-mono`}
              value={entry}
              disabled={disabled}
              onChange={(event) =>
                write(
                  entries.map((pair, position) => (position === index ? [key, event.target.value] : pair)) as [
                    string,
                    string,
                  ][],
                )
              }
            />
          </div>
          <Button
            variant="ghost"
            className="h-8 px-2 text-xs text-rose-600"
            disabled={disabled}
            onClick={() => write(entries.filter((_pair, position) => position !== index) as [string, string][])}
          >
            Quitar
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        className="mt-1 h-7 px-2 text-xs"
        disabled={disabled}
        onClick={() => onChange({ ...value, "": "" })}
      >
        Añadir
      </Button>
    </div>
  );
}

/** A list of strings, one per line. A textarea and not a row of inputs: these are pasted far more
 * often than they are typed one at a time. */
function StringLines({
  value,
  onChange,
  disabled,
  hint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  hint: string;
}) {
  return (
    <div>
      <p className={label}>{hint}</p>
      <textarea
        className="h-20 w-full rounded-lg border border-slate-200 p-2 font-mono text-[11px] outline-none focus:border-slate-900 disabled:bg-slate-50"
        value={value.join("\n")}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) =>
          onChange(
            event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          )
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function BudgetsEditor({ value, onChange, disabled }: EditorProps) {
  const rows = (value.budgets as Record<string, unknown>[]) ?? [];
  return (
    <RuleRows
      rows={rows}
      disabled={disabled}
      empty="Sin presupuestos: ninguna aserción de latencia se emite, que no es lo mismo que una que pasa."
      addLabel="Añadir presupuesto"
      onAdd={() => ({
        id: slugId(
          "presupuesto",
          rows.map((row) => String(row.id)),
        ),
        thresholdMs: 500,
        label: "Presupuesto",
        source: "manual",
      })}
      onChange={(next) => onChange({ ...value, budgets: next.map((row) => compact(row)) })}
      render={(row, update) => (
        <>
          <div>
            <p className={label}>Etiqueta</p>
            <input
              className={`${field} w-40`}
              value={String(row.label ?? "")}
              disabled={disabled}
              onChange={(event) => update({ label: event.target.value })}
            />
          </div>
          <div>
            <p className={label}>Umbral (ms)</p>
            <input
              className={`${field} w-24`}
              type="number"
              min={1}
              value={Number(row.thresholdMs ?? 0)}
              disabled={disabled}
              onChange={(event) => update({ thresholdMs: Number(event.target.value) })}
            />
          </div>
          <Methods
            value={(row.methods as HttpMethod[]) ?? []}
            disabled={disabled}
            onChange={(methods) => update({ methods })}
          />
          <div>
            <p className={label}>La ruta acaba en</p>
            <input
              className={`${field} w-32 font-mono`}
              value={String(row.pathSuffix ?? "")}
              disabled={disabled}
              onChange={(event) => update({ pathSuffix: event.target.value })}
            />
          </div>
          <div>
            <p className={label}>Origen</p>
            <input
              className={`${field} w-28`}
              value={String(row.source ?? "")}
              disabled={disabled}
              onChange={(event) => update({ source: event.target.value })}
            />
          </div>
        </>
      )}
    />
  );
}

function EnvelopeEditor({ value, onChange, disabled }: EditorProps) {
  const envelope = (value.envelope as Record<string, unknown>) ?? {};
  const rows = (envelope.rules as Record<string, unknown>[]) ?? [];
  const write = (patch: Record<string, unknown>) => onChange({ ...value, envelope: { ...envelope, ...patch } });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <div>
          <p className={label}>Forma por defecto</p>
          <input
            className={`${field} w-40 font-mono`}
            value={String(envelope.fallbackShape ?? "")}
            disabled={disabled}
            onChange={(event) => write({ fallbackShape: event.target.value })}
          />
        </div>
        <div>
          <p className={label}>Forma de un error</p>
          <input
            className={`${field} w-40 font-mono`}
            value={String(envelope.errorShape ?? "")}
            disabled={disabled}
            onChange={(event) => write({ errorShape: event.target.value })}
          />
        </div>
      </div>
      <RuleRows
        rows={rows}
        disabled={disabled}
        empty="Sin reglas: todo usa la forma por defecto."
        addLabel="Añadir regla"
        onAdd={() => ({
          id: slugId(
            "envelope",
            rows.map((row) => String(row.id)),
          ),
          match: {},
          shape: String(envelope.fallbackShape ?? "data"),
        })}
        onChange={(next) => write({ rules: next })}
        render={(row, update) => {
          const match = (row.match as Record<string, unknown>) ?? {};
          const patchMatch = (patch: Record<string, unknown>) => update({ match: compact({ ...match, ...patch }) });
          return (
            <>
              <Methods
                value={(match.methods as HttpMethod[]) ?? []}
                disabled={disabled}
                onChange={(methods) => patchMatch({ methods })}
              />
              <div>
                <p className={label}>La operación empieza por</p>
                <input
                  className={`${field} w-32 font-mono`}
                  value={String(match.operationIdPrefix ?? "")}
                  disabled={disabled}
                  onChange={(event) => patchMatch({ operationIdPrefix: event.target.value })}
                />
              </div>
              <div>
                <p className={label}>La ruta acaba en</p>
                <input
                  className={`${field} w-28 font-mono`}
                  value={String(match.pathSuffix ?? "")}
                  disabled={disabled}
                  onChange={(event) => patchMatch({ pathSuffix: event.target.value })}
                />
              </div>
              <div>
                <p className={label}>Forma</p>
                <input
                  className={`${field} w-32 font-mono`}
                  value={String(row.shape ?? "")}
                  disabled={disabled}
                  onChange={(event) => update({ shape: event.target.value })}
                />
              </div>
            </>
          );
        }}
      />
    </div>
  );
}

/**
 * `implemented` as a checklist against the contract.
 *
 * `null` and «todas marcadas» are different states and the control says so: null means the
 * project has not decided, and every operation runs. An empty list means somebody decided that
 * none of them is implemented, which is a matrix of nothing.
 */
function ImplementedEditor({ value, onChange, disabled, operationIds }: EditorProps) {
  const current = value.implemented as string[] | null;
  const [filter, setFilter] = useState("");
  const shown = operationIds.filter((id) => id.toLowerCase().includes(filter.toLowerCase()));

  if (current === null) {
    return (
      <div className="text-xs text-slate-500">
        <p>Sin decidir: la matriz ejecuta las {operationIds.length} operaciones del contrato.</p>
        <Button
          variant="ghost"
          className="mt-2 h-7 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange({ ...value, implemented: operationIds })}
        >
          Elegir cuáles están implementadas
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${field} w-48`}
          placeholder="Filtrar"
          value={filter}
          disabled={disabled}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="text-[11px] text-slate-500">
          {current.length} de {operationIds.length}
        </span>
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange({ ...value, implemented: operationIds })}
        >
          Todas
        </Button>
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange({ ...value, implemented: [] })}
        >
          Ninguna
        </Button>
        <Button
          variant="ghost"
          className="ml-auto h-7 px-2 text-xs"
          disabled={disabled}
          onClick={() => onChange({ ...value, implemented: null })}
        >
          Volver a «sin decidir»
        </Button>
      </div>
      <div className="mt-2 grid max-h-64 grid-cols-1 gap-x-4 overflow-y-auto sm:grid-cols-2">
        {operationIds.length === 0 && (
          <p className="text-xs text-slate-400">Importa un contrato y aquí saldrán sus operaciones.</p>
        )}
        {shown.map((id) => (
          <label key={id} className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-slate-700">
            <input
              type="checkbox"
              checked={current.includes(id)}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  implemented: event.target.checked ? [...current, id] : current.filter((entry) => entry !== id),
                })
              }
            />
            {id}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Lo que un endpoint dice de sus propios parámetros.
 *
 * Las listas de arriba van por nombre de parámetro, y eso vale hasta que dos endpoints usan el
 * mismo nombre para cosas distintas —que es siempre, en cuanto el contrato crece—. Aquí se acota
 * por operación: el `{id}` que existe en `/widgets/{id}` no es el que existe en `/usuarios/{id}`.
 *
 * Se edita una operación cada vez, elegida de las que el contrato declara, porque la pregunta
 * («¿qué vale esto *aquí*?») se hace sobre un endpoint concreto y no sobre una tabla.
 */
function PerOperationParameters({
  value,
  onChange,
  disabled,
  operationIds,
}: {
  value: Record<string, Draft>;
  onChange: (next: Record<string, Draft>) => void;
  disabled: boolean;
  operationIds: string[];
}) {
  const configured = Object.keys(value);
  const [open, setOpen] = useState(configured[0] ?? "");
  const current = (value[open] ?? {}) as Draft;
  const write = (next: Draft) => {
    // Una entrada que se queda sin nada que decir se va: guardar `{}` por operación llena la
    // sección de ruido que hay que leer para descubrir que no dice nada.
    const clean = Object.fromEntries(Object.entries(next).filter(([, entry]) => entry !== undefined));
    const { [open]: _previous, ...rest } = value;
    onChange(Object.keys(clean).length ? { ...rest, [open]: clean } : rest);
  };

  return (
    <div>
      <p className="text-[11px] text-slate-500">
        Lo que vale un parámetro <span className="font-medium">en un endpoint concreto</span>, cuando la lista de arriba
        no le sirve. Manda lo más estrecho: lo del endpoint, luego lo del proyecto.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <p className={label}>Operación</p>
          <select
            className={`${field} w-64 font-mono`}
            value={open}
            disabled={disabled}
            onChange={(event) => setOpen(event.target.value)}
          >
            <option value="">Elige una…</option>
            {operationIds.map((id) => (
              <option key={id} value={id}>
                {configured.includes(id) ? `• ${id}` : id}
              </option>
            ))}
          </select>
        </div>
        {configured.length > 0 && (
          <p className="pb-1 text-[11px] text-slate-400">
            Con algo dicho: <span className="font-mono">{configured.join(", ")}</span>
          </p>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-slate-200 p-2">
          <div>
            <p className={label}>Identificador que no existe, aquí</p>
            <input
              className={`${field} w-40 font-mono`}
              value={String(current.missingIdValue ?? "")}
              placeholder="(el del proyecto)"
              disabled={disabled}
              onChange={(event) => write({ ...current, missingIdValue: event.target.value || undefined })}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Valores de ruta de esta operación.</p>
          <StringMap
            value={(current.pathDefaults as Record<string, string>) ?? {}}
            disabled={disabled}
            keyLabel="Parámetro"
            valueLabel="Valor"
            empty="Ninguno: usa los del proyecto."
            onChange={(pathDefaults) =>
              write({ ...current, pathDefaults: Object.keys(pathDefaults).length ? pathDefaults : undefined })
            }
          />
          <p className="mt-2 text-[11px] text-slate-500">
            Valores con los que ejercitar un filtro de esta operación, separados por coma.
          </p>
          <StringMap
            value={Object.fromEntries(
              Object.entries((current.parameterSamples as Record<string, unknown[]>) ?? {}).map(([name, samples]) => [
                name,
                samples.map((sample) => String(sample)).join(", "),
              ]),
            )}
            disabled={disabled}
            keyLabel="Filtro"
            valueLabel="Valores"
            empty="Ninguno: usa los del proyecto."
            onChange={(samples) => {
              const parameterSamples = Object.fromEntries(
                Object.entries(samples).map(([name, list]) => [
                  name,
                  list
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean),
                ]),
              );
              write({
                ...current,
                parameterSamples: Object.keys(parameterSamples).length ? parameterSamples : undefined,
              });
            }}
          />
        </div>
      )}
    </div>
  );
}

function ParametersEditor({ value, onChange, disabled, operationIds }: EditorProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <div>
          <p className={label}>Valor de ruta por defecto</p>
          <input
            className={`${field} w-32 font-mono`}
            value={String(value.fallbackPathValue ?? "")}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, fallbackPathValue: event.target.value })}
          />
        </div>
        <div>
          <p className={label}>Identificador que no existe</p>
          <input
            className={`${field} w-32 font-mono`}
            value={String(value.missingIdValue ?? "")}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, missingIdValue: event.target.value })}
          />
        </div>
      </div>
      <div>
        <p className="text-[11px] text-slate-500">
          Valores concretos por parámetro de ruta. Es lo que separa un 404 de verdad de uno que solo dice que el
          identificador era inventado.
        </p>
        <StringMap
          value={(value.pathDefaults as Record<string, string>) ?? {}}
          disabled={disabled}
          keyLabel="Parámetro"
          valueLabel="Valor"
          empty="Ninguno: todos los parámetros usan el valor por defecto."
          onChange={(pathDefaults) => onChange({ ...value, pathDefaults })}
        />
      </div>
      <StringLines
        value={(value.excludeFromSoloScenarios as string[]) ?? []}
        disabled={disabled}
        hint="Parámetros que no generan un caso propio (uno por línea)"
        onChange={(excludeFromSoloScenarios) => onChange({ ...value, excludeFromSoloScenarios })}
      />
      <div className="border-t border-slate-100 pt-3">
        <PerOperationParameters
          value={(value.operationParameters as Record<string, Draft>) ?? {}}
          disabled={disabled}
          operationIds={operationIds}
          onChange={(operationParameters) => onChange({ ...value, operationParameters })}
        />
      </div>
    </div>
  );
}

function AuthorizationEditor({ value, onChange, disabled }: EditorProps) {
  const scopes = (value.scopes as Record<string, unknown>) ?? {};
  const rows = (value.authRules as Record<string, unknown>[]) ?? [];
  return (
    <div className="space-y-3">
      <div>
        <p className={label}>Scope por defecto</p>
        <input
          className={`${field} w-56 font-mono`}
          value={String(scopes.default ?? "")}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, scopes: { ...scopes, default: event.target.value } })}
        />
      </div>
      <RuleRows
        rows={rows}
        disabled={disabled}
        empty="Sin reglas: no se genera ningún caso de autorización."
        addLabel="Añadir regla"
        onAdd={() => ({
          id: slugId(
            "auth",
            rows.map((row) => String(row.id)),
          ),
          credential: "none",
          expectedStatus: 401,
          when: {},
        })}
        onChange={(next) => onChange({ ...value, authRules: next })}
        render={(row, update) => {
          const when = (row.when as Record<string, unknown>) ?? {};
          return (
            <>
              <div>
                <p className={label}>Credencial</p>
                <select
                  className={`${field} w-28`}
                  value={String(row.credential ?? "none")}
                  disabled={disabled}
                  onChange={(event) => update({ credential: event.target.value })}
                >
                  {["none", "insufficient", "api-key"].map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className={label}>Espera</p>
                <input
                  className={`${field} w-20`}
                  type="number"
                  value={Number(row.expectedStatus ?? 401)}
                  disabled={disabled}
                  onChange={(event) => update({ expectedStatus: Number(event.target.value) })}
                />
              </div>
              <div>
                <p className={label}>Si el contrato declara</p>
                <input
                  className={`${field} w-24`}
                  type="number"
                  value={when.declaredStatus === undefined ? "" : Number(when.declaredStatus)}
                  disabled={disabled}
                  onChange={(event) =>
                    update({
                      when: compact({
                        ...when,
                        declaredStatus: event.target.value ? Number(event.target.value) : undefined,
                      }),
                    })
                  }
                />
              </div>
              <Methods
                value={(when.methods as HttpMethod[]) ?? []}
                disabled={disabled}
                onChange={(methods) => update({ when: compact({ ...when, methods }) })}
              />
            </>
          );
        }}
      />
      <StringLines
        value={(value.authExcludedOperationIds as string[]) ?? []}
        disabled={disabled}
        hint="Operaciones sin casos de autorización (una por línea)"
        onChange={(authExcludedOperationIds) => onChange({ ...value, authExcludedOperationIds })}
      />
    </div>
  );
}

function TextEditor({ value, onChange, disabled }: EditorProps) {
  return (
    <div className="space-y-3">
      <div>
        <p className={label}>Idioma</p>
        <select
          className={`${field} w-24`}
          value={String(value.locale ?? "es")}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, locale: event.target.value })}
        >
          <option value="es">es</option>
          <option value="en">en</option>
        </select>
      </div>
      <StringMap
        value={(value.text as Record<string, string>) ?? {}}
        disabled={disabled}
        keyLabel="Clave"
        valueLabel="Texto"
        empty="Ninguno: se usan los textos del motor."
        onChange={(text) => onChange({ ...value, text })}
      />
    </div>
  );
}

/** Which sections have a visual editor, and which deliberately do not. */
/**
 * Quién puede llegar a qué, dibujado como lo que es: una rejilla.
 *
 * Es la sección que menos se puede dejar en un textarea de JSON. Las otras dos que lo conservan
 * guardan JSON arbitrario por definición —plantillas de escenario, payloads enteros— y un
 * formulario sobre eso es un editor de JSON peor que un editor de JSON. Esto es lo contrario: roles
 * por operaciones, tres estados por celda, y escribirlo a mano es contar corchetes.
 *
 * **Tres estados y no dos.** «Sin decidir» no es «no debe pasar»: un rol que no aparece en ninguna
 * lista es uno sobre el que este proyecto todavía no ha decidido, y el generador no le hace ningún
 * caso. Una rejilla de casillas —marcada o no— no podría decirlo, y convertiría cada silencio en
 * una afirmación que nadie escribió.
 */
function AccessEditor({ value, onChange, disabled, operationIds }: EditorProps) {
  const access = (value.access as Record<string, unknown>) ?? {};
  const roles = (access.roles as string[]) ?? [];
  const rules = (access.rules as Record<string, unknown>[]) ?? [];
  const crossRole = (access.crossRole as Record<string, unknown>[]) ?? [];
  const denied = (access.deniedStatuses as number[]) ?? [403, 404];
  const edit = (patch: Record<string, unknown>) => onChange({ ...value, access: { ...access, ...patch } });

  /** The three states of a cell, as the two stored lists see them. */
  const stateOf = (operationId: string, role: string): "allow" | "deny" | "" => {
    const rule = rules.find((item) => item.operationId === operationId);
    if ((rule?.allow as string[] | undefined)?.includes(role)) return "allow";
    if ((rule?.deny as string[] | undefined)?.includes(role)) return "deny";
    return "";
  };

  /** Writing a cell rewrites the operation's rule, and drops it when it stops saying anything —
   * a rule with two empty lists is refused on save, and leaving one behind would make the section
   * unsavable from a click that looks like an undo. */
  const setCell = (operationId: string, role: string, state: "allow" | "deny" | "") => {
    const rest = rules.filter((item) => item.operationId !== operationId);
    const rule = rules.find((item) => item.operationId === operationId);
    const without = (list: unknown) => ((list as string[] | undefined) ?? []).filter((name) => name !== role);
    const allow = state === "allow" ? [...without(rule?.allow), role] : without(rule?.allow);
    const deny = state === "deny" ? [...without(rule?.deny), role] : without(rule?.deny);
    const next = allow.length || deny.length ? [...rest, { operationId, allow, deny }] : rest;
    edit({ rules: next });
  };

  return (
    <div className="space-y-3">
      <div>
        <p className={label}>Roles del proyecto</p>
        <input
          className={`${field} w-full font-mono`}
          value={roles.join(", ")}
          placeholder="vendedor, comprador, admin"
          disabled={disabled}
          onChange={(event) =>
            edit({
              roles: event.target.value
                .split(",")
                .map((role) => role.trim())
                .filter(Boolean),
            })
          }
        />
        <p className="mt-1 text-[10px] leading-4 text-slate-400">
          Se declaran aquí y no se leen de las credenciales de un entorno: «esta API tiene estos roles» es verdad del
          proyecto, y «este token es el del vendedor» lo es de un entorno. Cada entorno guarda una credencial por rol.
        </p>
      </div>

      <div>
        <p className={label}>Qué cuenta como rechazo</p>
        <input
          className={`${field} w-40 font-mono`}
          value={denied.join(", ")}
          disabled={disabled}
          onChange={(event) =>
            edit({
              deniedStatuses: event.target.value
                .split(",")
                .map((code) => Number(code.trim()))
                .filter((code) => Number.isInteger(code)),
            })
          }
        />
        <p className="mt-1 max-w-2xl text-[10px] leading-4 text-slate-400">
          403 y 404 por defecto. Una API bien hecha esconde la existencia —pedir lo de otro debe ser 404, porque un 403
          confirma que el id existe—, así que exigir uno solo pondría en rojo un estilo y no un permiso.
        </p>
      </div>

      {roles.length === 0 ? (
        <p className="text-xs text-slate-500">Escribe los roles para dibujar la matriz.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-2 py-1.5 text-left text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                  Operación
                </th>
                {roles.map((role) => (
                  <th
                    key={role}
                    className="px-2 py-1.5 text-left text-[10px] font-semibold tracking-wide text-slate-500 uppercase"
                  >
                    {role}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {operationIds.map((operationId) => (
                <tr key={operationId} className="border-b border-slate-100 last:border-b-0">
                  <td className="px-2 py-1 font-mono text-[11px] text-slate-600">{operationId}</td>
                  {roles.map((role) => (
                    <td key={role} className="px-2 py-1">
                      <select
                        aria-label={`${operationId} para ${role}`}
                        className={`${field} w-32`}
                        value={stateOf(operationId, role)}
                        disabled={disabled}
                        onChange={(event) => setCell(operationId, role, event.target.value as "allow" | "deny" | "")}
                      >
                        <option value="">sin decidir</option>
                        <option value="allow">debe pasar</option>
                        <option value="deny">no debe pasar</option>
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <p className={label}>Entre roles</p>
        <p className="mb-1 max-w-2xl text-[10px] leading-4 text-slate-400">
          Se crea un recurso como el primer rol y se intenta alcanzar como el segundo. Es el fallo que una petición
          suelta no enseña: todos los códigos correctos, el esquema válido, y alguien leyendo lo de otro.
        </p>
        <RuleRows
          rows={crossRole}
          disabled={disabled}
          empty="Sin reglas entre roles."
          addLabel="Añadir regla entre roles"
          onAdd={() => ({
            source: roles[0] ?? "",
            target: roles[1] ?? "",
            createOperationId: operationIds[0] ?? "",
            operationId: operationIds[0] ?? "",
            allowed: false,
          })}
          onChange={(next) => edit({ crossRole: next })}
          render={(row, update) => (
            <>
              <div>
                <p className={label}>Lo crea</p>
                <select
                  className={`${field} w-28`}
                  value={String(row.source ?? "")}
                  disabled={disabled}
                  onChange={(event) => update({ source: event.target.value })}
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className={label}>Creando con</p>
                <select
                  className={`${field} w-44`}
                  value={String(row.createOperationId ?? "")}
                  disabled={disabled}
                  onChange={(event) => update({ createOperationId: event.target.value })}
                >
                  {operationIds.map((operationId) => (
                    <option key={operationId} value={operationId}>
                      {operationId}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className={label}>Lo intenta</p>
                <select
                  className={`${field} w-28`}
                  value={String(row.target ?? "")}
                  disabled={disabled}
                  onChange={(event) => update({ target: event.target.value })}
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className={label}>Sobre</p>
                <select
                  className={`${field} w-44`}
                  value={String(row.operationId ?? "")}
                  disabled={disabled}
                  onChange={(event) => update({ operationId: event.target.value })}
                >
                  {operationIds.map((operationId) => (
                    <option key={operationId} value={operationId}>
                      {operationId}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className={label}>Y</p>
                <select
                  className={`${field} w-36`}
                  value={row.allowed === true ? "si" : "no"}
                  disabled={disabled}
                  onChange={(event) => update({ allowed: event.target.value === "si" })}
                >
                  <option value="no">no debe verlo</option>
                  <option value="si">sí debe verlo</option>
                </select>
              </div>
            </>
          )}
        />
      </div>
    </div>
  );
}

export const SECTION_EDITORS: Record<string, ((props: EditorProps) => ReactNode) | undefined> = {
  budgets: BudgetsEditor,
  envelope: EnvelopeEditor,
  implemented: ImplementedEditor,
  parameters: ParametersEditor,
  authorization: AuthorizationEditor,
  access: AccessEditor,
  text: TextEditor,
};
