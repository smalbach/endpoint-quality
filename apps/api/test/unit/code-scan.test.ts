/**
 * The NestJS source reader and the scan diff, checked directly.
 *
 * Source text in, endpoints out — no filesystem, no network. If reading a controller ever needs a
 * real repo checked out, the parser has drifted out of the domain.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { analyzeNestSources, joinPath } from "@/modules/code-scan/domain/analyze-nest";
import { diffEndpoints, unknownRoles, type ExistingEndpoint } from "@/modules/code-scan/domain/diff";

const CONTROLLER = `
  import { Controller, Get, Post, Delete, UseGuards } from "@nestjs/common";

  @Controller("orders")
  @UseGuards(AuthGuard)
  export class OrdersController {
    @Get()
    list() {}

    @Get(":id")
    @RequireRole("viewer")
    get() {}

    @Post()
    @UseGuards(RolesGuard)
    @Roles("editor", "admin")
    create() {}

    @Delete(":id")
    @Public()
    remove() {}
  }

  @Controller({ path: "health" })
  export class HealthController {
    @Get()
    @Public()
    check() {}
  }
`;

describe("leer el código NestJS", () => {
  test("saca método, ruta completa, guards, roles y si exige auth", () => {
    const result = analyzeNestSources([{ path: "orders.controller.ts", content: CONTROLLER }], "api");
    assert.equal(result.controllers, 2);
    const byKey = new Map(result.endpoints.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint]));

    const list = byKey.get("GET /api/orders");
    assert.ok(list, "GET /api/orders existe con el prefijo aplicado");
    assert.deepEqual(list!.guards, ["AuthGuard"]);
    assert.equal(list!.requiresAuth, true);

    const get = byKey.get("GET /api/orders/{id}");
    assert.deepEqual(get!.roles, ["viewer"]);

    const create = byKey.get("POST /api/orders");
    assert.deepEqual(create!.guards, ["AuthGuard", "RolesGuard"]);
    assert.deepEqual(create!.roles, ["editor", "admin"]);

    // @Public en el método gana pese al @UseGuards de la clase.
    const remove = byKey.get("DELETE /api/orders/{id}");
    assert.equal(remove!.requiresAuth, false);

    // El objeto { path } y @Public a nivel de método.
    const health = byKey.get("GET /api/health");
    assert.equal(health!.requiresAuth, false);
  });

  test("joinPath normaliza barras", () => {
    assert.equal(joinPath("api", "/orders/", ":id"), "/api/orders/{id}");
    assert.equal(joinPath("", "", ""), "/");
    assert.equal(joinPath("//a//", "b"), "/a/b");
  });

  test("un fichero con sintaxis rota no tumba el escaneo", () => {
    const result = analyzeNestSources([
      { path: "roto.ts", content: "@Controller( export class {{{" },
      { path: "ok.controller.ts", content: `@Controller("x") export class X { @Get() a() {} }` },
    ]);
    assert.ok(result.endpoints.some((endpoint) => endpoint.path === "/x"));
  });
});

describe("el diff del escaneo", () => {
  const scanned = analyzeNestSources([{ path: "c.ts", content: CONTROLLER }], "api").endpoints;

  test("clasifica en añadidos, quitados, cambiados y sin cambios", () => {
    const existing: ExistingEndpoint[] = [
      { id: "e1", method: "GET", path: "/api/orders", requiresAuth: true }, // igual → sin cambios
      { id: "e2", method: "GET", path: "/api/orders/{id}", requiresAuth: false }, // el código ahora exige auth
      { id: "e3", method: "GET", path: "/api/legacy", requiresAuth: true }, // ya no está en el código
    ];
    const diff = diffEndpoints(scanned, existing);
    assert.equal(diff.unchanged, 1);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].id, "e2");
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0].id, "e3");
    // POST /api/orders, DELETE /api/orders/{id} y GET /api/health son nuevos.
    assert.equal(diff.added.length, 3);
  });

  test("señala los roles que el código nombra y el proyecto no define", () => {
    assert.deepEqual(unknownRoles(scanned, ["viewer"]), ["admin", "editor"]);
    assert.deepEqual(unknownRoles(scanned, ["viewer", "editor", "admin"]), []);
  });
});
