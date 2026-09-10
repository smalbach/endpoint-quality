/**
 * Seeds a live deployment with the Digital Catalog project.
 *
 * It drives the **public API**, with a real session, rather than writing rows: everything it does
 * — create a project, import the contract, write the eight configuration sections, define an
 * environment — is something an operator can do from the UI, and a script that reached into the
 * database would prove nothing about whether they can.
 *
 * The point of the exercise is that the coupled dashboard's five modules of literals end up as
 * rows somebody owns and can edit. When it finishes, `GET /scenarios` on the created project
 * returns the same 311 cases the compiled-in version produced.
 *
 *     EQ_API=http://localhost:3001 \
 *     EQ_EMAIL=you@example.com EQ_PASSWORD='…' \
 *     EQ_SPEC=../geronimo-martings/digital-catalog-back-end/docs/openapi/bundled.yaml \
 *     node --experimental-strip-types tools/migrate-digital-catalog.ts
 *
 * Idempotent: run it twice and the second run updates the same project instead of creating a
 * second one. Re-importing an unchanged contract resolves to the version already on file.
 */
import { readFileSync } from "node:fs";
import { digitalCatalogSections } from "./digital-catalog-sections.ts";

const API = process.env.EQ_API ?? "http://localhost:3001";
const EMAIL = required("EQ_EMAIL");
const PASSWORD = required("EQ_PASSWORD");
const SPEC = process.env.EQ_SPEC ?? "../geronimo-martings/digital-catalog-back-end/docs/openapi/bundled.yaml";
const PROJECT_NAME = process.env.EQ_PROJECT ?? "Digital Catalog";
/** The target the environment points at. Defaults to the isolated E2E backend rather than to
 * anything that could be somebody's real one. */
const BASE_URL = process.env.EQ_BASE_URL ?? "http://127.0.0.1:8100";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name}`);
  return value;
}

let accessToken = "";

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    // Problem Details all the way through, so a failure here names the field that was wrong
    // rather than printing a status code.
    const detail = parsed?.detail ?? response.statusText;
    const fields =
      parsed?.errors
        ?.map((error: { field: string; detail: string }) => `\n    ${error.field}: ${error.detail}`)
        .join("") ?? "";
    throw new Error(`${method} ${path} → ${response.status}: ${detail}${fields}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const session = await call("POST", "/auth/login", { email: EMAIL, password: PASSWORD });
  accessToken = session.accessToken;

  const me = await call("GET", "/auth/me");
  const organization = me.organizations[0];
  if (!organization) throw new Error("La cuenta no pertenece a ninguna organización");
  console.log(`organización  ${organization.name} (${organization.slug})`);

  const existing: { id: string; name: string }[] = await call(
    "GET",
    `/orgs/${organization.id}/projects?includeArchived=true`,
  );
  const found = existing.find((project) => project.name === PROJECT_NAME);
  const projectId =
    found?.id ??
    (
      await call("POST", `/orgs/${organization.id}/projects`, {
        name: PROJECT_NAME,
        description: "Contrato v1.8.0 del catálogo digital",
      })
    ).projectId;
  console.log(`proyecto      ${found ? "reutilizado" : "creado"} ${projectId}`);

  const base = `/orgs/${organization.id}/projects/${projectId}`;

  const imported = await call("POST", `${base}/spec-versions`, {
    source: { kind: "upload", filename: "bundled.yaml", raw: readFileSync(SPEC, "utf8") },
  });
  console.log(
    `contrato      ${imported.operationCount} operaciones · ${imported.unchanged ? "sin cambios" : "nueva versión"}`,
  );
  for (const problem of imported.problems ?? []) console.warn(`  aviso  ${problem.pointer}: ${problem.message}`);

  for (const [section, data] of Object.entries(digitalCatalogSections)) {
    await call("PUT", `${base}/config/${section}`, data);
    console.log(`sección       ${section}`);
  }

  const environments: { id: string; name: string }[] = await call("GET", `${base}/environments`);
  if (!environments.some((environment) => environment.name === "e2e")) {
    await call("POST", `${base}/environments`, {
      name: "e2e",
      baseUrl: BASE_URL,
      // The E2E backend is disposable and started with authorization on, which is what makes the
      // 401/403 matrix meaningful and the writes safe. Neither flag is ever set by default.
      writesAllowed: true,
      authEnforced: true,
    });
    console.log(`entorno       e2e → ${BASE_URL}`);
  }

  const scenarios = await call("GET", `${base}/scenarios`);
  console.log(`\nmatriz        ${scenarios.totals.operations} operaciones · ${scenarios.totals.cases} casos`);
  console.log(`credenciales  pendientes: PUT ${base}/environments/<id>/credentials (primary, insufficient, alternate)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
