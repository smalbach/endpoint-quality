/**
 * La credencial con la que se lee una URL en un import, convertida en cabecera.
 *
 * Una colección o un OpenAPI detrás de auth es el caso normal y no el raro: los contratos internos
 * viven detrás de un gateway, y sin esto «importar desde una URL» sólo servía para lo que ya era
 * público. Postman lo resuelve pidiendo la credencial en el mismo sitio donde pides la URL.
 *
 * **Esto es una credencial de un tercero y no se guarda en ningún sitio.** No hay tabla, ni
 * cifrado, ni campo en el proyecto: vive en el objeto de la petición, se pone en una cabecera y se
 * va con ella. La diferencia con la del contrato —que sí se guarda cifrada, porque un chequeo de
 * deriva programado tiene que volver a leer la misma URL solo— es que un import es un acto único:
 * nadie va a repetirlo a las tres de la mañana, así que guardar el secreto no compra nada y
 * cuesta una fila más que alguien puede leer.
 *
 * Por el mismo motivo, **el valor no sale de aquí nunca**: ni en el resumen del import, ni en el
 * `ProblemDetails` de un fallo, ni en un log. Los errores de este módulo nombran el problema y,
 * como mucho, el nombre de la cabecera; el valor no aparece en ninguna de sus frases.
 */

/**
 * Las dos formas que cubren casi todo: un bearer, o una cabecera con nombre y valor.
 *
 * Tal como llega, con los campos de la otra forma opcionales, y no como una unión cerrada: el DTO
 * de entrada no puede prometer «si `kind` es bearer entonces `token`», así que prometerlo aquí
 * sólo movería la comprobación a un `as` en el controlador. Quien decide qué falta es
 * `credentialHeaders`, y es el único que lo decide.
 */
export type ImportUrlCredential = {
  kind: "bearer" | "header";
  /** Para `bearer`. */
  token?: string;
  /** Para `header`, las dos juntas. */
  name?: string;
  value?: string;
};

/**
 * Los caracteres que RFC 7230 admite en el nombre de una cabecera.
 *
 * Comprobarlo no es formalismo: un nombre con un `\r\n` dentro es una inyección de cabeceras, y
 * `fetch` la rechaza con un `TypeError` que no dice nada útil. Mejor la frase de aquí.
 */
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * La cabecera, o un error con la frase en claro.
 *
 * Sin credencial devuelve un objeto vacío, que es lo que hace que quien llama no tenga que
 * ramificar.
 */
export function credentialHeaders(credential: ImportUrlCredential | undefined): Record<string, string> {
  if (!credential) return {};
  if (credential.kind === "bearer") {
    const token = (credential.token ?? "").trim();
    if (!token) throw new Error("el token está vacío");
    // Un token con un salto de línea dentro parte la petición en dos. No se recorta: se rechaza,
    // porque lo que llega mal es el dato y no el formato.
    if (/[\r\n]/.test(token)) throw new Error("el token trae un salto de línea");
    return { Authorization: `Bearer ${token}` };
  }
  const name = (credential.name ?? "").trim();
  if (!name) throw new Error("falta el nombre de la cabecera");
  if (!TOKEN.test(name)) throw new Error(`«${name}» no es un nombre de cabecera válido`);
  // El guardia de SSRF pone `Host` después de estas, con el nombre original de la URL: aceptarlo
  // aquí sería aceptar algo que luego se tira sin decirlo.
  if (name.toLowerCase() === "host") throw new Error("la cabecera Host la pone el guardia, no se puede fijar aquí");
  if (!credential.value) throw new Error(`falta el valor de la cabecera ${name}`);
  if (/[\r\n]/.test(credential.value)) throw new Error(`el valor de ${name} trae un salto de línea`);
  return { [name]: credential.value };
}
