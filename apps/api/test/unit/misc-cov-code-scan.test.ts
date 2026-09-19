/**
 * El escáner de código por sus bordes: las formas raras de escribir un decorador, GitHub cuando no
 * contesta lo esperado, y los comandos cuando el proyecto, el conector o el escaneo no están como se
 * espera.
 */
import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { analyzeNestSources, joinPath } from "@/modules/code-scan/domain/analyze-nest";
import { GithubSource } from "@/modules/code-scan/infrastructure/github-source";
import {
  DeleteConnectorCommand,
  DeleteConnectorHandler,
  SaveConnectorCommand,
  SaveConnectorHandler,
} from "@/modules/code-scan/application/commands/manage-connector";
import {
  ScanFromGithubCommand,
  ScanFromGithubHandler,
  ScanFromUploadCommand,
  ScanFromUploadHandler,
} from "@/modules/code-scan/application/commands/scan";
import { ImportScanCommand, ImportScanHandler } from "@/modules/code-scan/application/commands/import-scan";
import {
  GetConnectorHandler,
  GetConnectorQuery,
  GetScanHandler,
  GetScanQuery,
  ListScansHandler,
  ListScansQuery,
} from "@/modules/code-scan/application/queries/read-code-scan";
import type { CodeScan } from "@/modules/code-scan/domain/model";
import type { SafeFetchPort, SafeFetchResult, SafeRequestOptions } from "@/shared/http/safe-fetch";
import { AesGcmSecretCipher } from "@/shared/crypto/secret-cipher";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import {
  InMemoryCodeConnectorRepository,
  InMemoryCodeScanRepository,
  InMemoryProjectRepository,
} from "../support/in-memory-repositories";

describe("leer controladores", () => {
  test("joinPath: parámetros opcionales, comodines y partes vacías", () => {
    assert.equal(joinPath("", "/", ""), "/");
    assert.equal(joinPath("api/", "/orders/:id?/", "*"), "/api/orders/{id}/*");
  });

  test("las formas del camino: plantilla, lista, objeto y lo que no se puede leer", () => {
    const source = `
      @Controller({ path: "base" })
      export class Uno {
        @Get(\`plantilla\`) a() {}
        @Get(["lista", "otra"]) b() {}
        @Get([VARIABLE]) c() {}
        @Get([]) d() {}
        @Post({ path: \`objeto\` }) e() {}
        @Put({ path: VARIABLE }) f() {}
        @Patch({ version: "1" }) g() {}
        @Delete(RUTA) h() {}
        @All("todo") i() {}
        @Options() j() {}
        @Head("h") k() {}
        @Injectable() noEsRuta() {}
        sinDecorador() {}
      }
      export class NoEsControlador {
        @Get("x") x() {}
      }
    `;
    const result = analyzeNestSources([{ path: "uno.controller.ts", content: source }]);
    assert.equal(result.controllers, 1);
    assert.deepEqual(
      result.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.handler}`),
      [
        "GET /base/plantilla a",
        "GET /base/lista b",
        "GET /base c",
        "GET /base d",
        "POST /base/objeto e",
        "PUT /base f",
        "PATCH /base g",
        "DELETE /base h",
        "ALL /base/todo i",
        "OPTIONS /base j",
        "HEAD /base/h k",
      ],
    );
  });

  test("guards llamados, roles en lista o plantilla, @Public en la clase, y una clase sin nombre", () => {
    const source = `
      @Controller(\`raiz\`)
      @Public()
      @UseGuards(RolesGuard("x"), AuthGuard)
      @RequireRoles(["Admin", \`Soporte\`, VARIABLE])
      export default class {
        @Get()
        @UseGuards(OtroGuard)
        @Roles(\`auditor\`, OTRO)
        @RequireRole("editor")
        list() {}
      }
    `;
    const [endpoint] = analyzeNestSources([{ path: "sin nombre.jsx", content: source }], "/api/").endpoints;
    assert.deepEqual(endpoint, {
      method: "GET",
      path: "/api/raiz",
      controller: "(anónimo)",
      handler: "list",
      guards: ["RolesGuard", "AuthGuard", "OtroGuard"],
      roles: ["Admin", "Soporte", "auditor", "editor"],
      requiresAuth: false,
      file: "sin nombre.jsx",
    });
  });

  test("un .tsx se lee con su nombre, y el mismo nombre dos veces es el último", () => {
    const result = analyzeNestSources([
      { path: "vista.tsx", content: `@Controller("a") class A { @Get() x() {} }` },
      { path: "vista.tsx", content: `@Controller("b") class B { @Get() y() {} }` },
    ]);
    assert.equal(result.files, 2);
    assert.deepEqual(
      result.endpoints.map((endpoint) => endpoint.path),
      ["/a", "/b"],
    );
  });
});

/* ------------------------------------------------------------------ *
 * GitHub, con un guardia de mentira
 * ------------------------------------------------------------------ */

class FakeFetch implements SafeFetchPort {
  readonly calls: { url: string; headers: Record<string, string> }[] = [];
  constructor(private readonly routes: Record<string, { status?: number; body: unknown }>) {}
  async get(url: string): Promise<SafeFetchResult> {
    return this.request(url, {});
  }
  async request(url: string, options: SafeRequestOptions): Promise<SafeFetchResult> {
    this.calls.push({ url, headers: options.headers ?? {} });
    const route = this.routes[url] ?? { status: 404, body: { message: "Not Found" } };
    return {
      status: route.status ?? 200,
      headers: {},
      setCookie: [],
      body: JSON.stringify(route.body),
      finalUrl: url,
      durationMs: 1,
      timing: { dnsMs: 0, ttfbMs: 0, downloadMs: 0 },
    };
  }
}
const b64 = (text: string) => Buffer.from(text).toString("base64");
const TREE = "https://api.github.com/repos/acme/api/git/trees/rama%2Fx?recursive=1";
const content = (path: string) => `https://api.github.com/repos/acme/api/contents/${path}?ref=rama%2Fx`;

describe("leer el repositorio de GitHub", () => {
  test("un árbol que no se puede leer es un error con el código y el repositorio", async () => {
    const source = new GithubSource(new FakeFetch({ [TREE]: { status: 404, body: {} } }));
    await assert.rejects(
      source.fetchControllers({ repo: "acme/api", branch: "rama/x", basePath: "", token: null }),
      /GitHub respondió 404 al leer el árbol de acme\/api@rama\/x/,
    );
  });

  test("sin token no hay Authorization; sin sha la referencia es la rama; un árbol vacío no pide nada", async () => {
    const fetcher = new FakeFetch({ [TREE]: { body: {} } });
    const found = await new GithubSource(fetcher).fetchControllers({
      repo: "acme/api",
      branch: "rama/x",
      basePath: "",
      token: null,
    });
    assert.deepEqual(found, { sources: [], ref: "rama/x" });
    assert.equal(fetcher.calls.length, 1);
    assert.equal(fetcher.calls[0]!.headers.Authorization, undefined);
    assert.equal(fetcher.calls[0]!.headers["X-GitHub-Api-Version"], "2022-11-28");
  });

  test("una base que es un fichero escanea solo ese fichero", async () => {
    const fetcher = new FakeFetch({
      [TREE]: {
        body: {
          tree: [
            { path: "src/uno.controller.ts", type: "blob" },
            { path: "src/dos.controller.ts", type: "blob" },
          ],
        },
      },
      [content("src/uno.controller.ts")]: { body: { encoding: "base64", content: b64("// uno") } },
    });
    const found = await new GithubSource(fetcher).fetchControllers({
      repo: "acme/api",
      branch: "rama/x",
      basePath: "src/uno.controller.ts",
      token: null,
    });
    assert.deepEqual(found.sources, [{ path: "src/uno.controller.ts", content: "// uno" }]);
  });

  test("con base: solo lo de dentro; los ficheros que fallan, sin base64 o vacíos se saltan", async () => {
    const fetcher = new FakeFetch({
      [TREE]: {
        body: {
          sha: "0123456789abcdef",
          tree: [
            { path: "apps/api", type: "tree" },
            { path: "apps/api/a.controller.ts", type: "blob" },
            { path: "apps/api/con espacio.controller.ts", type: "blob" },
            { path: "apps/api/falla.controller.ts", type: "blob" },
            { path: "apps/api/texto.controller.ts", type: "blob" },
            { path: "apps/api/vacio.controller.ts", type: "blob" },
            { path: "apps/api/servicio.ts", type: "blob" },
            { path: "apps/apiotro/b.controller.ts", type: "blob" },
            { path: "otros/c.controller.ts", type: "blob" },
          ],
        },
      },
      [content("apps/api/a.controller.ts")]: { body: { encoding: "base64", content: b64("// a") } },
      [content("apps/api/con%20espacio.controller.ts")]: { body: { encoding: "base64", content: b64("// espacio") } },
      [content("apps/api/falla.controller.ts")]: { status: 500, body: {} },
      [content("apps/api/texto.controller.ts")]: { body: { encoding: "utf-8", content: "// texto" } },
      [content("apps/api/vacio.controller.ts")]: { body: { encoding: "base64", content: "" } },
    });
    const found = await new GithubSource(fetcher).fetchControllers({
      repo: "acme/api",
      branch: "rama/x",
      basePath: "/apps/api/",
      token: "ghp_secreto",
    });
    assert.equal(found.ref, "rama/x@01234567");
    assert.deepEqual(found.sources, [
      { path: "apps/api/a.controller.ts", content: "// a" },
      { path: "apps/api/con espacio.controller.ts", content: "// espacio" },
    ]);
    // El token viaja solo en la cabecera, en todas las peticiones.
    assert.ok(fetcher.calls.every((call) => call.headers.Authorization === "Bearer ghp_secreto"));
    assert.equal(fetcher.calls.length, 6);
  });
});

/* ------------------------------------------------------------------ *
 * Los comandos, con dobles
 * ------------------------------------------------------------------ */

const ORG = "org-1";
const clock = { now: () => new Date("2026-03-01T10:00:00Z") };
const cipher = new AesGcmSecretCipher(Buffer.alloc(32, 4).toString("base64"));

async function project(): Promise<{ projects: InMemoryProjectRepository; id: string }> {
  const projects = new InMemoryProjectRepository();
  const id = "p-1";
  await projects.save({ id, organizationId: ORG, archivedAt: null, deletedAt: null } as unknown as Project);
  return { projects, id };
}

type Row = { id: string; method: string; path: string; requiresAuth: boolean; operationId: string | null };
function endpointsRepo(rows: Row[]) {
  const saved: Row[] = [];
  return {
    saved,
    created: [] as Row[],
    async listAll() {
      return rows;
    },
    async findById(_projectId: string, id: string) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async nextOrderIndex() {
      return 7;
    },
    async saveMany(this: { created: Row[] }, list: Row[]) {
      this.created.push(...list);
    },
    async save(row: Row) {
      saved.push(row);
    },
  };
}
function rolesRepo(names: { name: string; position: number }[], permissions: { endpointId: string }[] = []) {
  const saved: { name: string; position: number; color: string }[] = [];
  return {
    saved,
    async list() {
      return names;
    },
    async listPermissions() {
      return permissions;
    },
    async save(role: { name: string; position: number; color: string }) {
      saved.push(role);
    },
  };
}
const workflowsRepo = (templates: { id: string; operationId: string }[] = [], flows: unknown[] = []) => ({
  async listTemplates() {
    return templates;
  },
  async listWorkflows() {
    return flows;
  },
});

describe("los comandos del escáner", () => {
  test("un escaneo cuenta los permisos y los flujos que se quedarían colgando de lo quitado", async () => {
    const { projects, id } = await project();
    const scans = new InMemoryCodeScanRepository();
    const endpoints = endpointsRepo([
      { id: "e1", method: "GET", path: "/viejo", requiresAuth: true, operationId: "op-viejo" },
      { id: "e2", method: "DELETE", path: "/otro", requiresAuth: true, operationId: null },
    ]);
    const roles = rolesRepo([], [{ endpointId: "e1" }, { endpointId: "e1" }, { endpointId: "e2" }]);
    const step = (requestTemplateId: string | null) => ({ requestTemplateId });
    const workflows = workflowsRepo(
      [
        { id: "t1", operationId: "op-viejo" },
        { id: "t2", operationId: "op-otro" },
      ],
      [
        // Dos pasos al mismo sitio en un flujo cuentan como un flujo.
        { definition: { steps: [step("t1"), step("t1"), step(null), step("t-borrada")] } },
        { definition: { steps: [step("t1"), step("t2")] } },
        { definition: { steps: [] } },
      ],
    );
    const handler = new ScanFromUploadHandler(projects, scans, endpoints as never, roles as never, workflows as never, clock);
    const { scanId } = await handler.execute(
      new ScanFromUploadCommand(ORG, id, [{ path: "a.controller.ts", content: `@Controller("nuevo") class A { @Get() x() {} }` }], "", "u"),
    );
    const scan = (await scans.find(id, scanId))!;
    assert.equal(scan.source, "upload");
    assert.deepEqual(scan.impact.removedWithPermissions, [
      { method: "GET", path: "/viejo", permissions: 2 },
      { method: "DELETE", path: "/otro", permissions: 1 },
    ]);
    assert.deepEqual(scan.impact.removedWithFlows, [{ method: "GET", path: "/viejo", flows: 2 }]);

    await assert.rejects(handler.execute(new ScanFromUploadCommand(ORG, id, [], "", "u")), (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.equal(error.code, "scan-empty");
      return true;
    });
    await assert.rejects(handler.execute(new ScanFromUploadCommand("otra-org", id, [], "", "u")), NotFoundError);
  });

  test("escanear GitHub sin conector es un 404; con token, se descifra; un fallo raro queda como texto", async () => {
    const { projects, id } = await project();
    const scans = new InMemoryCodeScanRepository();
    const connectors = new InMemoryCodeConnectorRepository();
    const seen: (string | null)[] = [];
    const github = {
      fetchControllers: async (input: { token: string | null }) => {
        seen.push(input.token);
        throw "límite de GitHub";
      },
    };
    const handler = new ScanFromGithubHandler(
      projects,
      connectors,
      scans,
      github as never,
      endpointsRepo([]) as never,
      rolesRepo([]) as never,
      workflowsRepo() as never,
      cipher,
      clock,
    );
    await assert.rejects(handler.execute(new ScanFromGithubCommand(ORG, id, "u")), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "connector-not-found");
      return true;
    });

    await connectors.save({
      id: "c",
      projectId: id,
      provider: "github",
      repo: "acme/api",
      branch: "develop",
      basePath: "",
      prefix: "",
      tokenCiphertext: cipher.encrypt("ghp_x"),
      createdAt: clock.now(),
      updatedAt: clock.now(),
      updatedBy: "u",
    });
    const { scanId } = await handler.execute(new ScanFromGithubCommand(ORG, id, "u"));
    assert.deepEqual(seen, ["ghp_x"]);
    const scan = (await scans.find(id, scanId))!;
    assert.equal(scan.status, "error");
    assert.equal(scan.error, "límite de GitHub");
    assert.equal(scan.ref, "develop");
  });

  const scanRow = (patch: Partial<CodeScan> = {}): CodeScan => ({
    id: "scan-1",
    projectId: "p-1",
    source: "upload",
    ref: "upload",
    status: "ok",
    result: { endpoints: [], files: 1, controllers: 1 },
    diff: { added: [], removed: [], changed: [], unchanged: 0 },
    impact: { unknownRoles: [], removedWithPermissions: [], removedWithFlows: [] },
    error: null,
    createdAt: clock.now(),
    createdBy: "u",
    ...patch,
  });
  const scanned = (method: string, path: string, requiresAuth: boolean, roles: string[] = []) => ({
    method,
    path,
    requiresAuth,
    roles,
    controller: "C",
    handler: "h",
    guards: [],
    file: "c.controller.ts",
  });

  test("importar: un escaneo que no existe o que falló no se importa", async () => {
    const { projects, id } = await project();
    const scans = new InMemoryCodeScanRepository();
    await scans.save(scanRow({ status: "error", error: "x" }));
    const handler = new ImportScanHandler(projects, scans, endpointsRepo([]) as never, rolesRepo([]) as never, clock);
    await assert.rejects(handler.execute(new ImportScanCommand(ORG, id, "no-existe", { createRoles: false }, "u")), NotFoundError);
    await assert.rejects(handler.execute(new ImportScanCommand(ORG, id, "scan-1", { createRoles: false }, "u")), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "scan-not-ok");
      return true;
    });
  });

  test("importar: solo cambia la auth de lo que sigue igual de distinto, salta @All, y crea los roles que faltan tras los que hay", async () => {
    const { projects, id } = await project();
    const scans = new InMemoryCodeScanRepository();
    await scans.save(
      scanRow({
        result: {
          endpoints: [scanned("GET", "/a", false), scanned("GET", "/igual", true)],
          files: 1,
          controllers: 1,
        },
        diff: {
          added: [scanned("POST", "/nuevo/:id", true), scanned("ALL", "/todo", true)],
          removed: [],
          changed: [
            { id: "e-a", method: "GET", path: "/a", changes: ["auth"] },
            { id: "e-borrado", method: "GET", path: "/b", changes: ["auth"] },
            { id: "e-igual", method: "GET", path: "/igual", changes: ["auth"] },
            { id: "e-fuera", method: "PUT", path: "/fuera", changes: ["auth"] },
          ],
          unchanged: 0,
        },
        impact: { unknownRoles: ["ADMIN", "soporte", "auditor"], removedWithPermissions: [], removedWithFlows: [] },
      }),
    );
    const endpoints = endpointsRepo([
      { id: "e-a", method: "GET", path: "/a", requiresAuth: true, operationId: null },
      { id: "e-igual", method: "GET", path: "/igual", requiresAuth: true, operationId: null },
      { id: "e-fuera", method: "PUT", path: "/fuera", requiresAuth: true, operationId: null },
    ]);
    const roles = rolesRepo([
      { name: "admin", position: 4 },
      { name: "lector", position: 1 },
    ]);
    const handler = new ImportScanHandler(projects, scans, endpoints as never, roles as never, clock);
    const result = await handler.execute(new ImportScanCommand(ORG, id, "scan-1", { createRoles: true }, "u"));
    assert.deepEqual(result, { created: 1, updated: 1, rolesCreated: 2 });
    const [created] = endpoints.created as unknown as { method: string; path: string; orderIndex: number; description: string }[];
    assert.equal(created!.method, "POST");
    assert.equal(created!.path, "/nuevo/:id");
    assert.equal(created!.orderIndex, 7);
    assert.equal(created!.description, "Importado del código (C.h)");
    assert.deepEqual(
      endpoints.saved.map((row) => [row.id, row.requiresAuth]),
      [["e-a", false]],
    );
    assert.deepEqual(
      roles.saved.map((role) => [role.name, role.position]),
      [
        ["soporte", 5],
        ["auditor", 6],
      ],
    );
    assert.notEqual(roles.saved[0]!.color, roles.saved[1]!.color);
  });

  test("importar sin roles que crear, o sin pedirlo, no toca los roles", async () => {
    const { projects, id } = await project();
    const scans = new InMemoryCodeScanRepository();
    await scans.save(scanRow({ impact: { unknownRoles: ["x"], removedWithPermissions: [], removedWithFlows: [] } }));
    const roles = rolesRepo([]);
    const handler = new ImportScanHandler(projects, scans, endpointsRepo([]) as never, roles as never, clock);
    assert.deepEqual(await handler.execute(new ImportScanCommand(ORG, id, "scan-1", { createRoles: false }, "u")), {
      created: 0,
      updated: 0,
      rolesCreated: 0,
    });
    await scans.save(scanRow());
    assert.equal((await handler.execute(new ImportScanCommand(ORG, id, "scan-1", { createRoles: true }, "u"))).rolesCreated, 0);
    assert.deepEqual(roles.saved, []);
  });

  test("el conector: repo inválido, token que se conserva, se cambia o se borra, y valores por omisión", async () => {
    const { projects, id } = await project();
    const connectors = new InMemoryCodeConnectorRepository();
    const save = new SaveConnectorHandler(projects, connectors, cipher, clock);
    const run = (input: Record<string, unknown>) => save.execute(new SaveConnectorCommand(ORG, id, input, "u"));

    for (const repo of [undefined, "sin-barra", "a/b/c", "a b/c"])
      await assert.rejects(run({ repo }), (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.equal(error.code, "connector-invalid");
        return true;
      });

    const { connectorId } = await run({ repo: " acme/api ", branch: "  ", token: "ghp_uno" });
    let row = (await connectors.find(id))!;
    assert.equal(row.repo, "acme/api");
    assert.equal(row.branch, "main");
    assert.equal(row.basePath, "");
    assert.equal(row.prefix, "");
    assert.equal(cipher.decrypt(row.tokenCiphertext!), "ghp_uno");

    // Sin el campo, se queda lo guardado — el repo incluido.
    assert.deepEqual(await run({ basePath: " src ", prefix: " api " }), { connectorId });
    row = (await connectors.find(id))!;
    assert.equal(row.repo, "acme/api");
    assert.equal(row.basePath, "src");
    assert.equal(row.prefix, "api");
    assert.equal(cipher.decrypt(row.tokenCiphertext!), "ghp_uno");

    await run({ token: "" });
    assert.equal((await connectors.find(id))!.tokenCiphertext, null);
    await run({ token: null });
    assert.equal((await connectors.find(id))!.tokenCiphertext, null);

    const view = await new GetConnectorHandler(projects, connectors).execute(new GetConnectorQuery(ORG, id));
    assert.equal(view!.tokenSet, false);

    await new DeleteConnectorHandler(projects, connectors).execute(new DeleteConnectorCommand(ORG, id));
    assert.equal(await new GetConnectorHandler(projects, connectors).execute(new GetConnectorQuery(ORG, id)), null);
    await assert.rejects(
      new DeleteConnectorHandler(projects, connectors).execute(new DeleteConnectorCommand("otra-org", id)),
      NotFoundError,
    );
  });

  test("la lista de escaneos resume cuentas y errores; uno que no existe es un 404", async () => {
    const { projects, id } = await project();
    const scans = new InMemoryCodeScanRepository();
    await scans.save(
      scanRow({
        diff: {
          added: [scanned("GET", "/x", true)],
          removed: [{ id: "r", method: "GET", path: "/r", requiresAuth: true }],
          changed: [],
          unchanged: 3,
        },
      }),
    );
    const [summary] = await new ListScansHandler(projects, scans).execute(new ListScansQuery(ORG, id));
    assert.deepEqual(summary!.counts, { added: 1, removed: 1, changed: 0, unchanged: 3 });
    assert.equal(summary!.error, null);
    await assert.rejects(new GetScanHandler(projects, scans).execute(new GetScanQuery(ORG, id, "no")), NotFoundError);
    await assert.rejects(new ListScansHandler(projects, scans).execute(new ListScansQuery("otra-org", id)), NotFoundError);
  });
});
