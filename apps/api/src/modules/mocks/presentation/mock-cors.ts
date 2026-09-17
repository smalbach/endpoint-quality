/**
 * El CORS del mock, que es el contrario del de la API.
 *
 * La API vive con una lista de orígenes y `credentials: true`, porque ahí hay una sesión que
 * proteger. Un mock es justo lo otro: **el caso normal es un front a medio hacer en un puerto que
 * cambia cada día**, y una lista de orígenes lo rompería en la primera hora. Así que el mock abre a
 * cualquier origen — y por eso mismo **no admite credenciales**, que además es la única combinación
 * que el navegador permite junto a `*`. Lo que autoriza a un mock privado es la cabecera
 * `x-api-key`, que se manda a mano y no viaja sola como una cookie.
 *
 * Va montado **antes** del CORS global: el de Nest contesta el preflight él mismo y lo cerraría con
 * la lista de la API antes de que esta ruta llegue a existir. Y va después de `helmet`, para poder
 * corregir su `Cross-Origin-Resource-Policy: same-origin`, que es correcto para la API y no para
 * algo cuyo único propósito es que lo lea otro origen.
 */
import type { NextFunction, Request, Response } from "express";

export const MOCK_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  // Sin esto el JavaScript de la página no puede leer las cabeceras de diagnóstico, que es donde el
  // mock dice qué ejemplo eligió y por qué.
  "access-control-expose-headers": "*",
  "access-control-max-age": "600",
  "cross-origin-resource-policy": "cross-origin",
  // Un mock cambia en cuanto se guarda otro ejemplo, y una respuesta cacheada por el navegador es
  // media hora buscando por qué no se ve el cambio.
  "cache-control": "no-store",
};

/**
 * Pone las cabeceras del mock, y **quita la que la API pone por su cuenta**.
 *
 * `Access-Control-Allow-Credentials: true` lo escribe el CORS global de Nest, y junto a un
 * `Allow-Origin: *` es la única combinación que el navegador rechaza de plano: un `fetch` con
 * `credentials: "include"` se queda sin respuesta. Como el CORS global corre **después** de este
 * middleware, quitarla aquí no basta por sí solo — por eso el controlador vuelve a llamar a esto
 * justo antes de escribir, que es el último momento en que alguien puede tener la última palabra.
 */
export function applyMockCors(response: Response): void {
  for (const [name, value] of Object.entries(MOCK_CORS_HEADERS)) response.setHeader(name, value);
  response.removeHeader("access-control-allow-credentials");
}

export function mockCors(request: Request, response: Response, next: NextFunction): void {
  applyMockCors(response);
  // `Access-Control-Request-Method` es lo que distingue un preflight de un `OPTIONS` de verdad, y
  // un proyecto puede tener declarado un `OPTIONS` que el mock debe contestar como cualquier otro.
  if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
    response.status(204).end();
    return;
  }
  next();
}
