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

function ParametersEditor({ value, onChange, disabled }: EditorProps) {
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
export const SECTION_EDITORS: Record<string, ((props: EditorProps) => ReactNode) | undefined> = {
  budgets: BudgetsEditor,
  envelope: EnvelopeEditor,
  implemented: ImplementedEditor,
  parameters: ParametersEditor,
  authorization: AuthorizationEditor,
  text: TextEditor,
};
