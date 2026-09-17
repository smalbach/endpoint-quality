/**
 * Lo que este módulo usa para firmar, en un sitio.
 *
 * Las firmas viven en el motor, que es donde se comprueban contra los vectores de cada
 * especificación; las etiquetas y la lista de parámetros que son secretos viven en el lector de
 * ficheros de Postman, que es donde se decide qué no se guarda. Reexportarlos aquí es lo que evita
 * que el que envía la petición tenga que importar de dos módulos de otros dos contextos.
 */
export { readTokenResponse, signAuth, tokenRequestFor, type AuthType, type RequestAuth } from "@eq/runner-core";
export { AUTH_LABELS, SECRET_PARAMS } from "@/modules/workflows/domain/postman-auth";
