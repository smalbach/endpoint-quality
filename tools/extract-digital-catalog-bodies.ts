/**
 * Lifts the request payloads out of the coupled dashboard into data.
 *
 * The bodies are the one part of the configuration that must be copied rather than rewritten:
 * `product_id: 2, store_id: 4` is a free pair in *those* E2E fixtures and no schema says so, so
 * transcribing them by hand would be 20 chances to introduce a typo the parity test would then
 * report as an engine bug.
 *
 * `replaceBody` is the interesting one. In the coupled version it was computed by a six-branch
 * `updatedBody()` chain over path fragments — `/products` but not `/categories` and not
 * `/projections`, then `/stores/`, then `/prices`… That chain is one API's resource layout
 * written as control flow. Here it is read once, at extraction time, and stored per operation;
 * the engine no longer has an opinion about what a PUT changes.
 *
 *     node --experimental-strip-types tools/extract-digital-catalog-bodies.ts
 */
import { writeFileSync } from "node:fs";
import { endpoints } from "../packages/runner-core/test/legacy/endpoints.ts";
import { scenariosFor } from "../packages/runner-core/test/legacy/scenarios.ts";

type BodyTemplate = { body?: unknown; conflictBody?: unknown; replaceBody?: unknown };

const bodyTemplates: Record<string, BodyTemplate> = {};
for (const endpoint of endpoints) {
  const template: BodyTemplate = {};
  if (endpoint.body) template.body = endpoint.body;
  if (endpoint.conflictBody) template.conflictBody = endpoint.conflictBody;
  const replace = scenariosFor(endpoint).find((scenario) => scenario.id === "replace-read");
  // Stored only when it differs from the plain body: an identical copy would be noise in the
  // configuration and would hide which PUTs actually mutate something.
  if (replace?.body && JSON.stringify(replace.body) !== JSON.stringify(endpoint.body))
    template.replaceBody = replace.body;
  if (Object.keys(template).length) bodyTemplates[endpoint.id] = template;
}

const implemented = endpoints.filter((endpoint) => endpoint.implemented).map((endpoint) => endpoint.id);

const output = { bodyTemplates, implemented };
const target = new URL("../packages/runner-core/test/fixtures/digital-catalog.bodies.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
console.log(`${Object.keys(bodyTemplates).length} payloads, ${implemented.length} operaciones implementadas`);
