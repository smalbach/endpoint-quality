/**
 * The plan, as a form: scenarios and their requests, the shape of the load, and the limits.
 *
 * Structured and not a JSON box, because the plan is the part somebody tunes between runs — a weight,
 * a think time, one more threshold — and a text area turns every tweak into a chance to break the
 * document. The nested extract/check rows sit behind a details toggle: they matter, but they are not
 * what somebody reads first.
 */
import { useState, type ReactNode } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import { PROFILE_LABEL, emptyScenario } from "@/lib/performance";
import type {
  LoadProfileView,
  PerformanceCheckView,
  PerformancePlanDefinitionView,
  PerformanceRequestView,
  PerformanceScenarioView,
  PerfCheckOperatorView,
  PerfCheckSourceView,
} from "@/lib/types";

const CHECK_SOURCES: PerfCheckSourceView[] = ["status", "durationMs", "body"];
const CHECK_OPERATORS: PerfCheckOperatorView[] = [
  "equals",
  "not_equals",
  "less_than",
  "greater_than",
  "contains",
  "exists",
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function PerformancePlanEditor({
  definition,
  canEdit,
  onChange,
}: {
  definition: PerformancePlanDefinitionView;
  canEdit: boolean;
  onChange: (next: PerformancePlanDefinitionView) => void;
}) {
  const setProfile = (profile: LoadProfileView) => onChange({ ...definition, profile });
  const setScenarios = (scenarios: PerformanceScenarioView[]) => onChange({ ...definition, scenarios });
  const setThreshold = (key: keyof PerformancePlanDefinitionView["thresholds"], value: number | undefined) => {
    const thresholds = { ...definition.thresholds };
    if (value === undefined || Number.isNaN(value)) delete thresholds[key];
    else thresholds[key] = value;
    onChange({ ...definition, thresholds });
  };

  return (
    <div className="space-y-4">
      <ProfileEditor profile={definition.profile} canEdit={canEdit} onChange={setProfile} />

      <section>
        <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Umbrales</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <ThresholdInput
            label="p95 (ms)"
            value={definition.thresholds.p95Ms}
            canEdit={canEdit}
            onChange={(v) => setThreshold("p95Ms", v)}
          />
          <ThresholdInput
            label="p99 (ms)"
            value={definition.thresholds.p99Ms}
            canEdit={canEdit}
            onChange={(v) => setThreshold("p99Ms", v)}
          />
          <ThresholdInput
            label="Tasa de error máx. (%)"
            value={
              definition.thresholds.maxErrorRate === undefined ? undefined : definition.thresholds.maxErrorRate * 100
            }
            canEdit={canEdit}
            onChange={(v) => setThreshold("maxErrorRate", v === undefined ? undefined : v / 100)}
          />
          <ThresholdInput
            label="req/s mín."
            value={definition.thresholds.minRps}
            canEdit={canEdit}
            onChange={(v) => setThreshold("minRps", v)}
          />
        </div>
        <p className="mt-1 text-[10px] text-slate-400">Un umbral vacío no se comprueba.</p>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Escenarios</p>
          {canEdit && (
            <Button
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() =>
                setScenarios([
                  ...definition.scenarios,
                  emptyScenario(`s${definition.scenarios.length + 1}-${Date.now().toString(36)}`),
                ])
              }
            >
              + Escenario
            </Button>
          )}
        </div>
        <div className="mt-2 space-y-2">
          {definition.scenarios.map((scenario, index) => (
            <ScenarioEditor
              key={scenario.id}
              scenario={scenario}
              canEdit={canEdit}
              onChange={(next) =>
                setScenarios(definition.scenarios.map((item, position) => (position === index ? next : item)))
              }
              onRemove={() => setScenarios(definition.scenarios.filter((_item, position) => position !== index))}
            />
          ))}
          {definition.scenarios.length === 0 && <p className="text-[11px] text-slate-400">Ningún escenario todavía.</p>}
        </div>
      </section>
    </div>
  );
}

function ProfileEditor({
  profile,
  canEdit,
  onChange,
}: {
  profile: LoadProfileView;
  canEdit: boolean;
  onChange: (profile: LoadProfileView) => void;
}) {
  const changeType = (type: LoadProfileView["type"]) => {
    if (type === profile.type) return;
    const durationS = profile.durationS;
    if (type === "constant") onChange({ type, vus: 10, durationS });
    else if (type === "ramp") onChange({ type, startVus: 0, endVus: 50, durationS });
    else onChange({ type, baseVus: 5, peakVus: 50, durationS });
  };

  return (
    <section>
      <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Carga</p>
      <div className="mt-2 flex gap-1">
        {(["constant", "ramp", "spike"] as const).map((type) => (
          <button
            key={type}
            disabled={!canEdit}
            onClick={() => changeType(type)}
            className={cn(
              "flex-1 rounded-md border px-2 py-1 text-xs",
              profile.type === type
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 text-slate-600 hover:bg-slate-50",
            )}
          >
            {PROFILE_LABEL[type]}
          </button>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {profile.type === "constant" && (
          <NumberField
            label="Usuarios"
            value={profile.vus}
            canEdit={canEdit}
            onChange={(v) => onChange({ ...profile, vus: v })}
          />
        )}
        {profile.type === "ramp" && (
          <>
            <NumberField
              label="De"
              value={profile.startVus}
              canEdit={canEdit}
              onChange={(v) => onChange({ ...profile, startVus: v })}
            />
            <NumberField
              label="A"
              value={profile.endVus}
              canEdit={canEdit}
              onChange={(v) => onChange({ ...profile, endVus: v })}
            />
          </>
        )}
        {profile.type === "spike" && (
          <>
            <NumberField
              label="Base"
              value={profile.baseVus}
              canEdit={canEdit}
              onChange={(v) => onChange({ ...profile, baseVus: v })}
            />
            <NumberField
              label="Pico"
              value={profile.peakVus}
              canEdit={canEdit}
              onChange={(v) => onChange({ ...profile, peakVus: v })}
            />
          </>
        )}
        <NumberField
          label="Duración (s)"
          value={profile.durationS}
          canEdit={canEdit}
          onChange={(v) => onChange({ ...profile, durationS: v })}
        />
      </div>
    </section>
  );
}

function ScenarioEditor({
  scenario,
  canEdit,
  onChange,
  onRemove,
}: {
  scenario: PerformanceScenarioView;
  canEdit: boolean;
  onChange: (next: PerformanceScenarioView) => void;
  onRemove: () => void;
}) {
  const setRequests = (requests: PerformanceRequestView[]) => onChange({ ...scenario, requests });
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <div className="flex items-center gap-2">
        <input
          className={inputClass}
          value={scenario.name}
          disabled={!canEdit}
          placeholder="Nombre"
          onChange={(event) => onChange({ ...scenario, name: event.target.value })}
        />
        {canEdit && (
          <button className="shrink-0 px-1 text-[11px] text-rose-600 hover:underline" onClick={onRemove}>
            Eliminar
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <NumberField
          label="Peso"
          value={scenario.weight}
          canEdit={canEdit}
          onChange={(v) => onChange({ ...scenario, weight: v })}
        />
        <NumberField
          label="Think (ms)"
          value={scenario.thinkMs}
          canEdit={canEdit}
          onChange={(v) => onChange({ ...scenario, thinkMs: v })}
        />
      </div>
      <div className="mt-2 space-y-2">
        {scenario.requests.map((requestItem, index) => (
          <RequestEditor
            key={index}
            request={requestItem}
            canEdit={canEdit}
            onChange={(next) =>
              setRequests(scenario.requests.map((item, position) => (position === index ? next : item)))
            }
            onRemove={() => setRequests(scenario.requests.filter((_item, position) => position !== index))}
          />
        ))}
      </div>
      {canEdit && (
        <Button
          variant="ghost"
          className="mt-2 h-7 px-2 text-[11px]"
          onClick={() => setRequests([...scenario.requests, { method: "GET", path: "/" }])}
        >
          + Petición
        </Button>
      )}
    </div>
  );
}

function RequestEditor({
  request,
  canEdit,
  onChange,
  onRemove,
}: {
  request: PerformanceRequestView;
  canEdit: boolean;
  onChange: (next: PerformanceRequestView) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const extract = request.extract ?? [];
  const checks = request.checks ?? [];
  return (
    <div className="rounded-md bg-slate-50 p-2">
      <div className="flex items-center gap-1">
        <select
          className="h-8 rounded-md border border-slate-200 bg-white px-1 text-[11px]"
          value={request.method}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...request, method: event.target.value })}
        >
          {METHODS.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
        <input
          className={`${inputClass} font-mono text-[11px]`}
          value={request.path}
          disabled={!canEdit}
          placeholder="/ruta/{{var}}"
          onChange={(event) => onChange({ ...request, path: event.target.value })}
        />
        <button
          className="shrink-0 px-1 text-[11px] text-slate-400 hover:text-slate-700"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "−" : "…"}
        </button>
        {canEdit && (
          <button className="shrink-0 px-1 text-[11px] text-rose-600" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 border-t border-slate-200 pt-2">
          <RowList
            title="Extrae"
            addLabel="+ Extraer"
            canEdit={canEdit}
            rows={extract.map((item, index) => (
              <div key={index} className="flex gap-1">
                <input
                  className={`${inputClass} text-[11px]`}
                  placeholder="variable"
                  value={item.variable}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onChange({
                      ...request,
                      extract: extract.map((e, p) => (p === index ? { ...e, variable: event.target.value } : e)),
                    })
                  }
                />
                <input
                  className={`${inputClass} font-mono text-[11px]`}
                  placeholder="data.id"
                  value={item.path}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onChange({
                      ...request,
                      extract: extract.map((e, p) => (p === index ? { ...e, path: event.target.value } : e)),
                    })
                  }
                />
                {canEdit && (
                  <button
                    className="px-1 text-[11px] text-rose-600"
                    onClick={() => onChange({ ...request, extract: extract.filter((_e, p) => p !== index) })}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            onAdd={() => onChange({ ...request, extract: [...extract, { variable: "", path: "" }] })}
          />
          <RowList
            title="Comprueba"
            addLabel="+ Comprobar"
            canEdit={canEdit}
            rows={checks.map((item, index) => (
              <CheckRow
                key={index}
                check={item}
                canEdit={canEdit}
                onChange={(next) => onChange({ ...request, checks: checks.map((c, p) => (p === index ? next : c)) })}
                onRemove={() => onChange({ ...request, checks: checks.filter((_c, p) => p !== index) })}
              />
            ))}
            onAdd={() =>
              onChange({ ...request, checks: [...checks, { source: "status", operator: "equals", value: 200 }] })
            }
          />
        </div>
      )}
    </div>
  );
}

function CheckRow({
  check,
  canEdit,
  onChange,
  onRemove,
}: {
  check: PerformanceCheckView;
  canEdit: boolean;
  onChange: (next: PerformanceCheckView) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <select
        className="h-8 rounded-md border border-slate-200 bg-white px-1 text-[11px]"
        value={check.source}
        disabled={!canEdit}
        onChange={(event) => onChange({ ...check, source: event.target.value as PerfCheckSourceView })}
      >
        {CHECK_SOURCES.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </select>
      {check.source === "body" && (
        <input
          className={`${inputClass} w-24 font-mono text-[11px]`}
          placeholder="ruta"
          value={check.path ?? ""}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...check, path: event.target.value })}
        />
      )}
      <select
        className="h-8 rounded-md border border-slate-200 bg-white px-1 text-[11px]"
        value={check.operator}
        disabled={!canEdit}
        onChange={(event) => onChange({ ...check, operator: event.target.value as PerfCheckOperatorView })}
      >
        {CHECK_OPERATORS.map((operator) => (
          <option key={operator} value={operator}>
            {operator}
          </option>
        ))}
      </select>
      {check.operator !== "exists" && (
        <input
          className={`${inputClass} w-20 text-[11px]`}
          placeholder="valor"
          value={check.value === undefined ? "" : String(check.value)}
          disabled={!canEdit}
          onChange={(event) => onChange({ ...check, value: event.target.value })}
        />
      )}
      {canEdit && (
        <button className="px-1 text-[11px] text-rose-600" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}

function RowList({
  title,
  addLabel,
  rows,
  canEdit,
  onAdd,
}: {
  title: string;
  addLabel: string;
  rows: ReactNode[];
  canEdit: boolean;
  onAdd: () => void;
}) {
  return (
    <div>
      <p className="text-[10px] text-slate-400">{title}</p>
      <div className="mt-1 space-y-1">{rows}</div>
      {canEdit && (
        <button className="mt-1 text-[10px] text-slate-500 hover:text-slate-800" onClick={onAdd}>
          {addLabel}
        </button>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  canEdit,
  onChange,
}: {
  label: string;
  value: number;
  canEdit: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        className={inputClass}
        type="number"
        min={0}
        value={value}
        disabled={!canEdit}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
      />
    </Field>
  );
}

function ThresholdInput({
  label,
  value,
  canEdit,
  onChange,
}: {
  label: string;
  value: number | undefined;
  canEdit: boolean;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      <input
        className={inputClass}
        type="number"
        min={0}
        value={value ?? ""}
        placeholder="—"
        disabled={!canEdit}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
      />
    </Field>
  );
}
