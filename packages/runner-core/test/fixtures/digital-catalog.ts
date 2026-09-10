/**
 * The Digital Catalog project, as configuration.
 *
 * This file is the proof of the decoupling: everything the coupled dashboard held as literals
 * across five modules is here, as one object, and the engine that consumes it knows nothing
 * about EANs, Colombian departments or the RFP.
 *
 * The **rules** below are written by hand on purpose — the geographic block, the authorization
 * matrix, the latency table and the envelope map are exactly the parts where a generalization
 * can be wrong, and transcribing them is how that is demonstrated. Only the **payloads** are
 * lifted mechanically, by `tools/extract-digital-catalog-bodies.ts`, because copying twenty
 * bodies by hand is twenty chances to introduce a typo the parity test would then blame on the
 * engine.
 */
import { defineProjectConfig, type BodyTemplate } from "../../src/config.ts";
import { presets } from "../../src/index.ts";
import payloads from "./digital-catalog.bodies.json" with { type: "json" };

const bodyTemplates = payloads.bodyTemplates as Record<string, BodyTemplate>;

export const digitalCatalogConfig = defineProjectConfig({
  locale: "es",

  // §1.4 — the values each filter is exercised with. `limit` carries its own expected status:
  // 0 and 101 are outside the contract's range and must be rejected, which used to be an `if`
  // on the parameter name inside the generator.
  parameterSamples: {
    cursor: ["eyJpZCI6MX0="],
    limit: [
      "1",
      "100",
      { value: "0", expectedStatus: 422, description: "Comprueba el límite fuera de rango." },
      { value: "101", expectedStatus: 422, description: "Comprueba el límite fuera de rango." },
    ],
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
  },

  // A radius on its own is not half a search, and a latitude without a longitude is not a
  // filter: the three only mean anything together, so they get combination cases instead of
  // one case each.
  excludeFromSoloScenarios: ["lat", "lon", "radius_km"],

  // §1.5 — the cases that need a set of parameters to exist. Declaration order is observable in
  // the queue, so it matches the order the coupled generator emitted them in.
  conditionalScenarios: [
    presets.corruptCursorScenario(),
    {
      id: "geo-1km",
      name: "Radio geográfico · 1 km",
      description: "Combina latitud, longitud y radio.",
      expectedStatus: 200,
      parameters: { lat: "4.6482", lon: "-74.0648", radius_km: "1" },
      requiresParameters: ["lat"],
    },
    {
      id: "geo-20km",
      name: "Radio geográfico · 20 km",
      description: "Un radio amplio debe alcanzar más tiendas que el de 1 km.",
      expectedStatus: 200,
      parameters: { lat: "4.6482", lon: "-74.0648", radius_km: "20" },
      requiresParameters: ["lat"],
    },
    {
      id: "geo-default",
      name: "Radio geográfico por defecto",
      description: "Envía coordenadas y verifica el radio contractual por defecto.",
      expectedStatus: 200,
      parameters: { lat: "4.6482", lon: "-74.0648" },
      requiresParameters: ["lat"],
    },
    // The case that separates a real geographic filter from no filter at all: over the ocean the
    // answer is an empty list, and an ignored filter answers with the whole catalogue instead.
    {
      id: "geo-empty",
      name: "Radio sin tiendas dentro",
      description: "Coordenadas en mitad del océano: 200 con lista vacía, nunca el catálogo completo.",
      expectedStatus: 200,
      parameters: { lat: "0", lon: "0", radius_km: "1" },
      requiresParameters: ["lat"],
    },
    {
      id: "geo-incomplete",
      name: "Coordenadas incompletas",
      description: "Latitud sin longitud debe rechazarse.",
      expectedStatus: 422,
      parameters: { lat: "4.6482" },
      requiresParameters: ["lat"],
    },
    {
      id: "geo-radius-alone",
      name: "radius_km sin coordenadas",
      description: "Un radio sin lat/lon no es media búsqueda: debe rechazarse.",
      expectedStatus: 422,
      parameters: { radius_km: "5" },
      requiresParameters: ["lat"],
    },
    {
      id: "store-enabled",
      name: "Tienda + habilitados",
      description: "Valida la combinación de filtros store_id e is_enabled.",
      expectedStatus: 200,
      parameters: { store_id: "1", is_enabled: "true" },
      requiresParameters: ["store_id", "is_enabled"],
    },
  ],

  // §1.8 — the seed identifiers a case uses when it wants the resource to exist.
  pathDefaults: {
    product_id: "1",
    store_id: "1",
    category_id: "1",
    price_id: "1",
    projection_id: "1",
    product_category_id: "1",
    store_assortment_id: "1",
  },
  missingIdValue: "999999",

  // §1.3 and §1.2 — lifted from the coupled modules, unchanged.
  bodyTemplates,
  implemented: payloads.implemented,

  // The authorization matrix. Generated from the statuses the contract declares, so an
  // operation that stops declaring 403 stops getting the case on the next spec import.
  authRules: [
    { id: "auth-none", credential: "none", expectedStatus: 401, when: { declaredStatus: 401 }, sendBody: true },
    {
      id: "auth-insufficient",
      credential: "insufficient",
      expectedStatus: 403,
      when: { declaredStatus: 403 },
      sendBody: true,
    },
    // D-29: the DELETEs declare no `ApiKeyAuth`, so a valid key is 401 and not 403 — it is not
    // a permission problem, it is a credential the operation does not accept.
    { id: "auth-api-key", credential: "api-key", expectedStatus: 401, when: { methods: ["DELETE"] } },
  ],
  // A public health probe has no authorization surface; generating 401 cases for it would fail
  // for a reason that is not the endpoint's.
  authExcludedOperationIds: ["healthCheck"],
  scopes: { default: "catalog:read", byMethod: { DELETE: "catalog:write" } },

  listOperations: { methods: ["GET"], operationIdPrefix: "list" },
  bulkOperationIdPrefix: "bulk",

  operationOverrides: {
    // `/health` is a GET that is not the read of a resource: inferring `found` / `not-found`
    // over it produces two cases that mean nothing.
    healthCheck: {
      functional: [
        {
          id: "healthy",
          name: "Dependencias disponibles",
          description: "Espera estado ok o degraded con HTTP 200.",
          expectedStatus: 200,
        },
      ],
    },
    getProductFull: {
      extraFunctional: [
        {
          id: "store-price",
          name: "Precio por tienda",
          description: "Comprueba que el precio de tienda tenga prioridad.",
          expectedStatus: 200,
          parameters: { product_id: "1", store_id: "1" },
        },
      ],
    },
  },

  // §1.6 — the RFP's published targets, in match order. Anything no rule matches gets no
  // latency assertion at all: the writes have no published target, and a green tick that
  // asserts nothing is what this replaced.
  budgets: [
    { id: "health", pathEquals: "/health", thresholdMs: 20, label: "GET /health < 20 ms", source: "RFP §6" },
    // Both bulk endpoints, matched by suffix: the target is published per call of 5 000 records,
    // so the next bulk the contract adds is covered instead of running unmeasured.
    { id: "bulk", pathSuffix: "/bulk", thresholdMs: 5_000, label: "Bulk de 5.000 registros < 5 s", source: "RFP §6" },
    // The EAN lookup is what the cache exists for and carries its own tighter target. It is only
    // claimed on a warm cache, so a first, cold sample is expected to miss it.
    {
      id: "ean",
      methods: ["GET"],
      queryMatches: "[?&]ean_sap=",
      thresholdMs: 50,
      label: "?ean_sap= p95 con caché caliente < 50 ms",
      source: "RFP §6",
    },
    { id: "get", methods: ["GET"], thresholdMs: 70, label: "GET p95 < 70 ms", source: "RFP §6" },
  ],

  // §1.7 — the envelope, in match order. Only consulted when the live OpenAPI document declares
  // no schema for the status under test.
  envelope: {
    rules: [
      { id: "delete", match: { methods: ["DELETE"] }, shape: "No body" },
      { id: "health", match: { operationId: "healthCheck" }, shape: "HealthStatus" },
      { id: "list", match: { operationIdPrefix: "list" }, shape: "{ data: [...], meta, links }" },
      // Before the generic `bulk` prefix: the two bulk endpoints return different result
      // objects, and first-match-wins is what lets the specific one say so.
      { id: "bulk-products", match: { operationId: "bulkUpsertProducts" }, shape: "{ data: ProductBulkResult }" },
      { id: "bulk", match: { operationIdPrefix: "bulk" }, shape: "{ data: StoreAssortmentBulkResult }" },
    ],
    fallbackShape: "{ data: Resource }",
    errorShape: "ProblemDetails",
  },
});
