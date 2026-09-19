/**
 * Los caminos de `auth.ts` que las pruebas de los vectores publicados no pisan: los «no» de cada
 * esquema, los algoritmos alternativos y los valores por defecto.
 *
 * Donde no hay vector ajeno, la firma esperada se calcula aquí a mano a partir de la cadena que dice
 * la especificación —escrita literal en la prueba— y no llamando otra vez al código que se prueba.
 */
import assert from "node:assert/strict";
import { constants, createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, test } from "node:test";

import {
  isAuthType,
  oauth1BaseString,
  readTokenResponse,
  sameSignature,
  signAuth,
  tokenRequestFor,
  type AuthRequest,
  type AuthResult,
  type RequestAuth,
} from "../src/auth.ts";

const header = (result: AuthResult, name: string): string =>
  result.headers.find((pair) => pair.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const get = (url = "https://example.com/recurso", extra: Partial<AuthRequest> = {}): AuthRequest => ({
  method: "GET",
  url,
  headers: {},
  ...extra,
});

const sign = (type: RequestAuth["type"], params: Record<string, string>, request: AuthRequest = get()): AuthResult =>
  signAuth({ type, params }, request);

const md5 = (text: string): string => createHash("md5").update(text, "utf8").digest("hex");
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("los tipos y los modos que no firman", () => {
  test("isAuthType reconoce los nombres de Postman y nada más", () => {
    assert.equal(isAuthType("awsv4"), true);
    assert.equal(isAuthType("inherit"), true);
    assert.equal(isAuthType("kerberos"), false);
    assert.equal(isAuthType(7), false);
    assert.equal(isAuthType(null), false);
  });

  test("none e inherit no añaden nada, ni cabecera ni query", () => {
    for (const type of ["none", "inherit"] as const) {
      const result = sign(type, { token: "no-debe-salir" });
      assert.deepEqual(result, { headers: [], query: [], bodyFields: [], needsChallenge: false, unsupported: null });
    }
  });

  test("Bearer manda el token sin los espacios de alrededor", () => {
    const result = sign("bearer", { token: "  abc.def  " });
    assert.equal(header(result, "authorization"), "Bearer abc.def");
    assert.equal(result.unsupported, null);
  });

  test("una clave de API sin nombre no se manda, y por defecto va en la cabecera", () => {
    assert.match(sign("apikey", { value: "abc" }).unsupported ?? "", /nombre de la clave/);
    const result = sign("apikey", { key: "X-Api-Key", value: "abc" });
    assert.deepEqual(result.headers, [{ name: "X-Api-Key", value: "abc" }]);
    assert.deepEqual(result.query, []);
  });

  test("sameSignature compara el contenido, y dos longitudes distintas no son la misma firma", () => {
    assert.equal(sameSignature("abc", "abc"), true);
    assert.equal(sameSignature("abc", "abd"), false);
    assert.equal(sameSignature("abc", "abcd"), false);
  });
});

describe("JWT: lo que no se firma y lo que se firma con RSA", () => {
  const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  test("un algoritmo desconocido o un secreto vacío se dicen en vez de firmar", () => {
    const wrong = sign("jwt", { algorithm: "none", secret: "x" });
    assert.match(wrong.unsupported ?? "", /Algoritmo NONE no soportado/);
    assert.deepEqual(wrong.headers, []);
    assert.match(sign("jwt", { algorithm: "HS256" }).unsupported ?? "", /Falta el secreto/);
  });

  test("un payload que es JSON pero no un objeto tampoco vale", () => {
    for (const payload of ["[1,2]", "null", "42"]) {
      const result = sign("jwt", { secret: "x", payload });
      assert.match(result.unsupported ?? "", /objeto JSON/, payload);
    }
  });

  test("las cabeceras extra entran en el header del token, pero alg y typ no se pueden pisar", () => {
    const result = sign("jwt", { secret: "x", headers: JSON.stringify({ kid: "clave-1", alg: "none" }) });
    const token = header(result, "authorization").replace("Bearer ", "");
    assert.deepEqual(decode(token.split(".")[0] ?? ""), { kid: "clave-1", alg: "HS256", typ: "JWT" });
  });

  test("unas cabeceras que no son un objeto se ignoran, y unas que no son JSON se dicen", () => {
    for (const headers of ["[1]", "null", "3"]) {
      const token = header(sign("jwt", { secret: "x", headers }), "authorization").replace("Bearer ", "");
      assert.deepEqual(decode(token.split(".")[0] ?? ""), { alg: "HS256", typ: "JWT" }, headers);
    }
    assert.match(sign("jwt", { secret: "x", headers: "{kid" }).unsupported ?? "", /cabeceras del JWT/);
  });

  test("RS256 firma con la clave privada y la firma valida con la pública", () => {
    const result = sign("jwt", { algorithm: "rs256", secret: privateKey, payload: '{"sub":"1"}' });
    const [head, body, signature] = header(result, "authorization").replace("Bearer ", "").split(".");
    assert.deepEqual(decode(head ?? ""), { alg: "RS256", typ: "JWT" });
    const ok = verify("sha256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature ?? "", "base64url"));
    assert.equal(ok, true);
  });

  test("PS384 firma con relleno PSS y sal del tamaño del resumen, no con el de RS", () => {
    const result = sign("jwt", { algorithm: "PS384", secret: privateKey, payload: '{"sub":"1"}' });
    const [head, body, signature] = header(result, "authorization").replace("Bearer ", "").split(".");
    const input = Buffer.from(`${head}.${body}`);
    const raw = Buffer.from(signature ?? "", "base64url");
    const pss = { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 };
    assert.equal(verify("sha384", input, pss, raw), true);
    // Con el relleno clásico la misma firma no valida: es otra firma, no la misma con otro nombre.
    assert.equal(verify("sha384", input, publicKey, raw), false);
  });

  test("RS256 con algo que no es una clave privada no firma y dice por qué", () => {
    const result = sign("jwt", { algorithm: "RS256", secret: "no-es-un-pem" });
    assert.match(result.unsupported ?? "", /^No se pudo firmar el JWT: /);
    assert.deepEqual(result.headers, []);
  });

  test("puede ir en la query, con el nombre de parámetro que se le dé o «token»", () => {
    const byDefault = sign("jwt", { secret: "x", addTokenTo: "queryParams" });
    assert.equal(byDefault.query[0]?.name, "token");
    assert.equal(byDefault.query[0]?.value.split(".").length, 3);
    assert.deepEqual(byDefault.headers, []);
    const named = sign("jwt", { secret: "x", addTokenTo: "queryParams", queryParamKey: "jwt" });
    assert.equal(named.query[0]?.name, "jwt");
  });

  test("con el prefijo en blanco la cabecera es el token solo", () => {
    const value = header(sign("jwt", { secret: "x", headerPrefix: "  " }), "authorization");
    assert.equal(value.split(".").length, 3);
    assert.ok(!value.includes(" "));
  });
});

describe("Digest: variantes del RFC 7616", () => {
  const base = {
    username: "Mufasa",
    password: "Circle of Life",
    realm: "r",
    nonce: "n",
    clientNonce: "c",
    nonceCount: "00000001",
  };
  const response = (result: AuthResult): string => /response="([0-9a-f]+)"/.exec(header(result, "authorization"))?.[1] ?? "";

  test("un algoritmo que no es de Digest no se firma", () => {
    assert.match(sign("digest", { ...base, algorithm: "SHA-1" }).unsupported ?? "", /Digest con SHA-1 no soportado/);
  });

  test("sin qop es la fórmula de RFC 2069: HA1:nonce:HA2, sin nc ni cnonce", () => {
    const result = sign("digest", base, get("https://example.com/dir/index.html"));
    const ha1 = md5("Mufasa:r:Circle of Life");
    const ha2 = md5("GET:/dir/index.html");
    assert.equal(response(result), md5(`${ha1}:n:${ha2}`));
    assert.doesNotMatch(header(result, "authorization"), /qop=|nc=|cnonce=|opaque=/);
  });

  test("qop=auth-int mete el hash del cuerpo en HA2", () => {
    const request = get("https://example.com/a", { method: "POST", body: "hola" });
    const result = sign("digest", { ...base, qop: "auth-int" }, request);
    const ha1 = md5("Mufasa:r:Circle of Life");
    const ha2 = md5(`POST:/a:${md5("hola")}`);
    assert.equal(response(result), md5(`${ha1}:n:00000001:c:auth-int:${ha2}`));
    assert.match(header(result, "authorization"), /qop=auth-int/);
  });

  test("un qop que no es auth ni auth-int se trata como si no hubiera qop", () => {
    const result = sign("digest", { ...base, qop: "token" }, get("https://example.com/a"));
    assert.equal(response(result), md5(`${md5("Mufasa:r:Circle of Life")}:n:${md5("GET:/a")}`));
  });

  test("MD5-sess rehace HA1 con el nonce y el cnonce", () => {
    const result = sign("digest", { ...base, algorithm: "MD5-sess", qop: "auth" }, get("https://example.com/a"));
    const ha1 = md5(`${md5("Mufasa:r:Circle of Life")}:n:c`);
    assert.equal(response(result), md5(`${ha1}:n:00000001:c:auth:${md5("GET:/a")}`));
    assert.match(header(result, "authorization"), /algorithm=MD5-SESS/);
  });

  test("SHA-512-256 es SHA-512 truncado a 256 bits, no SHA-256", () => {
    const h = (text: string) => createHash("sha512").update(text, "utf8").digest("hex").slice(0, 64);
    const result = sign("digest", { ...base, algorithm: "SHA-512-256", qop: "auth" }, get("https://example.com/a"));
    const expected = h(`${h("Mufasa:r:Circle of Life")}:n:00000001:c:auth:${h("GET:/a")}`);
    assert.equal(response(result), expected);
    assert.equal(expected.length, 64);
    assert.notEqual(expected, sha256(`${sha256("Mufasa:r:Circle of Life")}:n:00000001:c:auth:${sha256("GET:/a")}`));
  });

  test("con una URL relativa firma la ruta tal cual, poniendo la barra si falta", () => {
    const withSlash = sign("digest", base, get("/dir/x?y=1"));
    assert.match(header(withSlash, "authorization"), /uri="\/dir\/x\?y=1"/);
    const withoutSlash = sign("digest", base, get("dir/x"));
    assert.match(header(withoutSlash, "authorization"), /uri="\/dir\/x"/);
    assert.equal(response(withoutSlash), md5(`${md5("Mufasa:r:Circle of Life")}:n:${md5("GET:/dir/x")}`));
  });

  test("sin clientNonce usa el nonce de la petición como cnonce", () => {
    const { clientNonce: _unused, ...rest } = base;
    const result = sign("digest", { ...rest, qop: "auth" }, get("https://example.com/a", { nonce: "fijo" }));
    assert.match(header(result, "authorization"), /cnonce="fijo"/);
  });
});

describe("OAuth 1.0a: los otros métodos de firma y los «no»", () => {
  const params = {
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "tk",
    tokenSecret: "ts",
    timestamp: "137131200",
    nonce: "abc",
  };
  const oauth = (result: AuthResult): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [, key, item] of header(result, "authorization").matchAll(/(\w+)="([^"]*)"/g)) {
      out[key ?? ""] = decodeURIComponent(item ?? "");
    }
    return out;
  };

  test("un método de firma desconocido, sin consumer key o con URL relativa no se firma", () => {
    assert.match(sign("oauth1", { ...params, signatureMethod: "HMAC-MD5" }).unsupported ?? "", /HMAC-MD5 no soportada/);
    assert.match(sign("oauth1", { consumerSecret: "cs" }).unsupported ?? "", /consumer key/);
    assert.match(sign("oauth1", params, get("/relativa")).unsupported ?? "", /no es absoluta/);
  });

  test("PLAINTEXT manda la clave de firma tal cual: secretos codificados y unidos por &", () => {
    const result = sign("oauth1", { ...params, consumerSecret: "c s", signatureMethod: "PLAINTEXT" });
    assert.equal(oauth(result).oauth_signature, "c%20s&ts");
  });

  test("HMAC-SHA256 firma la cadena base con SHA-256", () => {
    const result = sign("oauth1", { ...params, signatureMethod: "HMAC-SHA256" }, get("https://example.com/r?b=2"));
    const sent = oauth(result);
    const base = oauth1BaseString("GET", new URL("https://example.com/r"), [
      ["b", "2"],
      ["oauth_consumer_key", "ck"],
      ["oauth_signature_method", "HMAC-SHA256"],
      ["oauth_timestamp", "137131200"],
      ["oauth_nonce", "abc"],
      ["oauth_version", "1.0"],
      ["oauth_token", "tk"],
    ]);
    assert.equal(sent.oauth_signature, createHmac("sha256", "cs&ts").update(base).digest("base64"));
  });

  test("RSA-SHA1 firma con la clave privada puesta como consumer secret, y valida con la pública", () => {
    const result = sign("oauth1", { ...params, consumerSecret: privateKey, signatureMethod: "RSA-SHA1" });
    const sent = oauth(result);
    const base = oauth1BaseString("GET", new URL("https://example.com/recurso"), [
      ["oauth_consumer_key", "ck"],
      ["oauth_signature_method", "RSA-SHA1"],
      ["oauth_timestamp", "137131200"],
      ["oauth_nonce", "abc"],
      ["oauth_version", "1.0"],
      ["oauth_token", "tk"],
    ]);
    assert.equal(verify("sha1", Buffer.from(base), publicKey, Buffer.from(sent.oauth_signature ?? "", "base64")), true);
  });

  test("RSA-SHA1 con un secreto que no es una clave dice por qué no firmó", () => {
    const result = sign("oauth1", { ...params, signatureMethod: "RSA-SHA1" });
    assert.match(result.unsupported ?? "", /^No se pudo firmar: /);
    assert.deepEqual(result.headers, []);
  });

  test("callback y verifier viajan como oauth_callback y oauth_verifier, y el realm va primero", () => {
    const result = sign("oauth1", { ...params, callback: "https://app/cb", verifier: "v1", realm: "Fotos" });
    const sent = oauth(result);
    assert.equal(sent.oauth_callback, "https://app/cb");
    assert.equal(sent.oauth_verifier, "v1");
    assert.match(header(result, "authorization"), /^OAuth realm="Fotos", /);
  });

  test("version vacía quita oauth_version de la firma y de la cabecera", () => {
    const sent = oauth(sign("oauth1", { ...params, version: "" }));
    assert.equal(sent.oauth_version, undefined);
    assert.equal(sent.oauth_consumer_key, "ck");
  });

  test("fuera de la cabecera, con un formulario y POST van en el cuerpo; con GET, en la query", () => {
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    const post = sign("oauth1", { ...params, addParamsToHeader: "false" }, get(undefined, { method: "POST", headers: form, body: "a=1" }));
    assert.deepEqual(post.query, []);
    assert.ok(post.bodyFields.some((pair) => pair.name === "oauth_signature"));
    const viaGet = sign("oauth1", { ...params, addParamsToHeader: "false" }, get(undefined, { headers: form, body: "a=1" }));
    assert.deepEqual(viaGet.bodyFields, []);
    assert.ok(viaGet.query.some((pair) => pair.name === "oauth_signature"));
  });

  test("la cadena base ordena por bytes, como pide el RFC 5849: B antes que a, aZ antes que a_b", () => {
    const base = oauth1BaseString("GET", new URL("https://x.com/"), [
      ["a", "1"],
      ["a_b", "3"],
      ["aZ", "4"],
      ["B", "2"],
      ["a", "1"],
      ["a", "0"],
    ]);
    assert.equal(base, `GET&https%3A%2F%2Fx.com%2F&${encodeURIComponent("B=2&a=0&a=1&a=1&aZ=4&a_b=3")}`);
  });
});

describe("OAuth 2.0: los casos sin token y el servidor de token", () => {
  test("sin token, implicit pide el navegador y password pide el botón", () => {
    assert.match(sign("oauth2", { grantType: "implicit" }).unsupported ?? "", /navegador/);
    assert.match(sign("oauth2", { grantType: "password_credentials" }).unsupported ?? "", /Pedir token/);
    assert.match(sign("oauth2", {}).unsupported ?? "", /Pedir token/);
  });

  test("con el prefijo en blanco manda el token solo", () => {
    assert.equal(header(sign("oauth2", { accessToken: "abc", headerPrefix: " " }), "authorization"), "abc");
  });

  test("tokenRequestFor no arma nada para flujos de navegador ni sin URL o client id", () => {
    assert.deepEqual(tokenRequestFor({ type: "oauth2", params: { grantType: "implicit" } }), {
      unsupported: "Solo se piden aquí los flujos que no necesitan navegador",
    });
    assert.deepEqual(tokenRequestFor({ type: "oauth2", params: { clientId: "id" } }), {
      unsupported: "Falta la URL del servidor de token",
    });
    assert.deepEqual(tokenRequestFor({ type: "oauth2", params: { accessTokenUrl: "https://t/token" } }), {
      unsupported: "Falta el client id",
    });
  });

  test("con scope lo manda, y en el cuerpo sin secreto no manda client_secret vacío", () => {
    const built = tokenRequestFor({
      type: "oauth2",
      params: { accessTokenUrl: "https://t/token", clientId: "id", scope: "leer escribir", client_authentication: "body" },
    });
    assert.ok("request" in built);
    const form = new URLSearchParams(built.request.body);
    assert.equal(form.get("scope"), "leer escribir");
    assert.equal(form.get("client_id"), "id");
    assert.equal(form.has("client_secret"), false);
    assert.equal(built.request.headers.authorization, undefined);
  });

  test("readTokenResponse lee expires_in en texto, descarta los que no son positivos y el scope que no es texto", () => {
    assert.equal(readTokenResponse(null), null);
    assert.equal(readTokenResponse("access_token=abc"), null);
    assert.deepEqual(readTokenResponse({ access_token: "a", expires_in: "3600", scope: "leer" }), {
      accessToken: "a",
      expiresIn: 3600,
      scope: "leer",
    });
    assert.deepEqual(readTokenResponse({ access_token: "a", expires_in: 0, scope: ["leer"] }), {
      accessToken: "a",
      expiresIn: null,
      scope: "",
    });
    assert.equal(readTokenResponse({ access_token: "a", expires_in: "pronto" })?.expiresIn, null);
  });
});

describe("Hawk: sha1, puertos por defecto y los campos opcionales", () => {
  const params = {
    authId: "dh37fgj492je",
    authKey: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn",
    timestamp: "1353832234",
    nonce: "j4h3g2",
  };
  const mac = (algorithm: string, normalized: string) =>
    createHmac(algorithm, params.authKey).update(normalized, "utf8").digest("base64");

  test("sin id o clave, con un algoritmo que no es de Hawk o con URL relativa no firma", () => {
    assert.match(sign("hawk", { authId: "x" }).unsupported ?? "", /Faltan el id o la clave/);
    assert.match(sign("hawk", { ...params, algorithm: "md5" }).unsupported ?? "", /Hawk con md5 no soportado/);
    assert.match(sign("hawk", params, get("/r")).unsupported ?? "", /no es absoluta/);
  });

  test("sha1 firma con HMAC-SHA1, y https sin puerto firma el 443", () => {
    const result = sign("hawk", { ...params, algorithm: "SHA1" }, get("https://example.com/resource/1?b=1&a=2"));
    const normalized = "hawk.1.header\n1353832234\nj4h3g2\nGET\n/resource/1?b=1&a=2\nexample.com\n443\n\n\n";
    assert.match(header(result, "authorization"), new RegExp(`mac="${escape(mac("sha1", normalized))}"`));
  });

  test("http sin puerto firma el 80, y app y dlg salen en la cabecera", () => {
    const result = sign("hawk", { ...params, app: "mi-app", delegation: "otra" }, get("http://Example.com/r"));
    const normalized = "hawk.1.header\n1353832234\nj4h3g2\nGET\n/r\nexample.com\n80\n\n\n";
    const value = header(result, "authorization");
    assert.match(value, new RegExp(`mac="${escape(mac("sha256", normalized))}"`));
    assert.match(value, /app="mi-app", dlg="otra"/);
  });

  test("el hash del cuerpo usa el tipo sin parámetros y lee también un cuerpo en bytes", () => {
    const request = get("http://example.com:8000/r", {
      method: "POST",
      headers: { "Content-Type": "Text/Plain; charset=utf-8" },
      body: new TextEncoder().encode("hola"),
    });
    const expected = createHash("sha256").update("hawk.1.payload\ntext/plain\nhola\n").digest("base64");
    assert.match(header(sign("hawk", params, request), "authorization"), new RegExp(`hash="${escape(expected)}"`));
  });

  const escape = (text: string) => text.replace(/[+/=]/g, (char) => `\\${char}`);
});

describe("AWS Signature v4: los «no», los valores por defecto y el orden", () => {
  const keys = { accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const when = Date.parse("2015-08-30T12:36:00Z");

  const expectedSignature = (canonical: string, region: string, service: string): string => {
    const scope = `20150830/${region}/${service}/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n20150830T123600Z\n${scope}\n${sha256(canonical)}`;
    let key = createHmac("sha256", `AWS4${keys.secretKey}`).update("20150830").digest();
    for (const part of [region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
    return createHmac("sha256", key).update(toSign).digest("hex");
  };

  test("sin claves, con URL relativa o sin servicio deducible no firma", () => {
    assert.match(sign("awsv4", { accessKey: "a" }).unsupported ?? "", /Faltan las claves/);
    assert.match(sign("awsv4", keys, get("/r")).unsupported ?? "", /no es absoluta/);
    assert.match(sign("awsv4", keys, get("https://api.ejemplo.com/")).unsupported ?? "", /Falta el servicio/);
    // `amazonaws.com` a secas no tiene delante el nombre del servicio.
    assert.match(sign("awsv4", keys, get("https://amazonaws.com/")).unsupported ?? "", /Falta el servicio/);
  });

  test("sin región en los parámetros ni en el host firma para us-east-1", () => {
    const result = sign("awsv4", { ...keys, service: "execute-api" }, get("https://api.ejemplo.com/", { now: when }));
    assert.match(header(result, "authorization"), /Credential=AKIDEXAMPLE\/20150830\/us-east-1\/execute-api\/aws4_request/);
  });

  test("la query se ordena por bytes, no alfabéticamente: B va antes que a", () => {
    const result = sign(
      "awsv4",
      { ...keys, region: "us-east-1", service: "service" },
      get("https://example.amazonaws.com/?a=1&B=2&a=0", { now: when }),
    );
    const canonical = [
      "GET",
      "/",
      "B=2&a=0&a=1",
      "host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n",
      "host;x-amz-date",
      sha256(""),
    ].join("\n");
    assert.match(header(result, "authorization"), new RegExp(`Signature=${expectedSignature(canonical, "us-east-1", "service")}$`));
  });

  test("connection y content-length no se firman, aunque vayan en la petición", () => {
    const result = sign(
      "awsv4",
      { ...keys, region: "us-east-1", service: "service" },
      get("https://example.amazonaws.com/", {
        now: when,
        headers: { Connection: "keep-alive", "Content-Length": "0", Authorization: "vieja", "X-Uno": "  a   b " },
      }),
    );
    assert.match(header(result, "authorization"), /SignedHeaders=host;x-amz-date;x-uno,/);
    const canonical = [
      "GET",
      "/",
      "",
      "host:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-uno:a b\n",
      "host;x-amz-date;x-uno",
      sha256(""),
    ].join("\n");
    assert.match(header(result, "authorization"), new RegExp(`Signature=${expectedSignature(canonical, "us-east-1", "service")}$`));
  });

  test("una URL sin ruta firma «/», tanto en S3 como en el resto", () => {
    for (const service of ["s3", "service"]) {
      const result = sign("awsv4", { ...keys, region: "us-east-1", service }, get("urn:", { now: when }));
      const hash = sha256("");
      const canonical =
        service === "s3"
          ? ["GET", "/", "", `host:\nx-amz-content-sha256:${hash}\nx-amz-date:20150830T123600Z\n`, "host;x-amz-content-sha256;x-amz-date", hash]
          : ["GET", "/", "", "host:\nx-amz-date:20150830T123600Z\n", "host;x-amz-date", hash];
      assert.match(
        header(result, "authorization"),
        new RegExp(`Signature=${expectedSignature(canonical.join("\n"), "us-east-1", service)}$`),
        service,
      );
    }
  });

  test("sin reloj fijado firma con la hora actual", () => {
    const before = Date.now();
    const result = sign("awsv4", { ...keys, service: "service" }, get("https://example.amazonaws.com/"));
    const stamp = header(result, "x-amz-date");
    assert.match(stamp, /^\d{8}T\d{6}Z$/);
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    assert.ok(Math.abs(Date.parse(iso) - before) < 60_000);
  });
});

describe("EdgeGrid: los «no» y el tamaño máximo del cuerpo", () => {
  const params = { accessToken: "at", clientToken: "ct", clientSecret: "secreto", timestamp: "20260101T00:00:00+0000", nonce: "n" };
  const signature = (result: AuthResult) => /signature=(.+)$/.exec(header(result, "authorization"))?.[1] ?? "";

  test("sin credenciales o con URL relativa no firma", () => {
    assert.match(sign("edgegrid", { accessToken: "at" }).unsupported ?? "", /Faltan credenciales/);
    assert.match(sign("edgegrid", params, get("/r")).unsupported ?? "", /no es absoluta/);
  });

  test("un maxBodySize que no es un número positivo usa el de 128 KiB, y el cuerpo en bytes cuenta", () => {
    const post = (maxBodySize: string) =>
      sign("edgegrid", { ...params, maxBodySize }, get("https://akab.luna.akamaiapis.net/x", { method: "POST", body: new TextEncoder().encode("hola") }));
    const head = "EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=20260101T00:00:00+0000;nonce=n;";
    const data = ["POST", "https", "akab.luna.akamaiapis.net", "/x", "", createHash("sha256").update("hola").digest("base64"), head].join("\t");
    const key = createHmac("sha256", "secreto").update(params.timestamp).digest("base64");
    const expected = createHmac("sha256", key).update(data).digest("base64");
    assert.equal(signature(post("nada")), expected);
    assert.equal(signature(post("0")), expected);
    // Con 2 bytes solo se hashea «ho», que es otra firma.
    assert.notEqual(signature(post("2")), expected);
  });

  test("sin marca de tiempo ni reloj fijado usa la hora actual en el formato de Akamai", () => {
    const { timestamp: _unused, ...rest } = params;
    const value = header(sign("edgegrid", rest, get("https://akab.luna.akamaiapis.net/x")), "authorization");
    assert.match(value, /timestamp=\d{8}T\d{2}:\d{2}:\d{2}\+0000;/);
  });
});
