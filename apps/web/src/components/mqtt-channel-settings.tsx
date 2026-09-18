/**
 * La configuración de un canal MQTT: el broker, la sesión MQTT y las suscripciones.
 *
 * Su propio formulario y no ramas dentro del de WebSocket, porque casi nada coincide: aquí no hay
 * subprotocolos ni cabeceras ni código de cierre, y sí id de cliente, keepalive y temas. Lo que sí
 * se comparte —la autenticación, que aquí es usuario y contraseña— es el mismo `AuthEditor`, y con
 * él el mismo aviso de que un secreto se escribe como `{{variable}}`: el servidor vacía los
 * literales al guardar.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/format";
import type { ChannelView, MqttSettingsView, RequestAuthView } from "@/lib/types";
import { AuthEditor } from "@/components/auth-editor";
import { UserPropertiesEditor } from "@/components/mqtt-publish";
import { ConfirmDialog } from "@/components/overlay";
import { useToast } from "@/components/toast";
import { Button, Field, inputClass } from "@/components/ui";

const DEFAULT_MQTT: MqttSettingsView = {
  version: 4,
  clientId: "",
  keepaliveSec: 60,
  cleanSession: true,
  subscriptions: [],
  will: null,
  userProperties: [],
};

const BLANK_WILL: NonNullable<MqttSettingsView["will"]> = { topic: "", payload: "", qos: 0, retain: false };

/** Sin cifrar y fuera de esta máquina: la contraseña del broker viaja en claro. */
export const plaintextBroker = (url: string): boolean =>
  /^(mqtt|ws):\/\//.test(url.trim()) && !/^(mqtt|ws):\/\/(localhost|127\.|\[::1\])/.test(url.trim());

const LIMITS: { key: keyof ChannelView["limits"]; label: string }[] = [
  { key: "maxMessages", label: "Mensajes" },
  { key: "maxBytes", label: "Bytes recibidos" },
  { key: "maxMessageBytes", label: "Bytes por mensaje" },
  { key: "maxDurationMs", label: "Duración (ms)" },
  { key: "idleMs", label: "Sin mensajes (ms)" },
];

export function MqttChannelSettings({
  base,
  projectId,
  channel,
  variables,
  canEdit,
  onRemoved,
}: {
  base: string;
  projectId: string;
  channel: ChannelView;
  variables: string[];
  canEdit: boolean;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(channel.name);
  const [url, setUrl] = useState(channel.url);
  const [mqtt, setMqtt] = useState<MqttSettingsView>({ ...DEFAULT_MQTT, ...channel.mqtt });
  const [auth, setAuth] = useState<RequestAuthView>(
    (channel.auth as RequestAuthView | null) ?? { type: "none", params: {} },
  );
  const [limits, setLimits] = useState(channel.limits);
  const [minMessages, setMinMessages] = useState(channel.expectations.minMessages?.toString() ?? "");
  const [saved, setSaved] = useState(channel.messages);
  const [removing, setRemoving] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${base}/channels/${channel.id}`, {
        method: "PATCH",
        body: {
          name,
          url,
          mqtt: {
            ...mqtt,
            subscriptions: mqtt.subscriptions.filter((row) => row.topic.trim()),
            // En 3.1.1 no hay propiedades: se mandan vacías, que es lo que el servidor guarda igual.
            userProperties: mqtt.version === 5 ? mqtt.userProperties.filter((row) => row.name.trim()) : [],
          },
          auth: auth.type === "none" ? null : auth,
          limits,
          expectations: {
            ...channel.expectations,
            minMessages: minMessages.trim() === "" ? undefined : Number(minMessages),
          },
          messages: saved.filter((row) => row.name.trim()),
        },
      }),
    onSuccess: () => {
      toast.success("Canal guardado");
      void queryClient.invalidateQueries({ queryKey: ["channel", channel.id] });
      void queryClient.invalidateQueries({ queryKey: ["channels", projectId] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`${base}/channels/${channel.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channels", projectId] });
      onRemoved();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const problems = save.error instanceof ApiError ? save.error.fields : [];
  const problemOf = (field: string) =>
    problems
      .filter((problem) => problem.field === field || problem.field.startsWith(`${field}.`))
      .map((problem) => problem.detail)
      .join(" · ") || undefined;
  const setSubscription = (index: number, patch: Partial<MqttSettingsView["subscriptions"][number]>) =>
    setMqtt({
      ...mqtt,
      subscriptions: mqtt.subscriptions.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre" error={problemOf("name")}>
          <input className={inputClass} value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Broker" error={problemOf("url")}>
          <input
            className={cn(inputClass, "font-mono")}
            value={url}
            disabled={!canEdit}
            placeholder="mqtts://broker.ejemplo.com:8883"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
      </div>
      {plaintextBroker(url) && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <code>{url.trim().split(":")[0]}://</code> va sin cifrar: usuario, contraseña y mensajes viajan en claro por
          la red. Contra un broker que no es el tuyo, usa <code>mqtts://</code> o <code>wss://</code>.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Versión" error={problemOf("mqtt.version")}>
          <select
            className={inputClass}
            value={mqtt.version}
            disabled={!canEdit}
            onChange={(e) => setMqtt({ ...mqtt, version: Number(e.target.value) as 4 | 5 })}
          >
            <option value={4}>3.1.1</option>
            <option value={5}>5.0</option>
          </select>
        </Field>
        <Field label="Id de cliente" hint="Vacío: uno nuevo en cada sesión." error={problemOf("mqtt.clientId")}>
          <input
            className={cn(inputClass, "font-mono")}
            value={mqtt.clientId}
            disabled={!canEdit}
            onChange={(e) => setMqtt({ ...mqtt, clientId: e.target.value })}
          />
        </Field>
        <Field label="Keepalive (s)" error={problemOf("mqtt.keepaliveSec")}>
          <input
            type="number"
            min={0}
            className={inputClass}
            value={mqtt.keepaliveSec}
            disabled={!canEdit}
            onChange={(e) => setMqtt({ ...mqtt, keepaliveSec: Number(e.target.value) })}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={mqtt.cleanSession}
            disabled={!canEdit}
            onChange={(e) => setMqtt({ ...mqtt, cleanSession: e.target.checked })}
          />
          Sesión limpia
        </label>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Usuario y contraseña</p>
        <AuthEditor
          auth={auth}
          onChange={setAuth}
          variables={variables}
          disabled={!canEdit}
          order={["none", "basic"]}
        />
        {problemOf("auth") && <p className="mt-1 text-xs text-rose-600">{problemOf("auth")}</p>}
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Suscripciones</p>
        <p className="mb-2 text-[11px] text-slate-500">
          Al conectar. <code>+</code> es un nivel y <code>#</code> el resto: <code>sensores/+/temp</code>,{" "}
          <code>alarmas/#</code>.
        </p>
        <div className="space-y-2">
          {mqtt.subscriptions.map((row, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1">
                <input
                  aria-label={`Tema de la suscripción ${index + 1}`}
                  className={cn(inputClass, "mt-0 font-mono text-xs")}
                  value={row.topic}
                  disabled={!canEdit}
                  onChange={(e) => setSubscription(index, { topic: e.target.value })}
                />
                {problemOf(`mqtt.subscriptions.${index}`) && (
                  <p className="mt-1 text-xs text-rose-600">{problemOf(`mqtt.subscriptions.${index}`)}</p>
                )}
              </div>
              <select
                aria-label={`QoS de la suscripción ${index + 1}`}
                className={cn(inputClass, "mt-0 w-20")}
                value={row.qos}
                disabled={!canEdit}
                onChange={(e) => setSubscription(index, { qos: Number(e.target.value) as 0 | 1 | 2 })}
              >
                <option value={0}>QoS 0</option>
                <option value={1}>QoS 1</option>
                <option value={2}>QoS 2</option>
              </select>
              {canEdit && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setMqtt({ ...mqtt, subscriptions: mqtt.subscriptions.filter((_, at) => at !== index) })
                  }
                >
                  Quitar
                </Button>
              )}
            </div>
          ))}
          {canEdit && (
            <Button
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setMqtt({ ...mqtt, subscriptions: [...mqtt.subscriptions, { topic: "", qos: 0 }] })}
            >
              Añadir suscripción
            </Button>
          )}
        </div>
      </div>

      <div>
        <label className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            checked={mqtt.will !== null}
            disabled={!canEdit}
            onChange={(e) => setMqtt({ ...mqtt, will: e.target.checked ? { ...BLANK_WILL } : null })}
          />
          Testamento (Last Will)
        </label>
        <p className="mb-2 text-[11px] text-slate-500">
          Lo publica el broker si la conexión se corta sin despedirse. Desconectar desde aquí se despide, así que no
          sale.
        </p>
        {mqtt.will && (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <Field label="Tema" error={problemOf("mqtt.will.topic")}>
              <input
                className={cn(inputClass, "font-mono text-xs")}
                placeholder="dispositivos/{{id}}/estado"
                value={mqtt.will.topic}
                disabled={!canEdit}
                onChange={(e) => mqtt.will && setMqtt({ ...mqtt, will: { ...mqtt.will, topic: e.target.value } })}
              />
            </Field>
            <Field label="QoS" error={problemOf("mqtt.will.qos")}>
              <select
                className={cn(inputClass, "w-20")}
                value={mqtt.will.qos}
                disabled={!canEdit}
                onChange={(e) =>
                  mqtt.will && setMqtt({ ...mqtt, will: { ...mqtt.will, qos: Number(e.target.value) as 0 | 1 | 2 } })
                }
              >
                <option value={0}>0</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </Field>
            <label className="flex items-center gap-1.5 self-end pb-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={mqtt.will.retain}
                disabled={!canEdit}
                onChange={(e) => mqtt.will && setMqtt({ ...mqtt, will: { ...mqtt.will, retain: e.target.checked } })}
              />
              Retener
            </label>
            <div className="sm:col-span-3">
              <Field label="Cuerpo" error={problemOf("mqtt.will.payload")}>
                <textarea
                  className={cn(inputClass, "min-h-9 font-mono text-xs")}
                  value={mqtt.will.payload}
                  disabled={!canEdit}
                  onChange={(e) => mqtt.will && setMqtt({ ...mqtt, will: { ...mqtt.will, payload: e.target.value } })}
                />
              </Field>
            </div>
          </div>
        )}
      </div>

      {mqtt.version === 5 && (
        <div>
          <UserPropertiesEditor
            label="Propiedades de usuario al conectar"
            rows={mqtt.userProperties}
            disabled={!canEdit}
            onChange={(userProperties) => setMqtt({ ...mqtt, userProperties })}
          />
          {problemOf("mqtt.userProperties") && (
            <p className="mt-1 text-xs text-rose-600">{problemOf("mqtt.userProperties")}</p>
          )}
        </div>
      )}

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Topes de una sesión</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {LIMITS.map(({ key, label }) => (
            <Field key={key} label={label} error={problemOf(`limits.${key}`)}>
              <input
                type="number"
                min={1}
                className={inputClass}
                value={limits[key]}
                disabled={!canEdit}
                onChange={(e) => setLimits({ ...limits, [key]: Number(e.target.value) })}
              />
            </Field>
          ))}
        </div>
      </div>

      <Field
        label="Mensajes que tienen que llegar"
        hint="Vacío: no se afirma nada sobre el número. MQTT no tiene código de cierre."
        error={problemOf("expectations.minMessages")}
      >
        <input
          type="number"
          min={0}
          className={cn(inputClass, "sm:w-60")}
          value={minMessages}
          disabled={!canEdit}
          onChange={(e) => setMinMessages(e.target.value)}
        />
      </Field>

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Mensajes guardados</p>
        <p className="mb-2 text-[11px] text-slate-500">Lo que se publica a menudo, con su tema.</p>
        <div className="space-y-2">
          {saved.map((row, index) => (
            <div key={index} className="flex gap-2">
              <input
                aria-label={`Nombre del mensaje ${index + 1}`}
                className={cn(inputClass, "mt-0 w-32")}
                value={row.name}
                disabled={!canEdit}
                onChange={(e) =>
                  setSaved(saved.map((item, at) => (at === index ? { ...item, name: e.target.value } : item)))
                }
              />
              <input
                aria-label={`Tema del mensaje ${index + 1}`}
                className={cn(inputClass, "mt-0 w-48 font-mono text-xs")}
                value={row.topic ?? ""}
                disabled={!canEdit}
                onChange={(e) =>
                  setSaved(saved.map((item, at) => (at === index ? { ...item, topic: e.target.value } : item)))
                }
              />
              <textarea
                aria-label={`Cuerpo del mensaje ${index + 1}`}
                className={cn(inputClass, "mt-0 min-h-9 flex-1 font-mono text-xs")}
                value={row.body}
                disabled={!canEdit}
                onChange={(e) =>
                  setSaved(saved.map((item, at) => (at === index ? { ...item, body: e.target.value } : item)))
                }
              />
              {canEdit && (
                <Button variant="ghost" onClick={() => setSaved(saved.filter((_, at) => at !== index))}>
                  Quitar
                </Button>
              )}
            </div>
          ))}
          {canEdit && (
            <Button
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setSaved([...saved, { name: "", body: "", topic: "" }])}
            >
              Añadir mensaje
            </Button>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="flex justify-between border-t border-slate-100 pt-3">
          <Button variant="danger" onClick={() => setRemoving(true)}>
            Eliminar canal
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Guardar
          </Button>
        </div>
      )}
      {save.error && !problems.length && <p className="text-xs text-rose-600">{save.error.message}</p>}

      {removing && (
        <ConfirmDialog
          title="Eliminar el canal"
          message="Sus sesiones se quedan como estaban: son lo que pasó."
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onClose={() => setRemoving(false)}
        />
      )}
    </div>
  );
}
