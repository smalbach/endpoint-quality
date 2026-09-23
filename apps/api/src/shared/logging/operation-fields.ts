/**
 * Los campos con los que una petición se convierte en un dato agregable.
 *
 * Compartido entre las dos piezas que escriben esa línea —el interceptor cuando la operación
 * termina y el filtro de errores cuando no— para que las dos escriban exactamente los mismos
 * nombres. Es la diferencia entre poder agrupar por `op` y tener dos conjuntos de líneas que
 * hablan de lo mismo con dos vocabularios.
 */
import { withoutHookToken } from "@/shared/http/redact-url";
import type { LogFields } from "./logger.port";

/**
 * Lo que hace falta de la petición, descrito aquí.
 *
 * Estructural y no el `AuthenticatedRequest` de `auth`: `shared` no depende de un módulo, y de
 * quien llama solo se lee su identificador.
 */
export type ObservedRequest = {
  method?: string;
  url?: string;
  route?: { path?: string };
  principal?: { kind?: string; userId?: string; organizationId?: string; tokenId?: string };
};

export type OperationDescription = {
  /** El patrón de la ruta, suelto, para decidir el nivel de la línea. */
  route: string;
  log: LogFields;
};

export function operationFields(request: ObservedRequest, ms: number | undefined): OperationDescription {
  const route = routeOf(request);
  return {
    route,
    log: {
      op: `${request.method ?? "?"} ${route}`,
      ...(ms === undefined ? {} : { ms }),
      ...caller(request),
    },
  };
}

/** El patrón registrado si Nest lo puso —lo hace al resolver el manejador— y la ruta sin la cadena
 * de consulta si no: un 404 no llega a ningún manejador y sigue siendo una operación que ocurrió. */
function routeOf(request: ObservedRequest): string {
  return request.route?.path ?? withoutHookToken((request.url ?? "").split("?")[0]);
}

/** Quién llamaba. Un token de CI no tiene usuario: tiene organización, y esa es la unidad con la
 * que se mira después «quién está gastando el cupo». */
function caller(request: ObservedRequest): LogFields {
  const principal = request.principal;
  if (!principal) return {};
  return principal.kind === "user"
    ? { userId: principal.userId }
    : { tokenId: principal.tokenId, organizationId: principal.organizationId };
}
