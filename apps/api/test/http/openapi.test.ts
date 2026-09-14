/**
 * This API's own contract, checked against this API.
 *
 * A product that verifies contracts publishing one it does not honour would be the joke telling
 * itself. And the document is not decoration here: the matrix is generated from the statuses an
 * operation declares, so a contract listing only the happy path produces no authorization cases,
 * no not-found cases and no invalid-body cases. Endpoint Quality could not be pointed at Endpoint
 * Quality, which is the cheapest test of whether any of this generalises.
 *
 * The errors are declared from the shape of the route rather than one decorator at a time, which
 * buys uniformity and costs a way to be wrong: the rule could describe routes that do not behave
 * that way. So the claim is checked where it is checkable — **every documented GET is called
 * without a token**, and the answer has to be 401 exactly when the document says the route needs
 * one. GETs only: this asserts a claim about the API, it does not get to create data doing it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { SwaggerModule, DocumentBuilder, type OpenAPIObject } from "@nestjs/swagger";

import { describeErrors, PUBLIC_PATHS } from "@/shared/openapi/describe-errors";
import { describeBodies } from "@/shared/openapi/describe-bodies";
import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
let document: OpenAPIObject;

before(async () => {
  context = await createTestApp();
  document = describeBodies(
    describeErrors(
      SwaggerModule.createDocument(
        context.app,
        new DocumentBuilder().setTitle("Endpoint Quality API").setVersion("0.1.0").addBearerAuth().build(),
      ),
    ),
  );
});
after(async () => {
  await context?.close();
});

const api = () => request(context.app.getHttpServer());

type DocumentedOperation = { method: string; path: string; responses: Record<string, unknown> };

function operations(): DocumentedOperation[] {
  const found: DocumentedOperation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = (item as Record<string, unknown>)[method] as
        { responses?: Record<string, unknown> } | undefined;
      if (operation?.responses) found.push({ method, path, responses: operation.responses });
    }
  }
  return found;
}

/** Any syntactically valid value: a 401 is decided by the guard, before anything is looked up. */
const fill = (path: string) => path.replace(/\{[^}]+\}/g, "11111111-2222-3333-4444-555555555555");

describe("el contrato que publica esta API", () => {
  test("declara operaciones y todas dicen algo sobre los errores", () => {
    const all = operations();
    assert.ok(all.length > 30, `solo ${all.length} operaciones documentadas`);
    for (const { method, path, responses } of all) {
      const statuses = Object.keys(responses).map(Number);
      assert.ok(
        statuses.some((status) => status >= 400),
        `${method.toUpperCase()} ${path} no declara ningún error: la matriz que genere de aquí no tendrá nada que comprobar`,
      );
    }
  });

  test("cada error declarado apunta al mismo ProblemDetails", () => {
    // One schema, referenced, not copied. `ProblemDetailsFilter` writes one shape for the whole
    // system, and a document with three variants of it would be describing a system that does not
    // exist.
    assert.ok(document.components?.schemas?.ProblemDetails, "falta el componente ProblemDetails");
    for (const { method, path, responses } of operations()) {
      for (const [status, response] of Object.entries(responses)) {
        if (Number(status) < 400) continue;
        const content = (response as { content?: Record<string, { schema?: { $ref?: string } }> }).content ?? {};
        const media = content["application/problem+json"];
        assert.ok(media, `${method.toUpperCase()} ${path} ${status} no se declara como application/problem+json`);
        assert.equal(
          media.schema?.$ref,
          "#/components/schemas/ProblemDetails",
          `${method.toUpperCase()} ${path} ${status} no referencia ProblemDetails`,
        );
      }
    }
  });

  test("las rutas públicas del documento son las que de verdad responden sin token", async () => {
    // The assertion that keeps the rule honest. If somebody adds a public route and forgets
    // `PUBLIC_PATHS`, the document promises a 401 the API does not answer; if somebody removes
    // `@Public()`, the document says a route is open that is not.
    for (const { path, responses } of operations().filter((entry) => entry.method === "get")) {
      const declaresUnauthenticated = "401" in responses;
      const response = await api().get(fill(path));
      const answered401 = response.status === 401;
      assert.equal(
        answered401,
        declaresUnauthenticated,
        `GET ${path}: el documento ${declaresUnauthenticated ? "declara" : "no declara"} 401 y la API respondió ${response.status}`,
      );
    }
  });

  test("y las públicas son las que tienen que serlo", () => {
    // Each one has to be: `/health` is what a load balancer polls, three are how a session begins —
    // `refresh` runs when there is no access token to present — and the shared run is read by a link
    // whose token is the credential.
    assert.deepEqual([...PUBLIC_PATHS].sort(), [
      "/auth/login",
      "/auth/refresh",
      "/auth/register",
      "/health",
      "/shared/security-runs/{shareToken}",
    ]);
  });

  test("ningún cuerpo de petición se publica vacío", async () => {
    // Nest genera `{"type":"object","properties":{}}` para cada DTO, porque las clases llevan
    // decoradores de class-validator y ningún `@ApiProperty`. Eso decía que cada escritura acepta
    // "un objeto" y nada más: el mismo fallo que declarar solo el camino feliz, un nivel más
    // abajo. Pointing this product at its own contract produced 22 write cases with no payload.
    //
    // Esta prueba es lo que hace que la lista de DTOs de `describe-bodies.ts` no se pueda olvidar:
    // un DTO nuevo que no esté en ella publica `{}` y rompe aquí.
    const empty: string[] = [];
    for (const { method, path, responses: _ignored } of operations()) {
      const operation = ((document.paths?.[path] as Record<string, unknown>)[method] as { requestBody?: unknown })
        .requestBody as { content?: Record<string, { schema?: { $ref?: string } }> } | undefined;
      const schema = operation?.content?.["application/json"]?.schema;
      if (!schema) continue;
      const resolved = schema.$ref
        ? (document.components?.schemas?.[schema.$ref.split("/").pop()!] as { properties?: object } | undefined)
        : (schema as { properties?: object });
      if (!resolved || Object.keys(resolved.properties ?? {}).length === 0)
        empty.push(`${method.toUpperCase()} ${path}`);
    }
    assert.deepEqual(empty, [], "estas operaciones declaran un cuerpo y no dicen qué lleva dentro");
  });

  test("el cuerpo publicado dice lo mismo que la validación exige", async () => {
    // Derivado de `class-validator`, no escrito a mano, que es lo que impide que el documento y la
    // regla se separen. Un `@MinLength(12)` y un `@ApiProperty({ minLength: 8 })` compilan los dos.
    const register = document.components?.schemas?.RegisterDto as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(
      register.required,
      ["email", "password", "name"],
      "organizationName es opcional y no debe aparecer",
    );
    assert.deepEqual(register.properties?.email, { type: "string", maxLength: 320, format: "email" });
    assert.equal(register.properties?.password.minLength, 12, "es el mínimo que el pipe rechaza de verdad");

    // Y lo anidado se resuelve en línea: `source` es el único campo que toma el endpoint de
    // importación, y valía `{}`.
    const importSpec = document.components?.schemas?.ImportSpecDto as {
      properties?: Record<string, { properties?: object }>;
    };
    assert.ok(Object.keys(importSpec.properties?.source.properties ?? {}).length > 0, "el DTO anidado no se resolvió");
  });

  test("crear y modificar un entorno no piden lo mismo, y el documento lo dice", async () => {
    // Los dos compartían clase, así que todo campo tenía que ser opcional para que un PATCH que
    // solo cambia `writesAllowed` no obligara a reenviar el nombre. El documento acababa diciendo
    // que crear un entorno no exige nada: que `{}` sirve. No sirve, y el 422 salía del handler.
    const create = document.components?.schemas?.CreateEnvironmentDto as { required?: string[] };
    assert.deepEqual(create.required, ["name", "baseUrl"]);
    const update = document.components?.schemas?.UpdateEnvironmentDto as { required?: string[] };
    assert.equal(update.required, undefined, "un PATCH parcial no exige ningún campo, y eso es correcto");
    // Que la API responda lo que aquí promete se comprueba autenticado, en config.test.ts.
  });

  test("un 401 real tiene la forma que el documento promete", async () => {
    // The document is only worth something if the body matches. This is the same check the
    // product runs against everybody else.
    const response = await api().get("/auth/me");
    assert.equal(response.status, 401);
    assert.match(response.headers["content-type"], /^application\/problem\+json/);
    for (const field of ["type", "title", "status", "detail"]) assert.ok(field in response.body, `falta ${field}`);
    assert.equal(response.body.status, 401);
  });
});
