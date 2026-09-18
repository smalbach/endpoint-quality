/**
 * Lo que MQTT añade al mandar y al leer un mensaje: el tema, la QoS y el `retain`, las propiedades
 * de MQTT 5, y suscribirse o darse de baja con la sesión abierta.
 *
 * Aparte de `routes/channels.tsx` para que la pantalla de canales solo tenga que decidir **si** los
 * enseña: un WebSocket no tiene temas, y ninguno de estos controles aparece en él.
 */
import { useState } from "react";

import { cn } from "@/lib/format";
import type { ChannelMessageView } from "@/lib/types";
import { Button, inputClass } from "@/components/ui";

export type UserProperty = { name: string; value: string };

export type MqttPublishDraft = { topic: string; qos: 0 | 1 | 2; retain: boolean; userProperties: UserProperty[] };

export const BLANK_PUBLISH: MqttPublishDraft = { topic: "", qos: 0, retain: false, userProperties: [] };

/**
 * Lo que se manda al publicar: sin las filas de propiedades a medio escribir, y sin propiedades en
 * 3.1.1, que no las tiene y el servidor las rechaza.
 */
export function publishBody(
  draft: MqttPublishDraft,
  version: 4 | 5,
): Omit<MqttPublishDraft, "userProperties"> & {
  userProperties?: UserProperty[];
} {
  const { userProperties, ...rest } = draft;
  const filled = userProperties.filter((row) => row.name.trim());
  return version === 5 && filled.length ? { ...rest, userProperties: filled } : rest;
}

/** Si un filtro sirve para suscribirse: `+` ocupa un nivel entero y `#` va solo y al final. */
export function topicFilterHint(filter: string): string | null {
  if (!filter.trim()) return "Falta el tema";
  const levels = filter.split("/");
  for (const [index, level] of levels.entries()) {
    if (level.includes("#") && (level !== "#" || index !== levels.length - 1))
      return "# va solo y en el último nivel: sensores/#";
    if (level.includes("+") && level !== "+") return "+ ocupa un nivel entero: sensores/+/temp";
  }
  return null;
}

/** Si el tema sirve para publicar. Los comodines son de suscribirse; publicar en uno no existe. */
export const publishTopicHint = (topic: string): string | null =>
  !topic.trim() ? "Falta el tema" : /[+#]/.test(topic) ? "Para publicar, un tema sin comodines (+ ni #)" : null;

export function MqttPublishFields({
  value,
  onChange,
  disabled,
  version = 4,
}: {
  value: MqttPublishDraft;
  onChange: (value: MqttPublishDraft) => void;
  disabled?: boolean;
  /** Solo en 5.0 se enseñan las propiedades de usuario: 3.1.1 no tiene dónde ponerlas. */
  version?: 4 | 5;
}) {
  const hint = value.topic ? publishTopicHint(value.topic) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-xs text-slate-600">
          Tema
          <input
            className={cn(inputClass, "font-mono text-xs")}
            placeholder="sensores/{{sala}}/temp"
            value={value.topic}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, topic: event.target.value })}
          />
          {hint && <span className="mt-1 block text-rose-600">{hint}</span>}
        </label>
        <label className="text-xs text-slate-600">
          QoS
          <select
            className={cn(inputClass, "w-20")}
            value={value.qos}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, qos: Number(event.target.value) as 0 | 1 | 2 })}
          >
            <option value={0}>0</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label className="mb-2 flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={value.retain}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, retain: event.target.checked })}
          />
          Retener
        </label>
      </div>
      {version === 5 && (
        <UserPropertiesEditor
          label="Propiedades de usuario del mensaje"
          rows={value.userProperties}
          disabled={disabled}
          onChange={(userProperties) => onChange({ ...value, userProperties })}
        />
      )}
    </div>
  );
}

/**
 * Pares nombre-valor de MQTT 5, con `{{variables}}`. El mismo nombre puede repetirse: el protocolo
 * lo admite y hay brokers que lo usan. Una credencial va como `{{variable}}`: al guardar, una
 * escrita a mano en una propiedad que se llama como una credencial se vacía, como en una cabecera.
 */
export function UserPropertiesEditor({
  label,
  rows,
  onChange,
  disabled,
}: {
  label: string;
  rows: UserProperty[];
  onChange: (rows: UserProperty[]) => void;
  disabled?: boolean;
}) {
  const set = (index: number, patch: Partial<UserProperty>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div>
      <p className="mb-1 text-xs text-slate-600">{label}</p>
      <div className="space-y-1">
        {rows.map((row, index) => (
          <div key={index} className="flex gap-2">
            <input
              aria-label={`Nombre de la propiedad ${index + 1}`}
              className={cn(inputClass, "mt-0 w-40 font-mono text-xs")}
              placeholder="nombre"
              value={row.name}
              disabled={disabled}
              onChange={(event) => set(index, { name: event.target.value })}
            />
            <input
              aria-label={`Valor de la propiedad ${index + 1}`}
              className={cn(inputClass, "mt-0 flex-1 font-mono text-xs")}
              placeholder="valor o {{variable}}"
              value={row.value}
              disabled={disabled}
              onChange={(event) => set(index, { value: event.target.value })}
            />
            {!disabled && (
              <Button variant="ghost" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
                Quitar
              </Button>
            )}
          </div>
        ))}
        {!disabled && (
          <Button variant="ghost" className="h-7 text-xs" onClick={() => onChange([...rows, { name: "", value: "" }])}>
            Añadir propiedad
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Suscribirse a un filtro más, o darse de baja, con la sesión abierta: el «Suscribir» de Postman.
 *
 * Lo que contesta el broker no se enseña aquí sino en la conversación, como un evento: es parte de
 * lo que pasó, y un no del broker no cierra la sesión.
 */
export function MqttSubscribeBar({
  onSubscribe,
  onUnsubscribe,
  pending,
}: {
  onSubscribe: (topic: string, qos: 0 | 1 | 2) => void;
  onUnsubscribe: (topic: string) => void;
  pending?: boolean;
}) {
  const [topic, setTopic] = useState("");
  const [qos, setQos] = useState<0 | 1 | 2>(0);
  const hint = topic ? topicFilterHint(topic) : null;
  const ready = Boolean(topic.trim()) && hint === null && !pending;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-48 flex-1 text-xs text-slate-600">
        Filtro
        <input
          aria-label="Filtro"
          className={cn(inputClass, "font-mono text-xs")}
          placeholder="alarmas/# o sensores/+/temp"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
        />
        {hint && <span className="mt-1 block text-rose-600">{hint}</span>}
      </label>
      <label className="text-xs text-slate-600">
        QoS pedida
        <select
          aria-label="QoS de la suscripción"
          className={cn(inputClass, "w-20")}
          value={qos}
          onChange={(event) => setQos(Number(event.target.value) as 0 | 1 | 2)}
        >
          <option value={0}>0</option>
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </label>
      <Button variant="ghost" className="mb-0.5 h-8 text-xs" disabled={!ready} onClick={() => onSubscribe(topic, qos)}>
        Suscribir
      </Button>
      <Button variant="ghost" className="mb-0.5 h-8 text-xs" disabled={!ready} onClick={() => onUnsubscribe(topic)}>
        Dar de baja
      </Button>
    </div>
  );
}

/** El tema de un mensaje en la transcripción, con su QoS y si venía retenido. Nada en un socket. */
export function MessageRoute({ message }: { message: ChannelMessageView }) {
  if (message.topic === undefined) return null;
  return (
    <span className="font-mono">
      {message.topic}
      {message.qos !== undefined && ` · QoS ${message.qos}`}
      {message.retain && " · retenido"}
    </span>
  );
}

/**
 * Las propiedades de MQTT 5 de un mensaje, debajo del cuerpo. Llegan ya tapadas del servidor.
 * Los datos de correlación dicen si son texto o hexadecimal, porque «a1b2» puede ser las dos cosas.
 */
export function MessageProperties({ message }: { message: ChannelMessageView }) {
  const properties = message.properties;
  if (!properties) return null;
  const rows: [string, string][] = [
    ...(properties.userProperties ?? []),
    ...(properties.contentType ? [["tipo de contenido", properties.contentType] as [string, string]] : []),
    ...(properties.responseTopic ? [["tema de respuesta", properties.responseTopic] as [string, string]] : []),
    ...(properties.correlationData !== undefined
      ? [
          [
            `correlación (${properties.correlationEncoding === "hex" ? "hex" : "texto"})`,
            properties.correlationData,
          ] as [string, string],
        ]
      : []),
  ];
  return (
    <dl aria-label="Propiedades" className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-[10px] opacity-80">
      {rows.map(([name, value], index) => (
        <div key={index} className="contents">
          <dt className="font-mono">{name}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
