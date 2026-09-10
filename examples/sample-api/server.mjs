/**
 * A small API to point the product at, so `docker compose up` has something to verify.
 *
 * It exists because a demo that verifies nothing demonstrates nothing. It publishes an OpenAPI
 * document, answers with a real envelope, and **carries one bug on purpose**: the delete is soft,
 * and the read by id forgot the flag. `DELETE /widgets/{id}` answers the `204` its contract
 * declares, the listing stops showing the row, and `GET /widgets/{id}` still serves it.
 *
 * That is the product's thesis in one case, and it is deliberately an ordinary bug rather than an
 * exotic one. A suite that asserts status codes sees `204` — exactly what was declared — and
 * reports a pass. The generated `delete-read` flow deletes and then **reads back**, and the read
 * answers `200` where `404` was declared, so the case goes red and says why.
 *
 * The bug is also deliberately *isolated*: because the flag is honoured everywhere except that one
 * read, the cleanup after a create still frees the name, the matrix can be run twice, and the run
 * comes back with two red rows among green ones instead of a cascade nobody reads.
 *
 * No dependencies, on purpose: `node server.mjs` and it runs, in the image or on a laptop.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 9000);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

/** In memory, reset on restart. A demo that accumulates state stops being a demo. */
let nextId = 3;
let widgets = [
  { id: 1, name: "Widget de muestra", colour: "azul", stock: 12, deleted: false },
  { id: 2, name: "Widget de repuesto", colour: "rojo", stock: 0, deleted: false },
];

/** What every path except one remembers to apply. See the `DELETE` handler. */
const live = () => widgets.filter((widget) => !widget.deleted);
/** The wire shape. `deleted` is bookkeeping and the contract does not declare it. */
const asWidget = ({ deleted, ...widget }) => widget;

const json = (response, status, body, contentType = "application/json") => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, payload ? { "content-type": contentType, "content-length": Buffer.byteLength(payload) } : {});
  response.end(payload);
};

/** RFC 9457, like everything this product asserts against. */
const problem = (response, status, title, detail, errors) =>
  json(response, status, { type: `${PUBLIC_URL}/problems/${title.toLowerCase().replace(/\s+/g, "-")}`, title, status, detail, ...(errors ? { errors } : {}) }, "application/problem+json");

const listEnvelope = (data, self) => ({ data, meta: { total: data.length, limit: 50 }, links: { self: `${PUBLIC_URL}${self}`, next: null, prev: null } });

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error("cuerpo demasiado grande"));
    });
    request.on("end", () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("el cuerpo no es JSON válido"));
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, PUBLIC_URL);
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (path === "/openapi.json") return json(response, 200, openapi());
  if (path === "/health") return json(response, 200, { status: "ok", checks: { memory: "ok" } });

  if (path === "/widgets" && method === "GET") {
    const colour = url.searchParams.get("colour");
    const filtered = colour ? live().filter((widget) => widget.colour === colour) : live();
    return json(response, 200, listEnvelope(filtered.map(asWidget), request.url));
  }

  if (path === "/widgets" && method === "POST") {
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return problem(response, 422, "Cuerpo invalido", error.message);
    }
    const missing = ["name", "colour"].filter((field) => typeof body?.[field] !== "string" || !body[field]);
    if (missing.length) {
      return problem(response, 422, "Entidad no procesable", "Faltan campos obligatorios", missing.map((field) => ({ field, detail: "es obligatorio y debe ser una cadena" })));
    }
    if (live().some((widget) => widget.name === body.name)) {
      return problem(response, 409, "Conflicto", `Ya existe un widget llamado ${body.name}`);
    }
    const widget = { id: nextId++, name: body.name, colour: body.colour, stock: Number(body.stock ?? 0), deleted: false };
    widgets.push(widget);
    return json(response, 201, { data: asWidget(widget) });
  }

  const detail = /^\/widgets\/(\d+)$/.exec(path);
  if (detail) {
    const id = Number(detail[1]);
    // **The deliberate defect lives here.** Every other path filters on `deleted`; the read by id
    // does not. It is a soft delete whose read path forgot the flag — one of the most ordinary
    // bugs there is, and completely invisible to a suite that checks status codes: the `DELETE`
    // answers the `204` its contract declares, and the row it promised to remove is still served.
    const widget = widgets.find((candidate) => candidate.id === id);
    const alive = widget && !widget.deleted ? widget : undefined;

    if (method === "GET") {
      if (!widget) return problem(response, 404, "No encontrado", `No existe el widget ${id}`);
      return json(response, 200, { data: asWidget(widget) });
    }

    if (method === "PATCH") {
      if (!alive) return problem(response, 404, "No encontrado", `No existe el widget ${id}`);
      let body;
      try {
        body = await readBody(request);
      } catch (error) {
        return problem(response, 422, "Cuerpo invalido", error.message);
      }
      // An empty patch is rejected rather than answered with 200: it is the 422 the contract
      // declares, and "modify nothing" is almost always a caller sending the wrong thing.
      if (!body || Object.keys(body).length === 0) {
        return problem(response, 422, "Entidad no procesable", "Un PATCH tiene que traer al menos un campo", [{ field: "", detail: "el cuerpo no puede estar vacío" }]);
      }
      const wrong = ["name", "colour"].filter((field) => body[field] !== undefined && typeof body[field] !== "string");
      if (wrong.length) {
        return problem(response, 422, "Entidad no procesable", "Campos con el tipo equivocado", wrong.map((field) => ({ field, detail: "debe ser una cadena" })));
      }
      Object.assign(widget, body);
      return json(response, 200, { data: asWidget(widget) });
    }

    if (method === "DELETE") {
      if (!alive) return problem(response, 404, "No encontrado", `No existe el widget ${id}`);
      // The flag is set, so the listing and the uniqueness check both stop seeing it — which is
      // why a run can be repeated and why the failure below stays isolated instead of turning
      // every later `POST` into a 409. Only the read by id still returns it.
      widget.deleted = true;
      return json(response, 204, undefined);
    }
  }

  return problem(response, 404, "No encontrado", `No hay ninguna ruta ${method} ${path}`);
});

server.listen(PORT, () => console.log(`sample-api en ${PUBLIC_URL} · contrato en ${PUBLIC_URL}/openapi.json`));

/** Written out rather than generated: it is the document under test, and a document derived from
 * the implementation would agree with it by construction — which is the failure this whole
 * product is about. */
function openapi() {
  const widget = {
    type: "object",
    required: ["id", "name", "colour", "stock"],
    properties: { id: { type: "integer" }, name: { type: "string" }, colour: { type: "string" }, stock: { type: "integer" } },
  };
  const problemSchema = {
    type: "object",
    required: ["type", "title", "status"],
    properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" }, errors: { type: "array", items: { type: "object" } } },
  };
  const listOf = {
    type: "object",
    required: ["data", "meta", "links"],
    properties: {
      data: { type: "array", items: widget },
      meta: { type: "object", required: ["total", "limit"], properties: { total: { type: "integer" }, limit: { type: "integer" } } },
      links: { type: "object", required: ["self"], properties: { self: { type: "string" }, next: { type: ["string", "null"] }, prev: { type: ["string", "null"] } } },
    },
  };
  const singleOf = { type: "object", required: ["data"], properties: { data: widget } };
  const body = (schema) => ({ content: { "application/json": { schema } } });
  const errorResponse = (description) => ({ description, content: { "application/problem+json": { schema: problemSchema } } });

  return {
    openapi: "3.0.3",
    info: { title: "Sample API", version: "1.0.0", description: "Un servicio de muestra para ver funcionando Endpoint Quality." },
    servers: [{ url: PUBLIC_URL }],
    paths: {
      "/health": {
        get: {
          operationId: "healthCheck",
          tags: ["Health"],
          summary: "Estado del servicio",
          responses: { 200: { description: "Vivo", ...body({ type: "object", required: ["status", "checks"], properties: { status: { type: "string" }, checks: { type: "object" } } }) } },
        },
      },
      "/widgets": {
        get: {
          operationId: "listWidgets",
          tags: ["Widgets"],
          summary: "Listado de widgets",
          parameters: [{ name: "colour", in: "query", schema: { type: "string" } }],
          responses: { 200: { description: "Listado", ...body(listOf) } },
        },
        post: {
          operationId: "createWidget",
          tags: ["Widgets"],
          summary: "Crear un widget",
          requestBody: body({ type: "object", required: ["name", "colour"], properties: { name: { type: "string" }, colour: { type: "string" }, stock: { type: "integer" } } }),
          responses: { 201: { description: "Creado", ...body(singleOf) }, 409: errorResponse("Nombre repetido"), 422: errorResponse("Cuerpo inválido") },
        },
      },
      "/widgets/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        get: { operationId: "getWidget", tags: ["Widgets"], summary: "Un widget", responses: { 200: { description: "El widget", ...body(singleOf) }, 404: errorResponse("No existe") } },
        patch: {
          operationId: "patchWidget",
          tags: ["Widgets"],
          summary: "Modificar un widget",
          requestBody: body({ type: "object", properties: { name: { type: "string" }, colour: { type: "string" }, stock: { type: "integer" } } }),
          responses: { 200: { description: "Modificado", ...body(singleOf) }, 404: errorResponse("No existe"), 422: errorResponse("Cuerpo inválido") },
        },
        delete: {
          operationId: "deleteWidget",
          tags: ["Widgets"],
          summary: "Eliminar un widget",
          // Declared, and answered — but not honoured. See the handler.
          responses: { 204: { description: "Eliminado" }, 404: errorResponse("No existe") },
        },
      },
    },
  };
}
