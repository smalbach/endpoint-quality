/**
 * Canales: probar un WebSocket o un servicio gRPC, que no son una petición sino una conversación.
 *
 * La lista a la izquierda y el canal abierto a la derecha, en la misma sección que los endpoints —
 * una pestaña más— porque para quien prueba una API los dos son «lo que se le manda». El canal
 * abierto va en la URL (`?c=`) y la sesión también (`?s=`): **recargar no cierra la conversación**.
 * El socket vive en la API y no en esta pestaña, así que al volver se lee la transcripción entera y
 * se sigue escuchando donde estaba.
 *
 * Lo que se enseña de cada mensaje ya viene tapado del servidor —en la trama en vivo igual que en la
 * fila—, así que esta pantalla no tiene nada que redactar ni puede olvidarse de hacerlo.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api, streamRun } from "@/lib/api";
import { useCan, useOrganization } from "@/lib/auth";
import { resolveActive, useActiveEnvironment } from "@/lib/active-environment";
import { gap, isOver, mergeMessage, prettyBody, stopText, visibleMessages } from "@/lib/channel-view";
import { cn } from "@/lib/format";
import type { FieldRow } from "@/lib/request-fields";
import type {
  ChannelDetailView,
  ChannelListView,
  ChannelMessageView,
  ChannelSessionView,
  ChannelView,
  Environment,
  GrpcSettingsView,
  RequestAuthView,
} from "@/lib/types";
import { AuthEditor } from "@/components/auth-editor";
import { GrpcChannelForm } from "@/components/grpc-channel-form";
import { EndpointsTabs } from "@/components/endpoints-tabs";
import { ConfirmDialog, Modal } from "@/components/overlay";
import { RequestFieldsEditor } from "@/components/request-fields-editor";
import { useToast } from "@/components/toast";
import { AssertionRow, Button, Field, inputClass } from "@/components/ui";

/** Lo que se ofrece para firmar un socket: lo que no necesita pedir un reto al servidor antes. */
const SOCKET_AUTH_TYPES = ["none", "bearer", "basic", "apikey"] as const;

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

export function ChannelsPage() {
  const { projectId } = useParams();
  const organization = useOrganization();
  const canEdit = useCan("editor");
  const [params, setParams] = useSearchParams();
  const base = `/orgs/${organization?.id}/projects/${projectId}`;
  const selected = params.get("c");
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ["channels", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<ChannelListView>(`${base}/channels`),
  });

  const select = (channelId: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (channelId) next.set("c", channelId);
      else next.delete("c");
      next.delete("s");
      return next;
    });

  if (!projectId) return null;
  const channels = list.data?.channels ?? [];

  return (
    <div>
      <EndpointsTabs projectId={projectId} />
      <div className="flex h-[calc(100dvh-12rem)] min-h-[28rem] gap-3">
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Canales</p>
            {canEdit && (
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setCreating(true)}>
                Nuevo canal
              </Button>
            )}
          </div>
          {list.isLoading ? (
            <p className="text-xs text-slate-400">Cargando…</p>
          ) : channels.length === 0 ? (
            <div className="mt-6 text-center">
              <p className="text-sm font-medium text-slate-700">Ningún canal todavía</p>
              <p className="mt-1 text-xs text-slate-500">
                Un canal es un WebSocket (<code>wss://</code>) o un servicio gRPC (<code>grpcs://</code>): lo que se le
                manda y lo que se espera oír.
              </p>
            </div>
          ) : (
            <ul className="-mx-1 min-h-0 flex-1 overflow-y-auto">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    onClick={() => select(channel.id)}
                    className={cn(
                      "w-full rounded-lg px-2 py-2 text-left",
                      channel.id === selected ? "bg-slate-900 text-white" : "hover:bg-slate-50",
                    )}
                  >
                    <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {channel.protocol === "grpc" && (
                        <span className="rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-700">
                          gRPC
                        </span>
                      )}
                      {channel.name}
                    </span>
                    <span
                      className={cn(
                        "block truncate font-mono text-[11px]",
                        channel.id === selected ? "text-slate-300" : "text-slate-500",
                      )}
                    >
                      {channel.url}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          {selected ? (
            <ChannelPanel
              key={selected}
              base={base}
              projectId={projectId}
              channelId={selected}
              canEdit={canEdit}
              onRemoved={() => select(null)}
            />
          ) : (
            <div className="grid h-full place-items-center text-center">
              <p className="text-sm font-medium text-slate-700">Elige un canal para conectarte a él</p>
            </div>
          )}
        </section>
      </div>

      {creating && (
        <NewChannelModal
          base={base}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(channel) => {
            setCreating(false);
            select(channel.id);
          }}
        />
      )}
    </div>
  );
}

function NewChannelModal({
  base,
  projectId,
  onClose,
  onCreated,
}: {
  base: string;
  projectId: string;
  onClose: () => void;
  onCreated: (channel: ChannelView) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [protocol, setProtocol] = useState<ChannelView["protocol"]>("ws");
  const create = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${base}/channels`, {
        method: "POST",
        body: protocol === "ws" ? { name, url } : { protocol, name, url },
      }),
    onSuccess: (channel) => {
      void queryClient.invalidateQueries({ queryKey: ["channels", projectId] });
      onCreated(channel);
    },
  });
  const problems = create.error instanceof ApiError ? create.error.fields : [];
  const problemOf = (field: string) => problems.find((problem) => problem.field === field)?.detail;

  return (
    <Modal
      title="Nuevo canal"
      description="Un WebSocket o un servicio gRPC del proyecto. La URL puede llevar {{variables}}: se resuelven contra el entorno activo al conectar."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!name.trim() || !url.trim() || create.isPending} onClick={() => create.mutate()}>
            Crear
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs" role="radiogroup" aria-label="Protocolo">
          {(
            [
              ["ws", "WebSocket"],
              ["grpc", "gRPC"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={protocol === value}
              onClick={() => setProtocol(value)}
              className={cn(
                "flex-1 rounded-md px-2.5 py-1 font-medium",
                protocol === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Field label="Nombre" error={problemOf("name")}>
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="URL" error={problemOf("url")}>
          <input
            className={cn(inputClass, "font-mono")}
            placeholder={
              protocol === "grpc"
                ? "grpcs://api.ejemplo.com:443 o {{grpcBase}}"
                : "wss://api.ejemplo.com/socket o {{wsBase}}/socket"
            }
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        {create.error && !problems.length && <p className="text-xs text-rose-600">{message(create.error)}</p>}
      </div>
    </Modal>
  );
}

function ChannelPanel({
  base,
  projectId,
  channelId,
  canEdit,
  onRemoved,
}: {
  base: string;
  projectId: string;
  channelId: string;
  canEdit: boolean;
  onRemoved: () => void;
}) {
  const [tab, setTab] = useState<"conversation" | "settings">("conversation");
  const detail = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api<ChannelDetailView>(`${base}/channels/${channelId}`),
  });
  const environments = useQuery({
    queryKey: ["environments", projectId],
    queryFn: () => api<Environment[]>(`${base}/environments`),
  });
  const [storedEnvironment] = useActiveEnvironment(projectId);
  const environment = resolveActive(storedEnvironment, environments.data ?? []);

  if (detail.isLoading) return <p className="text-sm text-slate-400">Cargando…</p>;
  if (!detail.data) return <p className="text-sm text-rose-600">No se pudo leer el canal.</p>;
  const channel = detail.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-slate-900">{channel.name}</h2>
          <p className="truncate font-mono text-xs text-slate-500">{channel.url}</p>
        </div>
        <nav className="flex shrink-0 gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
          {(
            [
              ["conversation", "Conversación"],
              ["settings", "Configuración"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium",
                tab === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "conversation" ? (
          <Conversation base={base} channel={channel} environment={environment} canEdit={canEdit} />
        ) : (
          <ChannelSettings
            base={base}
            projectId={projectId}
            channel={channel}
            variables={Object.keys(environment?.variables ?? {})}
            environmentId={environment?.id ?? null}
            canEdit={canEdit}
            onRemoved={onRemoved}
          />
        )}
      </div>
    </div>
  );
}

/**
 * La conversación: conectar, oír, mandar, y el veredicto al terminar.
 *
 * El stream se abre por el id de la sesión y abre con **la transcripción entera**, así que la misma
 * función sirve para la sesión recién abierta y para la que se encuentra al recargar. Una sesión ya
 * terminada no abre stream: se lee y se enseña su veredicto.
 */
function Conversation({
  base,
  channel,
  environment,
  canEdit,
}: {
  base: string;
  channel: ChannelDetailView;
  environment: Environment | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("s") ?? channel.sessions.find((session) => session.live && !isOver(session))?.id ?? null;
  const [session, setSession] = useState<ChannelSessionView | null>(null);
  const [messages, setMessages] = useState<ChannelMessageView[]>([]);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  const setSessionId = (id: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("s", id);
      else next.delete("s");
      return next;
    });

  // La sesión, leída entera y seguida en vivo si sigue abierta aquí.
  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void api<ChannelSessionView>(`${base}/channels/sessions/${sessionId}`)
      .then((read) => {
        if (cancelled) return;
        setSession(read);
        setMessages(read.messages ?? []);
        if (isOver(read) || !read.live) return;
        return streamRun(`${base}/channels/sessions/${sessionId}/stream`, {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "snapshot") {
              const snapshot = event.data as ChannelSessionView;
              setSession(snapshot);
              setMessages(snapshot.messages ?? []);
            } else if (event.type === "message") {
              const { message: arrived } = event.data as { message: ChannelMessageView };
              setMessages((current) => mergeMessage(current, arrived));
            } else if (event.type === "finished") {
              // El veredicto se calcula al cerrar y se guarda: se relee la sesión para enseñarlo.
              void api<ChannelSessionView>(`${base}/channels/sessions/${sessionId}`).then((final) => {
                setSession(final);
                setMessages(final.messages ?? []);
                void queryClient.invalidateQueries({ queryKey: ["channel", channel.id] });
              });
            }
          },
        });
      })
      .catch((error: unknown) => {
        if (!cancelled && !controller.signal.aborted) toast.error(message(error));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [base, sessionId, channel.id, queryClient, toast]);

  // Con `?.` también en la función: no todos los entornos la tienen (jsdom no), y una pantalla que
  // revienta por no poder desplazarse es peor que una que no se desplaza.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  const connect = useMutation({
    mutationFn: () =>
      api<ChannelSessionView>(`${base}/channels/${channel.id}/sessions`, {
        method: "POST",
        body: environment ? { environmentId: environment.id } : {},
      }),
    onSuccess: (opened) => {
      setSessionId(opened.id);
      void queryClient.invalidateQueries({ queryKey: ["channel", channel.id] });
    },
    onError: (error) => toast.error(message(error)),
  });
  const send = useMutation({
    mutationFn: (text: string) =>
      api(`${base}/channels/sessions/${sessionId}/messages`, { method: "POST", body: { text } }),
    onSuccess: () => setDraft(""),
    onError: (error) => toast.error(message(error)),
  });
  const close = useMutation({
    mutationFn: () => api(`${base}/channels/sessions/${sessionId}/close`, { method: "POST", body: {} }),
    onError: (error) => toast.error(message(error)),
  });
  // El medio cierre de un stream gRPC: «ya no mando más», y el servidor contesta lo que le quede.
  const end = useMutation({
    mutationFn: () => api(`${base}/channels/sessions/${sessionId}/end`, { method: "POST", body: {} }),
    onError: (error) => toast.error(message(error)),
  });
  const grpc = channel.protocol === "grpc";

  const open = session !== null && !isOver(session);
  const canSend = canEdit && open && session.live && Boolean(draft.trim()) && !send.isPending;
  const rows = useMemo(() => visibleMessages(messages), [messages]);

  return (
    <div className="flex min-h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {open ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              <span className="size-1.5 rounded-full bg-emerald-500" /> {grpc ? "En curso" : "Conectado"}
            </span>
            {canEdit && session.live && grpc && (
              <Button variant="ghost" className="h-8 text-xs" onClick={() => end.mutate()} disabled={end.isPending}>
                Terminar envío
              </Button>
            )}
            {canEdit && session.live && (
              <Button variant="ghost" className="h-8 text-xs" onClick={() => close.mutate()} disabled={close.isPending}>
                {grpc ? "Cancelar llamada" : "Desconectar"}
              </Button>
            )}
            {!session.live && (
              <p className="text-xs text-amber-700">
                Esta sesión la tiene otra instancia de la API: se puede leer, pero no seguir ni usar desde aquí.
              </p>
            )}
          </>
        ) : (
          canEdit && (
            <Button className="h-8 text-xs" onClick={() => connect.mutate()} disabled={connect.isPending}>
              {connect.isPending ? (grpc ? "Invocando…" : "Conectando…") : grpc ? "Invocar" : "Conectar"}
            </Button>
          )
        )}
        <span className="text-xs text-slate-500">
          {environment ? (
            <>
              contra <strong className="font-medium text-slate-700">{environment.name}</strong>
            </>
          ) : (
            "sin entorno: una URL con {{variables}} no tendrá de dónde sacarlas"
          )}
        </span>
      </div>

      {session && <SessionHeader session={session} maxMessages={channel.limits.maxMessages} grpc={grpc} />}

      <div className="min-h-40 flex-1 rounded-xl border border-slate-200 bg-slate-50 p-2" aria-label="Conversación">
        {rows.length === 0 ? (
          <p className="p-4 text-center text-xs text-slate-400">
            {session ? "Sin mensajes todavía." : "Conecta para empezar la conversación."}
          </p>
        ) : (
          <ol className="space-y-1.5">
            {rows.map((row, index) => (
              <li
                key={row.seq}
                className={cn(
                  "max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs",
                  row.direction === "out"
                    ? "ml-auto bg-slate-900 text-white"
                    : row.direction === "error"
                      ? "bg-rose-50 text-rose-800"
                      : "bg-white text-slate-800 shadow-sm",
                )}
              >
                <div className="mb-0.5 flex items-center gap-2 text-[10px] opacity-70">
                  <span>{row.direction === "out" ? "enviado" : row.direction === "in" ? "recibido" : "error"}</span>
                  <span>{gap(row.atMs, index > 0 ? rows[index - 1].atMs : null)}</span>
                  {row.kind === "binary" && <span>binario · {row.bytes} B</span>}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono">{prettyBody(row.body)}</pre>
                {row.truncated && (
                  <p className="mt-1 text-[10px] opacity-70">
                    recortado: llegaron {row.bytes.toLocaleString("es")} bytes y aquí se guarda el principio
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
        <div ref={bottom} />
      </div>

      {open && session.live && canEdit && (
        <div className="space-y-2">
          {channel.messages.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {channel.messages.map((saved) => (
                <button
                  key={saved.name}
                  type="button"
                  onClick={() => setDraft(saved.body)}
                  className="rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                >
                  {saved.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              aria-label="Mensaje"
              className={cn(inputClass, "min-h-16 flex-1 font-mono text-xs")}
              placeholder={
                grpc
                  ? '{"name": "…"} — JSON del tipo de entrada, Ctrl+Enter para enviar'
                  : '{"type":"ping"} — Ctrl+Enter para enviar'
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // La misma tecla que el editor de peticiones.
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && canSend) {
                  event.preventDefault();
                  send.mutate(draft);
                }
              }}
            />
            <Button className="self-end" disabled={!canSend} onClick={() => send.mutate(draft)}>
              Enviar
            </Button>
          </div>
        </div>
      )}

      {channel.sessions.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">Sesiones anteriores ({channel.sessions.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {channel.sessions.map((past) => (
              <li key={past.id}>
                <button
                  type="button"
                  onClick={() => setSessionId(past.id)}
                  className={cn("text-left hover:underline", past.id === sessionId && "font-semibold")}
                >
                  {new Date(past.openedAt).toLocaleString("es")} · {statusText(past)}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Los estados de gRPC por su nombre: el número es la posición en el estándar. */
const GRPC_STATUS = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
];
const grpcStatusName = (code: number): string => `${GRPC_STATUS[code] ?? "desconocido"} (${code})`;

const statusText = (session: ChannelSessionView): string =>
  !isOver(session)
    ? "abierta"
    : session.verdict?.ok
      ? "en verde"
      : session.status === "error"
        ? "no llegó a abrir"
        : "en rojo";

function SessionHeader({
  session,
  maxMessages,
  grpc = false,
}: {
  session: ChannelSessionView;
  maxMessages: number;
  grpc?: boolean;
}) {
  const over = isOver(session);
  return (
    <div className="rounded-xl border border-slate-200 p-3 text-xs">
      <p className="text-slate-600">
        {session.counters.sent} enviados · {session.counters.received} recibidos ·{" "}
        {session.counters.bytesIn.toLocaleString("es")} bytes recibidos
        {session.handshake && !grpc && ` · upgrade ${session.handshake.status}`}
        {over && session.stopReason && (
          <>
            {" "}
            · <strong className="font-medium">{stopText(session.stopReason, { maxMessages })}</strong>
          </>
        )}
        {over &&
          session.closeCode !== null &&
          (grpc
            ? ` · estado ${grpcStatusName(session.closeCode)}${session.closeReason ? ` «${session.closeReason}»` : ""}`
            : ` · cierre ${session.closeCode}${session.closeReason ? ` «${session.closeReason}»` : ""}`)}
      </p>
      {grpc && session.trailers && Object.keys(session.trailers).length > 0 && (
        <dl
          className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[11px] text-slate-500"
          aria-label="Trailers"
        >
          {Object.entries(session.trailers).map(([name, value]) => (
            <div key={name} className="contents">
              <dt>{name}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {over && session.verdict && (
        <div className="mt-2">
          {session.verdict.assertions.map((assertion) => (
            <AssertionRow key={assertion.label} {...assertion} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * La configuración del canal.
 *
 * El protocolo se elige al crear y no aquí: un canal no cambia de protocolo, porque su URL, sus
 * cabeceras y lo que afirma dependen de él. Lo que es de un solo protocolo —subprotocolos en un
 * WebSocket; definición, método, mensaje y plazo en gRPC— solo sale en el suyo.
 */
function ChannelSettings({
  base,
  projectId,
  channel,
  variables,
  environmentId,
  canEdit,
  onRemoved,
}: {
  base: string;
  projectId: string;
  channel: ChannelView;
  variables: string[];
  environmentId: string | null;
  canEdit: boolean;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(channel.name);
  const [url, setUrl] = useState(channel.url);
  const [subprotocols, setSubprotocols] = useState(channel.subprotocols.join(", "));
  const [headers, setHeaders] = useState<FieldRow[]>(channel.headers);
  const [auth, setAuth] = useState<RequestAuthView>(
    (channel.auth as RequestAuthView | null) ?? { type: "none", params: {} },
  );
  const [limits, setLimits] = useState(channel.limits);
  const [minMessages, setMinMessages] = useState(channel.expectations.minMessages?.toString() ?? "");
  const [closeCode, setCloseCode] = useState(channel.expectations.closeCode?.toString() ?? "");
  const grpc = channel.protocol === "grpc";
  const [grpcSettings, setGrpcSettings] = useState<GrpcSettingsView | null>(channel.grpc);
  const [status, setStatus] = useState(channel.expectations.status?.toString() ?? "");
  const [saved, setSaved] = useState(channel.messages);
  const [removing, setRemoving] = useState(false);

  const number = (value: string) => (value.trim() === "" ? undefined : Number(value));
  const save = useMutation({
    mutationFn: () =>
      api<ChannelView>(`${base}/channels/${channel.id}`, {
        method: "PATCH",
        body: {
          name,
          url,
          subprotocols: grpc
            ? []
            : subprotocols
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
          headers: headers.filter((row) => row.name.trim()),
          auth: auth.type === "none" ? null : auth,
          limits,
          expectations: {
            ...channel.expectations,
            minMessages: number(minMessages),
            ...(grpc ? { status: number(status) } : { closeCode: number(closeCode) }),
          },
          messages: saved.filter((row) => row.name.trim()),
          ...(grpc && grpcSettings ? { grpc: grpcSettings } : {}),
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
    onError: (error) => toast.error(message(error)),
  });

  const problems = save.error instanceof ApiError ? save.error.fields : [];
  const problemOf = (field: string) =>
    problems
      .filter((problem) => problem.field === field || problem.field.startsWith(`${field}.`))
      .map((problem) => problem.detail)
      .join(" · ") || undefined;
  const headerProblems = problems
    .filter((problem) => problem.field.startsWith("headers."))
    .map((problem) => ({ index: Number(problem.field.split(".")[1]), detail: problem.detail }));

  const LIMITS: { key: keyof typeof limits; label: string }[] = [
    { key: "maxMessages", label: "Mensajes" },
    { key: "maxBytes", label: "Bytes recibidos" },
    { key: "maxMessageBytes", label: "Bytes por mensaje" },
    { key: "maxDurationMs", label: "Duración (ms)" },
    { key: "idleMs", label: "Sin mensajes (ms)" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre" error={problemOf("name")}>
          <input
            className={inputClass}
            value={name}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="URL" error={problemOf("url")}>
          <input
            className={cn(inputClass, "font-mono")}
            value={url}
            disabled={!canEdit}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      </div>
      {(url.trim().startsWith("ws://") || url.trim().startsWith("grpc://")) &&
        !/^(ws|grpc):\/\/(localhost|127\.|\[::1\])/.test(url.trim()) && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <code>{grpc ? "grpc://" : "ws://"}</code> va sin cifrar: cualquier credencial que mande este canal viaja en
            claro por la red. Contra un servidor que no es el tuyo, usa <code>{grpc ? "grpcs://" : "wss://"}</code>.
          </p>
        )}

      {grpc && grpcSettings ? (
        <GrpcChannelForm
          base={base}
          channelId={channel.id}
          value={grpcSettings}
          onChange={setGrpcSettings}
          canEdit={canEdit}
          environmentId={environmentId}
          problemOf={problemOf}
        />
      ) : (
        <Field
          label="Subprotocolos"
          hint="Separados por comas, en orden de preferencia. El servidor elige uno."
          error={problemOf("subprotocols")}
        >
          <input
            className={cn(inputClass, "font-mono")}
            value={subprotocols}
            disabled={!canEdit}
            placeholder="graphql-ws, v1.chat"
            onChange={(event) => setSubprotocols(event.target.value)}
          />
        </Field>
      )}

      <RequestFieldsEditor
        label={grpc ? "Metadata" : "Cabeceras del upgrade"}
        hint={
          grpc
            ? "Claves en minúsculas; las grpc-* y las de HTTP/2 las pone la llamada. Una credencial va como {{variable}}: escrita a mano no se guarda."
            : "Las del propio protocolo —Host, Upgrade, Sec-WebSocket-*— las pone la conexión."
        }
        rows={headers}
        problems={headerProblems}
        namePlaceholder="Nombre"
        valuePlaceholder="Valor o {{variable}}"
        disabled={!canEdit}
        onChange={setHeaders}
        variables={variables}
      />

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Autenticación</p>
        <AuthEditor
          auth={auth}
          onChange={setAuth}
          variables={variables}
          disabled={!canEdit}
          order={[...SOCKET_AUTH_TYPES]}
        />
        {problemOf("auth") && <p className="mt-1 text-xs text-rose-600">{problemOf("auth")}</p>}
      </div>

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
                onChange={(event) => setLimits({ ...limits, [key]: Number(event.target.value) })}
              />
            </Field>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Mensajes que tienen que llegar"
          hint="Vacío: no se afirma nada sobre el número."
          error={problemOf("expectations.minMessages")}
        >
          <input
            type="number"
            min={0}
            className={inputClass}
            value={minMessages}
            disabled={!canEdit}
            onChange={(event) => setMinMessages(event.target.value)}
          />
        </Field>
        {grpc ? (
          <Field
            label="Estado esperado"
            hint="0 es OK; vacío, no se afirma el estado. 5 es NOT_FOUND; 14, UNAVAILABLE."
            error={problemOf("expectations.status")}
          >
            <input
              type="number"
              min={0}
              max={16}
              className={inputClass}
              value={status}
              disabled={!canEdit}
              onChange={(event) => setStatus(event.target.value)}
            />
          </Field>
        ) : (
          <Field
            label="Código de cierre esperado"
            hint="1000 es «se despidió»; 1006, «se murió»."
            error={problemOf("expectations.closeCode")}
          >
            <input
              type="number"
              className={inputClass}
              value={closeCode}
              disabled={!canEdit}
              onChange={(event) => setCloseCode(event.target.value)}
            />
          </Field>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-slate-600">Tramas guardadas</p>
        <p className="mb-2 text-[11px] text-slate-500">
          Lo que se manda a menudo, para no reteclear la trama de auth en cada sesión.
        </p>
        <div className="space-y-2">
          {saved.map((row, index) => (
            <div key={index} className="flex gap-2">
              <input
                aria-label={`Nombre de la trama ${index + 1}`}
                className={cn(inputClass, "w-40")}
                value={row.name}
                disabled={!canEdit}
                onChange={(event) =>
                  setSaved(saved.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)))
                }
              />
              <textarea
                aria-label={`Cuerpo de la trama ${index + 1}`}
                className={cn(inputClass, "min-h-9 flex-1 font-mono text-xs")}
                value={row.body}
                disabled={!canEdit}
                onChange={(event) =>
                  setSaved(saved.map((item, at) => (at === index ? { ...item, body: event.target.value } : item)))
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
              onClick={() => setSaved([...saved, { name: "", body: "" }])}
            >
              Añadir trama
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
      {save.error && !problems.length && <p className="text-xs text-rose-600">{message(save.error)}</p>}

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
