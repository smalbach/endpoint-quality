/**
 * Los fragmentos de código, y sobre todo las comillas.
 *
 * Lo que se comprueba aquí no es que salga texto: es que el texto **manda la misma petición**. Un
 * generador de fragmentos falla de dos maneras, y la segunda es la mala:
 *
 * 1. El código no compila. Molesta, se ve en dos segundos, se arregla.
 * 2. El código compila y manda otra cosa. Un `$` sin escapar en una cadena de PHP se convierte en
 *    una variable vacía; un `#{` en Ruby ejecuta lo que haya dentro. El fragmento corre, contesta
 *    200, y prueba algo distinto de lo que se probó aquí. Eso no se ve nunca.
 *
 * Por eso el cuerpo de estas pruebas está lleno de `$`, `#{`, comillas de los dos tipos, barras y
 * un salto de línea: es el cuerpo que destapa la segunda clase de fallo.
 *
 * Once de los dieciséis se comprobaron además con el parser o el compilador de su lenguaje, y cinco
 * de ellos —curl, requests, PHP, Ruby, fetch— mandando la petición de verdad contra un servidor que
 * devolvía los bytes recibidos, para comparar byte a byte. Go, C#, Kotlin, Dart y PowerShell no:
 * no había toolchain. Eso está en el registro de fases, no escondido.
 */
import { describe, expect, test } from "vitest";

import {
  DEFAULT_SNIPPET,
  SNIPPET_LANGUAGES,
  authPlan,
  base64Utf8,
  dartQuote,
  dq,
  fullUrl,
  kotlinQuote,
  phpQuote,
  psQuote,
  renderSnippet,
  rubyQuote,
  rustQuote,
  snippetNotes,
  type SnippetRequest,
} from "@/lib/snippets";

const request = (patch: Partial<SnippetRequest> = {}): SnippetRequest => ({
  method: "POST",
  url: "https://api.ejemplo.com/v1/pedidos?dry=1",
  headers: [{ name: "X-Trace", value: "abc" }],
  body: { kind: "text", text: '{"a":1}', contentType: "application/json", json: true },
  auth: { type: "none", params: {} },
  ...patch,
});

/** El cuerpo que rompe a los generadores descuidados. */
const NASTY = `{"quote":"it's \\"x\\"","dollar":"$id \${y}","ruby":"#{evil}"}\n{"line":2}`;

const render = (id: string, patch: Partial<SnippetRequest> = {}) => renderSnippet(id, request(patch));

describe("las comillas de cada lenguaje", () => {
  test("la barra se escapa antes que nada, o se escapan las escapadas", () => {
    // Si `"` se escapara primero, el `\` que se añade se volvería a escapar después.
    expect(dq('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  test("un salto de línea no se cuela crudo dentro de una cadena", () => {
    // Un salto literal dentro de comillas no compila en ninguno de los dieciséis salvo PowerShell.
    expect(dq("a\nb")).toBe('"a\\nb"');
    expect(dq("a\tb")).toBe('"a\\tb"');
  });

  test("PHP escapa el dólar: sin eso, «$id» es una variable vacía y el cuerpo cambia", () => {
    expect(phpQuote("$id")).toBe('"\\$id"');
    expect(phpQuote("${y}")).toBe('"\\${y}"');
  });

  test("Ruby escapa la almohadilla: «#{evil}» se ejecutaría", () => {
    expect(rubyQuote("#{evil}")).toBe('"\\#{evil}"');
  });

  test("Kotlin y Dart escapan el dólar, cada uno con su comilla", () => {
    expect(kotlinQuote("$id")).toBe('"\\$id"');
    expect(dartQuote("$id")).toBe("'\\$id'");
    expect(dartQuote("it's")).toBe("'it\\'s'");
  });

  test("Rust escribe los controles «\\u{7f}»: la forma de cuatro dígitos no compila", () => {
    expect(rustQuote("ab")).toBe('"a\\u{7f}b"');
    expect(dq("ab")).toBe('"a\\u007fb"');
  });

  test("PowerShell dobla la comilla en vez de escaparla", () => {
    expect(psQuote("it's")).toBe("'it''s'");
    // Y no toca el dólar, porque dentro de comilla simple no interpola.
    expect(psQuote("$id")).toBe("'$id'");
  });

  test("base64 de UTF-8, que es donde btoa se rompe", () => {
    // `btoa("ñ")` lanza: no es latin-1. Una contraseña con acento es justo la que nadie prueba.
    expect(base64Utf8("añ")).toBe("YcOx");
  });
});

describe("los dieciséis", () => {
  test("cada uno tiene un id propio, o el selector enseña dos entradas que son la misma", () => {
    const ids = SNIPPET_LANGUAGES.map((language) => language.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_SNIPPET);
  });

  test("todos escriben el método, la ruta y el método en mayúsculas", () => {
    for (const language of SNIPPET_LANGUAGES) {
      const code = language.render(request());
      expect(code.length, language.id).toBeGreaterThan(20);
      // La ruta y no la URL entera: el crudo lleva el host en su propia línea `Host:`, que es lo
      // que dice el protocolo, y buscar la URL completa daría un falso negativo en el único
      // generador que la escribe bien.
      expect(code, language.id).toContain("/v1/pedidos?dry=1");
      expect(code.toUpperCase(), language.id).toContain("POST");
    }
  });

  test("todos llevan la cabecera que se escribió", () => {
    for (const language of SNIPPET_LANGUAGES) {
      expect(language.render(request()), language.id).toContain("X-Trace");
    }
  });

  test("todos nombran el Content-Type, salvo los que lo ponen por defecto", () => {
    for (const language of SNIPPET_LANGUAGES) {
      const code = language.render(request());
      // HTTPie manda `application/json` de serie cuando hay cuerpo: escribirlo sería ruido, y un
      // fragmento con ruido es un fragmento que se nota generado.
      if (language.id === "httpie") {
        expect(code, language.id).not.toContain("Content-Type");
        continue;
      }
      expect(code, language.id).toContain("application/json");
    }
  });

  test("HTTPie sí nombra el tipo cuando no es el que pone por defecto", () => {
    const code = render("httpie", { body: { kind: "text", text: "<x/>", contentType: "text/xml", json: false } });
    expect(code).toContain("Content-Type:text/xml");
  });

  test("el salto de línea del cuerpo nunca va crudo dentro de una cadena", () => {
    // Esta es la invariante que no depende del lenguaje: un salto literal dentro de un literal de
    // cadena no compila en ninguno de los doce que meten el cuerpo en uno. Las comillas sí dependen
    // —`"` se escapa donde la cadena va entre `"`, y no en Dart, que usa `'`— así que se comprueban
    // aparte y no en un barrido que tendría que llevar una excepción por lenguaje.
    const literal = new Set(["curl", "httpie", "http", "powershell"]);
    for (const language of SNIPPET_LANGUAGES) {
      const code = language.render(
        request({ body: { kind: "text", text: NASTY, contentType: "application/json", json: true } }),
      );
      if (literal.has(language.id)) {
        // Comilla simple del shell, o el cuerpo tal cual va por el cable: no hay nada que escapar.
        expect(code, language.id).toContain('{"line":2}');
        continue;
      }
      expect(code, language.id).toContain("}\\n{");
    }
  });

  test("la comilla doble se escapa en los once que citan con comilla doble, y no en Dart", () => {
    const body = { kind: "text" as const, text: '{"a":1}', contentType: "application/json", json: true };
    for (const id of ["fetch", "axios", "python", "go", "java", "csharp", "php", "ruby", "rust", "swift", "kotlin"]) {
      expect(render(id, { body }), id).toContain('{\\"a\\":1}');
    }
    expect(render("dart", { body })).toContain("'{\"a\":1}'");
  });
});

describe("el curl, que es el que ya estaba", () => {
  test("sale igual que antes: si este refactor lo hubiera cambiado, se ve aquí", () => {
    expect(render("curl")).toBe(
      [
        "curl -X POST 'https://api.ejemplo.com/v1/pedidos?dry=1'",
        "  -H 'X-Trace: abc'",
        "  -H 'Content-Type: application/json'",
        `  --data '{"a":1}'`,
      ].join(" \\\n"),
    );
  });

  test("un GET no lleva -X, que es lo que curl hace de todas formas", () => {
    expect(render("curl", { method: "GET", body: { kind: "none" } })).toMatch(/^curl '/);
  });
});

describe("la autenticación", () => {
  test("una cabecera Authorization escrita a mano gana: dos darían un 401 sin explicación", () => {
    const plan = authPlan({ type: "bearer", params: { token: "t" } }, [{ name: "Authorization", value: "Bearer mio" }]);
    expect(plan.headers).toEqual([]);
    expect(plan.basic).toBeNull();
  });

  test("Basic sale con lo que cada cliente trae de fábrica, no como cabecera a mano", () => {
    const basic = { auth: { type: "basic" as const, params: { username: "ana", password: "s3cr3t0" } } };
    expect(render("curl", basic)).toContain("-u 'ana:s3cr3t0'");
    expect(render("python", basic)).toContain('auth=("ana", "s3cr3t0")');
    expect(render("go", basic)).toContain('req.SetBasicAuth("ana", "s3cr3t0")');
    expect(render("rust", basic)).toContain('.basic_auth("ana", Some("s3cr3t0"))');
    expect(render("ruby", basic)).toContain('request.basic_auth("ana", "s3cr3t0")');
    expect(render("axios", basic)).toContain('auth: { username: "ana", password: "s3cr3t0" }');
    expect(render("kotlin", basic)).toContain('Credentials.basic("ana", "s3cr3t0")');
    expect(render("php", basic)).toContain("CURLAUTH_BASIC");
  });

  test("Digest solo lo negocian curl y requests; el resto se lleva el aviso, no una cabecera falsa", () => {
    const digest = { auth: { type: "digest" as const, params: { username: "ana", password: "p" } } };
    expect(render("curl", digest)).toContain("--digest -u 'ana:p'");
    expect(render("python", digest)).toContain('HTTPDigestAuth("ana", "p")');
    expect(render("go", digest)).toContain("Digest: solo curl y requests");
    // Y no se inventa una cabecera Digest que el servidor rechazaría.
    expect(render("go", digest)).not.toMatch(/Header\.Set\("Authorization", "Digest/);
  });

  test("una clave en la URL va a la URL de los dieciséis, no a una cabecera", () => {
    const patch = { auth: { type: "apikey" as const, params: { key: "api_key", value: "k1", in: "query" } } };
    for (const language of SNIPPET_LANGUAGES) {
      const code = language.render(request(patch));
      expect(code, language.id).toContain("api_key=k1");
    }
    expect(render("curl", patch)).toContain("--url-query 'api_key=k1'");
  });

  test("fullUrl respeta la interrogación que ya había", () => {
    const plan = authPlan({ type: "apikey", params: { key: "k", value: "1", in: "query" } }, []);
    expect(fullUrl(request(), plan)).toBe("https://api.ejemplo.com/v1/pedidos?dry=1&k=1");
    expect(fullUrl(request({ url: "https://x.com/y" }), plan)).toBe("https://x.com/y?k=1");
  });

  test("una firma no se escribe a medias: se dice que falta", () => {
    for (const type of ["awsv4", "hawk", "oauth1", "edgegrid", "ntlm"] as const) {
      const plan = authPlan({ type, params: {} }, []);
      expect(plan.headers, type).toEqual([]);
      expect(plan.note, type).toContain("la firma se calcula sobre la petición");
    }
    // Y llega al fragmento como comentario del lenguaje, no como cabecera rota.
    expect(render("python", { auth: { type: "awsv4", params: {} } })).toContain("# awsv4: la firma");
    expect(render("fetch", { auth: { type: "awsv4", params: {} } })).toContain("// awsv4: la firma");
  });

  test("un OAuth 2.0 sin token lo dice en vez de mandar «Bearer »", () => {
    const plan = authPlan({ type: "oauth2", params: {} }, []);
    expect(plan.note).toBe("falta el token de OAuth 2.0");
    expect(plan.headers).toEqual([]);
  });
});

describe("lo que el fragmento no puede llevar", () => {
  test("una variable secreta se nombra: el fragmento no corre tal cual y hay que saberlo", () => {
    const notes = snippetNotes(
      request({
        headers: [{ name: "X-Key", value: "{{apiKey}}" }],
        body: { kind: "text", text: '{"t":"{{token}}"}', contentType: "application/json", json: true },
      }),
      authPlan({ type: "none", params: {} }, []),
    );
    expect(notes.some((note) => note.includes("apiKey") && note.includes("token"))).toBe(true);
  });

  test("un cuerpo binario dice de qué fichero sale", () => {
    const notes = snippetNotes(
      request({ body: { kind: "binary", filename: "informe.pdf" } }),
      authPlan({ type: "none", params: {} }, []),
    );
    expect(notes.some((note) => note.includes("informe.pdf"))).toBe(true);
  });

  test("un campo de fichero sale con el nombre, nunca con el contenido", () => {
    const patch = {
      body: {
        kind: "multipart" as const,
        fields: [
          { name: "nota", value: "hola", file: false },
          { name: "adjunto", value: "informe.pdf", file: true },
        ],
      },
    };
    expect(render("curl", patch)).toContain("-F 'adjunto=@informe.pdf'");
    expect(render("python", patch)).toContain('"adjunto": open("informe.pdf", "rb")');
    expect(render("php", patch)).toContain('new CURLFile("informe.pdf")');
  });
});

describe("Go, que no compila con un import de sobra", () => {
  test("sin cuerpo no importa strings", () => {
    const code = render("go", { method: "GET", body: { kind: "none" } });
    expect(code).not.toContain('"strings"');
    expect(code).toContain('http.NewRequest("GET", "https://api.ejemplo.com/v1/pedidos?dry=1", nil)');
  });

  test("con cuerpo de texto sí, y sin os ni multipart", () => {
    const code = render("go");
    expect(code).toContain('"strings"');
    expect(code).not.toContain('"os"');
    expect(code).not.toContain('"mime/multipart"');
  });

  test("con multipart entran bytes, os y mime/multipart, y el Content-Type lo pone el writer", () => {
    const code = render("go", {
      body: { kind: "multipart", fields: [{ name: "a", value: "f.pdf", file: true }] },
    });
    expect(code).toContain('"bytes"');
    expect(code).toContain('"mime/multipart"');
    expect(code).toContain('"os"');
    // El boundary lo genera el writer: escribirlo a mano rompe el cuerpo.
    expect(code).toContain("writer.FormDataContentType()");
  });
});

describe("C#, y la cabecera que lanza en tiempo de ejecución", () => {
  test("el Content-Type va en el contenido, nunca en Headers.Add", () => {
    const code = render("csharp");
    // `request.Headers.Add("Content-Type", …)` lanza: es una cabecera de contenido.
    expect(code).not.toMatch(/Headers\.Add\("Content-Type"/i);
    expect(code).toContain('new StringContent("{\\"a\\":1}", Encoding.UTF8, "application/json")');
    expect(code).toContain('request.Headers.Add("X-Trace", "abc")');
  });

  test("System.IO entra solo cuando hay un fichero", () => {
    expect(render("csharp")).not.toContain("using System.IO;");
    expect(render("csharp", { body: { kind: "binary", filename: "f.bin" } })).toContain("using System.IO;");
  });
});

describe("el HTTP crudo, que es el que se manda por un socket", () => {
  test("parte el Host de la ruta y cuenta el Content-Length en bytes, no en caracteres", () => {
    const code = render("http", {
      body: { kind: "text", text: '{"a":"ñ"}', contentType: "application/json", json: true },
    });
    expect(code.split("\n")[0]).toBe("POST /v1/pedidos?dry=1 HTTP/1.1");
    expect(code).toContain("Host: api.ejemplo.com");
    // 9 caracteres, 10 bytes: la «ñ» son dos. Declarar 9 corta el cuerpo.
    expect(code).toContain("Content-Length: 10");
  });

  test("el Basic se calcula, porque una cabecera que lo describe no se puede mandar", () => {
    const code = render("http", { auth: { type: "basic", params: { username: "ana", password: "abc" } } });
    expect(code).toContain(`Authorization: Basic ${base64Utf8("ana:abc")}`);
  });

  test("con una variable sin sustituir no hay nada que calcular, y lo dice", () => {
    const code = render("http", { auth: { type: "basic", params: { username: "ana", password: "{{clave}}" } } });
    expect(code).toContain("Authorization: Basic <base64 de ana:{{clave}}>");
  });

  test("el aviso no entra en el texto: una línea con # no es una cabecera y rompe la petición", () => {
    const code = render("http", { auth: { type: "awsv4", params: {} } });
    expect(code).not.toContain("#");
    // Y sigue estando donde se lee: en la lista de avisos que la pantalla pone encima.
    expect(
      snippetNotes(request({ auth: { type: "awsv4", params: {} } }), authPlan({ type: "awsv4", params: {} }, [])),
    ).toEqual([expect.stringContaining("la firma se calcula")]);
  });

  test("una URL sin resolver se escribe entera en vez de inventar un Host", () => {
    const code = render("http", { url: "{{baseUrl}}/pedidos" });
    expect(code.split("\n")[0]).toBe("POST {{baseUrl}}/pedidos HTTP/1.1");
    expect(code).not.toContain("Host:");
  });
});

describe("los cuerpos de formulario", () => {
  test("urlencoded se codifica, y el espacio y el ampersand no se cuelan crudos", () => {
    const patch = {
      body: {
        kind: "form" as const,
        fields: [
          { name: "q", value: "a b&c" },
          { name: "n", value: "1" },
        ],
      },
    };
    expect(render("curl", patch)).toContain("--data-urlencode 'q=a b&c'");
    expect(render("fetch", patch)).toContain('body: "q=a+b%26c&n=1"');
    expect(render("fetch", patch)).toContain("application/x-www-form-urlencoded");
  });

  test("multipart no declara Content-Type: el boundary lo pone el cliente", () => {
    const code = render("fetch", { body: { kind: "multipart", fields: [{ name: "a", value: "1", file: false }] } });
    expect(code).toContain("new FormData()");
    // Un `Content-Type: multipart/form-data` sin boundary rompe el cuerpo.
    expect(code).not.toContain("multipart/form-data");
  });
});

describe("pedir un lenguaje que no existe", () => {
  test("lanza en vez de devolver cadena vacía, que esconde el error de quien llama", () => {
    expect(() => renderSnippet("cobol", request())).toThrow(/cobol/);
  });
});
