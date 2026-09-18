/**
 * Un `.zip`, abierto para que lo de dentro se importe como si lo hubieras soltado suelto.
 *
 * **Es el caso normal, no un extra.** «Export data» de Postman no baja un JSON: baja un `.zip` con
 * todas las colecciones y todos los entornos dentro. Mandar a alguien a descomprimirlo a mano era
 * mandarle a hacer el trabajo que el formato existe para evitar.
 *
 * Sin dependencia nueva, y no por ahorrar: el detector es una función pura que corre en los dos
 * lados de la red, y meterle un paquete de terceros lo convierte en un paquete de terceros dentro
 * del bundle del navegador *y* dentro del proceso que lee ficheros que sube un desconocido. Lo que
 * hace falta ya está en la plataforma — `DecompressionStream("deflate-raw")`, en el navegador y en
 * Node— y el resto del formato son cuatro cabeceras con desplazamientos.
 *
 * Se lee por el **directorio central** y no recorriendo cabeceras locales de principio a fin, que
 * es lo que dice la especificación y además lo único correcto: una cabecera local puede declarar
 * tamaño cero y remitir a un descriptor que va *después* de los datos, así que recorrerlas de
 * frente no dice dónde acaba cada entrada.
 *
 * Lo que **no** se saca de un zip, y es a propósito:
 *
 * - Nada que no sea texto plano. Un zip es contenido que ha elegido otra persona, y el import solo
 *   sabe leer texto; una imagen o un binario dentro solo puede ser ruido o algo peor.
 * - Nada fuera de su propio árbol. Una entrada llamada `../../etc/algo` no se escribe en ningún
 *   sitio aquí —nada de esto toca el disco— pero sí se enseñaría por su nombre, así que se
 *   normaliza a su última parte.
 * - Nada por encima de los topes. Un zip de 2 KB puede declarar 10 GB descomprimidos, y el tope es
 *   lo que separa «este fichero no vale» de que se caiga el proceso que lo está leyendo.
 *
 * **Zip64 se lee**, y no por los ficheros de más de 4 GB —esos no pasan los topes de todos modos—:
 * hay escritores que lo usan siempre (el `zip` de Info-ZIP cuando comprime lo que le llega por una
 * tubería, las librerías que escriben en streaming y no saben de antemano cuánto va a ocupar), y un
 * volcado así, con dos colecciones de 10 KB dentro, salía como «no parece un .zip». Los campos de
 * 64 bits se leen donde el formato los pone y **pasan por los mismos topes**: un tamaño declarado de
 * 5 GB en el extra de Zip64 es el mismo número mentiroso que uno de 32 bits, solo que más grande.
 */

/** Un fichero sacado del zip, indistinguible de uno soltado a mano. */
export type ZipEntry = { name: string; text: string };

/** Cuántas entradas y cuánto texto se aceptan. Un volcado de Postman de verdad cabe de sobra. */
const MAX_ENTRIES = 200;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Lo que el import sabe leer. Cualquier otra cosa dentro del zip es ruido. */
const TEXTUAL = /\.(json|ya?ml|txt|md|markdown|har|curl)$/i;

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
/** El identificador del campo extra de Zip64, y el valor que en un campo de 32 bits dice «míralo ahí». */
const ZIP64_EXTRA = 0x0001;
const U32_MAX = 0xffffffff;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP_MAGIC = `PK${String.fromCharCode(3)}${String.fromCharCode(4)}`;

/**
 * Los cuatro bytes con los que empieza cualquier zip, y el sufijo: para decidirlo sin leerlo entero.
 *
 * Los bytes se arman con `fromCharCode` en vez de escribirse dentro de la cadena. Un `\u0003`
 * literal acaba siendo un byte de control **invisible** en el fuente, que es una forma tonta de
 * que alguien lo borre sin verlo y la comprobación se quede en «cualquier texto que empiece por PK».
 */
export function looksZipped(filename: string, head: Uint8Array | string): boolean {
  if (/\.zip$/i.test(filename.trim())) return true;
  if (typeof head === "string") return head.startsWith(ZIP_MAGIC);
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * Los ficheros de texto de un zip, en el orden en que los guardó.
 *
 * Lanza cuando el fichero no es un zip legible. No lanza por una entrada que no se puede
 * descomprimir: esa se salta, porque un zip con nueve colecciones y un binario roto tiene que
 * traer las nueve.
 */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = endOfCentralDirectory(bytes, view);

  const entries: ZipEntry[] = [];
  let offset = directory.offset;
  let total = 0;
  for (let index = 0; index < directory.count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL) {
      throw new Error("el .zip tiene el índice corrupto");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = utf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const { compressed, uncompressed, localOffset } = entrySizes(
      view,
      offset,
      bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;
    // Una entrada cifrada se salta. Sin mirar este bit, su contenido sale como «texto»: bytes de
    // criptografía decodificados a UTF-8, que el detector no reconoce y que nadie sabe de dónde
    // vienen. Se salta y no se lanza, por lo mismo que el resto de este bucle: un volcado con
    // nueve colecciones buenas y una entrada con contraseña tiene que traer las nueve.
    if ((flags & 0x1) !== 0) continue;
    if (uncompressed > MAX_ENTRY_BYTES || total + uncompressed > MAX_TOTAL_BYTES) continue;
    if (entries.length >= MAX_ENTRIES) break;

    // El tamaño y el nombre se leen del índice; de la cabecera local solo hace falta saber cuánto
    // ocupa para saltarla, porque sus propios tamaños pueden ser cero.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL) continue;
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const payload = bytes.subarray(start, start + compressed);
    if (payload.length < compressed) continue;

    let text: string;
    try {
      text = method === 0 ? utf8(payload) : utf8(await inflate(payload));
    } catch {
      continue;
    }
    total += text.length;
    entries.push({ name: basename(name), text });
  }
  return entries;
}

/**
 * Los tamaños y el desplazamiento de una entrada del índice, con los de Zip64 si los trae.
 *
 * Un campo de 32 bits a `0xFFFFFFFF` quiere decir «el de verdad está en el extra de Zip64», y ahí
 * van **solo los que están así marcados**, en este orden fijo: sin comprimir, comprimido,
 * desplazamiento. Leerlos todos siempre descuadraría el tercero cuando solo el primero desborda.
 */
function entrySizes(
  view: DataView,
  offset: number,
  extra: Uint8Array,
): { compressed: number; uncompressed: number; localOffset: number } {
  let uncompressed = view.getUint32(offset + 24, true);
  let compressed = view.getUint32(offset + 20, true);
  let localOffset = view.getUint32(offset + 42, true);
  if (uncompressed !== U32_MAX && compressed !== U32_MAX && localOffset !== U32_MAX) {
    return { compressed, uncompressed, localOffset };
  }

  const field = zip64Field(extra);
  let cursor = 0;
  const next = (): number => {
    // Un campo marcado sin su valor en el extra no se inventa: se deja en el máximo, que ningún
    // tope deja pasar y ningún desplazamiento alcanza, así que la entrada se salta sola.
    if (!field || cursor + 8 > field.byteLength) return Number.MAX_SAFE_INTEGER;
    const value = u64(field, cursor);
    cursor += 8;
    return value;
  };
  if (uncompressed === U32_MAX) uncompressed = next();
  if (compressed === U32_MAX) compressed = next();
  if (localOffset === U32_MAX) localOffset = next();
  return { compressed, uncompressed, localOffset };
}

/** El contenido del campo extra de Zip64, entre los demás que pueda traer la entrada. */
function zip64Field(extra: Uint8Array): DataView | null {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let at = 0; at + 4 <= extra.length;) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    if (at + 4 + size > extra.length) return null;
    if (id === ZIP64_EXTRA) return new DataView(extra.buffer, extra.byteOffset + at + 4, size);
    at += 4 + size;
  }
  return null;
}

/**
 * Un entero de 64 bits, como número de JavaScript.
 *
 * Por encima de `MAX_SAFE_INTEGER` se queda en `MAX_SAFE_INTEGER`, y no es perder precisión sin
 * decirlo: cualquier número de ese tamaño ya está muy por encima de los topes y de lo que ocupa el
 * fichero, que es lo único para lo que se usa.
 */
function u64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

/**
 * El final del directorio central, buscado desde atrás.
 *
 * Desde atrás porque ahí está: el bloque es lo último del fichero salvo un comentario opcional de
 * hasta 64 KB, así que se busca su firma en esa cola en vez de recorrer el zip entero.
 *
 * Si justo delante está el localizador de Zip64, el número de entradas y el desplazamiento se leen
 * del registro de Zip64 y no de este: aquí son de 16 y 32 bits, y un zip con más de 65 535 entradas
 * o un índice más allá de los 4 GB los trae a `0xFFFF` y `0xFFFFFFFF`. Se prefiere siempre que
 * esté, aunque los de 32 bits no estén marcados, porque es el que el escritor dice que vale.
 */
function endOfCentralDirectory(bytes: Uint8Array, view: DataView): { offset: number; count: number } {
  const floor = Math.max(0, bytes.length - 0xffff - 22);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) !== EOCD) continue;
    const zip64 = zip64EndOfCentralDirectory(bytes, view, at);
    if (zip64) return zip64;
    const count = view.getUint16(at + 10, true);
    const offset = view.getUint32(at + 16, true);
    if (offset >= bytes.length) break;
    return { offset, count };
  }
  throw new Error("no parece un .zip: le falta el índice del final");
}

/** El registro de Zip64, si el localizador está justo antes del final de 32 bits. */
function zip64EndOfCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
  eocd: number,
): { offset: number; count: number } | null {
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) return null;
  const record = u64(view, locator + 8);
  if (record + 56 > locator || view.getUint32(record, true) !== ZIP64_EOCD) {
    throw new Error("el .zip tiene el índice corrupto");
  }
  const count = u64(view, record + 32);
  const offset = u64(view, record + 48);
  if (offset >= bytes.length) throw new Error("el .zip tiene el índice corrupto");
  return { offset, count };
}

/** Lo que se saca y lo que se deja. Las carpetas no son ficheros y `__MACOSX` es ruido de macOS. */
function wanted(name: string): boolean {
  if (name.endsWith("/")) return false;
  if (name.startsWith("__MACOSX/") || name.includes("/__MACOSX/")) return false;
  if (basename(name).startsWith(".")) return false;
  return TEXTUAL.test(name);
}

/** La última parte del nombre: una entrada puede llamarse `../algo`, y aquí solo se enseña. */
function basename(name: string): string {
  return name.split(/[\\/]/).filter(Boolean).pop() ?? name;
}

async function inflate(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([payload as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
