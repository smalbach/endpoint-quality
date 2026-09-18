/**
 * El guion de un nodo canal: lo que una corrida manda sin nadie delante.
 *
 * Una lista de acciones, en orden, y ninguna más de las tres que el motor entiende: enviar un
 * mensaje, esperar a que lleguen N, y —solo en gRPC— terminar el envío de un stream. Cada fila dice
 * lo que hace en palabras, porque «esperar 1 · 5000» no lo lee nadie.
 */
import { Button, Field, inputClass } from "@/components/ui";
import { MAX_SCRIPT_STEPS, newScriptStep, type ScriptAction, type ScriptStepView } from "@/lib/channel-node-draft";
import type { ChannelView } from "@/lib/types";

const ACTION_LABEL: Record<ScriptAction, string> = {
  send: "Enviar",
  wait: "Esperar mensajes",
  end: "Terminar envío",
};

export function ChannelScriptEditor({
  steps,
  protocol,
  variables,
  canEdit,
  onChange,
}: {
  steps: ScriptStepView[];
  protocol: ChannelView["protocol"] | undefined;
  /** Lo que `{{` puede nombrar aquí: las variables del entorno y las capturadas antes. */
  variables: string[];
  canEdit: boolean;
  onChange: (steps: ScriptStepView[]) => void;
}) {
  const set = (index: number, next: ScriptStepView) => onChange(steps.map((step, at) => (at === index ? next : step)));
  const remove = (index: number) => onChange(steps.filter((_, at) => at !== index));
  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const actions: ScriptAction[] = protocol === "grpc" ? ["send", "wait", "end"] : ["send", "wait"];

  return (
    <div>
      {variables.length > 0 && (
        <p className="mb-2 text-[11px] leading-5 text-slate-500">
          Los mensajes aceptan <span className="font-mono">{"{{variables}}"}</span>:{" "}
          <span className="font-mono">{variables.slice(0, 8).join(", ")}</span>
          {variables.length > 8 && "…"}
        </p>
      )}
      {steps.length === 0 && (
        <p className="text-[11px] leading-5 text-slate-500">
          Sin acciones: la sesión solo escucha hasta que se cumpla lo esperado, cierre el otro lado o salte un tope.
        </p>
      )}
      <ol className="grid gap-3">
        {steps.map((step, index) => (
          <li key={index} className="rounded-lg border border-slate-200 p-3" aria-label={`Acción ${index + 1}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-800">
                {index + 1} · {ACTION_LABEL[step.action]}
              </p>
              {canEdit && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    aria-label="Subir"
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-6 px-1.5 text-xs"
                    aria-label="Bajar"
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-6 px-1.5 text-xs text-rose-600"
                    aria-label={`Quitar la acción ${index + 1}`}
                    onClick={() => remove(index)}
                  >
                    ✕
                  </Button>
                </div>
              )}
            </div>
            {step.action === "send" && (
              <div className="mt-2 grid gap-2">
                <textarea
                  aria-label={`Mensaje ${index + 1}`}
                  className={`${inputClass} h-24 font-mono text-[11px]`}
                  placeholder={protocol === "grpc" ? '{"name": "{{nombre}}"}' : '{"auth": "{{token}}"}'}
                  value={step.body}
                  disabled={!canEdit}
                  spellCheck={false}
                  onChange={(event) => set(index, { ...step, body: event.target.value })}
                />
                <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
                  {protocol === "mqtt" && (
                    <>
                      <Field label="Tema" info="Dónde se publica. Sin comodines (+ ni #), como al publicar a mano.">
                        <input
                          aria-label={`Tema ${index + 1}`}
                          className={`${inputClass} font-mono`}
                          placeholder="casa/salon/temp"
                          value={step.topic ?? ""}
                          disabled={!canEdit}
                          onChange={(event) => set(index, { ...step, topic: event.target.value })}
                        />
                      </Field>
                      <Field label="QoS" info="0: como mucho una vez; 1: al menos una; 2: exactamente una.">
                        <select
                          aria-label={`QoS ${index + 1}`}
                          className={inputClass}
                          value={step.qos ?? 0}
                          disabled={!canEdit}
                          onChange={(event) => set(index, { ...step, qos: Number(event.target.value) as 0 | 1 | 2 })}
                        >
                          <option value={0}>0</option>
                          <option value={1}>1</option>
                          <option value={2}>2</option>
                        </select>
                      </Field>
                      <label className="flex items-end gap-2 pb-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={Boolean(step.retain)}
                          disabled={!canEdit}
                          onChange={(event) => set(index, { ...step, retain: event.target.checked || undefined })}
                        />
                        Retener
                      </label>
                    </>
                  )}
                  {protocol === "socketio" && (
                    <>
                      <Field label="Evento" info="El evento que se emite; el mensaje es su argumento (texto o JSON).">
                        <input
                          aria-label={`Evento ${index + 1}`}
                          className={`${inputClass} font-mono`}
                          placeholder="chat:mensaje"
                          value={step.event ?? ""}
                          disabled={!canEdit}
                          onChange={(event) => set(index, { ...step, event: event.target.value })}
                        />
                      </Field>
                      <label className="flex items-end gap-2 pb-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={Boolean(step.ack)}
                          disabled={!canEdit}
                          onChange={(event) => set(index, { ...step, ack: event.target.checked || undefined })}
                        />
                        Esperar acuse
                      </label>
                    </>
                  )}
                  <Field
                    label="Antes, esperar (ms)"
                    info="Pausa antes de mandar este mensaje (0–30 000 ms). Vacío: sin pausa."
                  >
                    <input
                      aria-label={`Pausa ${index + 1}`}
                      className={inputClass}
                      type="number"
                      min={0}
                      max={30000}
                      placeholder="0"
                      value={step.delayMs ?? ""}
                      disabled={!canEdit}
                      onChange={(event) =>
                        set(index, { ...step, delayMs: event.target.value ? Number(event.target.value) : undefined })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}
            {step.action === "wait" && (
              <div className="mt-2 grid grid-cols-2 gap-2 @3xl:grid-cols-[10rem_12rem]">
                <Field
                  label="Mensajes más"
                  info="Cuántos mensajes nuevos tienen que llegar antes de seguir con el guion."
                >
                  <input
                    aria-label={`Mensajes a esperar ${index + 1}`}
                    className={inputClass}
                    type="number"
                    min={1}
                    max={1000}
                    value={step.messages}
                    disabled={!canEdit}
                    onChange={(event) => set(index, { ...step, messages: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Como mucho (ms)" info="Si no llegan en este tiempo, el guion sigue igual (1–60 000 ms).">
                  <input
                    aria-label={`Tiempo máximo ${index + 1}`}
                    className={inputClass}
                    type="number"
                    min={1}
                    max={60000}
                    value={step.timeoutMs}
                    disabled={!canEdit}
                    onChange={(event) => set(index, { ...step, timeoutMs: Number(event.target.value) })}
                  />
                </Field>
              </div>
            )}
            {step.action === "end" && (
              <p className="mt-1 text-[11px] leading-5 text-slate-500">
                Termina el envío del stream de cliente: el servidor contesta cuando lo recibe. Si el guion no lo pone,
                se termina solo al acabar.
              </p>
            )}
          </li>
        ))}
      </ol>
      {canEdit && steps.length < MAX_SCRIPT_STEPS && (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onChange([...steps, newScriptStep(action, protocol)])}
            >
              + {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
