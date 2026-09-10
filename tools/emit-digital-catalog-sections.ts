/**
 * Writes the Digital Catalog configuration as the JSON the API stores.
 *
 * The output is exactly what `PUT /config/:section` accepts, which is what makes it usable by
 * both the seeding script and the parity test — and what makes the test meaningful: it seeds a
 * live project through the real endpoints rather than reaching into a repository.
 *
 *     node --experimental-strip-types tools/emit-digital-catalog-sections.ts
 */
import { writeFileSync } from "node:fs";
import { digitalCatalogSections } from "./digital-catalog-sections.ts";

const target = new URL("../apps/api/test/fixtures/digital-catalog-sections.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(digitalCatalogSections, null, 2)}\n`);
console.log(`${Object.keys(digitalCatalogSections).length} secciones escritas`);
