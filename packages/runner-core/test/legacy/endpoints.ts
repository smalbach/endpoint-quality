/**
 * The contract operations, plus the two things the contract cannot supply.
 *
 * The structural half — method, path, tag, declared statuses, parameter names — is **generated**
 * into `contract-operations.ts` from `bundled.yaml` and is never edited here. It used to be a
 * hand-written copy: exact on the day it was checked, and the only consumer of the spec in the
 * repo without a generator behind it. When v1.9.0 lands, a stale copy would make the dashboard
 * report green against a contract that no longer exists — the worst failure a drift detector can
 * have. `make dashboard-check` now fails instead.
 *
 * What stays by hand, because no schema can derive it:
 *
 * - **the request bodies**, which have to satisfy the seed's foreign keys and dodge the natural
 *   keys the E2E fixtures already occupy;
 * - **`implemented`**, which is a fact about the code, not about the contract.
 */
import { contractOperations, type ContractOperation } from "./contract-operations.ts";

export type HttpMethod = ContractOperation["method"];
export type Endpoint = ContractOperation & {
  implemented: boolean;
  responseShape: string;
  body?: Record<string, unknown>;
  // A body that collides with the resource's natural key, for the 409 the contract declares.
  // Only the resources that have a UNIQUE carry one; `price` and `store` declare no 409.
  conflictBody?: Record<string, unknown>;
};

// What the API actually routes today. `make contract-check` prints the same count (18/46). The
// 9 writes of stores and assortments are complete: `bulkUpsertStoreAssortments` runs on the
// full-upsert resolution D-20 itself proposes, which is written down rather than assumed.
// `bulkUpsertProducts` arrived with the contract and has no route yet: it stays out of the set,
// which is what makes the dashboard report it as pending instead of red.
const implemented = new Set([
  "healthCheck",
  "listProducts", "getProduct", "getProductFull",
  "listStores", "getStore", "createStore", "replaceStore", "patchStore", "deleteStore",
  "listStoreAssortment", "listStoreAssortments", "getStoreAssortment",
  "createStoreAssortment", "replaceStoreAssortment", "patchStoreAssortment", "deleteStoreAssortment",
  "bulkUpsertStoreAssortments",
]);

// `ProductWrite` requires the **11 SAP fields**. `measure_unit_value_sap` is a *string* since
// v1.8.0 ("1000", not 1000): sending the integer is a 422 that says nothing about the endpoint.
const productBody = { ean_sap: "7702005555555", code_sap: "MAT-E2E-001", name_sap: "Producto E2E", description_sap: "Producto de prueba E2E", pack_code_sap: "UNIDAD", quantity_in_pack_sap: "1", measure_unit_sap: "1", measure_unit_code_sap: "L", measure_unit_value_sap: "1000", sub_category_sap: "Lácteos", sub_category_code_sap: "LAC-01", type_akn: "product" };
const storeBody = { name: "Ara Prueba E2E", address: "Cra 7 # 62-15", department: "Cundinamarca", region: "Bogotá", latitude: 4.6482, longitude: -74.0648 };
// `StoreAssortmentWrite` declares **10 required fields**: the pair, the 6 price and validity
// ones, and — since v1.8.0 — `pum_vkp0` and `pum_vka0`. The PUM pair stopped being `readOnly`:
// the integrator sends it pre-computed and the back end stores it, so a body without it is a 422.
// The pair is (2, 4) because the E2E fixtures leave store 4 without assortment: (2, 1) is taken
// and the POST would answer 409, which is correct behaviour and a useless test case.
const assortmentDates = {
  vkp0_start_validity_date: "2026-01-01T00:00:00Z",
  vkp0_end_validity_date: "2026-12-31T23:59:59Z",
  vka0_start_validity_date: "2026-06-01T00:00:00Z",
  vka0_end_validity_date: "2026-06-30T23:59:59Z",
};
// PUM follows the contract's own formula over `measure_unit_value_sap: "1000"`, so the values
// stay coherent with the prices above even though nothing recomputes them any more.
const assortmentPum = { pum_vkp0: 4.9, pum_vka0: 3.9 };
const assortmentBody = { product_id: 2, store_id: 4, is_enabled: true, vkp0_base_price_sap: 4900, vka0_promotional_price_sap: 3900, ...assortmentDates, ...assortmentPum };
const categoryBody = { code_akn: "e2e-category", parent_code_akn: "alimentos", labels_akn: { es_CO: "Categoría E2E" } };
const projectionBody = { locale_akn: "pt_BR", channel_akn: "kiosk", name_akn: "Produto E2E" };
// `PriceWrite` requires the same 8 fields as the store-level payload minus the (product, store)
// pair: the 2 prices, the 4 validity dates and the 2 PUM values.
const priceBody = { vkp0_base_price_sap: 4900, vka0_promotional_price_sap: 3900, ...assortmentDates, ...assortmentPum };

/** The payloads, keyed by operationId. Anything absent simply has no body. */
const bodies: Record<string, { body?: Record<string, unknown>; conflictBody?: Record<string, unknown> }> = {
  createProduct: { body: productBody, conflictBody: { ...productBody, ean_sap: "7702001234567" } },
  replaceProduct: { body: productBody },
  patchProduct: { body: { name_sap: "Producto actualizado" } },
  createProductProjection: { body: projectionBody, conflictBody: { locale_akn: "es_CO", channel_akn: "app", name_akn: "Proyección duplicada" } },
  replaceProductProjection: { body: projectionBody },
  patchProductProjection: { body: { name_akn: "Nombre actualizado" } },
  assignProductCategory: { body: { category_id: 1 }, conflictBody: { category_id: 2 } },
  createPrice: { body: priceBody },
  replacePrice: { body: priceBody },
  patchPrice: { body: { vkp0_base_price_sap: 5100 } },
  createStore: { body: storeBody },
  replaceStore: { body: storeBody },
  patchStore: { body: { name: "Ara Chapinero Norte" } },
  createStoreAssortment: { body: assortmentBody, conflictBody: { product_id: 1, store_id: 1, vkp0_base_price_sap: 4900, vka0_promotional_price_sap: 0, ...assortmentDates, pum_vkp0: 4.9, pum_vka0: 0 } },
  // `records`, not `items`: that is the property `StoreAssortmentBulkWrite` declares, and a
  // body keyed by anything else is a 422 that says nothing about the endpoint.
  //
  // Its pair is **(2, 3)** and not the (2, 4) of the POST, because the bulk is the one write
  // with no cleanup step: it is a single request and there is no id to delete afterwards. Over
  // (2, 4) the row it leaves behind would turn the next run of `createStoreAssortment` into a
  // 409, and over store 4 it would take away the only store with no assortment, which is what
  // the 404 of `listStoreAssortment` is told apart from an empty list with. Store 3 already has
  // assortment, so the row is invisible to every other case and the second run is `unchanged`.
  bulkUpsertStoreAssortments: { body: { records: [{ ...assortmentBody, store_id: 3 }] } },
  // The product bulk keys on `ean_sap`, not on an id, so what it needs is a **free EAN** rather
  // than a free (product, store) pair. It carries its own — not `productBody`'s — for the same
  // reason the assortment bulk moves to store 3: the bulk is a write with no cleanup step, and
  // the row it leaves behind over `7702005555555` would turn the next run of `createProduct`
  // into a 409. On its own EAN the first run is a `created` and every later one an `unchanged`.
  bulkUpsertProducts: { body: { records: [{ ...productBody, ean_sap: "7702005555556", code_sap: "MAT-E2E-002", name_sap: "Producto E2E bulk" }] } },
  replaceStoreAssortment: { body: assortmentBody },
  patchStoreAssortment: { body: { is_enabled: false } },
  createCategory: { body: categoryBody, conflictBody: { ...categoryBody, code_akn: "alimentos" } },
  replaceCategory: { body: categoryBody },
  patchCategory: { body: { labels_akn: { es_CO: "Lácteos y derivados" } } },
};

function responseShape(operation: ContractOperation): string {
  if (operation.method === "DELETE") return "No body";
  if (operation.id === "healthCheck") return "HealthStatus";
  if (operation.id.startsWith("list")) return "{ data: [...], meta, links }";
  if (operation.id === "bulkUpsertProducts") return "{ data: ProductBulkResult }";
  if (operation.id.startsWith("bulk")) return "{ data: StoreAssortmentBulkResult }";
  return "{ data: Resource }";
}

export const endpoints: Endpoint[] = contractOperations.map((operation) => ({
  ...operation,
  implemented: implemented.has(operation.id),
  responseShape: responseShape(operation),
  ...bodies[operation.id],
}));
