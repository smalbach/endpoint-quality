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
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = utf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted(name)) continue;
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
 * El final del directorio central, buscado desde atrás.
 *
 * Desde atrás porque ahí está: el bloque es lo último del fichero salvo un comentario opcional de
 * hasta 64 KB, así que se busca su firma en esa cola en vez de recorrer el zip entero.
 */
function endOfCentralDirectory(bytes: Uint8Array, view: DataView): { offset: number; count: number } {
  const floor = Math.max(0, bytes.length - 0xffff - 22);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (view.getUint32(at, true) !== EOCD) continue;
    const count = view.getUint16(at + 10, true);
    const offset = view.getUint32(at + 16, true);
    if (offset >= bytes.length) break;
    return { offset, count };
  }
  throw new Error("no parece un .zip: le falta el índice del final");
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
