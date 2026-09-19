/**
 * Los cuerpos y las autenticaciones que `snippets.test.ts` no recorre en cada lenguaje.
 *
 * Cada prueba afirma la línea exacta que ese lenguaje necesita para mandar lo mismo: el fichero
 * leído del disco, el campo de texto del multipart, el Basic que cada cliente trae de fábrica. Un
 * generador que pierda una de estas ramas manda otra petición, y eso no se ve corriendo el código.
 */
import { describe, expect, test } from "vitest";

import { authPlan, contentTypeOf, renderSnippet, SNIPPET_LANGUAGES, type SnippetRequest } from "@/lib/snippets";

const base = (patch: Partial<SnippetRequest> = {}): SnippetRequest => ({
  method: "POST",
  url: "https://api.ejemplo.com/subir",
  headers: [],
  body: { kind: "none" },
  auth: { type: "none", params: {} },
  ...patch,
});

const multipart: Partial<SnippetRequest> = {
  body: {
    kind: "multipart",
    fields: [
      { name: "nota", value: "hola", file: false },
      { name: "adjunto", value: "informe.pdf", file: true },
    ],
  },
};
const binary: Partial<SnippetRequest> = { body: { kind: "binary", filename: "datos.bin" } };
const form: Partial<SnippetRequest> = {
  body: {
    kind: "form",
    fields: [
      { name: "q", value: "a b" },
      { name: "n", value: "1" },
    ],
  },
};
const basic: Partial<SnippetRequest> = { auth: { type: "basic", params: { username: "ana", password: "pw" } } };
const digest: Partial<SnippetRequest> = { auth: { type: "digest", params: { username: "ana", password: "pw" } } };
const signed: Partial<SnippetRequest> = { auth: { type: "hawk", params: {} } };

const render = (id: string, patch: Partial<SnippetRequest> = {}) => renderSnippet(id, base(patch));

describe("authPlan, caso por caso", () => {
  test("bearer con token pone la cabecera; sin token no pone nada", () => {
    expect(authPlan({ type: "bearer", params: { token: "t1" } }, []).headers).toEqual([
      { name: "Authorization", value: "Bearer t1" },
    ]);
    const empty = authPlan({ type: "bearer", params: {} }, []);
    expect(empty).toEqual({ headers: [], query: [], basic: null, digest: null, note: null });
  });

  test("apikey sin nombre de clave no manda nada, y sin «in» va en cabecera", () => {
    expect(authPlan({ type: "apikey", params: { value: "v" } }, []).headers).toEqual([]);
    expect(authPlan({ type: "apikey", params: { key: "X-Key", value: "v" } }, []).headers).toEqual([
      { name: "X-Key", value: "v" },
    ]);
    expect(authPlan({ type: "apikey", params: { key: "X-Key", in: "header" } }, []).headers).toEqual([
      { name: "X-Key", value: "" },
    ]);
  });

  test("JWT usa accessToken o token, y sin ninguno lo dice con su nombre", () => {
    expect(authPlan({ type: "jwt", params: { token: "j" } }, []).headers[0].value).toBe("Bearer j");
    expect(authPlan({ type: "oauth2", params: { accessToken: "o" } }, []).headers[0].value).toBe("Bearer o");
    expect(authPlan({ type: "jwt", params: {} }, []).note).toBe("falta el token de JWT");
  });

  test("contentTypeOf: texto no JSON usa el suyo, multipart y binario no llevan", () => {
    expect(contentTypeOf({ kind: "text", text: "x", contentType: "text/csv", json: false })).toBe("text/csv");
    expect(contentTypeOf({ kind: "binary", filename: "f" })).toBeNull();
    expect(contentTypeOf({ kind: "none" })).toBeNull();
  });
});

describe("curl", () => {
  test("bearer va como -H y el aviso como comentario", () => {
    expect(render("curl", { auth: { type: "bearer", params: { token: "t1" } } })).toContain(
      "-H 'Authorization: Bearer t1'",
    );
    expect(render("curl", signed)).toContain("  # hawk: la firma se calcula");
  });

  test("un Content-Type escrito a mano no se repite", () => {
    const code = render("curl", {
      headers: [{ name: "content-type", value: "text/plain" }],
      body: { kind: "text", text: "hola", contentType: "application/json", json: true },
    });
    expect(code.match(/content-type/gi)).toHaveLength(1);
    expect(code).toContain("--data 'hola'");
  });

  test("un texto no JSON lleva su tipo, y un binario sale con @", () => {
    expect(render("curl", { body: { kind: "text", text: "a", contentType: "text/csv", json: false } })).toContain(
      "-H 'Content-Type: text/csv'",
    );
    expect(render("curl", binary)).toContain("--data-binary '@datos.bin'");
  });
});

describe("HTTPie", () => {
  test("Basic, Digest y el aviso", () => {
    expect(render("httpie", basic)).toContain("--auth 'ana:pw'");
    expect(render("httpie", digest)).toContain("--auth-type digest --auth 'ana:pw'");
    expect(render("httpie", signed)).toContain("# hawk: la firma");
  });

  test("form, multipart y binario, cada uno con su sintaxis", () => {
    const f = render("httpie", form);
    expect(f).toContain("--form");
    expect(f).toContain("'q=a b'");
    const m = render("httpie", multipart);
    expect(m).toContain("--multipart");
    expect(m).toContain("nota=hola");
    expect(m).toContain("adjunto@informe.pdf");
    expect(render("httpie", binary)).toContain("  < 'datos.bin'");
  });
});

describe("HTTP crudo", () => {
  test("multipart escribe el cuerpo con su boundary, y el fichero sin contenido", () => {
    const code = render("http", multipart);
    expect(code).toContain("Content-Type: multipart/form-data; boundary=----limite");
    expect(code).toContain('Content-Disposition: form-data; name="nota"\n\nhola');
    expect(code).toContain(
      'Content-Disposition: form-data; name="adjunto"; filename="informe.pdf"\n\n<el contenido del fichero>',
    );
    expect(code.endsWith("------limite--")).toBe(true);
  });

  test("binario y Digest", () => {
    expect(render("http", binary).endsWith("\n\n<el contenido de datos.bin>")).toBe(true);
    expect(render("http", digest)).toContain("Authorization: Digest <se calcula");
  });

  test("sin cuerpo no hay Content-Length", () => {
    expect(render("http")).not.toContain("Content-Length");
  });
});

describe("fetch", () => {
  test("Basic se calcula con btoa en la cabecera", () => {
    expect(render("fetch", basic)).toContain('"Authorization": "Basic " + btoa("ana:pw"),');
  });

  test("multipart con fichero y texto, y el binario", () => {
    const code = render("fetch", multipart);
    expect(code).toContain('form.append("nota", "hola");');
    expect(code).toContain('form.append("adjunto", fichero); // informe.pdf');
    expect(code).toContain("  body: form,");
    expect(render("fetch", binary)).toContain("  body: fichero, // datos.bin");
  });

  test("sin cabeceras no escribe un bloque headers vacío", () => {
    expect(render("fetch", { method: "GET" })).not.toContain("headers:");
  });
});

describe("axios", () => {
  test("multipart, form y binario", () => {
    const code = render("axios", multipart);
    expect(code).toContain('form.append("nota", "hola");');
    expect(code).toContain('form.append("adjunto", fichero); // informe.pdf');
    expect(code).toContain("  data: form,");
    expect(render("axios", form)).toContain('  data: "q=a+b&n=1",');
    expect(render("axios", binary)).toContain("  data: fichero, // datos.bin");
    expect(render("axios")).not.toContain("headers:");
  });
});

describe("Python", () => {
  test("form va como diccionario", () => {
    const code = render("python", form);
    expect(code).toContain('payload = {\n    "q": "a b",\n    "n": "1",\n}');
    expect(code).toContain("data=payload");
  });

  test("multipart solo de texto no abre ficheros, solo de ficheros no manda data", () => {
    const texts = render("python", { body: { kind: "multipart", fields: [{ name: "a", value: "1", file: false }] } });
    expect(texts).toContain("data=payload");
    expect(texts).not.toContain("files=");
    const files = render("python", {
      body: { kind: "multipart", fields: [{ name: "f", value: "x.pdf", file: true }] },
    });
    expect(files).toContain("files=files");
    expect(files).not.toContain("data=");
  });

  test("binario se abre en modo rb", () => {
    expect(render("python", binary)).toContain('payload = open("datos.bin", "rb")');
  });

  test("sin cabeceras ni cuerpo la llamada lleva solo la URL", () => {
    expect(render("python")).toContain('requests.request("POST", url)');
  });
});

describe("Go", () => {
  test("multipart escribe los campos de texto con WriteField", () => {
    expect(render("go", multipart)).toContain('\twriter.WriteField("nota", "hola")');
  });

  test("binario abre el fichero y lo manda como cuerpo, importando os", () => {
    const code = render("go", binary);
    expect(code).toContain('\tfile, err := os.Open("datos.bin")');
    expect(code).toContain(", file)");
    expect(code).toContain('\t"os"');
    expect(code).not.toContain('"bytes"');
  });
});

describe("Java", () => {
  test("Basic importa Base64 y lo calcula", () => {
    const code = render("java", basic);
    expect(code).toContain("import java.util.Base64;");
    expect(code).toContain('Base64.getEncoder().encodeToString("ana:pw".getBytes())');
  });

  test("binario usa ofFile, multipart avisa y va sin cuerpo", () => {
    const b = render("java", binary);
    expect(b).toContain("import java.nio.file.Path;");
    expect(b).toContain('HttpRequest.BodyPublishers.ofFile(Path.of("datos.bin"))');
    const m = render("java", multipart);
    expect(m).toContain("// multipart: el HttpClient de la plataforma no lo monta");
    expect(m).toContain("HttpRequest.BodyPublishers.noBody()");
  });
});

describe("C#", () => {
  test("Basic va en Headers.Authorization", () => {
    expect(render("csharp", basic)).toContain(
      'request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes("ana:pw")));',
    );
  });

  test("multipart con ByteArrayContent para el fichero y StringContent para el texto", () => {
    const code = render("csharp", multipart);
    expect(code).toContain('content.Add(new StringContent("hola"), "nota");');
    expect(code).toContain(
      'content.Add(new ByteArrayContent(File.ReadAllBytes("informe.pdf")), "adjunto", "informe.pdf");',
    );
    expect(code).toContain("request.Content = content;");
  });

  test("binario y un texto sin tipo, que cae en text/plain", () => {
    expect(render("csharp", binary)).toContain(
      'request.Content = new ByteArrayContent(File.ReadAllBytes("datos.bin"));',
    );
    expect(render("csharp", { body: { kind: "text", text: "x", contentType: "", json: false } })).toContain(
      'new StringContent("x", Encoding.UTF8, "text/plain")',
    );
  });
});

describe("PHP", () => {
  test("multipart texto, binario y Digest", () => {
    expect(render("php", multipart)).toContain('        "nota" => "hola",');
    expect(render("php", binary)).toContain('CURLOPT_POSTFIELDS => file_get_contents("datos.bin"),');
    const d = render("php", digest);
    expect(d).toContain("CURLOPT_HTTPAUTH => CURLAUTH_DIGEST,");
    expect(d).toContain('CURLOPT_USERPWD => "ana:pw",');
    expect(render("php")).not.toContain("CURLOPT_HTTPHEADER");
  });
});

describe("Ruby", () => {
  test("multipart con set_form, y binario con binread", () => {
    const code = render("ruby", multipart);
    expect(code).toContain('    ["nota", "hola"],');
    expect(code).toContain('    ["adjunto", File.open("informe.pdf")],');
    expect(code).toContain('  ], "multipart/form-data")');
    expect(render("ruby", binary)).toContain('request.body = File.binread("datos.bin")');
    expect(render("ruby", { method: "DELETE" })).toContain("Net::HTTP::Delete.new(uri)");
  });
});

describe("Rust", () => {
  test("un método sin atajo va por reqwest::Method", () => {
    expect(render("rust", { method: "OPTIONS" })).toContain(
      '.request(reqwest::Method::OPTIONS, "https://api.ejemplo.com/subir")',
    );
  });

  test("multipart y binario", () => {
    const code = render("rust", multipart);
    expect(code).toContain('form = form.text("nota", "hola");');
    expect(code).toContain('form = form.file("adjunto", "informe.pdf").await?;');
    expect(render("rust", binary)).toContain('.body(std::fs::read("datos.bin")?)');
  });
});

describe("Swift", () => {
  test("Basic, multipart y binario", () => {
    expect(render("swift", basic)).toContain('let credential = "ana:pw".data(using: .utf8)!.base64EncodedString()');
    expect(render("swift", multipart)).toContain("// multipart: URLSession no lo monta");
    expect(render("swift", binary)).toContain(
      'request.httpBody = try Data(contentsOf: URL(fileURLWithPath: "datos.bin"))',
    );
  });
});

describe("Kotlin", () => {
  test("multipart importa lo suyo y escribe cada parte", () => {
    const code = render("kotlin", multipart);
    expect(code).toContain("import okhttp3.MultipartBody");
    expect(code).toContain('    .addFormDataPart("nota", "hola")');
    expect(code).toContain('    .addFormDataPart("adjunto", "informe.pdf", File("informe.pdf").asRequestBody())');
    expect(code).toContain('    .method("POST", body)');
  });

  test("binario y sin cuerpo", () => {
    expect(render("kotlin", binary)).toContain('val body = File("datos.bin").asRequestBody()');
    expect(render("kotlin", { method: "GET" })).toContain('    .method("GET", null)');
  });
});

describe("Dart", () => {
  test("Basic importa dart:convert y lo calcula", () => {
    const code = render("dart", basic);
    expect(code).toContain("import 'dart:convert';");
    expect(code).toContain("base64Encode(utf8.encode('ana:pw'))");
  });

  test("multipart usa MultipartRequest, con sus campos y cabeceras", () => {
    const code = render("dart", { ...multipart, headers: [{ name: "X-T", value: "1" }] });
    expect(code).toContain(
      "final request = http.MultipartRequest('POST', Uri.parse('https://api.ejemplo.com/subir'));",
    );
    expect(code).toContain("request.fields['nota'] = 'hola';");
    expect(code).toContain("request.files.add(await http.MultipartFile.fromPath('adjunto', 'informe.pdf'));");
    expect(code).toContain("request.headers['X-T'] = '1';");
  });

  test("binario lee los bytes del fichero", () => {
    expect(render("dart", binary)).toContain("request.bodyBytes = await File('datos.bin').readAsBytes();");
  });
});

describe("PowerShell", () => {
  test("Basic sin otras cabeceras crea el diccionario antes de usarlo", () => {
    const code = render("powershell", basic);
    expect(code).toContain("$pair = 'ana:pw'");
    expect(code).toContain("$headers = @{}");
    expect(code).toContain("-Headers $headers");
  });

  test("Basic con cabeceras reutiliza el diccionario", () => {
    const code = render("powershell", { ...basic, headers: [{ name: "X-T", value: "1" }] });
    expect(code).not.toContain("$headers = @{}");
    expect(code).toContain("\n$headers\n");
  });

  test("multipart con -Form, binario con ReadAllBytes, y sin cabeceras no hay -Headers", () => {
    const m = render("powershell", multipart);
    expect(m).toContain("    'nota' = 'hola'");
    expect(m).toContain("    'adjunto' = Get-Item 'informe.pdf'");
    expect(m).toContain("-Form $form");
    const b = render("powershell", binary);
    expect(b).toContain("$body = [IO.File]::ReadAllBytes('datos.bin')");
    expect(b).toContain("-Body $body");
    expect(render("powershell")).not.toContain("-Headers");
  });
});

describe("todos los lenguajes con cada cuerpo", () => {
  test("todos nombran el fichero del binario, y el del multipart salvo los que lo avisan", () => {
    // Java y Swift no montan multipart con la biblioteca estándar: escriben el aviso, no el campo.
    const warns = new Set(["java", "swift"]);
    for (const language of SNIPPET_LANGUAGES) {
      expect(language.render(base(binary)), language.id).toContain("datos.bin");
      const code = language.render(base(multipart));
      if (warns.has(language.id)) expect(code, language.id).toContain("// multipart:");
      else expect(code, language.id).toContain("informe.pdf");
    }
  });
});
