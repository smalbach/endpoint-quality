import { describe, expect, test } from "vitest";
import { previewBodyFor } from "@/lib/request-preview";
import type { RequestTemplateView } from "@/lib/types";

const template = (overrides: Partial<RequestTemplateView> = {}): RequestTemplateView => ({
  id: "t1",
  name: "Listar cosas",
  operationId: "listThings",
  description: null,
  expectedStatus: 200,
  parameters: {},
  disabledParameters: {},
  headers: {},
  disabledHeaders: {},
  body: { type: "none" },
  auth: "default",
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...overrides,
});

/**
 * Lo que se manda cuando alguien pulsa «Enviar».
 *
 * El módulo existe porque aquí es donde el formulario deja de ser un formulario y pasa a ser una
 * petición, y los dos bordes de esa conversión no se ven hasta que el destino la rechaza: una fila
 * a medio escribir no es una instrucción de mandar `?=`, y el tipo del cuerpo viaja con él porque
 * «sin cuerpo» y «un JSON vacío» son dos peticiones distintas contra bastantes destinos.
 */
describe("el cuerpo de una petición de prueba", () => {
  test("«sin cuerpo» viaja como tal y no como un objeto vacío", () => {
    expect(previewBodyFor(template({ body: { type: "none" } }), "env-1").body).toEqual({ type: "none" });
  });

  test("un JSON sin claves sigue siendo un cuerpo: alguien eligió mandarlo vacío", () => {
    expect(previewBodyFor(template({ body: { type: "json", json: {} } }), "env-1").body).toEqual({
      type: "json",
      json: {},
    });
  });

  test("un cuerpo en texto viaja con su content-type, que es lo que el motor no puede adivinar", () => {
    const body = { type: "raw", text: "<pedido/>", contentType: "application/xml" } as const;
    expect(previewBodyFor(template({ body }), "env-1").body).toEqual(body);
  });

  test("un parámetro a medio escribir no se manda", () => {
    const built = previewBodyFor(template({ parameters: { status: "activo", "": "1", page: "" } }), "env-1");
    expect(built.parameters).toEqual({ status: "activo" });
  });

  test("una cabecera apagada no está en lo que se manda: vive en el otro mapa", () => {
    const built = previewBodyFor(
      template({ headers: { "X-Tenant": "acme" }, disabledHeaders: { "X-Debug": "1" } }),
      "env-1",
    );
    expect(built.headers).toEqual({ "X-Tenant": "acme" });
  });

  test("lleva el entorno y el resto del formulario", () => {
    const built = previewBodyFor(template({ auth: "none", expectedStatus: 404 }), "env-7");
    expect(built).toMatchObject({
      environmentId: "env-7",
      operationId: "listThings",
      expectedStatus: 404,
      auth: "none",
    });
  });
});
