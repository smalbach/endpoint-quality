/**
 * Los valores computados, que son la respuesta declarativa a `preRequestScript`.
 *
 * El analizador ejecutaba JavaScript de quien fuera sobre `node:vm` antes de cada petición. `vm` no
 * es una frontera de seguridad y este runner corre en el servidor con los secretos de cada proyecto
 * en memoria, así que esa puerta se queda cerrada. Lo que la gente escribía de verdad en esos
 * scripts es una lista corta —un id nuevo, la hora, un número al azar, un base64, una firma— y las
 * cinco cosas son valores y no programas.
 *
 * Lo impuro entra como dato, que es lo que deja al motor sin reloj, sin azar y sin criptografía: una
 * semilla por caso. Eso hace que estas pruebas no necesiten ninguna de las tres.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { interpolateText, interpolateValue, unresolvedVariables, type ComputedSeed } from "../src/variables.ts";

const seed: ComputedSeed = {
  uuid: "8f14e45f-ceea-467a-9a3a-1b0a7c0e0001",
  now: new Date("2026-09-11T10:00:00.000Z"),
  random: 0.5,
  // Reconocible en vez de real: lo que hay que comprobar aquí es que el motor le pasa la clave y
  // el texto correctos y coloca lo que devuelve, no que node sabe hacer HMAC.
  hmacSha256: (key, text) => `hmac(${key},${text})`,
};

describe("los valores computados", () => {
  test("un identificador nuevo", () => {
    assert.equal(interpolateText("{{$uuid}}", {}, seed), seed.uuid);
  });

  test("el mismo dentro de un caso, que es lo que hace que un flujo funcione", () => {
    // Una cabecera de idempotencia y el cuerpo quieren decir el mismo valor, y el paso que relee
    // quiere decirlo otra vez. Uno nuevo por aparición rompería justo los flujos para los que esto
    // existe.
    assert.equal(interpolateText("{{$uuid}}/{{$uuid}}", {}, seed), `${seed.uuid}/${seed.uuid}`);
  });

  test("la hora, en ISO y en segundos desde época", () => {
    assert.equal(interpolateText("{{$now}}", {}, seed), "2026-09-11T10:00:00.000Z");
    // Una petición firmada o un payload con forma de JWT quiere segundos, y nada más de esta lista
    // sabe convertir la cadena ISO.
    assert.equal(interpolateText("{{$now:unix}}", {}, seed), "1789120800");
  });

  test("un número al azar, en el rango que se pidió y con los dos extremos dentro", () => {
    assert.equal(interpolateText("{{$randomInt:1:100}}", {}, seed), "51");
    assert.equal(interpolateText("{{$randomInt:0:0}}", {}, seed), "0");
  });

  test("un rango al revés se lee en el orden que se escribió en vez de no dar nada", () => {
    assert.equal(interpolateText("{{$randomInt:100:1}}", {}, seed), "51");
  });

  test("base64 sobre bytes UTF-8, no sobre unidades de código", () => {
    // `btoa` lanza con cualquier cosa por encima de U+00FF, y un payload con una tilde es el caso
    // corriente aquí.
    assert.equal(interpolateText("{{$base64:año}}", {}, seed), "YcOxbw==");
  });

  test("una firma recibe la clave y el texto partidos por el primer dos puntos", () => {
    // El texto lleva dos puntos muy a menudo —una URL, una marca de tiempo— y la clave no.
    assert.equal(interpolateText("{{$hmacSha256:clave:GET:/pedidos}}", {}, seed), "hmac(clave,GET:/pedidos)");
  });

  test("una firma sin texto se queda como estaba: no hay nada que firmar", () => {
    assert.equal(interpolateText("{{$hmacSha256:clave}}", {}, seed), "{{$hmacSha256:clave}}");
  });

  test("un nombre que no se conoce se queda en pie en vez de adivinarse", () => {
    assert.equal(interpolateText("{{$uuidd}}", {}, seed), "{{$uuidd}}");
  });

  test("sin semilla no se toca nada, que es lo que ven las pruebas puras del generador", () => {
    assert.equal(interpolateText("{{$uuid}}", {}), "{{$uuid}}");
  });
});

describe("una variable dentro de un valor computado", () => {
  test("el argumento puede ser una variable del entorno", () => {
    // Las llaves de dentro terminarían la coincidencia de fuera, así que como token único no se
    // podría leer. Lo que lo hace funcionar es el orden: primero las nombradas, después las
    // computadas, y para cuando le toca al segundo paso ya no hay llaves anidadas.
    assert.equal(
      interpolateText("{{$hmacSha256:{{secreto}}:texto}}", { secreto: "mi-clave" }, seed),
      "hmac(mi-clave,texto)",
    );
  });

  test("y el texto también", () => {
    assert.equal(interpolateText("{{$base64:{{usuario}}}}", { usuario: "ana" }, seed), "YW5h");
  });

  test("una variable que no existe deja el computado sin resolver, no a medias", () => {
    // Lo importante es que no se manda: `unresolvedVariables` lo ve, y la petición se detiene.
    const built = interpolateText("{{$hmacSha256:{{secreto}}:texto}}", {}, seed);
    assert.match(built, /secreto/);
    assert.ok(unresolvedVariables(built).includes("secreto"));
  });
});

describe("lo que queda sin resolver", () => {
  test("un computado mal escrito se denuncia como una variable que falta", () => {
    // Dejarlo viajar al destino como literal devolvería un 400 sobre un valor que el informe
    // enseña como si se hubiera mandado a propósito.
    assert.deepEqual(unresolvedVariables("{{$uuidd}}"), ["$uuidd"]);
  });

  test("uno resuelto no queda nada que denunciar", () => {
    assert.deepEqual(unresolvedVariables(interpolateText("{{$uuid}}", {}, seed)), []);
  });
});

describe("la sustitución recorre la petición entera", () => {
  test("el cuerpo, las cabeceras y la ruta a la vez", () => {
    const built = interpolateValue(
      {
        requestPath: "/pedidos/{{$uuid}}",
        headers: { "Idempotency-Key": "{{$uuid}}" },
        body: { creado: "{{$now}}", firma: "{{$hmacSha256:k:t}}" },
      },
      {},
      seed,
    );
    assert.equal(built.requestPath, `/pedidos/${seed.uuid}`);
    assert.equal(built.headers["Idempotency-Key"], seed.uuid);
    assert.deepEqual(built.body, { creado: "2026-09-11T10:00:00.000Z", firma: "hmac(k,t)" });
  });
});
