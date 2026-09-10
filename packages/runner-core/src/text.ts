/**
 * The wording of a generated case, as a resource rather than a constant.
 *
 * In the coupled dashboard these strings were Spanish literals inside `scenarios.ts`. In a
 * product that serves several projects and more than one language they are a bundle a project
 * can override key by key — and the default bundle below is, verbatim, what the coupled version
 * emitted. That is deliberate: the parity test compares descriptions too, so a reworded string
 * here is a failing test and not a silent change to what an operator reads.
 *
 * Templates interpolate `{{name}}` against a flat record. An unknown placeholder is left alone
 * rather than rendered as `undefined`, so a bad key is visible instead of quietly blank.
 */

export type TextBundle = {
  listDefaultName: string;
  listDefaultDescription: string;
  soloName: string;
  soloDescription: string;
  authNoneName: string;
  authNoneDescription: string;
  authInsufficientName: string;
  authInsufficientDescription: string;
  authApiKeyName: string;
  authApiKeyDescription: string;
  notFoundWriteName: string;
  notFoundWriteDescription: string;
  invalidBodyName: string;
  invalidBodyPutDescription: string;
  invalidBodyPatchDescription: string;
  invalidBodyPostDescription: string;
  conflictName: string;
  conflictDescription: string;
  getFoundName: string;
  getFoundDescription: string;
  getNotFoundName: string;
  getNotFoundDescription: string;
  createReadName: string;
  createReadDescription: string;
  replaceReadName: string;
  replaceReadDescription: string;
  patchReadName: string;
  patchReadDescription: string;
  deleteReadName: string;
  deleteReadDescription: string;
  deletedReadName: string;
  deletedReadDescription: string;
};

export const es: TextBundle = {
  listDefaultName: "Listado sin filtros",
  listDefaultDescription: "Valida la respuesta por defecto, envelope y paginación.",
  soloName: "{{parameter}} = {{value}}",
  soloDescription: "Ejercita el filtro {{parameter}} de forma independiente.",
  authNoneName: "Sin credencial",
  authNoneDescription: "Sin token ni API key la operación debe responder 401 en Problem Details.",
  authInsufficientName: "Scope insuficiente",
  authInsufficientDescription: "Un token de {{scope}} no alcanza para esta operación.",
  authApiKeyName: "API key en un DELETE",
  authApiKeyDescription: "Los DELETE no declaran ApiKeyAuth: una key válida es 401, no 403 (D-29).",
  notFoundWriteName: "Recurso inexistente",
  notFoundWriteDescription: "Sobre un identificador que no existe debe responder 404 y no crear nada.",
  invalidBodyName: "Payload inválido",
  invalidBodyPutDescription: "Un PUT sin los campos requeridos debe rechazarse con 422.",
  invalidBodyPatchDescription: "Un PATCH sin ningún campo escribible debe rechazarse con 422.",
  invalidBodyPostDescription: "Envía un body vacío y espera validación 422.",
  conflictName: "Clave natural duplicada",
  conflictDescription: "Repetir una clave que ya existe debe responder 409 y no una violación de constraint.",
  getFoundName: "Recurso existente",
  getFoundDescription: "Consulta el identificador semilla y valida la respuesta completa.",
  getNotFoundName: "Recurso inexistente",
  getNotFoundDescription: "Comprueba el 404 y el formato Problem Details.",
  createReadName: "Crear y consultar",
  createReadDescription: "Crea el recurso, captura el ID devuelto y lo consulta para comparar todos los campos enviados.",
  replaceReadName: "Crear, reemplazar y consultar",
  replaceReadDescription: "Crea una entidad aislada, ejecuta PUT y verifica el estado persistido con GET.",
  patchReadName: "Crear, actualizar y consultar",
  patchReadDescription: "Crea una entidad aislada, ejecuta PATCH y comprueba los campos modificados con GET.",
  deleteReadName: "Crear, eliminar y confirmar",
  deleteReadDescription: "Crea una entidad aislada, la elimina y confirma que GET responde 404.",
  deletedReadName: "Consultar el recurso eliminado",
  deletedReadDescription: "Tras eliminarlo, el GET debe responder 404 en Problem Details y un segundo DELETE también 404: ni sigue accesible ni se puede borrar dos veces.",
};

export const en: TextBundle = {
  listDefaultName: "Unfiltered list",
  listDefaultDescription: "Checks the default response, its envelope and pagination.",
  soloName: "{{parameter}} = {{value}}",
  soloDescription: "Exercises the {{parameter}} filter on its own.",
  authNoneName: "No credential",
  authNoneDescription: "With no token and no API key the operation must answer 401 in Problem Details.",
  authInsufficientName: "Insufficient scope",
  authInsufficientDescription: "A {{scope}} token does not reach this operation.",
  authApiKeyName: "API key on a DELETE",
  authApiKeyDescription: "The operation declares no API key scheme: a valid key is 401, not 403.",
  notFoundWriteName: "Missing resource",
  notFoundWriteDescription: "Over an identifier that does not exist it must answer 404 and create nothing.",
  invalidBodyName: "Invalid payload",
  invalidBodyPutDescription: "A PUT without the required fields must be rejected with 422.",
  invalidBodyPatchDescription: "A PATCH with nothing writable in it must be rejected with 422.",
  invalidBodyPostDescription: "Sends an empty body and expects 422 validation.",
  conflictName: "Duplicate natural key",
  conflictDescription: "Repeating an existing key must answer 409 and not a constraint violation.",
  getFoundName: "Existing resource",
  getFoundDescription: "Reads the seed identifier and validates the full response.",
  getNotFoundName: "Missing resource",
  getNotFoundDescription: "Checks the 404 and the Problem Details format.",
  createReadName: "Create and read back",
  createReadDescription: "Creates the resource, captures the returned ID and reads it back to compare every field sent.",
  replaceReadName: "Create, replace and read back",
  replaceReadDescription: "Creates an isolated entity, runs the PUT and verifies the persisted state with a GET.",
  patchReadName: "Create, update and read back",
  patchReadDescription: "Creates an isolated entity, runs the PATCH and checks the changed fields with a GET.",
  deleteReadName: "Create, delete and confirm",
  deleteReadDescription: "Creates an isolated entity, deletes it and confirms the GET answers 404.",
  deletedReadName: "Read the deleted resource",
  deletedReadDescription: "After deleting it the GET must answer 404 in Problem Details and a second DELETE 404 too: it is neither still reachable nor deletable twice.",
};

export const bundles = { es, en } as const;
export type Locale = keyof typeof bundles;

export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
