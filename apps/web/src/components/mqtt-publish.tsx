/**
 * Lo que MQTT añade al mandar y al leer un mensaje: el tema, la QoS y el `retain`.
 *
 * Aparte de `routes/channels.tsx` para que la pantalla de canales solo tenga que decidir **si** los
 * enseña: un WebSocket no tiene temas, y ninguno de estos controles aparece en él.
 */
import { cn } from "@/lib/format";
import type { ChannelMessageView } from "@/lib/types";
import { inputClass } from "@/components/ui";

export type MqttPublishDraft = { topic: string; qos: 0 | 1 | 2; retain: boolean };

export const BLANK_PUBLISH: MqttPublishDraft = { topic: "", qos: 0, retain: false };

/** Si el tema sirve para publicar. Los comodines son de suscribirse; publicar en uno no existe. */
export const publishTopicHint = (topic: string): string | null =>
  !topic.trim() ? "Falta el tema" : /[+#]/.test(topic) ? "Para publicar, un tema sin comodines (+ ni #)" : null;

export function MqttPublishFields({
  value,
  onChange,
  disabled,
}: {
  value: MqttPublishDraft;
  onChange: (value: MqttPublishDraft) => void;
  disabled?: boolean;
}) {
  const hint = value.topic ? publishTopicHint(value.topic) : null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-48 flex-1 text-xs text-slate-600">
        Tema
        <input
          className={cn(inputClass, "font-mono text-xs")}
          placeholder="sensores/sala/temp"
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
