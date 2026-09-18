/**
 * «Capturar tráfico»: la pestaña del import donde se graba lo que pasa por un proxy.
 *
 * Vive **dentro del diálogo de importar** y no en una pantalla propia, que es donde la pone Postman
 * (junto a sus otras formas de traer cosas) y donde ya está el HAR, que es lo mismo grabado de otra
 * manera. Y termina igual que el resto de pestañas: lo elegido va por la puerta del HAR en el
 * servidor y el diálogo enseña el mismo resumen, con los endpoints creados enlazados.
 *
 * Tres cosas que esta pantalla cuida:
 *
 * - **El token se ve una vez.** Llega al abrir la sesión, vive en el estado de este componente y se
 *   va con él. Ninguna lectura del servidor lo repite; quien lo pierde abre otra sesión.
 * - **La lista viene marcada con el filtro del import.** Lo que el import tiraría —un bundle, una
 *   hoja de estilo, un `OPTIONS`, un túnel cifrado— llega sin marcar y dice por qué, así que lo que
 *   se importa por omisión es la API y nada más.
 * - **Descifrar HTTPS es por sesión y solo si el servidor lo ofrece.** Con `CAPTURE_MITM` apagado
 *   la opción no aparece; encendido, se marca antes de abrir y la CA se descarga desde aquí mismo.
 * - **La lista se lee por cursor.** Se pregunta cada segundo y medio por lo que vino después de lo
 *   último que ya se tiene, sin cuerpos: una sesión de quinientas no se vuelve a bajar entera.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { useOrganization } from "@/lib/auth";
import { Button, inputClass } from "@/components/ui";
import { cn } from "@/lib/format";
import type {
  CaptureAuthorityView,
  CaptureItemSummaryView,
  CaptureMitmView,
  CaptureOverviewView,
  CapturePageView,
  CaptureSessionView,
  CaptureStartedView,
  ImportAnythingResult,
} from "@/lib/types";

/** Cada cuánto se pregunta por lo nuevo mientras la sesión está abierta. */
export const CAPTURE_POLL_MS = 1500;

const STOP_REASON: Record<NonNullable<CaptureSessionView["stopReason"]>, string> = {
  manual: "parada a mano",
  expired: "se acabó su tiempo",
  "request-limit": "llegó al máximo de peticiones",
  replaced: "se abrió otra sesión",
  restart: "la API se reinició",
};

export function CaptureTraffic({
  projectId,
  onResult,
}: {
  projectId: string;
  /** Lo que contestó el import, para que el diálogo enseñe su resumen de siempre. */
  onResult: (result: ImportAnythingResult) => void;
}) {
  const organization = useOrganization();
  const base = `/orgs/${organization?.id}/projects/${projectId}/captures`;

  const overview = useQuery({
    queryKey: ["captures", projectId],
    enabled: Boolean(organization && projectId),
    queryFn: () => api<CaptureOverviewView>(base),
  });

  const [session, setSession] = useState<CaptureSessionView | null>(null);
  const [started, setStarted] = useState<CaptureStartedView | null>(null);
  const [items, setItems] = useState<CaptureItemSummaryView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [onlyApi, setOnlyApi] = useState(true);
  const [flow, setFlow] = useState(false);
  const [decryptHttps, setDecryptHttps] = useState(false);
  const [busy, setBusy] = useState<"start" | "stop" | "import" | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const cursor = useRef(0);

  // La última sesión del proyecto, para poder volver a ella: cerrar el diálogo a media captura no
  // puede costar lo capturado.
  useEffect(() => {
    if (!session && overview.data?.sessions[0]) setSession(overview.data.sessions[0]);
  }, [overview.data, session]);

  const sessionId = session?.id;
  const active = session?.status === "active";

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pull = async () => {
      try {
        const page = await api<CapturePageView>(`${base}/${sessionId}?after=${cursor.current}`);
        if (cancelled) return;
        if (page.items.length) {
          cursor.current = page.items[page.items.length - 1].seq;
          setItems((current) => [...current, ...page.items]);
          // Lo que el import no tiraría llega marcado; el ruido, no.
          setSelected((current) => {
            const next = new Set(current);
            for (const item of page.items) if (!item.noise) next.add(item.id);
            return next;
          });
        }
        setSession(page.session);
        // Una página llena es que hay más: se pide ya. Si no, se espera mientras siga abierta.
        if (page.items.length >= 200) timer = setTimeout(pull, 0);
        else if (page.session.status === "active") timer = setTimeout(pull, CAPTURE_POLL_MS);
      } catch (error) {
        if (!cancelled) setProblem(error);
      }
    };
    void pull();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Se vuelve a enganchar al cambiar de sesión o al pasar de abierta a parada, no con cada página.
  }, [base, sessionId, active]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return items.filter(
      (item) =>
        (!onlyApi || !item.noise) &&
        (!needle || `${item.method} ${item.url} ${item.status ?? ""}`.toLowerCase().includes(needle)),
    );
  }, [items, filter, onlyApi]);

  const start = async () => {
    setBusy("start");
    setProblem(null);
    try {
      // Solo se pide descifrar si el servidor lo ofrece; si no, la opción ni se ve.
      const opened = await api<CaptureStartedView>(
        base,
        overview.data?.mitm ? { method: "POST", body: { decryptHttps } } : { method: "POST" },
      );
      cursor.current = 0;
      setItems([]);
      setSelected(new Set());
      setStarted(opened);
      setSession(opened.session);
      void overview.refetch();
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!session) return;
    setBusy("stop");
    try {
      setSession(await api<CaptureSessionView>(`${base}/${session.id}/stop`, { method: "POST" }));
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };

  const importSelected = async () => {
    if (!session) return;
    setBusy("import");
    setProblem(null);
    try {
      const itemIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);
      onResult(
        await api<ImportAnythingResult>(`${base}/${session.id}/import`, {
          method: "POST",
          body: { itemIds, flow },
        }),
      );
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (overview.isPending) return <p className="mt-3 text-xs text-slate-500">Cargando…</p>;
  if (overview.data && !overview.data.enabled) {
    return (
      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900">
        <p className="font-medium">La captura de tráfico no está activada en esta instalación.</p>
        <p className="mt-1 text-[11px] leading-4">
          Quien administra el servidor tiene que definir <code>CAPTURE_PROXY_PORT</code> (y publicar ese puerto). Está
          apagada por omisión porque abre un proxy con salida a la red desde el servidor.
        </p>
      </div>
    );
  }

  const chosen = items.filter((item) => selected.has(item.id)).length;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Button variant="danger" className="h-8 text-xs" disabled={busy !== null} onClick={() => void stop()}>
            {busy === "stop" ? "Parando…" : "Parar la captura"}
          </Button>
        ) : (
          <Button className="h-8 text-xs" disabled={busy !== null} onClick={() => void start()}>
            {busy === "start" ? "Abriendo…" : session ? "Nueva captura" : "Empezar a capturar"}
          </Button>
        )}
        {session && <SessionState session={session} />}
      </div>

      {overview.data?.mitm && !active && (
        <HttpsOption
          mitm={overview.data.mitm}
          checked={decryptHttps}
          onChange={setDecryptHttps}
          base={base}
          onProblem={setProblem}
        />
      )}

      {active && started && started.session.id === session?.id && (
        <Instructions started={started} decrypting={started.session.decryptHttps} base={base} onProblem={setProblem} />
      )}
      {active && (!started || started.session.id !== session?.id) && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-600">
          Esta sesión sigue abierta, pero su contraseña solo se enseñó al abrirla. Si ya no la tienes, abre una nueva:
          la anterior se cierra sola.
        </p>
      )}

      {problem !== null && <CaptureProblem error={problem} />}

      {session && (
        <CaptureList
          items={visible}
          total={items.length}
          selected={selected}
          onToggle={toggle}
          filter={filter}
          onFilter={setFilter}
          onlyApi={onlyApi}
          onOnlyApi={setOnlyApi}
        />
      )}

      {session && items.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <input type="checkbox" checked={flow} onChange={(event) => setFlow(event.target.checked)} />
            Crear también un flujo, en el orden capturado
          </label>
          <Button className="h-8 text-xs" disabled={!chosen || busy !== null} onClick={() => void importSelected()}>
            {busy === "import" ? "Importando…" : `Importar ${chosen} ${chosen === 1 ? "petición" : "peticiones"}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function SessionState({ session }: { session: CaptureSessionView }) {
  const until = new Date(session.expiresAt).toLocaleTimeString();
  return (
    <span className="text-[11px] text-slate-500">
      {session.status === "active" ? (
        <>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" aria-hidden />
          Capturando · {session.itemCount} de {session.limits.maxRequests} · hasta las {until}
        </>
      ) : (
        <>
          Parada ({session.stopReason ? STOP_REASON[session.stopReason] : "sin motivo"}) · {session.itemCount}{" "}
          {session.itemCount === 1 ? "petición" : "peticiones"}
        </>
      )}
    </span>
  );
}

/**
 * Cómo apuntar el dispositivo al proxy.
 *
 * El nombre del servidor sale de la configuración cuando la hay y, si no, del nombre con el que se
 * abrió esta página: es el que el navegador ya sabe alcanzar.
 */
function Instructions({
  started,
  decrypting,
  base,
  onProblem,
}: {
  started: CaptureStartedView;
  decrypting: boolean;
  base: string;
  onProblem: (error: unknown) => void;
}) {
  const host = started.proxy.host ?? window.location.hostname;
  const rows: [string, string][] = [
    ["Servidor", host],
    ["Puerto", String(started.proxy.port)],
    ["Usuario", started.proxy.username],
    ["Contraseña", started.token],
  ];
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-medium text-slate-800">Configura este proxy HTTP en el navegador o el dispositivo</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-500">{label}</dt>
            <dd className="flex items-center gap-2 font-mono text-slate-800">
              <span className="break-all" data-testid={`proxy-${label.toLowerCase()}`}>
                {value}
              </span>
              <button
                className="shrink-0 rounded px-1 font-sans text-[10px] text-slate-500 hover:bg-slate-200"
                aria-label={`Copiar ${label.toLowerCase()}`}
                onClick={() => void navigator.clipboard?.writeText(value)}
              >
                copiar
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] leading-4 text-amber-800">
        La contraseña solo se enseña ahora: no se guarda en ningún sitio. La sesión se cierra sola a las{" "}
        {new Date(started.session.expiresAt).toLocaleTimeString()} o al llegar a {started.session.limits.maxRequests}{" "}
        peticiones.
      </p>
      {decrypting ? (
        <div className="mt-1 space-y-1 text-[11px] leading-4 text-slate-500">
          <p>
            Esta sesión descifra HTTPS: el dispositivo tiene que confiar en la CA de captura, o sus conexiones seguras
            fallarán y quedarán en la lista con el motivo.
          </p>
          <CertificateDownload base={base} onProblem={onProblem} />
        </div>
      ) : (
        <p className="mt-1 text-[11px] leading-4 text-slate-500">
          Lo que va por HTTPS pasa por un túnel que el proxy no abre: se apunta a qué servidor iba, «cifrado, sin
          detalle», y no se puede importar.
        </p>
      )}
      <p className="mt-1 text-[11px] leading-4 text-slate-500">
        Las cabeceras de credenciales y los campos con contraseñas o tokens se guardan tapados.
      </p>
    </div>
  );
}

/**
 * «Descifrar HTTPS», antes de abrir la sesión. Solo aparece si el servidor lo tiene encendido
 * (`CAPTURE_MITM`), y desactivado con el motivo cuando no puede usarse —sin `SECRETS_KEY`, por
 * ejemplo—: una opción que falla al pulsar «Empezar» no dice nada que sirva.
 */
function HttpsOption({
  mitm,
  checked,
  onChange,
  base,
  onProblem,
}: {
  mitm: CaptureMitmView;
  checked: boolean;
  onChange: (value: boolean) => void;
  base: string;
  onProblem: (error: unknown) => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-[11px] leading-4 text-slate-600">
      <label className="flex items-center gap-1.5 font-medium text-slate-800">
        <input
          type="checkbox"
          checked={checked && mitm.ready}
          disabled={!mitm.ready}
          onChange={(event) => onChange(event.target.checked)}
        />
        Descifrar HTTPS
      </label>
      {mitm.ready ? (
        <>
          <p className="mt-1">
            El proxy verá dentro de las conexiones seguras y podrás importarlas como el resto. Para eso el dispositivo
            tiene que instalar la CA de captura de esta instalación como raíz de confianza.
          </p>
          <CertificateDownload base={base} onProblem={onProblem} />
        </>
      ) : (
        <p className="mt-1 text-amber-800">No se puede usar en esta instalación: {mitm.problem}</p>
      )}
    </div>
  );
}

/**
 * La CA para instalar en el dispositivo: solo el certificado, que es público. Se baja con la sesión
 * de la aplicación y se entrega como fichero, porque la ruta pide la cabecera `Authorization`.
 */
function CertificateDownload({ base, onProblem }: { base: string; onProblem: (error: unknown) => void }) {
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const download = async () => {
    try {
      const authority = await api<CaptureAuthorityView>(`${base}/authority/certificate`);
      const url = URL.createObjectURL(new Blob([authority.pem], { type: "application/x-pem-file" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = authority.fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setFingerprint(authority.fingerprint);
    } catch (error) {
      onProblem(error);
    }
  };
  return (
    <div className="mt-2 space-y-1">
      <Button variant="ghost" className="h-7 text-[11px]" onClick={() => void download()}>
        Descargar el certificado de la CA
      </Button>
      {fingerprint && (
        <p className="break-all font-mono text-[10px] text-slate-500" data-testid="ca-fingerprint">
          SHA-256 {fingerprint}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-slate-700">Cómo instalarla</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>macOS: ábrela con Acceso a Llaveros, en «Sistema»; en el certificado, «Confiar» → «Confiar siempre».</li>
          <li>
            Windows: doble clic → «Instalar certificado» → «Equipo local» → «Entidades de certificación raíz de
            confianza».
          </li>
          <li>
            iPhone/iPad: ábrela en el dispositivo e instala el perfil; luego Ajustes → General → Información → Ajustes
            de confianza de certificados, y actívala.
          </li>
          <li>
            Android: Ajustes → Seguridad → Cifrado → Instalar un certificado → Certificado de CA. Desde Android 7 las
            apps solo confían en ella si su configuración de red lo permite.
          </li>
          <li>Firefox usa su propio almacén: Ajustes → Privacidad y seguridad → Certificados → Importar.</li>
        </ul>
        <p className="mt-1 text-amber-800">
          Esta CA puede firmar certificados para cualquier dominio: instálala solo en dispositivos de prueba y quítala
          al terminar. Las apps que fijan el certificado de su servidor no se pueden descifrar.
        </p>
      </details>
    </div>
  );
}

function CaptureList({
  items,
  total,
  selected,
  onToggle,
  filter,
  onFilter,
  onlyApi,
  onOnlyApi,
}: {
  items: CaptureItemSummaryView[];
  total: number;
  selected: Set<string>;
  onToggle: (id: string) => void;
  filter: string;
  onFilter: (value: string) => void;
  onlyApi: boolean;
  onOnlyApi: (value: boolean) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          className={`${inputClass} h-8 text-xs`}
          aria-label="Filtrar peticiones capturadas"
          placeholder="Filtrar por método, URL o estado"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
        />
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-600">
          <input type="checkbox" checked={onlyApi} onChange={(event) => onOnlyApi(event.target.checked)} />
          Solo la API
        </label>
      </div>
      {total === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">Todavía no ha pasado nada por el proxy.</p>
      ) : (
        <ul className="mt-2 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 px-2 py-1.5">
              <input
                type="checkbox"
                className="mt-0.5"
                aria-label={`Elegir ${item.method} ${item.url}`}
                checked={selected.has(item.id)}
                disabled={item.encrypted}
                onChange={() => onToggle(item.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] text-slate-800">
                  <span className="font-semibold">{item.method}</span> {item.url}
                </p>
                {(item.noise || item.error) && (
                  <p className={cn("text-[10px]", item.error ? "text-rose-700" : "text-slate-400")}>
                    {item.error ?? item.noise}
                  </p>
                )}
              </div>
              <span
                className={cn(
                  "shrink-0 font-mono text-[11px]",
                  item.status === null ? "text-slate-400" : item.status >= 400 ? "text-rose-700" : "text-emerald-700",
                )}
              >
                {item.status ?? "—"}
              </span>
            </li>
          ))}
          {items.length === 0 && (
            <li className="px-2 py-1.5 text-[11px] text-slate-500">Nada coincide con el filtro.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function CaptureProblem({ error }: { error: unknown }) {
  const problem = error instanceof ApiError ? error : null;
  return (
    <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
      <p>{problem ? problem.message : "Algo falló con la captura"}</p>
      {problem?.fields.map((field, index) => (
        <p key={index} className="mt-0.5 text-[11px]">
          {field.detail}
        </p>
      ))}
    </div>
  );
}
