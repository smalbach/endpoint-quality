/** Zips escritos a mano para las pruebas: los de verdad no traen las entradas raras que hay que probar. */
import { deflateRawSync } from "node:zlib";

/** Un zip mínimo pero de verdad: índice central, cabeceras locales y los dos métodos que se usan. */
export function buildZip(
  files: { name: string; body: string; store?: boolean; declared?: number; encrypted?: boolean }[],
): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.body, "utf8");
    const data = file.store ? raw : deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.encrypted ? 0x1 : 0, 6);
    local.writeUInt16LE(file.store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.declared ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, data]));

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(file.encrypted ? 0x1 : 0, 8);
    entry.writeUInt16LE(file.store ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(file.declared ?? raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/**
 * Un zip en Zip64: cada entrada con sus tres campos de 32 bits a `0xFFFFFFFF` y los de verdad en el
 * extra `0x0001`, y el final de 32 bits apuntando al registro de Zip64 a través del localizador.
 *
 * Todo marcado, que es el caso más exigente para el orden del extra. `declared` pone en el extra un
 * tamaño sin comprimir de 64 bits, que es donde una bomba zip de este formato miente.
 */
export function buildZip64(files: { name: string; body: string; declared?: bigint }[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.body, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    const localExtra = Buffer.alloc(20);
    localExtra.writeUInt16LE(0x0001, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(file.declared ?? BigInt(raw.length), 4);
    localExtra.writeBigUInt64LE(BigInt(data.length), 12);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(Buffer.concat([local, name, localExtra, data]));

    // Un campo extra ajeno delante del de Zip64, como los de fecha que pone el `zip` del sistema:
    // el lector tiene que buscar el suyo, no suponer que es el primero.
    const other = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]);
    const zip64 = Buffer.alloc(28);
    zip64.writeUInt16LE(0x0001, 0);
    zip64.writeUInt16LE(24, 2);
    zip64.writeBigUInt64LE(file.declared ?? BigInt(raw.length), 4);
    zip64.writeBigUInt64LE(BigInt(data.length), 12);
    zip64.writeBigUInt64LE(BigInt(offset), 20);
    const extra = Buffer.concat([other, zip64]);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(45, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(0xffffffff, 20);
    entry.writeUInt32LE(0xffffffff, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt32LE(0xffffffff, 42);
    central.push(Buffer.concat([entry, name, extra]));
    offset += local.length + name.length + localExtra.length + data.length;
  }
  const directory = Buffer.concat(central);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(files.length), 24);
  record.writeBigUInt64LE(BigInt(files.length), 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(files.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(files.length, 0xffff), 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, record, locator, end]));
}
