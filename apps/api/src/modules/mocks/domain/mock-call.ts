/**
 * La bitácora del mock: una fila por petición que llegó a su URL.
 *
 * Es la pantalla que contesta «¿llegó mi petición?». Sin ella, quien apunta su front a un mock y ve
 * un 404 no tiene forma de saber si la petición salió, si la ruta era otra, o si el mock ni la vio:
 * lo único que hay es la consola del navegador y una URL que no explica nada.
 *
 * ## Lo que NO se guarda, que es la decisión que da forma a la tabla
 *
 * La petición que entra al mock **es de un tercero**. No la escribió nadie de esta casa, viene del
 * front de alguien apuntado aquí, y lleva lo que ese front manda a su API de verdad: el `Bearer` de
 * un usuario real en las cabeceras, un correo y una contraseña en el cuerpo del login que se está
 * probando, una `api_key` en la cadena de consulta. Guardar cualquiera de las tres convertiría esta
 * tabla en el peor sitio de todo el producto: un almacén de credenciales ajenas que nadie pidió, en
 * una ruta `@Public()` que cualquiera puede llamar tantas veces como quiera.
 *
 * Así que de la petición no se guarda **nada que la propia petición traiga dentro**:
 *
 * - **Cabeceras, ninguna.** Ahí van `authorization`, `cookie` y la `x-api-key` del propio mock.
 *   Filtrar las peligrosas por una lista sería apostar a que la lista está completa, y la de
 *   cabeceras que llevan credenciales no se puede completar: `x-empresa-token` no está en ninguna.
 * - **El cuerpo, tampoco.** Es el sitio donde viajan las contraseñas y los datos personales, y un
 *   cuerpo guardado es además lo que hace que una bitácora pese más que los datos del proyecto.
 * - **La cadena de consulta, ni cruda ni redactada.** `?token=…` es la forma más vieja de mandar
 *   una credencial y sigue viva. Los nombres de los parámetros tampoco: distinguir dos llamadas por
 *   su `?page=` no vale lo que cuesta guardar una lista donde puede haber un `?password=`.
 *
 * Y de la respuesta no se guarda el cuerpo servido: ya está en el ejemplo, y `exampleId` lleva a él.
 *
 * ## Lo que sí, y por qué cada cosa
 *
 * Lo mínimo que hace útil la pantalla: **cuándo** (`at`), **qué se pidió** (`method` y `path`),
 * **qué se contestó** (`status`), **con qué** —`exampleId` y `exampleName`, o `missCode` cuando no
 * hubo con qué— y **cuánto tardó** (`durationMs`).
 *
 * `path` es la ruta del mock ya normalizada, sin el prefijo y sin la cadena de consulta: es lo que
 * se compara con las rutas declaradas del proyecto, y es la mitad de «pediste `/user/42` y el mock
 * sirve `/users/{id}`». Va recortada, porque una ruta la escribe quien llama y puede tener el largo
 * que quiera.
 *
 * `missCode` es el código que ya decide `serve-mock.ts` (`mock-no-route`, `mock-wrong-method`,
 * `mock-no-example`…) y no una frase: el motivo se decide en un sitio, se escribe igual en la
 * cabecera de la respuesta y en esta fila, y así se puede contar cuántas veces pasó.
 *
 * Tampoco se guarda de quién era la petición —ni IP ni agente—: no hace falta para arreglar nada de
 * lo que esta pantalla arregla, y sería un registro de tráfico de terceros con su propia ley encima.
 */
import { randomUUID } from "node:crypto";

import { normalizeMockPath, type MockOutcome } from "./serve-mock";

/**
 * Cuántas llamadas se guardan por servidor de mock.
 *
 * Doscientas y no las cincuenta de `MONITOR_HISTORY`, porque el ritmo no se parece: un monitor
 * escribe una fila cada cinco minutos y un mock escribe una por cada petición de un front que se
 * está recargando en bucle. Doscientas son varias pantallas de desplazamiento —suficiente para ver
 * el patrón de lo que un front pide al arrancar— y siguen siendo un tope por mock, que es lo que
 * importa: la bitácora de una URL pública no puede crecer sin fin, porque quien la llena no es el
 * dueño del proyecto.
 */
export const MOCK_CALL_HISTORY = 200;

/** Lo que cabe de una ruta. La escribe quien llama, así que tiene que tener un tope. */
export const MAX_MOCK_CALL_PATH = 300;

export type MockCall = {
  id: string;
  mockServerId: string;
  at: Date;
  method: string;
  /** La ruta del mock, normalizada y **sin la cadena de consulta**. Ver la cabecera. */
  path: string;
  status: number;
  /** El ejemplo que se sirvió. Nulo cuando no se sirvió ninguno. */
  exampleId: string | null;
  /** Su nombre, para no tener que resolver el id en la pantalla. Vacío cuando no hubo ejemplo. */
  exampleName: string;
  /** El código del «no»: `mock-no-route`, `mock-wrong-method`, `mock-no-example`… Vacío en un acierto. */
  missCode: string;
  /** Lo que costó decidir y servir, sin el retardo simulado. Ver `recordMockCall`. */
  durationMs: number;
};

/** Un método HTTP cabe de sobra; el tope está porque la palabra la escribe quien llama. */
const MAX_METHOD = 16;

/**
 * La fila que deja una petición servida.
 *
 * Es una función pura de lo que `serveMock` ya decidió, y por eso está aquí y no dentro de él: lo
 * que se guarda es una **consecuencia** de la respuesta, y meter la escritura en el motor haría que
 * la función que decide qué se contesta dejara de poder probarse con dos arrays.
 */
export function mockCallOf(fields: {
  mockServerId: string;
  method: string;
  path: string;
  outcome: MockOutcome;
  at: Date;
  durationMs: number;
}): MockCall {
  const { outcome } = fields;
  return {
    id: randomUUID(),
    mockServerId: fields.mockServerId,
    at: fields.at,
    method: fields.method.toUpperCase().slice(0, MAX_METHOD),
    path: normalizeMockPath(fields.path).slice(0, MAX_MOCK_CALL_PATH),
    status: outcome.status,
    exampleId: outcome.kind === "hit" ? outcome.trace.exampleId : null,
    exampleName: outcome.kind === "hit" ? outcome.trace.exampleName : "",
    missCode: outcome.kind === "problem" ? outcome.code : "",
    // Negativo no puede ser, y un reloj que salta hacia atrás no vale una fila con un número raro.
    durationMs: Math.max(0, Math.round(fields.durationMs)),
  };
}

/** Lo que sale por la API. La fila entera menos el `mockServerId`, que ya está en la URL. */
export type MockCallView = Omit<MockCall, "mockServerId" | "at"> & { at: string };

export function viewMockCall(call: MockCall): MockCallView {
  const { mockServerId: _mockServerId, ...rest } = call;
  return { ...rest, at: call.at.toISOString() };
}
