/**
 * La página publicada: los endpoints de un proyecto, para quien no tiene cuenta aquí.
 *
 * Es la única pantalla del producto **fuera de la sesión**. No lleva el armazón de la aplicación, no
 * hay organización ni proyecto en el contexto, y lo único que sabe es el `publicId` de la URL. Lo
 * que se pinta viene entero de `/shared/docs/<publicId>`, que es el que decide qué se publica: esta
 * pantalla no filtra nada, porque un filtro en el navegador no es un filtro.
 *
 * ## El código, en los dieciséis lenguajes de la ola 2
 *
 * Y es el mismo generador, no una copia. Lo que la documentación de Postman hace con un fragmento
 * por lenguaje, aquí sale de `renderSnippet`, que ya estaba probado. Lo que **no** se puede
 * sustituir sale escrito como `{{variable}}` y con su aviso encima: la página no tiene el token de
 * nadie, y no debe tenerlo.
 *
 * ## La clave de una privada se queda en el navegador de quien la abre
 *
 * Si la documentación es privada, la API contesta 401 y esta pantalla pide la clave. Se guarda en
 * `localStorage` por `publicId` para no pedirla en cada recarga, y **no viaja en la URL**: una URL
 * con la clave dentro acaba en el historial, en el registro del proxy y en el «compartir» de
 * cualquiera.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "@/lib/api";
import {
  DEFAULT_SNIPPET,
  SNIPPET_LANGUAGES,
  authPlan,
  renderSnippet,
  snippetNotes,
  type SnippetBody,
  type SnippetRequest,
} from "@/lib/snippets";
import { MASKED_VALUE } from "@/lib/env-variables";
import type { DocEndpointView, DocPageView, RequestAuthView } from "@/lib/types";

const KEY_STORE = "eq.doc-key.";

/** La clave guardada de esta documentación, si quien abre la página ya la escribió alguna vez. */
function storedKey(publicId: string): string {
  try {
    return window.localStorage.getItem(`${KEY_STORE}${publicId}`) ?? "";
  } catch {
    // Sin almacenamiento —ventana privada, permisos— se pide en cada recarga y no se avisa: no
    // recordarla no es un error que le interese a nadie.
    return "";
  }
}

function rememberKey(publicId: string, key: string): void {
  try {
    window.localStorage.setItem(`${KEY_STORE}${publicId}`, key);
  } catch {
    // Ver `storedKey`.
  }
}

const METHOD_TONE: Record<string, string> = {
  GET: "bg-sky-100 text-sky-800",
  POST: "bg-emerald-100 text-emerald-800",
  PUT: "bg-amber-100 text-amber-800",
  PATCH: "bg-amber-100 text-amber-800",
  DELETE: "bg-rose-100 text-rose-800",
  HEAD: "bg-slate-100 text-slate-700",
  OPTIONS: "bg-slate-100 text-slate-700",
};

/**
 * Los parámetros de la autenticación que la página **no tiene**, escritos como lo que son.
 *
 * La API publica el tipo y nunca un valor, así que el fragmento de código se escribe con
 * marcadores. Eso hace dos cosas a la vez: el código enseña dónde va la credencial, y
 * `snippetNotes` avisa de que ahí falta algo — que es justo lo que hay que saber antes de pegarlo.
 */
function authParamsFor(endpoint: DocEndpointView): RequestAuthView {
  const auth = endpoint.auth;
  // La misma regla que `authPlan`: una cabecera `Authorization` escrita a mano gana. Sin esto el
  // aviso nombraría un `{{token}}` que no aparece en el código, y un aviso que no se corresponde
  // con lo que se ve es peor que ninguno.
  if (endpoint.headers.some((header) => header.name.toLowerCase() === "authorization"))
    return { type: "none", params: {} };
  switch (auth.type) {
    case "bearer":
    case "jwt":
    case "oauth2":
      return { type: auth.type, params: { token: "{{token}}" } };
    case "basic":
    case "digest":
      return { type: auth.type, params: { username: "{{usuario}}", password: "{{contraseña}}" } };
    case "apikey":
      // Sin el nombre no se puede escribir el par, y inventarse uno sería documentar algo falso.
      return auth.keyName
        ? { type: "apikey", params: { key: auth.keyName, value: "{{clave}}", in: auth.in } }
        : { type: "none", params: {} };
    default:
      // Firmadas (AWS, Hawk, EdgeGrid) y NTLM: el generador ya sabe que no puede escribirlas y lo
      // dice en una línea encima del código, que es mejor que un fragmento que da un 403 mudo.
      return { type: auth.type, params: {} };
  }
}

/**
 * El cuerpo para el fragmento de código, con los campos tapados escritos como marcadores.
 *
 * Es lo mismo que se hace con una cabecera tapada, y por lo mismo: los ocho puntos se pegan tal
 * cual y mandan ocho puntos por contraseña. `{{password}}` se ve como lo que hay que rellenar, y
 * además el generador lo cuenta en su aviso de lo que queda sin sustituir.
 *
 * Solo en JSON que parsea. Un cuerpo que no parsea se deja como está: adivinar dónde está el campo
 * dentro de un XML con una expresión regular es la clase de cosa que corta el cuerpo por la mitad.
 */
export function bodyWithPlaceholders(text: string, masked: string[]): string {
  if (!masked.length) return text;
  try {
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, inner]) =>
            inner === MASKED_VALUE && masked.includes(key) ? [key, `{{${key}}}`] : [key, walk(inner)],
          ),
        );
      }
      return value;
    };
    return JSON.stringify(walk(JSON.parse(text)), null, 2);
  } catch {
    return text;
  }
}

function snippetBodyOf(endpoint: DocEndpointView): SnippetBody {
  const body = endpoint.body;
  if (!body) return { kind: "none" };
  if (body.mode === "form-data")
    return { kind: "multipart", fields: body.fields.map((field) => ({ ...field, file: field.file })) };
  if (body.mode === "x-www-form-urlencoded")
    return { kind: "form", fields: body.fields.map((field) => ({ name: field.name, value: field.value })) };
  if (body.mode === "binary") return { kind: "binary", filename: "el-fichero" };
  return {
    kind: "text",
    text: body.mode === "json" ? bodyWithPlaceholders(body.text, body.masked) : body.text,
    contentType: body.contentType,
    json: body.mode === "json",
  };
}

/** La URL con los parámetros de consulta que la documentación enseña, para que el código se pegue. */
function urlWithQuery(endpoint: DocEndpointView): string {
  const pairs = endpoint.query.filter((row) => row.example !== "");
  if (!pairs.length) return endpoint.url;
  const query = pairs.map((row) => `${encodeURIComponent(row.name)}=${row.example}`).join("&");
  return `${endpoint.url}${endpoint.url.includes("?") ? "&" : "?"}${query}`;
}

function snippetOf(endpoint: DocEndpointView): SnippetRequest {
  return {
    method: endpoint.method,
    url: urlWithQuery(endpoint),
    // Una cabecera tapada sale como marcador y no con los ocho puntos: `{{authorization}}` en el
    // código se ve como lo que hay que rellenar, y los puntos se pegan tal cual y dan un 401.
    headers: endpoint.headers.map((header) => ({
      name: header.name,
      value: header.masked ? `{{${header.name.toLowerCase()}}}` : header.value,
    })),
    body: snippetBodyOf(endpoint),
    auth: authParamsFor(endpoint),
  };
}

export function PublishedDocsPage() {
  const { publicId = "" } = useParams();
  const [key, setKey] = useState(() => storedKey(publicId));
  const [typed, setTyped] = useState("");

  const page = useQuery({
    queryKey: ["published-docs", publicId, key],
    enabled: Boolean(publicId),
    queryFn: () =>
      api<DocPageView>(`/shared/docs/${publicId}`, {
        ...(key ? { headers: { "x-api-key": key } } : {}),
        // Sin reintento: un 401 de aquí no es la sesión de este producto caducada, y dejar que el
        // cliente intente refrescar cerraría la sesión de quien esté además dentro de la aplicación.
        retryOnUnauthorized: false,
      }),
    retry: false,
  });

  const error = page.error instanceof ApiError ? page.error : null;
  const needsKey = error?.status === 401;

  useEffect(() => {
    if (page.isSuccess && key) rememberKey(publicId, key);
  }, [page.isSuccess, key, publicId]);

  if (needsKey) {
    return (
      <Shell>
        <div className="mx-auto max-w-sm space-y-3 py-16">
          <h1 className="text-base font-semibold text-slate-900">Esta documentación es privada</h1>
          <p className="text-xs text-slate-500">
            Hace falta la clave que da quien la publicó. Se guarda en este navegador y no sale de aquí.
          </p>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              setKey(typed.trim());
            }}
          >
            <input
              autoFocus
              aria-label="Clave"
              type="password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <button
              type="submit"
              disabled={!typed.trim()}
              className="w-full rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Entrar
            </button>
          </form>
          {key && <p className="text-xs text-rose-600">Esa clave no vale.</p>}
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <div className="mx-auto max-w-md space-y-2 py-16 text-center">
          <h1 className="text-base font-semibold text-slate-900">Aquí no hay documentación</h1>
          <p className="text-xs text-slate-500">
            {/* El detalle viene del servidor: dice si no existe o si está despublicada, que es lo que
                quien tiene el enlace necesita saber para preguntar por él. */}
            {error.message}
          </p>
        </div>
      </Shell>
    );
  }

  if (!page.data) {
    return (
      <Shell>
        <p className="py-16 text-center text-sm text-slate-400">…</p>
      </Shell>
    );
  }

  const doc = page.data;
  return (
    <Shell>
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[14rem_1fr]">
        <nav className="text-xs lg:sticky lg:top-8 lg:self-start">
          <p className="mb-2 font-semibold text-slate-900">{doc.title}</p>
          <ul className="space-y-3">
            {doc.groups.map((group) => (
              <li key={group.tag}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.tag}</p>
                <ul className="space-y-0.5">
                  {group.endpoints.map((endpoint) => (
                    <li key={endpoint.id}>
                      <a href={`#${endpoint.id}`} className="block truncate text-slate-600 hover:text-slate-900">
                        <span className="font-mono text-[10px] text-slate-400">{endpoint.method}</span> {endpoint.path}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 space-y-8">
          <header className="space-y-3">
            <h1 className="text-xl font-semibold text-slate-900">{doc.title}</h1>
            {doc.description && <p className="text-sm text-slate-600">{doc.description}</p>}
            {doc.intro && <p className="whitespace-pre-wrap text-sm text-slate-600">{doc.intro}</p>}
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              {doc.baseUrl ? (
                <code className="rounded bg-slate-950 px-2 py-1 font-mono text-slate-100">{doc.baseUrl}</code>
              ) : (
                <span className="text-amber-700">
                  Sin URL base: las rutas salen sin host y el código de ejemplo hay que completarlo.
                </span>
              )}
              <span>
                {doc.counts.endpoints} rutas · {doc.counts.documented} con descripción
              </span>
            </div>
          </header>

          {doc.groups.map((group) => (
            <section key={group.tag} className="space-y-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{group.tag}</h2>
              {group.endpoints.map((endpoint) => (
                <EndpointSection key={endpoint.id} endpoint={endpoint} />
              ))}
            </section>
          ))}

          <footer className="border-t border-slate-200 pt-4 text-[11px] text-slate-400">
            Generada el {new Date(doc.generatedAt).toLocaleString("es-ES")}. Las variables escritas como{" "}
            <code className="font-mono">{"{{nombre}}"}</code> hay que sustituirlas por lo tuyo.
          </footer>
        </main>
      </div>
    </Shell>
  );
}

/** El armazón: fondo y nada más. Esta página no lleva la navegación de la aplicación. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-white text-slate-900">{children}</div>;
}

function EndpointSection({ endpoint }: { endpoint: DocEndpointView }) {
  return (
    <article id={endpoint.id} className="scroll-mt-8 space-y-3 rounded-xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${METHOD_TONE[endpoint.method] ?? "bg-slate-100 text-slate-700"}`}
        >
          {endpoint.method}
        </span>
        <code className="min-w-0 break-all font-mono text-sm text-slate-900">{endpoint.path}</code>
      </div>
      {endpoint.description ? (
        <p className="whitespace-pre-wrap text-sm text-slate-600">{endpoint.description}</p>
      ) : (
        <p className="text-xs italic text-slate-400">Sin descripción.</p>
      )}

      <p className="text-xs text-slate-600">
        <span className="font-medium text-slate-800">{endpoint.auth.label}.</span> {endpoint.auth.detail}
        {endpoint.auth.keyName && (
          <>
            {" "}
            Va en {endpoint.auth.in === "query" ? "el parámetro" : "la cabecera"}{" "}
            <code className="font-mono text-slate-700">{endpoint.auth.keyName}</code>.
          </>
        )}
      </p>

      {endpoint.pathParameters.length > 0 && (
        <ParameterTable title="Parámetros de ruta" rows={endpoint.pathParameters} />
      )}
      {endpoint.query.length > 0 && <ParameterTable title="Parámetros de consulta" rows={endpoint.query} />}

      {endpoint.headers.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Cabeceras</p>
          <ul className="space-y-0.5 text-xs">
            {endpoint.headers.map((header) => (
              <li key={header.name} className="font-mono text-slate-700">
                {header.name}: <span className={header.masked ? "text-slate-400" : ""}>{header.value}</span>
                {header.masked && <span className="ml-1 font-sans text-[11px] text-slate-400">(la tuya)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {endpoint.body && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Cuerpo · {endpoint.body.contentType}
          </p>
          {endpoint.body.text && (
            <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
              {endpoint.body.text}
            </pre>
          )}
          {endpoint.body.fields.length > 0 && (
            <ul className="space-y-0.5 text-xs font-mono text-slate-700">
              {endpoint.body.fields.map((field) => (
                <li key={field.name}>
                  {field.name}: {field.file ? <span className="text-slate-400">(un fichero)</span> : field.value}
                </li>
              ))}
            </ul>
          )}
          {endpoint.body.masked.length > 0 && (
            <p className="text-[11px] text-slate-400">
              Tapados por ser credenciales: {endpoint.body.masked.join(", ")}.
            </p>
          )}
        </div>
      )}

      <CodeBlock endpoint={endpoint} />

      {endpoint.examples.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Respuestas de ejemplo</p>
          {endpoint.examples.map((example) => (
            <div key={example.name} className="space-y-1">
              <p className="text-xs text-slate-600">
                <span className="font-mono font-semibold">{example.status}</span> · {example.name}
              </p>
              <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
                {example.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function ParameterTable({ title, rows }: { title: string; rows: DocEndpointView["query"] }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
      <ul className="space-y-1 text-xs">
        {rows.map((row) => (
          <li key={row.name}>
            <code className="font-mono text-slate-900">{row.name}</code>
            <span className="ml-1 text-slate-400">{row.type}</span>
            {row.required && <span className="ml-1 text-rose-600">obligatorio</span>}
            {row.description && <span className="ml-1 text-slate-600">— {row.description}</span>}
            {row.example && <span className="ml-1 font-mono text-slate-400">p. ej. {row.example}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * La petición como código, con el lenguaje que elija quien lee.
 *
 * El generador es el de la aplicación, no una copia: dieciséis lenguajes ya probados. Lo que el
 * fragmento no puede llevar sale **encima** del código, porque un aviso debajo de treinta líneas de
 * Rust es un aviso que nadie lee.
 */
function CodeBlock({ endpoint }: { endpoint: DocEndpointView }) {
  const [language, setLanguage] = useState(DEFAULT_SNIPPET);
  const request = useMemo(() => snippetOf(endpoint), [endpoint]);
  const code = renderSnippet(language, request);
  const notes = snippetNotes(request, authPlan(request.auth, request.headers));

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`lang-${endpoint.id}`}>
          Lenguaje
        </label>
        <select
          id={`lang-${endpoint.id}`}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px]"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          {SNIPPET_LANGUAGES.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100"
          onClick={() => void navigator.clipboard?.writeText(code)}
        >
          Copiar
        </button>
      </div>
      {notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-amber-700">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
        {code}
      </pre>
    </div>
  );
}
