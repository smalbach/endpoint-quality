#!/usr/bin/env node
/**
 * La prueba de paridad entre backends.
 *
 * Corre el mismo guion de HTTP contra cada implementación y compara **contra la de referencia**
 * (NestJS). No es un test de cada backend por separado: es la definición operativa de lo que
 * significa que un módulo esté portado. Un módulo está portado cuando su bloque pasa aquí, y no
 * cuando alguien lo declara en el descriptor.
 *
 *   node tools/conformance/run.mjs                      los tres, con los puertos por defecto
 *   node tools/conformance/run.mjs --only auth,projects  solo esos módulos
 *   node tools/conformance/run.mjs --backend python      uno, igualmente contra la referencia
 *
 * Sin dependencias, como `tools/eq-run.mjs`: un fichero que corre cualquier Node 22.
 *
 * Códigos de salida, con la misma lógica que el lanzador de corridas: **0** todo cuadra, **1** hay
 * divergencias, **2** no se pudo ejecutar (un backend no contesta, faltan argumentos).
 */

import { scenarios } from "./scenarios.mjs";

const BACKENDS = [
  { id: "node", label: "NestJS", url: process.env.EQ_NODE_URL ?? "http://localhost:3001", reference: true },
  { id: "python", label: "FastAPI", url: process.env.EQ_PY_URL ?? "http://localhost:3002" },
  { id: "go", label: "Go", url: process.env.EQ_GO_URL ?? "http://localhost:3003" },
];

const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const only = argument("only")
  ?.split(",")
  .map((value) => value.trim());
const chosen = argument("backend");

/** Colores solo si hay una terminal delante: en un log de CI los códigos ANSI son ruido. */
const tty = process.stdout.isTTY;
const paint = (code, text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (text) => paint("32", text);
const red = (text) => paint("31", text);
const yellow = (text) => paint("33", text);
const dim = (text) => paint("2", text);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const VOLATILE = new Set(["latencyMs"]);
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Sustituye lo que cambia de una corrida a otra por un marcador.
 *
 * Sin esto, comparar dos respuestas sería comparar dos uuids distintos y declarar que los backends
 * divergen siempre. Lo que queda después de normalizar es la **forma**: qué claves hay, en qué
 * orden, con qué tipos y con qué valores fijos — que es exactamente lo que un cliente espera.
 */
function normalize(value, run) {
  if (typeof value === "string") {
    if (UUID.test(value)) return "<uuid>";
    // También dentro de una cadena: `instance` es una ruta con identificadores incrustados, y sin
    // esto dos backends que contestan exactamente lo mismo parecerían divergir siempre. Se compara
    // el resultado del reemplazo en vez de usar `test`, que sobre un regex global lleva estado en
    // `lastIndex` y contesta distinto en llamadas alternas.
    const withoutIds = value.replace(UUID_ANYWHERE, "<uuid>");
    if (withoutIds !== value) return normalize(withoutIds, run);
    if (ISO_DATE.test(value)) return "<fecha>";
    if (JWT.test(value) && value.length > 80) return "<jwt>";
    if (value.startsWith("eqt_")) return "<token-de-servicio>";
    // Un opaco de 32 bytes en base64url: el refresco y el de una invitación.
    if (/^[\w-]{40,}$/.test(value)) return "<token>";
    return value.split(run).join("<run>");
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, run));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      // Una medición no es una forma: `latencyMs` vale 1 en un backend y 2 en el otro por lo que
      // tardó el disco, no por lo que contesta el código. Compararla sería comparar el ruido.
      Object.entries(value).map(([key, item]) => [key, VOLATILE.has(key) ? "<medición>" : normalize(item, run)]),
    );
  }
  return value;
}

/** El valor de una plantilla `{{nombre}}`, o la cadena tal cual si no lo es. */
function fill(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => variables[name] ?? `{{${name}}}`);
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, variables)]));
  }
  return value;
}

/** Los atributos de una cookie, en minúsculas, para poder afirmar sobre ellos sin depender del
 * capricho de mayúsculas de cada framework. */
function cookieAttributes(header) {
  return header
    .split(";")
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

let throttled = false;

async function runScenario(backend, step, variables, run) {
  const headers = { ...(step.headers ?? {}) };
  if (step.body !== undefined) headers["content-type"] = "application/json";
  if (step.auth === "session" && variables.accessToken) headers.Authorization = `Bearer ${variables.accessToken}`;
  if (step.auth === "other" && variables.otherAccessToken)
    headers.Authorization = `Bearer ${variables.otherAccessToken}`;
  if (step.auth === "api-token" && variables.apiToken) headers.Authorization = `Bearer ${variables.apiToken}`;

  const path = fill(step.path, variables);
  const response = await fetch(`${backend.url}${path}`, {
    method: step.method,
    headers,
    ...(step.body === undefined ? {} : { body: JSON.stringify(fill(step.body, variables)) }),
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { "<no era json>": text.slice(0, 200) };
  }

  for (const [name, field] of Object.entries(step.capture ?? {})) {
    if (body && body[field] !== undefined) variables[name] = body[field];
  }

  const problems = [];
  if (response.status !== step.expect) {
    problems.push(`esperaba ${step.expect} y contestó ${response.status}`);
  }
  // El freno de peticiones es real y está bien que lo sea: el guion registra tres cuentas por
  // corrida y el tope son cinco por minuto. Cortado por ahí, todo lo que viene después contesta
  // 401 y el informe diría «divergen en cuarenta casos» cuando lo único que pasa es que nadie
  // llegó a entrar. Se distingue para poder decirlo, en vez de mentir con un rojo.
  if (response.status === 429 && step.expect !== 429) throttled = true;
  // Un error tiene que salir como Problem Details, con `type`, `title` y `status` coherente. Es
  // la mitad del contrato que más se olvida al portar, y la que el front lee para decidir qué
  // enseñar junto a qué campo.
  if (response.status >= 400 && body) {
    const kind = response.headers.get("content-type") ?? "";
    if (!kind.includes("problem+json")) problems.push(`el error no viaja como problem+json sino como «${kind}»`);
    if (typeof body.type !== "string" || !body.type.startsWith("https://endpoint-quality.dev/problems/")) {
      problems.push("el error no trae un `type` de este producto");
    }
    if (body.status !== response.status) problems.push("`status` del cuerpo y el del HTTP no coinciden");
  }
  if (step.cookie) {
    const header = response.headers.getSetCookie?.().find((value) => value.startsWith(`${step.cookie.name}=`));
    if (!header) problems.push(`no puso la cookie ${step.cookie.name}`);
    else {
      const attributes = cookieAttributes(header);
      for (const required of step.cookie.attributes) {
        if (!attributes.includes(required.toLowerCase())) problems.push(`la cookie no es ${required}`);
      }
    }
  }
  if (step.assert && response.status === step.expect) {
    const failure = step.assert(body);
    if (failure) problems.push(failure);
  }

  return {
    status: response.status,
    // La huella que se compara entre backends: el cuerpo sin lo que cambia en cada corrida.
    shape: JSON.stringify(normalize(body, run)),
    problems,
  };
}

async function runAll(backend) {
  // Cada backend corre con su propio sufijo: el guion escribe de verdad en la base compartida, y
  // dos corridas con el mismo correo chocarían con el 409 que el propio guion afirma.
  const run = `${backend.id}-${Date.now().toString(36)}`;
  // `--only` no puede tirar los pasos que fundan la cuenta y abren la sesión: sin ellos, el
  // bloque que se quiere mirar contestaría 401 y el informe diría que divergen cuando lo único
  // que pasa es que nadie entró.
  const steps = scenarios(run).filter((step) => !only || step.setup || only.includes(step.module));
  const variables = {};
  const results = [];
  for (const step of steps) {
    try {
      results.push({ step, ...(await runScenario(backend, step, variables, run)) });
    } catch (error) {
      results.push({
        step,
        status: 0,
        shape: "<sin respuesta>",
        problems: [`no contestó: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }
  return { run, results };
}

async function reachable(backend) {
  try {
    const response = await fetch(`${backend.url}/backend`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const main = async () => {
  const wanted = BACKENDS.filter((backend) => backend.reference || !chosen || backend.id === chosen);
  const live = [];
  for (const backend of wanted) {
    const descriptor = await reachable(backend);
    if (descriptor) live.push({ ...backend, descriptor });
    else if (backend.reference) {
      console.error(red(`La referencia (${backend.url}) no contesta. Sin ella no hay con qué comparar.`));
      process.exit(2);
    } else {
      console.log(dim(`· ${backend.label} (${backend.url}) no contesta; se omite.`));
    }
  }

  const reference = live.find((backend) => backend.reference);
  const runs = new Map();
  for (const backend of live) runs.set(backend.id, await runAll(backend));

  if (throttled) {
    console.error(
      red("\n  El freno de peticiones cortó la corrida: el guion funda tres cuentas y el tope son cinco al minuto."),
    );
    console.error(dim("  Espera un minuto y vuelve a lanzarlo. No se puede concluir nada de esta corrida.\n"));
    process.exit(2);
  }

  let divergences = 0;
  let surprises = 0;
  const referenceResults = runs.get(reference.id).results;

  console.log("");
  console.log(`  Conformidad · ${referenceResults.length} casos × ${live.length} backends`);
  console.log("");

  const modules = [...new Set(referenceResults.map((result) => result.step.module))];
  for (const module of modules) {
    const rows = referenceResults.filter((result) => result.step.module === module);
    console.log(`  ${module}`);
    for (const [index, row] of rows.entries()) {
      const position = referenceResults.indexOf(row);
      const marks = [];
      for (const backend of live) {
        const result = runs.get(backend.id).results[position];
        const comparable = row.step.compare !== false && backend.id !== reference.id;
        const mismatch = comparable && (result.status !== row.status || result.shape !== row.shape);
        const failed = result.problems.length > 0;
        if (mismatch) divergences += 1;
        // Un hallazgo declarado (`known`) es una diferencia entre lo que la referencia hace y lo
        // que debería hacer, ya escrita y con dueño. Se sigue enseñando en cada corrida —para que
        // no se vuelva invisible— y no cuenta como fallo: si contara, el guion estaría en rojo
        // permanente y dejaría de significar nada el día que aparezca una divergencia de verdad.
        if (failed && backend.id === reference.id && !row.step.known) surprises += 1;
        marks.push(mismatch ? red(`${backend.id}≠`) : failed ? yellow(`${backend.id}!`) : green(`${backend.id}✓`));
      }
      console.log(`    ${marks.join(" ")}  ${dim(`${index + 1}.`)} ${row.step.name}`);
      if (row.step.known) console.log(`        ${yellow("◆")} hallazgo conocido: ${row.step.known}`);

      for (const backend of live) {
        const result = runs.get(backend.id).results[position];
        for (const problem of result.problems) {
          console.log(`        ${yellow("·")} ${backend.id}: ${problem}`);
        }
        if (backend.id === reference.id || row.step.compare === false) continue;
        if (result.status !== row.status) {
          console.log(`        ${red("≠")} ${backend.id} contestó ${result.status} donde la referencia ${row.status}`);
        } else if (result.shape !== row.shape) {
          console.log(`        ${red("≠")} ${backend.id} devolvió otra forma`);
          console.log(`            referencia: ${dim(row.shape.slice(0, 300))}`);
          console.log(`            ${backend.id}: ${dim(result.shape.slice(0, 300))}`);
        }
      }
    }
    console.log("");
  }

  for (const backend of live) {
    const coverage = backend.descriptor.modules ?? {};
    const declared = Object.entries(coverage)
      .filter(([, value]) => value !== "none")
      .map(([name, value]) => (value === "full" ? name : `${name}(parcial)`));
    console.log(`  ${backend.label.padEnd(8)} ${dim(backend.descriptor.runtime ?? "")}`);
    console.log(`  ${" ".repeat(8)} ${dim(`declara: ${declared.join(", ") || "nada"}`)}`);
  }
  console.log("");

  if (divergences === 0 && surprises === 0) {
    console.log(
      green(`  Paridad: los ${live.length} backends contestan lo mismo en los ${referenceResults.length} casos.`),
    );
    process.exit(0);
  }
  if (divergences > 0) console.log(red(`  ${divergences} divergencia(s) respecto de la referencia.`));
  if (surprises > 0)
    console.log(yellow(`  ${surprises} caso(s) en los que la propia referencia no hace lo declarado.`));
  process.exit(1);
};

main().catch((error) => {
  console.error(red(`No se pudo ejecutar: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(2);
});
