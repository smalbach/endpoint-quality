/**
 * La parte de un canal gRPC que no tiene un WebSocket: de dónde sale la definición, qué método se
 * invoca, con qué mensaje y con qué plazo.
 *
 * Como Postman: los `.proto` se suben —con sus `import`, varios a la vez— o se le pregunta al
 * servidor por reflexión, y de cualquiera de las dos sale el mismo selector de servicio y método.
 * «Generar ejemplo» escribe el mensaje de entrada con sus valores por omisión, que lo calcula el
 * servidor a partir del tipo: aquí no se lee ningún `.proto`.
 *
 * Los `.proto` se guardan al subirlos —aparte del resto del canal— porque se leen allí mismo: un
 * conjunto que no se puede leer se dice en ese momento, con el fichero y la línea. El resto
 * (servicio, método, mensaje, plazo) se guarda con «Guardar», como cualquier ajuste del canal.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/format";
import type { GrpcMethodView, GrpcSchemaView, GrpcSettingsView } from "@/lib/types";
import { Button, Field, inputClass } from "@/components/ui";

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

/** El texto de un fichero. Con `FileReader` y no `file.text()`, que no todos los entornos tienen. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`No se pudo leer ${file.name}`));
    reader.readAsText(file);
  });
}

/** Cómo se llama cada forma de llamada, en la lista y junto al método elegido. */
export function callKind(method: Pick<GrpcMethodView, "clientStreaming" | "serverStreaming">): string {
  if (method.clientStreaming && method.serverStreaming) return "bidireccional";
  if (method.clientStreaming) return "stream de cliente";
  if (method.serverStreaming) return "stream de servidor";
  return "unaria";
}

export function GrpcChannelForm({
  base,
  channelId,
  value,
  onChange,
  canEdit,
  environmentId,
  problemOf,
}: {
  base: string;
  channelId: string;
  value: GrpcSettingsView;
  onChange: (next: GrpcSettingsView) => void;
  canEdit: boolean;
  environmentId: string | null;
  problemOf?: (field: string) => string | undefined;
}) {
  const queryClient = useQueryClient();
  const [reflected, setReflected] = useState<GrpcSchemaView | null>(null);
  const stored = useQuery({
    queryKey: ["channel-grpc", channelId],
    queryFn: () => api<GrpcSchemaView>(`${base}/channels/${channelId}/grpc`),
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) =>
      api<GrpcSchemaView>(`${base}/channels/${channelId}/grpc/protos`, {
        method: "PUT",
        body: {
          // La ruta dentro de la carpeta cuando se sube una carpeta: es la que nombran los `import`.
          files: await Promise.all(
            files.map(async (file) => ({ path: file.webkitRelativePath || file.name, content: await readText(file) })),
          ),
        },
      }),
    onSuccess: (schema) => queryClient.setQueryData(["channel-grpc", channelId], schema),
  });
  const reflect = useMutation({
    mutationFn: () =>
      api<GrpcSchemaView>(`${base}/channels/${channelId}/grpc/reflection`, {
        method: "POST",
        body: environmentId ? { environmentId } : {},
      }),
    onSuccess: setReflected,
  });

  const schema = value.source === "reflection" ? reflected : (stored.data ?? null);
  const services = schema?.services ?? [];
  const service = services.find((candidate) => candidate.name === value.service) ?? null;
  const method = service?.methods.find((candidate) => candidate.name === value.method) ?? null;
  const set = (patch: Partial<GrpcSettingsView>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-600">Definición</span>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5 text-xs" role="radiogroup" aria-label="Definición">
          {(
            [
              ["proto", "Ficheros .proto"],
              ["reflection", "Reflexión del servidor"],
            ] as const
          ).map(([source, label]) => (
            <button
              key={source}
              type="button"
              role="radio"
              aria-checked={value.source === source}
              disabled={!canEdit}
              onClick={() => set({ source })}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium",
                value.source === source ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {value.source === "proto" ? (
        <div className="space-y-1 text-xs">
          {canEdit && (
            <label className="inline-flex cursor-pointer items-center gap-2 text-slate-600">
              <span className="rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50">
                {upload.isPending ? "Leyendo…" : "Subir .proto"}
              </span>
              <input
                type="file"
                accept=".proto"
                multiple
                aria-label="Ficheros .proto"
                className="sr-only"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  if (files.length) upload.mutate(files);
                  event.target.value = "";
                }}
              />
              <span className="text-slate-400">todos a la vez, con los que importan</span>
            </label>
          )}
          {stored.data?.files.length ? (
            <p className="font-mono text-[11px] text-slate-500">
              {stored.data.files.map((file) => file.path).join(" · ")}
            </p>
          ) : (
            <p className="text-slate-400">Ningún .proto todavía.</p>
          )}
          {(upload.error || stored.data?.problem) && (
            <p className="text-rose-600">{upload.error ? message(upload.error) : stored.data?.problem}</p>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            variant="ghost"
            className="h-7 text-xs"
            disabled={!canEdit || reflect.isPending}
            onClick={() => reflect.mutate()}
          >
            {reflect.isPending ? "Preguntando…" : "Cargar servicios"}
          </Button>
          <span className="text-slate-400">
            con la URL, la metadata y la autenticación del canal; se vuelve a preguntar en cada llamada
          </span>
          {reflect.error && <p className="w-full text-rose-600">{message(reflect.error)}</p>}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Servicio" error={problemOf?.("grpc.service")}>
          <select
            className={inputClass}
            value={value.service}
            disabled={!canEdit}
            onChange={(event) => set({ service: event.target.value, method: "" })}
          >
            <option value="">{services.length ? "Elige un servicio" : "Sin servicios cargados"}</option>
            {services.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name}
              </option>
            ))}
            {value.service && !service && <option value={value.service}>{value.service}</option>}
          </select>
        </Field>
        <Field
          label="Método"
          hint={method ? `${callKind(method)} · ${method.requestType} → ${method.responseType}` : undefined}
          error={problemOf?.("grpc.method")}
        >
          <select
            className={inputClass}
            value={value.method}
            disabled={!canEdit}
            onChange={(event) => set({ method: event.target.value })}
          >
            <option value="">{service ? "Elige un método" : "Elige antes el servicio"}</option>
            {service?.methods.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} ({callKind(candidate)})
              </option>
            ))}
            {value.method && !method && <option value={value.method}>{value.method}</option>}
          </select>
        </Field>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-600">Mensaje</span>
          <Button
            variant="ghost"
            className="h-7 text-xs"
            disabled={!canEdit || !method}
            onClick={() => method && set({ message: method.example })}
          >
            Generar ejemplo
          </Button>
        </div>
        <textarea
          aria-label="Mensaje de la petición"
          className={cn(inputClass, "min-h-24 font-mono text-xs")}
          value={value.message}
          disabled={!canEdit}
          placeholder='{"item_id": "{{itemId}}"}'
          onChange={(event) => set({ message: event.target.value })}
        />
        <p className="mt-1 text-[11px] text-slate-500">
          {method?.clientStreaming
            ? "Este método recibe un stream: tras invocar, cada mensaje se manda con «Enviar»."
            : "JSON con {{variables}}; viaja con la llamada al invocar."}
          {method && !method.readOnly && " En un entorno sin escrituras no se invoca: no está declarado sin efectos."}
        </p>
        {problemOf?.("grpc.message") && <p className="text-xs text-rose-600">{problemOf("grpc.message")}</p>}
      </div>

      <Field
        label="Plazo (ms)"
        hint="Vacío: sin plazo propio, la cortan los topes de la sesión. Viaja al servidor como grpc-timeout."
        error={problemOf?.("grpc.deadlineMs")}
      >
        <input
          type="number"
          min={1}
          className={inputClass}
          value={value.deadlineMs ?? ""}
          disabled={!canEdit}
          onChange={(event) => set({ deadlineMs: event.target.value === "" ? null : Number(event.target.value) })}
        />
      </Field>
    </div>
  );
}
