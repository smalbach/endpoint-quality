import { test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { budgetFor, latencyAssertion, percentile } from "../src/budgets.ts";
import { digitalCatalogConfig } from "./fixtures/digital-catalog.ts";

test("el percentil es nearest-rank y no interpola", () => {
  // Interpolating would invent a value between two measurements and read as more precision than
  // ten samples carry.
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([], 95), 0);
});

test("una sola muestra no se presenta como un p95", () => {
  const budget = { ms: 70, label: "GET p95 < 70 ms", source: "RFP §6" };
  const single = latencyAssertion(budget, [42])!;
  assert.match(single.detail, /1 muestra: 42 ms \(una medición no es un p95\)/);
  const many = latencyAssertion(budget, [10, 20, 30])!;
  assert.match(many.detail, /3 muestras · p50 20 ms · p95 30 ms/);
});

test("sin presupuesto no se emite aserción, ni siquiera una que pase", () => {
  // The vice this replaced was `{ label: "Tiempo de respuesta < 12 s", pass: true }` hardcoded.
  assert.equal(latencyAssertion(null, [5]), null);
  assert.equal(latencyAssertion({ ms: 70, label: "x", source: "y" }, []), null);
});

test("el umbral es estricto: medir exactamente el objetivo no lo cumple", () => {
  const budget = { ms: 70, label: "GET p95 < 70 ms", source: "RFP §6" };
  assert.equal(latencyAssertion(budget, [69])!.pass, true);
  assert.equal(latencyAssertion(budget, [70])!.pass, false);
});

test("las reglas casan en orden y gana la primera", () => {
  const config = digitalCatalogConfig;
  assert.equal(budgetFor(config, "GET", "/health", "/health")!.ms, 20);
  assert.equal(budgetFor(config, "POST", "/v1/store-assortments/bulk", "/v1/store-assortments/bulk")!.ms, 5000);
  // The bulk rule matches by suffix, so the product bulk the contract added later is covered
  // instead of running unmeasured.
  assert.equal(budgetFor(config, "POST", "/v1/products/bulk", "/v1/products/bulk")!.ms, 5000);
  assert.equal(budgetFor(config, "GET", "/v1/products", "/v1/products?ean_sap=7702001234567")!.ms, 50);
  assert.equal(budgetFor(config, "GET", "/v1/products", "/v1/products")!.ms, 70);
});

test("una escritura sin regla no recibe presupuesto", () => {
  // The RFP publishes no target for the writes; a rule limited to GET is how that is said.
  assert.equal(budgetFor(digitalCatalogConfig, "POST", "/v1/stores", "/v1/stores"), null);
  assert.equal(budgetFor(digitalCatalogConfig, "DELETE", "/v1/stores/{store_id}", "/v1/stores/1"), null);
});

test("un proyecto sin presupuestos no recibe ninguno", () => {
  assert.equal(budgetFor(defineProjectConfig(), "GET", "/anything", "/anything"), null);
});
