/**
 * Lo que Socket.IO añade a un canal: sus ajustes (ruta, espacio de nombres, carga de `auth`, eventos,
 * transportes) y, al mandar, el evento que se emite, sus argumentos y si se espera el acuse.
 *
 * Aparte de `routes/channels.tsx`, como `mqtt-publish.tsx`, para que la pantalla de canales solo
 * decida **si** los enseña. Lo que es de todos los canales —cabeceras del upgrade, autenticación,
 * topes— sigue en el formulario de siempre.
 */
import { cn } from "@/lib/format";
import type { ChannelMessageView, SocketIoSettingsView } from "@/lib/types";
import { Button, Field, inputClass } from "@/components/ui";

export const DEFAULT_SOCKETIO: SocketIoSettingsView = {
  version: 4,
  path: "/socket.io",
  namespace: "/",
  auth: "",
  query: [],
  listenAll: true,
  events: [],
  transports: ["websocket"],
};

/** Los que emite la propia biblioteca: ni se emiten ni se oyen como eventos del servidor. */
const RESERVED = new Set(["connect", "connect_error", "disconnect", "disconnecting", "newListener", "removeListener"]);

/** Lo que tiene mal un nombre de evento, con la misma regla que el servidor. */
export function eventNameHint(event: string): string | null {
  if (!event.trim()) return "Falta el evento";
  if (RESERVED.has(event.trim())) return `«${event.trim()}» lo emite Socket.IO`;
  return null;
}

/**
 * Si la carga de `auth` es un objeto JSON. Con `{{variables}}` fuera de una cadena no lo es hasta
 * resolverla, y entonces lo dice el servidor al conectar.
 */
export function authPayloadHint(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? null : 'Un objeto JSON: {"token": "…"}';
  } catch {
    return text.includes("{{") ? null : "No es JSON";
  }
}

/** El evento que se emite al mandar, el acuse, y los argumentos que van detrás del borrador. */
export type SocketIoEmitDraft = { event: string; ack: boolean; extraArgs: string[] };

export const BLANK_EMIT: SocketIoEmitDraft = { event: "", ack: false, extraArgs: [] };

/**
 * Lo que se manda al emitir: el borrador es el primer argumento y los de más van detrás, en orden.
 * Con un solo argumento no hace falta `args`: el servidor usa `text`.
 */
export function emitBody(text: string, draft: SocketIoEmitDraft) {
  const extra = draft.extraArgs;
  return {
    text,
    event: draft.event.trim(),
    ack: draft.ack,
    ...(extra.length ? { args: [text, ...extra] } : {}),
  };
}

export function SocketIoEmitFields({
  value,
  onChange,
  disabled,
}: {
  value: SocketIoEmitDraft;
  onChange: (value: SocketIoEmitDraft) => void;
  disabled?: boolean;
}) {
  const hint = value.event ? eventNameHint(value.event) : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1 text-xs text-slate-600">
          Evento
          <input
            className={cn(inputClass, "font-mono text-xs")}
            placeholder="chat:mensaje"
            value={value.event}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, event: event.target.value })}
          />
          {hint && <span className="mt-1 block text-rose-600">{hint}</span>}
        </label>
        <label className="mb-2 flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={value.ack}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, ack: event.target.checked })}
          />
          Esperar acuse
        </label>
        <Button
          variant="ghost"
          className="mb-1 h-7 text-xs"
          disabled={disabled}
          onClick={() => onChange({ ...value, extraArgs: [...value.extraArgs, ""] })}
        >
          Añadir argumento
        </Button>
      </div>
      {value.extraArgs.map((arg, index) => (
        <div key={index} className="flex gap-2">
          <input
            aria-label={`Argumento ${index + 2}`}
            className={cn(inputClass, "flex-1 font-mono text-xs")}
            placeholder={`Argumento ${index + 2}: texto o JSON`}
            value={arg}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                extraArgs: value.extraArgs.map((item, at) => (at === index ? event.target.value : item)),
              })
            }
          />
          <Button
            variant="ghost"
            className="h-8 text-xs"
            disabled={disabled}
            onClick={() => onChange({ ...value, extraArgs: value.extraArgs.filter((_, at) => at !== index) })}
          >
            Quitar
          </Button>
        </div>
      ))}
    </div>
  );
}

/** El evento de un mensaje, y si pidió acuse o lo es, en la cabecera de la burbuja. */
export function EventRoute({ message }: { message: ChannelMessageView }) {
  if (message.event === undefined) return null;
  return (
    <span className="font-mono">
      {message.event}
      {message.ack && (message.direction === "in" ? " · acuse" : " · pide acuse")}
    </span>
  );
}

/**
 * Los ajustes de un canal Socket.IO. La carga de `auth` va aparte de la autenticación del canal: esa
 * firma el upgrade HTTP, y esta es el objeto que el `io.use()` del servidor lee en el `CONNECT`.
 */
export function SocketIoSettingsForm({
  value,
  onChange,
  disabled,
  variables,
  problemOf,
}: {
  value: SocketIoSettingsView;
  onChange: (value: SocketIoSettingsView) => void;
  disabled?: boolean;
  variables: string[];
  problemOf: (field: string) => string | undefined;
}) {
  const transport = (name: "websocket" | "polling", on: boolean) =>
    onChange({
      ...value,
      transports: on
        ? (["polling", "websocket"] as const).filter((item) => item === name || value.transports.includes(item))
        : value.transports.filter((item) => item !== name),
    });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Ruta" hint="La del servidor: /socket.io salvo que diga otra." error={problemOf("socketio.path")}>
          <input
            className={cn(inputClass, "font-mono")}
            value={value.path}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, path: event.target.value })}
          />
        </Field>
        <Field
          label="Espacio de nombres"
          hint="/ es el principal; con / vale la ruta de la URL."
          error={problemOf("socketio.namespace")}
        >
          <input
            className={cn(inputClass, "font-mono")}
            value={value.namespace}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, namespace: event.target.value })}
          />
        </Field>
        <Field
          label="Versión del servidor"
          hint="El cliente 4 habla con servidores 3 y 4. Un servidor 2 no está soportado."
          error={problemOf("socketio.version")}
        >
          <select
            className={inputClass}
            value={value.version}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, version: Number(event.target.value) as 3 | 4 })}
          >
            <option value={4}>v4</option>
            <option value={3}>v3</option>
          </select>
        </Field>
      </div>

      <Field
        label="Carga de auth"
        hint={`El objeto del CONNECT, en JSON. Un secreto va como {{variable}}${variables.length ? ` (${variables.slice(0, 3).join(", ")}…)` : ""}: escrito a mano en un campo de credencial no se guarda.`}
        error={problemOf("socketio.auth") ?? authPayloadHint(value.auth) ?? undefined}
      >
        <textarea
          aria-label="Carga de auth"
          className={cn(inputClass, "min-h-16 font-mono text-xs")}
          placeholder='{"token": "{{token}}"}'
          value={value.auth}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange({ ...value, auth: event.target.value })}
        />
      </Field>

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Parámetros de la query</p>
        <div className="space-y-2">
          {value.query.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Parámetro ${index + 1} activo`}
                checked={row.enabled}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    query: value.query.map((item, at) =>
                      at === index ? { ...item, enabled: event.target.checked } : item,
                    ),
                  })
                }
              />
              <input
                aria-label={`Nombre del parámetro ${index + 1}`}
                className={cn(inputClass, "w-40 font-mono text-xs")}
                value={row.name}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    query: value.query.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)),
                  })
                }
              />
              <input
                aria-label={`Valor del parámetro ${index + 1}`}
                className={cn(inputClass, "flex-1 font-mono text-xs")}
                placeholder="Valor o {{variable}}"
                value={row.value}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...value,
                    query: value.query.map((item, at) =>
                      at === index ? { ...item, value: event.target.value } : item,
                    ),
                  })
                }
              />
              {!disabled && (
                <Button
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => onChange({ ...value, query: value.query.filter((_, at) => at !== index) })}
                >
                  Quitar
                </Button>
              )}
            </div>
          ))}
          {!disabled && (
            <Button
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => onChange({ ...value, query: [...value.query, { name: "", value: "", enabled: true }] })}
            >
              Añadir parámetro
            </Button>
          )}
          {problemOf("socketio.query") && <p className="text-xs text-rose-600">{problemOf("socketio.query")}</p>}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-slate-600">Eventos que se oyen</p>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={value.listenAll}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, listenAll: event.target.checked })}
            />
            Todos los eventos
          </label>
          {!value.listenAll && (
            <input
              aria-label="Eventos que se oyen"
              className={cn(inputClass, "mt-1 font-mono text-xs")}
              placeholder="chat, estado, alerta"
              value={value.events.join(", ")}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  events: event.target.value.split(",").map((item) => item.trim()),
                })
              }
            />
          )}
          {problemOf("socketio.events") && <p className="mt-1 text-xs text-rose-600">{problemOf("socketio.events")}</p>}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-slate-600">Transportes</p>
          <div className="flex gap-3 text-xs text-slate-600">
            {(["websocket", "polling"] as const).map((name) => (
              <label key={name} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={value.transports.includes(name)}
                  disabled={disabled}
                  onChange={(event) => transport(name, event.target.checked)}
                />
                {name === "websocket" ? "WebSocket" : "Sondeo largo (HTTP)"}
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            Con los dos, se empieza sondeando y se sube a WebSocket. Solo sondeo, para un servidor que no acepta el
            upgrade.
          </p>
          {problemOf("socketio.transports") && (
            <p className="mt-1 text-xs text-rose-600">{problemOf("socketio.transports")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
