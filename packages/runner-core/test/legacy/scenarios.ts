import type { Endpoint } from "./endpoints.ts";

export type ScenarioFlow =
  "request" | "create-read" | "replace-read" | "patch-read" | "delete-read" | "deleted-read" | "bulk-read";

/** How a case is meant to authenticate. `none` and `insufficient` are the two the contract
 * declares on every operation and that nothing exercised: 44 × 401 and 44 × 403, zero cases. */
export type ScenarioAuth = "default" | "none" | "insufficient" | "api-key";

export type TestScenario = {
  id: string;
  name: string;
  description: string;
  expectedStatus: number;
  parameters?: Record<string, string>;
  body?: Record<string, unknown>;
  flow: ScenarioFlow;
  auth?: ScenarioAuth;
};

const values: Record<string, string[]> = {
  cursor: ["eyJpZCI6MX0="],
  limit: ["1", "100", "0", "101"],
  ean_sap: ["7702001234567", "0000000000000"],
  code_sap: ["MAT-00123"],
  name_sap: ["leche", "producto-inexistente"],
  category_id: ["1", "999999"],
  store_id: ["1", "999999"],
  type_akn: ["product", "model"],
  family_code_akn: ["alimentos_liquidos"],
  q: ["leche entera", "termino-inexistente"],
  region: ["Centro", "region-inexistente"],
  department: ["Cundinamarca", "departamento-inexistente"],
  zone_id: ["ZN-01", "zona-inexistente"],
  lat: ["4.6482"],
  lon: ["-74.0648"],
  radius_km: ["1", "10"],
  product_id: ["1", "999999"],
  is_enabled: ["true", "false"],
  locale_akn: ["es_CO", "en_US"],
  channel_akn: ["app", "web"],
  parent_code_akn: ["alimentos", "root"],
  include_children: ["true", "false"],
};

function updatedBody(endpoint: Endpoint) {
  const body = { ...(endpoint.body ?? {}) };
  if (
    endpoint.path.includes("/products") &&
    !endpoint.path.includes("/categories") &&
    !endpoint.path.includes("/projections")
  )
    return { ...body, name_sap: "Producto reemplazado E2E" };
  if (endpoint.path.includes("/stores/")) return { ...body, name: "Ara reemplazada E2E" };
  if (endpoint.path.includes("/prices")) return { ...body, vkp0_base_price_sap: 5150 };
  if (endpoint.path.includes("/categories")) return { ...body, labels_akn: { es_CO: "Categoría reemplazada E2E" } };
  if (endpoint.path.includes("/projections")) return { ...body, name_akn: "Proyección reemplazada E2E" };
  if (endpoint.path.includes("/store-assortments")) return { ...body, is_enabled: false };
  return body;
}

function listScenarios(endpoint: Endpoint): TestScenario[] {
  const scenarios: TestScenario[] = [
    {
      id: "default",
      name: "Listado sin filtros",
      description: "Valida la respuesta por defecto, envelope y paginación.",
      expectedStatus: 200,
      flow: "request",
    },
  ];
  const queryParameters = endpoint.parameters?.filter((name) => !endpoint.path.includes(`{${name}}`)) ?? [];
  for (const parameter of queryParameters) {
    if (["lat", "lon", "radius_km"].includes(parameter)) continue;
    for (const value of values[parameter] ?? ["test"]) {
      const invalidLimit = parameter === "limit" && ["0", "101"].includes(value);
      scenarios.push({
        id: `${parameter}-${value}`,
        name: `${parameter} = ${value}`,
        description: invalidLimit
          ? "Comprueba el límite fuera de rango."
          : `Ejercita el filtro ${parameter} de forma independiente.`,
        expectedStatus: invalidLimit ? 422 : 200,
        parameters: { [parameter]: value },
        flow: "request",
      });
    }
  }
  if (queryParameters.includes("cursor"))
    scenarios.push({
      id: "cursor-invalid",
      name: "Cursor inválido",
      description: "Un cursor corrupto debe producir Problem Details y nunca un 500.",
      expectedStatus: 422,
      parameters: { cursor: "broken" },
      flow: "request",
    });
  if (queryParameters.includes("lat")) {
    scenarios.push(
      {
        id: "geo-1km",
        name: "Radio geográfico · 1 km",
        description: "Combina latitud, longitud y radio.",
        expectedStatus: 200,
        parameters: { lat: "4.6482", lon: "-74.0648", radius_km: "1" },
        flow: "request",
      },
      {
        id: "geo-20km",
        name: "Radio geográfico · 20 km",
        description: "Un radio amplio debe alcanzar más tiendas que el de 1 km.",
        expectedStatus: 200,
        parameters: { lat: "4.6482", lon: "-74.0648", radius_km: "20" },
        flow: "request",
      },
      {
        id: "geo-default",
        name: "Radio geográfico por defecto",
        description: "Envía coordenadas y verifica el radio contractual por defecto.",
        expectedStatus: 200,
        parameters: { lat: "4.6482", lon: "-74.0648" },
        flow: "request",
      },
      // The case that separates ST_DWithin from no filter at all: over the ocean the answer is
      // an empty list, and an ignored geographic filter answers with every store instead.
      {
        id: "geo-empty",
        name: "Radio sin tiendas dentro",
        description: "Coordenadas en mitad del océano: 200 con lista vacía, nunca el catálogo completo.",
        expectedStatus: 200,
        parameters: { lat: "0", lon: "0", radius_km: "1" },
        flow: "request",
      },
      {
        id: "geo-incomplete",
        name: "Coordenadas incompletas",
        description: "Latitud sin longitud debe rechazarse.",
        expectedStatus: 422,
        parameters: { lat: "4.6482" },
        flow: "request",
      },
      {
        id: "geo-radius-alone",
        name: "radius_km sin coordenadas",
        description: "Un radio sin lat/lon no es media búsqueda: debe rechazarse.",
        expectedStatus: 422,
        parameters: { radius_km: "5" },
        flow: "request",
      },
    );
  }
  if (queryParameters.includes("store_id") && queryParameters.includes("is_enabled"))
    scenarios.push({
      id: "store-enabled",
      name: "Tienda + habilitados",
      description: "Valida la combinación de filtros store_id e is_enabled.",
      expectedStatus: 200,
      parameters: { store_id: "1", is_enabled: "true" },
      flow: "request",
    });
  return scenarios;
}

/**
 * The 401 and 403 every operation declares and nobody was testing.
 *
 * Measured before this existed: of the 192 responses the contract declares across its 45
 * operations, **88 are 401 or 403 and none had a case**. The security surface was verified by
 * reading the table that describes it.
 *
 * They only run against a backend started with `--auth`; without it the API grants
 * `catalog:admin` to everyone and each of these would fail for the wrong reason. The dashboard
 * hides them unless the auth switch is on.
 */
function authScenarios(endpoint: Endpoint): TestScenario[] {
  if (endpoint.id === "healthCheck") return [];
  const scenarios: TestScenario[] = [];
  if (endpoint.statuses.includes(401))
    scenarios.push({
      id: "auth-none",
      name: "Sin credencial",
      description: "Sin token ni API key la operación debe responder 401 en Problem Details.",
      expectedStatus: 401,
      flow: "request",
      auth: "none",
      body: endpoint.body,
    });
  if (endpoint.statuses.includes(403))
    scenarios.push({
      id: "auth-insufficient",
      name: "Scope insuficiente",
      description: `Un token de ${endpoint.method === "DELETE" ? "catalog:write" : "catalog:read"} no alcanza para esta operación.`,
      expectedStatus: 403,
      flow: "request",
      auth: "insufficient",
      body: endpoint.body,
    });
  // D-29: the 7 DELETEs declare no `ApiKeyAuth`, so a valid key is **401 and not 403** — it is
  // not a permission problem, it is a credential the operation does not accept.
  if (endpoint.method === "DELETE")
    scenarios.push({
      id: "auth-api-key",
      name: "API key en un DELETE",
      description: "Los DELETE no declaran ApiKeyAuth: una key válida es 401, no 403 (D-29).",
      expectedStatus: 401,
      flow: "request",
      auth: "api-key",
    });
  return scenarios;
}

/** The 404 of a write, and the 409 of a natural key. Neither had a case: of the 33 declared
 * 404 only 8 were covered, and of the 5 declared 409, none. */
function writeEdgeScenarios(endpoint: Endpoint): TestScenario[] {
  const scenarios: TestScenario[] = [];
  const missing = Object.fromEntries(
    (endpoint.parameters ?? []).filter((name) => endpoint.path.includes(`{${name}}`)).map((name) => [name, "999999"]),
  );
  if (endpoint.statuses.includes(404) && Object.keys(missing).length) {
    scenarios.push({
      id: "not-found",
      name: "Recurso inexistente",
      description: "Sobre un identificador que no existe debe responder 404 y no crear nada.",
      expectedStatus: 404,
      parameters: missing,
      body: endpoint.body,
      flow: "request",
    });
  }
  // The 422 of a write. Only the POSTs had one; PUT and PATCH declare it too — a PUT without
  // the required fields and a PATCH with nothing writable in it are both 422.
  if (endpoint.statuses.includes(422) && ["PUT", "PATCH"].includes(endpoint.method)) {
    scenarios.push({
      id: "invalid-body",
      name: "Payload inválido",
      description:
        endpoint.method === "PUT"
          ? "Un PUT sin los campos requeridos debe rechazarse con 422."
          : "Un PATCH sin ningún campo escribible debe rechazarse con 422.",
      expectedStatus: 422,
      parameters: Object.fromEntries(Object.keys(missing).map((name) => [name, "1"])),
      body: {},
      flow: "request",
    });
  }
  if (endpoint.statuses.includes(409) && endpoint.conflictBody) {
    scenarios.push({
      id: "conflict",
      name: "Clave natural duplicada",
      description: "Repetir una clave que ya existe debe responder 409 y no una violación de constraint.",
      expectedStatus: 409,
      body: endpoint.conflictBody,
      flow: "request",
    });
  }
  return scenarios;
}

export function scenariosFor(endpoint: Endpoint): TestScenario[] {
  // Deduplicated by id: the detail GETs already generate their own `not-found`, and adding a
  // second one would give two cases the same key in `operationStates`, where they would
  // overwrite each other's result.
  const all = [...functionalScenarios(endpoint), ...writeEdgeScenarios(endpoint), ...authScenarios(endpoint)];
  return all.filter((scenario, index) => all.findIndex((other) => other.id === scenario.id) === index);
}

/** The subset that can run against the backend as it is started. The authorization cases need
 * `e2e_env.py --auth`; against the default backend every one of them would fail for the wrong
 * reason, because the API grants `catalog:admin` to everyone. */
export function runnableScenarios(endpoint: Endpoint, authEnabled: boolean): TestScenario[] {
  return scenariosFor(endpoint).filter((scenario) => authEnabled || !scenario.auth || scenario.auth === "default");
}

function functionalScenarios(endpoint: Endpoint): TestScenario[] {
  if (endpoint.id === "healthCheck")
    return [
      {
        id: "healthy",
        name: "Dependencias disponibles",
        description: "Espera estado ok o degraded con HTTP 200.",
        expectedStatus: 200,
        flow: "request",
      },
    ];
  if (endpoint.method === "GET" && endpoint.id.startsWith("list")) return listScenarios(endpoint);
  if (endpoint.method === "GET") {
    const required = Object.fromEntries(
      (endpoint.parameters ?? []).filter((name) => endpoint.path.includes(`{${name}}`)).map((name) => [name, "1"]),
    );
    const missing = Object.fromEntries(Object.keys(required).map((name) => [name, "999999"]));
    const scenarios: TestScenario[] = [
      {
        id: "found",
        name: "Recurso existente",
        description: "Consulta el identificador semilla y valida la respuesta completa.",
        expectedStatus: 200,
        parameters: required,
        flow: "request",
      },
      {
        id: "not-found",
        name: "Recurso inexistente",
        description: "Comprueba el 404 y el formato Problem Details.",
        expectedStatus: 404,
        parameters: missing,
        flow: "request",
      },
    ];
    if (endpoint.id === "getProductFull")
      scenarios.push({
        id: "store-price",
        name: "Precio por tienda",
        description: "Comprueba que el precio de tienda tenga prioridad.",
        expectedStatus: 200,
        parameters: { product_id: "1", store_id: "1" },
        flow: "request",
      });
    return scenarios;
  }
  const base = endpoint.body ?? {};
  if (endpoint.method === "POST")
    return [
      {
        id: "create-read",
        name: "Crear y consultar",
        description: "Crea el recurso, captura el ID devuelto y lo consulta para comparar todos los campos enviados.",
        expectedStatus: endpoint.statuses.includes(201) ? 201 : 200,
        body: base,
        flow: endpoint.id.startsWith("bulk") ? "bulk-read" : "create-read",
      },
      {
        id: "invalid-body",
        name: "Payload inválido",
        description: "Envía un body vacío y espera validación 422.",
        expectedStatus: 422,
        body: {},
        flow: "request",
      },
    ];
  if (endpoint.method === "PUT")
    return [
      {
        id: "replace-read",
        name: "Crear, reemplazar y consultar",
        description: "Crea una entidad aislada, ejecuta PUT y verifica el estado persistido con GET.",
        expectedStatus: 200,
        body: updatedBody(endpoint),
        flow: "replace-read",
      },
    ];
  if (endpoint.method === "PATCH")
    return [
      {
        id: "patch-read",
        name: "Crear, actualizar y consultar",
        description: "Crea una entidad aislada, ejecuta PATCH y comprueba los campos modificados con GET.",
        expectedStatus: 200,
        body: base,
        flow: "patch-read",
      },
    ];
  return [
    {
      id: "delete-read",
      name: "Crear, eliminar y confirmar",
      description: "Crea una entidad aislada, la elimina y confirma que GET responde 404.",
      expectedStatus: 204,
      flow: "delete-read",
    },
    // What the resource *is* after the DELETE, which is not the same question as whether the
    // DELETE answered 204. A soft delete that hides nothing, a cache that keeps serving the row
    // and a second DELETE that answers 204 over a row that no longer exists all pass the case
    // above and fail this one.
    {
      id: "deleted-read",
      name: "Consultar el recurso eliminado",
      description:
        "Tras eliminarlo, el GET debe responder 404 en Problem Details y un segundo DELETE también 404: ni sigue accesible ni se puede borrar dos veces.",
      expectedStatus: 404,
      flow: "deleted-read",
    },
  ];
}
