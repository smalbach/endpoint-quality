/**
 * Abrir un `.zip`, que es lo que de verdad baja «Export data» de Postman.
 *
 * Se prueba contra dos zips: uno escrito aquí —para poder meterle a mano las entradas raras que
 * traen los de verdad: carpetas, `__MACOSX`, una entrada almacenada sin comprimir— y otro hecho
 * por el `zip` del sistema, que es lo único que descarta que el lector y el escritor de estas
 * pruebas estén equivocados de la misma manera.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readZip, looksZipped } from "../src/zip.ts";
import { detectImport } from "../src/index.ts";

/** Un zip mínimo pero de verdad: índice central, cabeceras locales y los dos métodos que se usan. */
function buildZip(files: { name: string; body: string; store?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.body, "utf8");
    const data = file.store ? raw : deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, data]));

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(file.store ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
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

const collection = (name: string) =>
  JSON.stringify({ info: { name }, item: [{ name: "Alta", request: { method: "POST", url: "{{baseUrl}}/x" } }] });
const environment = (name: string) => JSON.stringify({ name, values: [{ key: "baseUrl", value: "http://x" }] });

describe("reconocer que es un zip antes de leerlo entero", () => {
  test("por el sufijo y por sus dos primeros bytes", () => {
    assert.equal(looksZipped("postman-data.zip", ""), true);
    assert.equal(looksZipped("sin-sufijo", new Uint8Array([0x50, 0x4b, 0x03, 0x04])), true);
    assert.equal(looksZipped("cosa.json", new Uint8Array([0x7b])), false);
  });
});

describe("lo de dentro sale como si se hubiera soltado suelto", () => {
  test("una colección comprimida y un entorno almacenado, los dos legibles", async () => {
    const zip = buildZip([
      { name: "Tienda.postman_collection.json", body: collection("Tienda") },
      { name: "local.postman_environment.json", body: environment("local"), store: true },
    ]);
    const entries = await readZip(zip);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["Tienda.postman_collection.json", "local.postman_environment.json"],
    );
    // Y cada una entra por el detector como cualquier otro fichero: es el punto entero.
    assert.deepEqual(
      entries.map((entry) => detectImport(entry.name, entry.text).kind),
      ["postman-collection", "postman-environment"],
    );
  });

  test("las carpetas, `__MACOSX` y lo que no es texto se quedan fuera", async () => {
    const zip = buildZip([
      { name: "volcado/", body: "", store: true },
      { name: "__MACOSX/._Tienda.json", body: "basura", store: true },
      { name: "volcado/.DS_Store", body: "basura", store: true },
      { name: "volcado/logo.png", body: "no es texto", store: true },
      { name: "volcado/Tienda.postman_collection.json", body: collection("Tienda") },
    ]);
    assert.deepEqual(
      (await readZip(zip)).map((entry) => entry.name),
      ["Tienda.postman_collection.json"],
    );
  });

  test("una entrada con `..` en el nombre se enseña por su última parte", async () => {
    const zip = buildZip([{ name: "../../../etc/passwd.json", body: collection("X") }]);
    assert.deepEqual(
      (await readZip(zip)).map((entry) => entry.name),
      ["passwd.json"],
    );
  });

  test("lo que no es un zip se dice, no se adivina", async () => {
    await assert.rejects(() => readZip(new Uint8Array([0x7b, 0x7d])), /no parece un \.zip/);
  });
});

describe("y contra un zip que no ha escrito esta prueba", () => {
  // Lo único que descarta que el lector y el escritor de arriba estén mal de la misma manera.
  const zipAvailable = (() => {
    try {
      execFileSync("zip", ["-v"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test("un zip del `zip` del sistema se lee igual", { skip: zipAvailable ? false : "sin `zip`" }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "eq-zip-"));
    try {
      writeFileSync(join(directory, "Tienda.postman_collection.json"), collection("Tienda"));
      writeFileSync(join(directory, "local.postman_environment.json"), environment("local"));
      execFileSync("zip", ["-q", "volcado.zip", "Tienda.postman_collection.json", "local.postman_environment.json"], {
        cwd: directory,
      });
      const entries = await readZip(new Uint8Array(readFileSync(join(directory, "volcado.zip"))));
      assert.deepEqual(entries.map((entry) => detectImport(entry.name, entry.text).kind).sort(), [
        "postman-collection",
        "postman-environment",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
