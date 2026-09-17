/**
 * Un zip escrito a mano, para las pruebas del import por URL.
 *
 * A mano y no como fichero binario en el repositorio: un fixture de bytes no dice por qué falla
 * cuando falla, y la mitad de estas pruebas consiste en torcer un campo a propósito —el bit de
 * cifrado, un tamaño que miente— para ver qué contesta el lector.
 *
 * Los tamaños van en el directorio central, que es donde el lector los busca y donde un zip real
 * los tiene siempre. El CRC va a cero a propósito: no se comprueba, y ponerlo bien haría creer
 * que sí.
 */
import { deflateRawSync } from "node:zlib";

export type ZipFile = { name: string; text: string; deflate?: boolean; encrypted?: boolean };

export function makeZip(files: ZipFile[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.text, "utf8");
    const data = file.deflate ? deflateRawSync(raw) : raw;
    const method = file.deflate ? 8 : 0;
    const flags = file.encrypted ? 0x1 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.byteLength, 18);
    header.writeUInt32LE(raw.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    local.push(header, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.byteLength, 20);
    entry.writeUInt32LE(raw.byteLength, 24);
    entry.writeUInt16LE(name.byteLength, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.byteLength + name.byteLength + data.byteLength;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}
