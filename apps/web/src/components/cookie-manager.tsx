/**
 * El tarro de cookies: lo que hay guardado, y una para escribir a mano.
 *
 * Esta pantalla existe por lo mismo que en Postman: cuando una petición contesta 401 y no se sabe
 * por qué, lo primero que hay que poder mirar es **qué cookie se está mandando**. Sin la lista, el
 * tarro es un estado invisible que cambia la respuesta y no se puede inspeccionar.
 *
 * El valor sale tapado. Una cookie de sesión es una credencial: enseñarla de serie la deja en
 * cualquier captura de pantalla y en cualquier grabación. «Ver» la pide aparte, que es una llamada
 * distinta y con eso basta para que sea una decisión.
 *
 * Escribir una se hace pegando la línea `Set-Cookie` tal cual, y no rellenando seis campos, por dos
 * razones: es el formato que la gente ya tiene —se copia del inspector del navegador— y pasa por el
 * mismo lector que las del servidor, así que las reglas de dominio y de ruta son las mismas y no
 * una segunda versión que puede diferir.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Button } from "@/components/ui";
import { Modal } from "@/components/overlay";
import { useToast } from "@/components/toast";
import type { CookieView } from "@/lib/types";

const MASK = "•".repeat(8);

export function CookieManager({
  projectId,
  baseUrl,
  onClose,
}: {
  projectId: string;
  /** Para qué URL se escribe una cookie a mano: es lo que decide qué dominio puede declarar. */
  baseUrl: string;
  onClose: () => void;
}) {
  const organization = useOrganization();
  const base = `/orgs/${organization?.id}/projects/${projectId}/cookies`;
  const client = useQueryClient();
  const toast = useToast();
  const [revealed, setRevealed] = useState(false);
  const [line, setLine] = useState("");
  const [url, setUrl] = useState("");

  const cookies = useQuery({
    queryKey: ["cookies", projectId, revealed],
    queryFn: () => api<{ cookies: CookieView[] }>(`${base}${revealed ? "?reveal=true" : ""}`),
  });

  const refresh = () => void client.invalidateQueries({ queryKey: ["cookies", projectId] });

  const remove = useMutation({
    mutationFn: (cookie: CookieView | null) =>
      api<void>(
        cookie
          ? `${base}?domain=${encodeURIComponent(cookie.domain)}&path=${encodeURIComponent(cookie.path)}&name=${encodeURIComponent(cookie.name)}`
          : base,
        { method: "DELETE" },
      ),
    onSuccess: (_result, cookie) => {
      refresh();
      toast.success(cookie ? `Borrada ${cookie.name}` : "Tarro vacío");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const write = useMutation({
    mutationFn: () =>
      api<{ cookie: CookieView }>(base, { method: "POST", body: { url: url || baseUrl, setCookie: line } }),
    onSuccess: (result) => {
      refresh();
      setLine("");
      toast.success(`Guardada ${result.cookie.name}`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = cookies.data?.cookies ?? [];

  return (
    <Modal
      title="Cookies"
      description="Las que este proyecto presenta en tus peticiones. Son tuyas: nadie más de la organización las usa."
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={() => setRevealed(!revealed)}>
              {revealed ? "Tapar valores" : "Ver valores"}
            </Button>
            <Button variant="ghost" disabled={!rows.length || remove.isPending} onClick={() => remove.mutate(null)}>
              Vaciar
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
            {cookies.isPending ? "…" : "El tarro está vacío. Un login que conteste Set-Cookie lo llena."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">Nombre</th>
                  <th className="px-3 py-1.5 font-semibold">Valor</th>
                  <th className="px-3 py-1.5 font-semibold">Dominio</th>
                  <th className="px-3 py-1.5 font-semibold">Caduca</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((cookie) => (
                  <tr key={`${cookie.domain}${cookie.path}${cookie.name}`} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-mono text-slate-800">{cookie.name}</td>
                    <td className="max-w-48 truncate px-3 py-1.5 font-mono text-slate-500" title={cookie.value}>
                      {cookie.value || MASK}
                    </td>
                    <td className="px-3 py-1.5 text-slate-600">
                      {cookie.domain}
                      {cookie.path}
                      <span className="ml-1 text-slate-400">
                        {[
                          cookie.hostOnly ? "solo este host" : "y subdominios",
                          cookie.secure ? "Secure" : "",
                          cookie.httpOnly ? "HttpOnly" : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">
                      {cookie.expiresAt ? new Date(cookie.expiresAt).toLocaleString() : "al cerrar"}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        className="text-slate-400 hover:text-rose-600"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(cookie)}
                      >
                        borrar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="space-y-2 border-t border-slate-100 pt-3">
          <p className="text-[11px] font-semibold text-slate-700">Escribir una a mano</p>
          <p className="text-[11px] text-slate-500">
            La línea tal cual la manda un servidor. Se puede copiar del inspector del navegador. Pasa por las mismas
            reglas: un dominio que no es el de la URL se rechaza.
          </p>
          <input
            aria-label="Set-Cookie"
            className="h-8 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs outline-none focus:border-slate-900"
            placeholder="session=abc123; Path=/; HttpOnly"
            value={line}
            spellCheck={false}
            onChange={(event) => setLine(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="URL para la que vale"
              className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 font-mono text-xs outline-none focus:border-slate-900"
              placeholder={baseUrl || "https://api.ejemplo.com"}
              value={url}
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button disabled={!line.trim() || write.isPending} onClick={() => write.mutate()}>
              Guardar
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Qué cookies viajaron, qué se guardó, y qué no se guardó y por qué. */
export function CookiePanel({
  cookies,
}: {
  cookies: { sent: string[]; stored: string[]; rejected: { line: string; why: string }[] };
}) {
  const empty = !cookies.sent.length && !cookies.stored.length && !cookies.rejected.length;
  if (empty) {
    return (
      <p className="mt-2 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-[11px] text-slate-400">
        Ni se presentó ninguna cookie ni el servidor puso ninguna.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-2 text-[11px]">
      {cookies.sent.length > 0 && (
        <p className="text-slate-600">
          <span className="font-semibold">Se enviaron:</span> {cookies.sent.join(", ")}
        </p>
      )}
      {cookies.stored.length > 0 && (
        <p className="text-emerald-700">
          <span className="font-semibold">El servidor puso:</span> {cookies.stored.join(", ")}
        </p>
      )}
      {cookies.rejected.map((entry, index) => (
        <p key={index} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
          <span className="font-mono">{entry.line}</span> — no se guardó: {entry.why}
        </p>
      ))}
    </div>
  );
}
