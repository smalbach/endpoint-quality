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
  body: null,
  auth: "default",
  updatedAt: "2026-03-01T10:00:00.000Z",
  ...overrides,
});

/**
 * Lo que se manda cuando alguien pulsa «Enviar».
 *
 * El caso que justifica el módulo es el del cuerpo: el formulario guarda `{}` cuando nadie lo ha
 * tocado, y el motor lee `{}` como «manda un cuerpo vacío» y `null` como «no mandes ninguno». Un
 * GET con cuerpo vacío es una petición que algunos destinos rechazan, y el error no diría nada
 * de por qué.
 */
describe("el cuerpo de una petición de prueba", () => {
  test("un body sin claves es «sin cuerpo», no un cuerpo vacío", () => {
    expect(previewBodyFor(template({ body: {} }), "env-1").body).toBeNull();
  });

  test("un body con claves viaja tal cual", () => {
    expect(previewBodyFor(template({ body: { name: "x" } }), "env-1").body).toEqual({ name: "x" });
  });

  test("un parámetro a medio escribir no se manda", () => {
    const built = previewBodyFor(template({ parameters: { status: "activo", "": "1", page: "" } }), "env-1");
    expect(built.parameters).toEqual({ status: "activo" });
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
