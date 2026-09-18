/**
 * Los monitores del proyecto: las corridas que se lanzan solas.
 *
 * Lo primero que se ve de cada uno es **si va bien ahora y desde cuándo va mal**, porque es lo único
 * que se quiere saber al abrir esta pantalla. Después, cuándo le toca; y en tercer lugar, cómo está
 * configurado — que es lo que se mira una vez y no se vuelve a mirar.
 *
 * Tres cosas de esta pantalla no son decoración:
 *
 * - **La racha de fallos sale aunque no haya ningún canal de aviso.** Un monitor que lleva cuatro
 *   turnos en rojo y no avisa a nadie es peor que uno que no existe, y verlo aquí es lo que hace que
 *   alguien configure el aviso.
 * - **«Correr ahora» no reprograma.** El botón dice correr, así que el turno siguiente no se mueve.
 *   Y se puede saltar igual si la anterior no ha terminado: eso se dice en la vuelta.
 * - **El aviso pide el nombre de una variable, no una URL.** La pantalla no tiene ningún campo donde
 *   pegar una URL de webhook, y eso es a propósito: quien la tiene puede escribir en ese canal. El
 *   correo sí se escribe aquí tal cual, y no es una excepción descuidada: una dirección no autoriza
 *   nada, y verla es lo que permite saber a quién se está despertando.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, inputClass } from "@/components/ui";
import { ConfirmDialog, Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/format";
import { ChannelScriptEditor } from "@/components/channel-script-editor";
import { PROTOCOL_LABEL, type ScriptStepView } from "@/lib/channel-node-draft";
import type {
  ChannelListView,
  ChannelView,
  Environment,
  MonitorAlertView,
  MonitorExecutionView,
  MonitorListView,
  MonitorOutcomeView,
  MonitorPlanView,
  MonitorScheduleView,
  MonitorView,
  WorkflowsView,
} from "@/lib/types";

const MIN_INTERVAL_MINUTES = 5;

/** Las mismas dos expresiones y el mismo tope que valida la API, para decirlo antes de enviarlo. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const EMAIL_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const MAX_ALERT_RECIPIENTS = 5;

/** Los intervalos que la gente pide de verdad. Un campo libre invita a poner «1». */
const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "cada 5 minutos" },
  { minutes: 15, label: "cada 15 minutos" },
  { minutes: 30, label: "cada 30 minutos" },
  { minutes: 60, label: "cada hora" },
  { minutes: 360, label: "cada 6 horas" },
  { minutes: 1440, label: "cada día" },
];

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

const OUTCOME_TONE: Record<MonitorOutcomeView, string> = {
  running: "border-sky-200 bg-sky-50 text-sky-800",
  passed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-rose-200 bg-rose-50 text-rose-800",
  error: "border-rose-200 bg-rose-50 text-rose-800",
  skipped: "border-slate-200 bg-slate-50 text-slate-600",
};

const OUTCOME_LABEL: Record<MonitorOutcomeView, string> = {
  running: "corriendo",
  passed: "verde",
  failed: "rojo",
  error: "error",
  skipped: "saltada",
};

export function MonitorsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const client = useQueryClient();
  const toast = useToast();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const enabled = Boolean(organization && projectId);

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MonitorView | null>(null);
  const [deleting, setDeleting] = useState<MonitorView | null>(null);

  const list = useQuery({
    queryKey: ["monitors", projectId],
    enabled,
    queryFn: () => api<MonitorListView>(`${base}/monitors`),
    // Una vuelta en marcha cambia de estado sola: sin esto habría que recargar para verla acabar.
    refetchInterval: 10_000,
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    enabled,
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const flows = useQuery({
    queryKey: ["workflows", projectId],
    enabled,
    queryFn: () => api<WorkflowsView>(`${base}/workflows`),
  });
  // La misma clave que la pantalla de canales y el nodo del lienzo: un canal recién creado sale aquí.
  const channels = useQuery({
    queryKey: ["channels", projectId],
    enabled,
    queryFn: () => api<ChannelListView>(`${base}/channels`),
  });

  const refresh = () => client.invalidateQueries({ queryKey: ["monitors", projectId] });

  const toggle = useMutation({
    mutationFn: (monitor: MonitorView) =>
      api<MonitorView>(`${base}/monitors/${monitor.id}`, { method: "PATCH", body: { enabled: !monitor.enabled } }),
    onSuccess: async (_result, monitor) => {
      await refresh();
      toast.success(monitor.enabled ? `«${monitor.name}» pausado` : `«${monitor.name}» activo`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const runNow = useMutation({
    mutationFn: (monitor: MonitorView) =>
      api<{ runId: string | null; outcome: string; note: string }>(`${base}/monitors/${monitor.id}/runs`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async (result) => {
      await refresh();
      if (result.runId) toast.success("Corrida lanzada");
      else toast.error(result.note || "No se pudo lanzar");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (monitor: MonitorView) => api<void>(`${base}/monitors/${monitor.id}`, { method: "DELETE" }),
    onSuccess: async (_result, monitor) => {
      setDeleting(null);
      await refresh();
      toast.success(`«${monitor.name}» eliminado`);
    },
    onError: (error: Error) => {
      setDeleting(null);
      toast.error(error.message);
    },
  });

  const monitors = list.data?.monitors ?? [];
  const noEnvironments = environments.isSuccess && (environments.data?.length ?? 0) === 0;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Monitores</h1>
          <p className="mt-1 max-w-xl text-xs text-slate-500">
            Una corrida guardada que se lanza sola cada tanto y avisa cuando se pone en rojo. Es la misma corrida que el
            botón de ejecutar, con el mismo plan y el mismo entorno.
          </p>
        </div>
        {canEdit && !noEnvironments && <Button onClick={() => setCreating(true)}>Crear un monitor</Button>}
      </div>

      {noEnvironments && (
        <Card className="p-4">
          <p className="text-sm text-slate-800">Este proyecto no tiene ningún entorno todavía.</p>
          <p className="mt-1 text-xs text-slate-500">
            Un monitor corre contra un entorno concreto: la URL y las credenciales salen de ahí. Se crean en Settings →
            Entornos.
          </p>
        </Card>
      )}

      {monitors.length === 0 ? (
        !noEnvironments && (
          <Empty
            title={list.isPending ? "…" : "Sin monitores"}
            hint="Nada corre solo hasta que se crea un monitor. Crear uno no lanza nada: el primer turno es el siguiente del horario."
          />
        )
      ) : (
        <div className="space-y-2">
          {monitors.map((monitor) => (
            <Card key={monitor.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">{monitor.name}</p>
                {monitor.lastOutcome && (
                  <Badge className={OUTCOME_TONE[monitor.lastOutcome]}>{OUTCOME_LABEL[monitor.lastOutcome]}</Badge>
                )}
                {!monitor.enabled && <Badge className="border-slate-200 bg-slate-100 text-slate-500">pausado</Badge>}
                {monitor.consecutiveFailures > 0 && (
                  <Badge className="border-rose-200 bg-rose-50 text-rose-800">
                    {monitor.consecutiveFailures} fallo{monitor.consecutiveFailures === 1 ? "" : "s"} seguido
                    {monitor.consecutiveFailures === 1 ? "" : "s"}
                  </Badge>
                )}
                <span className="ml-auto text-[11px] text-slate-400">{monitor.scheduleLabel}</span>
              </div>

              <p className="text-[11px] text-slate-500">
                {monitor.enabled && monitor.nextRunAt
                  ? `Le toca el ${formatDate(monitor.nextRunAt)}.`
                  : "Pausado: no le toca nunca."}
                {monitor.lastRunAt && ` Última vez, el ${formatDate(monitor.lastRunAt)}.`}
                {monitor.alert && ` Avisa ${describeAlert(monitor.alert)}.`}
                {!monitor.alert && monitor.consecutiveFailures > 0 && (
                  <span className="text-amber-700"> Este monitor no avisa a nadie: los fallos solo se ven aquí.</span>
                )}
              </p>

              {monitor.recent.length > 0 && <Executions executions={monitor.recent} />}

              {canEdit && (
                <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => toggle.mutate(monitor)}>
                    {monitor.enabled ? "Pausar" : "Activar"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    disabled={runNow.isPending}
                    onClick={() => runNow.mutate(monitor)}
                  >
                    Correr ahora
                  </Button>
                  <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setEditing(monitor)}>
                    Editar
                  </Button>
                  <Button
                    variant="ghost"
                    className="ml-auto h-7 px-2 text-[11px] text-rose-600"
                    onClick={() => setDeleting(monitor)}
                  >
                    Eliminar
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {creating && (
        <MonitorModal
          base={base}
          environments={environments.data ?? []}
          flows={flows.data}
          channels={channels.data?.channels ?? []}
          onClose={() => setCreating(false)}
          onSaved={async (name) => {
            setCreating(false);
            await refresh();
            toast.success(`«${name}» creado`);
          }}
        />
      )}

      {editing && (
        <MonitorModal
          key={editing.id}
          base={base}
          environments={environments.data ?? []}
          flows={flows.data}
          channels={channels.data?.channels ?? []}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            await refresh();
            toast.success(`«${name}» guardado`);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Eliminar el monitor"
          message={`«${deleting.name}» deja de correr y su historial se va con él. Las corridas que ya lanzó se quedan donde están.`}
          confirmLabel="Eliminar"
          pending={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/**
 * A quién avisa, en una línea de la tarjeta.
 *
 * Las direcciones se enseñan **enteras**, y eso no es un descuido: el argumento para guardar el
 * correo en claro y no detrás de una variable es justo poder ver a quién se está despertando, y
 * esconderlo aquí lo desmontaría. Del canal de webhook se enseña el nombre de la variable, que es
 * lo único que hay — y es también la respuesta a «¿y este avisa a alguien?».
 */
function describeAlert(alert: MonitorAlertView): string {
  const when = alert.afterFailures === 1 ? "al primer fallo" : `tras ${alert.afterFailures} fallos seguidos`;
  if (alert.channel === "email") return `por correo a ${(alert.recipients ?? []).join(", ")} ${when}`;
  return `por ${alert.channel}, con la URL de ${alert.urlVariable}, ${when}`;
}

/** Las últimas vueltas, en una fila. Lo que se lee de un golpe es la forma: verde, verde, rojo. */
function Executions({ executions }: { executions: MonitorExecutionView[] }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {[...executions].reverse().map((execution) => (
          <span
            key={execution.id}
            title={`${OUTCOME_LABEL[execution.outcome]} · ${formatDate(execution.startedAt)}${execution.note ? ` · ${execution.note}` : ""}`}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${OUTCOME_TONE[execution.outcome]}`}
          >
            {execution.totals
              ? `${execution.totals.failed}/${execution.totals.cases}`
              : OUTCOME_LABEL[execution.outcome]}
          </span>
        ))}
      </div>
      {executions[0]?.note && <p className="text-[11px] text-slate-500">{executions[0].note}</p>}
    </div>
  );
}

/**
 * El formulario.
 *
 * El horario se elige de una lista y no se escribe: un campo libre de minutos invita a poner «1», y
 * el mínimo son cinco porque cada turno es una corrida entera contra un servicio real.
 *
 * Para un horario diario o semanal, la zona **se propone la del navegador**, que es la de quien lo
 * está escribiendo. Es la única vez en este producto que un valor por defecto es el cómodo, y es
 * porque aquí lo cómodo es también lo correcto: la hora que quiere decir es la de su reloj.
 *
 * El mismo formulario edita. Al editar, la zona es **la que ya tenía el monitor** y no la del
 * navegador: quien abre desde Bogotá un monitor puesto en Madrid para cambiarle el nombre no ha
 * pedido que se le mueva la hora.
 */
function MonitorModal({
  base,
  environments,
  flows,
  channels,
  editing,
  onClose,
  onSaved,
}: {
  base: string;
  environments: Environment[];
  flows: WorkflowsView | undefined;
  channels: ChannelView[];
  /** El monitor que se edita; sin él, se crea uno. */
  editing?: MonitorView;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const initialSchedule = editing?.schedule;
  const initialAlert = editing?.alert ?? null;
  const [name, setName] = useState(editing?.name ?? "");
  const [kind, setKind] = useState<"interval" | "daily" | "weekly">(initialSchedule?.kind ?? "interval");
  const [minutes, setMinutes] = useState(initialSchedule?.kind === "interval" ? initialSchedule.minutes : 60);
  const [hour, setHour] = useState(initialSchedule && initialSchedule.kind !== "interval" ? initialSchedule.hour : 9);
  const [minute, setMinute] = useState(
    initialSchedule && initialSchedule.kind !== "interval" ? initialSchedule.minute : 0,
  );
  const [weekdays, setWeekdays] = useState<number[]>(
    initialSchedule?.kind === "weekly" ? initialSchedule.weekdays : [1],
  );
  const [timeZone] = useState(() => {
    if (initialSchedule && initialSchedule.kind !== "interval") return initialSchedule.timeZone;
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });
  const [environmentId, setEnvironmentId] = useState(editing?.plan.environmentId ?? environments[0]?.id ?? "");
  const [what, setWhat] = useState<"matrix" | "flow" | "suite" | "channel">(
    editing?.plan.channel ? "channel" : editing?.plan.workflowId ? "flow" : editing?.plan.suiteId ? "suite" : "matrix",
  );
  const [targetId, setTargetId] = useState(
    editing?.plan.channel?.channelId ?? editing?.plan.workflowId ?? editing?.plan.suiteId ?? "",
  );
  // Ausente es «los mensajes guardados del canal», como en el nodo del flujo; una lista, el guion propio.
  const [script, setScript] = useState<ScriptStepView[] | undefined>(editing?.plan.channel?.messages);
  const pickedChannel = what === "channel" ? channels.find((entry) => entry.id === targetId) : undefined;
  const environmentVariables = Object.keys(
    environments.find((environment) => environment.id === environmentId)?.variables ?? {},
  );
  const [alerting, setAlerting] = useState(Boolean(initialAlert));
  const [channel, setChannel] = useState<MonitorAlertView["channel"]>(initialAlert?.channel ?? "slack");
  const [urlVariable, setUrlVariable] = useState(initialAlert?.urlVariable ?? "");
  const [recipients, setRecipients] = useState((initialAlert?.recipients ?? []).join(", "));
  const [afterFailures, setAfterFailures] = useState(initialAlert?.afterFailures ?? 1);

  // Un solo campo de texto y no una lista de entradas: se pegan de un chat o de una libreta, y
  // separadas por lo que sea —coma, punto y coma, o un salto de línea— es como vienen pegadas.
  const addresses = recipients.split(/[\s,;]+/).filter(Boolean);
  const byMail = channel === "email";

  const schedule = (): MonitorScheduleView => {
    if (kind === "interval") return { kind: "interval", minutes };
    if (kind === "daily") return { kind: "daily", hour, minute, timeZone };
    return { kind: "weekly", weekdays, hour, minute, timeZone };
  };

  // Cada canal manda su campo y no el otro, igual que lo valida la API: un aviso por correo
  // con un nombre de variable dentro no se sabe por dónde sale.
  const alert = (): MonitorAlertView =>
    byMail
      ? { channel, recipients: addresses, afterFailures }
      : { channel, urlVariable: urlVariable.trim(), afterFailures };

  const plan = (): MonitorPlanView => ({
    // Al editar se conserva lo que este formulario no enseña —etiquetas, muestras, concurrencia—:
    // guardar el nombre no puede tirar en silencio el resto del plan. El conjunto de datos es de un
    // flujo, así que solo sobrevive si el flujo es el mismo.
    ...withoutTarget(editing?.plan),
    ...(editing?.plan.datasetId && what === "flow" && targetId === editing.plan.workflowId
      ? { datasetId: editing.plan.datasetId }
      : {}),
    environmentId,
    ...(what === "flow" && targetId ? { workflowId: targetId } : {}),
    ...(what === "suite" && targetId ? { suiteId: targetId } : {}),
    // Lo que el nodo sabe además del guion —la petición gRPC, el final, la inactividad— se conserva si
    // el canal es el mismo: este formulario no lo enseña y guardar el nombre no debe tirarlo.
    ...(what === "channel" && targetId
      ? {
          channel: {
            ...(editing?.plan.channel?.channelId === targetId ? editing.plan.channel : {}),
            channelId: targetId,
            messages: script,
          },
        }
      : {}),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!editing)
        return api<MonitorView>(`${base}/monitors`, {
          method: "POST",
          body: { name: name.trim(), schedule: schedule(), plan: plan(), ...(alerting ? { alert: alert() } : {}) },
        });
      // El horario solo viaja si cambió: la API recalcula el turno desde ahora cuando lo recibe, y
      // cambiar el nombre de un monitor horario no debe correrle la siguiente vuelta una hora.
      const next = schedule();
      const scheduleChanged = JSON.stringify(next) !== JSON.stringify(editing.schedule);
      return api<MonitorView>(`${base}/monitors/${editing.id}`, {
        method: "PATCH",
        // `alert: null` es «quitar el aviso»; ausente lo dejaría como estaba y la casilla mentiría.
        body: {
          name: name.trim(),
          ...(scheduleChanged ? { schedule: next } : {}),
          plan: plan(),
          alert: alerting ? alert() : null,
        },
      });
    },
    onSuccess: () => onSaved(name.trim()),
  });

  const badVariable = alerting && !byMail && !VARIABLE_NAME.test(urlVariable.trim());
  const badRecipients = alerting && byMail && !addresses.every((address) => EMAIL_ADDRESS.test(address));
  const tooManyRecipients = alerting && byMail && addresses.length > MAX_ALERT_RECIPIENTS;
  const incomplete =
    !name.trim() ||
    !environmentId ||
    (what !== "matrix" && !targetId) ||
    (kind === "weekly" && weekdays.length === 0) ||
    badVariable ||
    badRecipients ||
    tooManyRecipients ||
    // Un aviso por correo sin destinatarios es el botón de avisar sin nadie detrás.
    (alerting && byMail && addresses.length === 0);

  return (
    <Modal
      title={editing ? "Editar el monitor" : "Crear un monitor"}
      description={
        editing
          ? "Guardar no lanza nada. Si cambia el horario, el turno siguiente se calcula desde ahora."
          : "Una corrida que se lanza sola. Crearlo no lanza nada: el primer turno es el siguiente del horario."
      }
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={incomplete || save.isPending} onClick={() => save.mutate()}>
            {editing ? (save.isPending ? "Guardando…" : "Guardar") : save.isPending ? "Creando…" : "Crear"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Nombre *" error={save.error?.message}>
          <input
            autoFocus
            className={inputClass}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label="Cada cuánto *"
          hint={`El mínimo son ${MIN_INTERVAL_MINUTES} minutos: cada turno es una corrida entera.`}
        >
          <select
            aria-label="Tipo de horario"
            className={inputClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="interval">Cada tanto</option>
            <option value="daily">Todos los días a una hora</option>
            <option value="weekly">Días concretos a una hora</option>
          </select>
        </Field>

        {kind === "interval" ? (
          <Field label="Intervalo">
            <select
              aria-label="Intervalo"
              className={inputClass}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            >
              {INTERVALS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field
              label="Hora"
              hint={`En tu zona: ${timeZone}. Se guarda así, no en UTC, para que no se mueva con el cambio de hora.`}
            >
              <div className="flex items-center gap-2">
                <input
                  aria-label="Hora"
                  className={inputClass}
                  inputMode="numeric"
                  value={hour}
                  onChange={(event) => setHour(Number(event.target.value) || 0)}
                />
                <span className="text-slate-400">:</span>
                <input
                  aria-label="Minuto"
                  className={inputClass}
                  inputMode="numeric"
                  value={minute}
                  onChange={(event) => setMinute(Number(event.target.value) || 0)}
                />
              </div>
            </Field>
            {kind === "weekly" && (
              <Field label="Días *">
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((label, day) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={label}
                      aria-pressed={weekdays.includes(day)}
                      className={`rounded border px-2 py-1 text-[11px] ${
                        weekdays.includes(day)
                          ? "border-slate-800 bg-slate-800 text-white"
                          : "border-slate-200 text-slate-600"
                      }`}
                      onClick={() =>
                        setWeekdays((current) =>
                          current.includes(day) ? current.filter((entry) => entry !== day) : [...current, day],
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}

        <Field label="Entorno *" hint="De aquí salen la URL y las credenciales de la corrida.">
          <select
            aria-label="Entorno"
            className={inputClass}
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.target.value)}
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Qué corre">
          <select
            aria-label="Qué corre"
            className={inputClass}
            value={what}
            onChange={(event) => {
              setWhat(event.target.value as typeof what);
              setTargetId("");
            }}
          >
            <option value="matrix">La matriz del contrato</option>
            <option value="flow">Un flujo</option>
            <option value="suite">Una suite</option>
            <option value="channel">Un canal</option>
          </select>
        </Field>

        {what === "channel" && (
          <>
            <Field label="Canal *">
              <select
                aria-label="Canal"
                className={inputClass}
                value={targetId}
                onChange={(event) => {
                  setTargetId(event.target.value);
                  setScript(undefined);
                }}
              >
                <option value="">Elige uno</option>
                {channels.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {PROTOCOL_LABEL[entry.protocol]}
                  </option>
                ))}
              </select>
            </Field>
            {pickedChannel && (
              <div>
                <label className="mb-2 flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={script === undefined}
                    onChange={(event) => setScript(event.target.checked ? undefined : [])}
                  />
                  {pickedChannel.protocol === "grpc"
                    ? "Sin guion propio: solo la petición de la llamada"
                    : "Mandar los mensajes guardados del canal, en orden"}
                </label>
                {script !== undefined && (
                  <ChannelScriptEditor
                    steps={script}
                    protocol={pickedChannel.protocol}
                    variables={environmentVariables}
                    canEdit
                    onChange={setScript}
                  />
                )}
              </div>
            )}
          </>
        )}

        {(what === "flow" || what === "suite") && (
          <Field label={what === "flow" ? "Flujo *" : "Suite *"}>
            <select
              aria-label={what === "flow" ? "Flujo" : "Suite"}
              className={inputClass}
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Elige uno</option>
              {(what === "flow" ? (flows?.workflows ?? []) : (flows?.suites ?? [])).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <label className="flex cursor-pointer gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:bg-slate-50">
          <input
            type="checkbox"
            aria-label="Avisar cuando se ponga en rojo"
            className="mt-0.5"
            checked={alerting}
            onChange={(event) => setAlerting(event.target.checked)}
          />
          <span>
            <span className="font-medium text-slate-800">Avisar cuando se ponga en rojo</span>
            <span className="block text-[11px] text-slate-500">
              A Slack, Teams, un webhook o por correo. Sin esto, los fallos solo se ven en esta pantalla.
            </span>
          </span>
        </label>

        {alerting && (
          <>
            <Field label="Canal">
              <select
                aria-label="Canal"
                className={inputClass}
                value={channel}
                onChange={(event) => setChannel(event.target.value as MonitorAlertView["channel"])}
              >
                <option value="slack">Slack</option>
                <option value="teams">Teams</option>
                <option value="webhook">Webhook</option>
                <option value="email">Correo</option>
              </select>
            </Field>
            {byMail ? (
              <Field
                label="Destinatarios *"
                hint={`Las direcciones, separadas por comas. Como mucho ${MAX_ALERT_RECIPIENTS}: para una lista más larga, una lista de distribución del servidor de correo. El aviso cuenta qué monitor falló y cuántos casos, y nada de lo que la corrida vio.`}
                error={
                  tooManyRecipients
                    ? `Como mucho ${MAX_ALERT_RECIPIENTS} destinatarios`
                    : badRecipients
                      ? "Alguna no es una dirección de correo"
                      : undefined
                }
              >
                <textarea
                  className={inputClass}
                  rows={2}
                  value={recipients}
                  placeholder="guardia@ejemplo.com, equipo@ejemplo.com"
                  onChange={(event) => setRecipients(event.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="Variable del entorno con la URL *"
                hint="El nombre, no la URL. Quien tiene una URL de webhook puede escribir en ese canal, así que vive en el entorno y no aquí."
                error={badVariable ? "Un nombre de variable, como SLACK_WEBHOOK" : undefined}
              >
                <input
                  className={inputClass}
                  value={urlVariable}
                  placeholder="SLACK_WEBHOOK"
                  onChange={(event) => setUrlVariable(event.target.value)}
                />
              </Field>
            )}
            <Field
              label="Avisar tras"
              hint="Fallos seguidos. Avisa una vez al llegar a ese número, no en cada turno: un canal que avisa cada cinco minutos acaba silenciado."
            >
              <select
                aria-label="Avisar tras"
                className={inputClass}
                value={afterFailures}
                onChange={(event) => setAfterFailures(Number(event.target.value))}
              >
                <option value={1}>el primer fallo</option>
                <option value={2}>dos fallos seguidos</option>
                <option value={3}>tres fallos seguidos</option>
              </select>
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/** El plan sin lo que elige el formulario: qué corre, y el conjunto de datos que va con un flujo. */
function withoutTarget(plan: MonitorPlanView | undefined): Partial<MonitorPlanView> {
  if (!plan) return {};
  const { workflowId: _workflowId, suiteId: _suiteId, datasetId: _datasetId, channel: _channel, ...rest } = plan;
  return rest;
}
