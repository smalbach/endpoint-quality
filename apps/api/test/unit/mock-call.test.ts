/**
 * La fila que deja una llamada al mock.
 *
 * Lo que se comprueba aquí es lo que decide la forma de la tabla: que de un acierto sale **qué
 * ejemplo** se sirvió, que de cada manera de no contestar sale **su código** —404 la ruta que no
 * está, 405 el método equivocado, 501 la ruta sin ejemplos—, y que ninguna de las dos lleva nada de
 * lo que la petición traía dentro. La fila se construye a partir de la respuesta ya decidida, así
 * que la única forma de que una cabecera acabe guardada sería que alguien añadiera la columna.
 *
 * Y que la retención recorta: la bitácora de una URL pública la llena un tercero, así que un tope
 * que no se aplicara sería una tabla que crece mientras alguien tenga un front recargándose.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_MOCK_CALL_PATH, MOCK_CALL_HISTORY, mockCallOf, viewMockCall } from "@/modules/mocks/domain/mock-call";
import type { MockOutcome } from "@/modules/mocks/domain/serve-mock";
import { InMemoryMockRepository } from "../support/in-memory-mocks";

const AT = new Date("2026-03-01T10:00:00.000Z");
const MOCK_ID = "00000000-0000-4000-8000-000000000001";

const hit = (): MockOutcome => ({
  kind: "hit",
  status: 200,
  headers: [],
  body: '{"id":"42"}',
  trace: {
    endpointId: "00000000-0000-4000-8000-0000000000e1",
    endpointRoute: "GET /v1/pedidos/{id}",
    exampleId: "00000000-0000-4000-8000-0000000000a1",
    exampleName: "el bueno",
    reason: "lowest-2xx",
  },
});

const miss = (status: number, code: string): MockOutcome => ({
  kind: "problem",
  status,
  code,
  title: "no",
  detail: "no",
});

const call = (outcome: MockOutcome, path = "/v1/pedidos/42", method = "GET", durationMs = 7) =>
  mockCallOf({ mockServerId: MOCK_ID, method, path, outcome, at: AT, durationMs });

describe("la fila de una llamada servida", () => {
  it("de un acierto guarda el ejemplo que casó, por id y por nombre", () => {
    const row = call(hit());
    assert.equal(row.status, 200);
    assert.equal(row.exampleId, "00000000-0000-4000-8000-0000000000a1");
    assert.equal(row.exampleName, "el bueno");
    // Vacío y no «ok»: el hueco del motivo es lo que distingue un acierto de un «no» en la pantalla.
    assert.equal(row.missCode, "");
    assert.equal(row.durationMs, 7);
  });

  it("no guarda nada del cuerpo servido: ya está en el ejemplo, y el id lleva a él", () => {
    // Esto es la prueba de la forma, no del contenido: si algún día alguien añade la columna, aquí
    // se ve. Lo que la tabla no tiene no se puede filtrar.
    assert.deepEqual(Object.keys(call(hit())).sort(), [
      "at",
      "durationMs",
      "exampleId",
      "exampleName",
      "id",
      "method",
      "missCode",
      "mockServerId",
      "path",
      "status",
    ]);
  });

  it("de la ruta que no está guarda el 404 y su código", () => {
    const row = call(miss(404, "mock-no-route"), "/v1/pedido/42");
    assert.equal(row.status, 404);
    assert.equal(row.missCode, "mock-no-route");
    assert.equal(row.exampleId, null);
    assert.equal(row.exampleName, "");
  });

  it("del método equivocado guarda el 405 y su código, que no es el mismo «no»", () => {
    const row = call(miss(405, "mock-wrong-method"), "/v1/pedidos/42", "PUT");
    assert.equal(row.status, 405);
    assert.equal(row.missCode, "mock-wrong-method");
    assert.equal(row.method, "PUT");
  });

  it("de la ruta declarada sin ejemplos guarda el 501, que es el «no» que se arregla guardando uno", () => {
    const row = call(miss(501, "mock-no-example"), "/v1/pedidos/42", "delete");
    assert.equal(row.status, 501);
    assert.equal(row.missCode, "mock-no-example");
    // El método en mayúsculas, como en HTTP: si no, «delete» y «DELETE» serían dos filas distintas.
    assert.equal(row.method, "DELETE");
  });

  it("normaliza la ruta y la recorta: la escribe quien llama", () => {
    assert.equal(call(hit(), "//v1//pedidos/42/").path, "/v1/pedidos/42");
    assert.equal(call(hit(), `/v1/${"x".repeat(500)}`).path.length, MAX_MOCK_CALL_PATH);
  });

  it("un tiempo negativo no llega a la fila", () => {
    // Pasa restando el retardo simulado con un reloj que se mueve: no vale una fila con un −3.
    assert.equal(call(hit(), "/v1/pedidos/42", "GET", -3).durationMs, 0);
  });

  it("lo que sale por la API no lleva el mock dentro: ya está en la URL", () => {
    const view = viewMockCall(call(hit()));
    assert.equal("mockServerId" in view, false);
    assert.equal(view.at, "2026-03-01T10:00:00.000Z");
  });
});

describe("la retención", () => {
  it(`deja las ${MOCK_CALL_HISTORY} últimas de ese mock y borra las viejas`, async () => {
    const repository = new InMemoryMockRepository();
    // Una más que el tope, cada una un segundo después: la primera es la que tiene que irse.
    for (let index = 0; index <= MOCK_CALL_HISTORY; index += 1) {
      await repository.saveCall(
        mockCallOf({
          mockServerId: MOCK_ID,
          method: "GET",
          path: `/v1/pedidos/${index}`,
          outcome: hit(),
          at: new Date(AT.getTime() + index * 1_000),
          durationMs: 1,
        }),
      );
    }
    await repository.trimCalls(MOCK_ID, MOCK_CALL_HISTORY);

    const kept = await repository.listCalls(MOCK_ID, MOCK_CALL_HISTORY + 10);
    assert.equal(kept.length, MOCK_CALL_HISTORY);
    // La más reciente primero, que es como se lee la pantalla.
    assert.equal(kept[0].path, `/v1/pedidos/${MOCK_CALL_HISTORY}`);
    assert.equal(
      kept.some((row) => row.path === "/v1/pedidos/0"),
      false,
    );
  });

  it("no toca la bitácora de otro mock", async () => {
    const repository = new InMemoryMockRepository();
    const other = "00000000-0000-4000-8000-000000000002";
    for (const mockServerId of [MOCK_ID, other]) {
      for (let index = 0; index < 3; index += 1) {
        await repository.saveCall(
          mockCallOf({
            mockServerId,
            method: "GET",
            path: `/v1/pedidos/${index}`,
            outcome: hit(),
            at: new Date(AT.getTime() + index * 1_000),
            durationMs: 1,
          }),
        );
      }
    }
    await repository.trimCalls(MOCK_ID, 1);
    assert.equal((await repository.listCalls(MOCK_ID, 10)).length, 1);
    assert.equal((await repository.listCalls(other, 10)).length, 3);
  });
});
