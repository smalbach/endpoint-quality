/**
 * Las firmas, contra el ejemplo publicado de cada especificación.
 *
 * Una firma mal calculada no se ve: la respuesta es un 403 idéntico al de una credencial caducada,
 * y nadie mira dentro de la cabecera. Comprobarla contra un vector ajeno —el de la documentación de
 * AWS, el del RFC de Digest, el del README de Hawk— es lo único que distingue firmar de producir
 * una cadena con pinta de firma, porque el vector lo calculó otra implementación.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  oauth1BaseString,
  parseChallenge,
  percent,
  readTokenResponse,
  signAuth,
  tokenRequestFor,
} from "../src/auth.ts";

const header = (result: { headers: { name: string; value: string }[] }, name: string): string =>
  result.headers.find((pair) => pair.name.toLowerCase() === name.toLowerCase())?.value ?? "";

describe("lo de siempre, que también se puede hacer mal", () => {
  it("Basic codifica usuario y contraseña juntos, no por separado", () => {
    const result = signAuth(
      { type: "basic", params: { username: "Aladdin", password: "open sesame" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    // El ejemplo del RFC 7617.
    assert.equal(header(result, "authorization"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
  });

  it("una clave de API puede ir en la query, y entonces no va en la cabecera", () => {
    const result = signAuth(
      { type: "apikey", params: { key: "api_key", value: "abc", in: "query" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    assert.deepEqual(result.query, [{ name: "api_key", value: "abc" }]);
    assert.deepEqual(result.headers, []);
  });

  it("un token que falta se dice, no se manda vacío", () => {
    const result = signAuth({ type: "bearer", params: { token: "  " } }, { method: "GET", url: "/x", headers: {} });
    assert.deepEqual(result.headers, []);
    assert.match(result.unsupported ?? "", /token/i);
  });
});

describe("JWT, firmado aquí", () => {
  it("reproduce el token del ejemplo canónico de HS256", () => {
    const result = signAuth(
      {
        type: "jwt",
        params: {
          algorithm: "HS256",
          secret: "your-256-bit-secret",
          payload: JSON.stringify({ sub: "1234567890", name: "John Doe", iat: 1516239022 }),
        },
      },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    assert.equal(
      header(result, "authorization"),
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
        ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
  });

  it("un secreto en base64 se decodifica antes de firmar, que es otro token", () => {
    const params = { algorithm: "HS256", secret: Buffer.from("clave").toString("base64"), payload: "{}" };
    const asBase64 = signAuth(
      { type: "jwt", params: { ...params, secretBase64Encoded: "true" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    const asText = signAuth({ type: "jwt", params }, { method: "GET", url: "https://example.com/", headers: {} });
    assert.notEqual(header(asBase64, "authorization"), header(asText, "authorization"));
    // Y el de base64 es el que coincide con firmar los bytes de «clave».
    const [head, body] = header(asBase64, "authorization").replace("Bearer ", "").split(".");
    const expected = createHmac("sha256", Buffer.from("clave", "utf8")).update(`${head}.${body}`).digest("base64url");
    assert.equal(header(asBase64, "authorization").split(".")[2], expected);
  });

  it("un payload que no es JSON se dice en vez de mandar un token roto", () => {
    const result = signAuth(
      { type: "jwt", params: { secret: "x", payload: "{no" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    assert.match(result.unsupported ?? "", /payload/i);
  });
});

describe("Digest, con el reto del servidor", () => {
  it("reproduce la respuesta del ejemplo del RFC 7616", () => {
    const result = signAuth(
      {
        type: "digest",
        params: {
          username: "Mufasa",
          password: "Circle of Life",
          realm: "http-auth@example.org",
          nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
          qop: "auth",
          algorithm: "MD5",
          clientNonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
          nonceCount: "00000001",
          opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
        },
      },
      { method: "GET", url: "http://www.example.org/dir/index.html", headers: {} },
    );
    const sent = header(result, "authorization");
    assert.match(sent, /response="8ca523f5e9506fed4657c9700eebdbec"/);
    assert.match(sent, /qop=auth/);
    assert.match(sent, /nc=00000001/);
  });

  it("y la de SHA-256 del mismo ejemplo, que es otro algoritmo y no otro formato", () => {
    const result = signAuth(
      {
        type: "digest",
        params: {
          username: "Mufasa",
          password: "Circle of Life",
          realm: "http-auth@example.org",
          nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
          qop: "auth",
          algorithm: "SHA-256",
          clientNonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
          nonceCount: "00000001",
        },
      },
      { method: "GET", url: "http://www.example.org/dir/index.html", headers: {} },
    );
    assert.match(
      header(result, "authorization"),
      /response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"/,
    );
  });

  it("sin reto pide el 401 en vez de inventarse un nonce", () => {
    const result = signAuth(
      { type: "digest", params: { username: "a", password: "b" } },
      { method: "GET", url: "https://example.com/x", headers: {} },
    );
    assert.equal(result.needsChallenge, true);
    assert.deepEqual(result.headers, []);
  });

  it("saca realm, nonce y qop del WWW-Authenticate y firma con ellos", () => {
    const result = signAuth(
      { type: "digest", params: { username: "Mufasa", password: "Circle of Life", clientNonce: "abc" } },
      {
        method: "GET",
        url: "http://www.example.org/dir/index.html",
        headers: {},
        challenge:
          'Digest realm="http-auth@example.org", qop="auth,auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"',
      },
    );
    assert.equal(result.needsChallenge, false);
    assert.match(header(result, "authorization"), /realm="http-auth@example\.org"/);
    // De `auth,auth-int` se elige `auth`, no la cadena entera.
    assert.match(header(result, "authorization"), /qop=auth,/);
  });

  it("el reto se parte por comas fuera de las comillas", () => {
    const parsed = parseChallenge('Digest realm="a,b", qop="auth,auth-int", nonce="n"', "digest");
    assert.equal(parsed.realm, "a,b");
    assert.equal(parsed.qop, "auth,auth-int");
  });

  it("y un 401 que ofrece dos esquemas da el que se le pide", () => {
    const line = 'Basic realm="simple", Digest realm="complex", nonce="n2"';
    assert.equal(parseChallenge(line, "digest").nonce, "n2");
    assert.equal(parseChallenge(line, "basic").realm, "simple");
  });
});

describe("OAuth 1.0a", () => {
  it("codifica los cinco caracteres que encodeURIComponent deja pasar", () => {
    assert.equal(percent("!'()*"), "%21%27%28%29%2A");
    assert.equal(percent("a b"), "a%20b");
  });

  it("construye la cadena base publicada en el RFC 5849, byte a byte", () => {
    // El vector ajeno del esquema. La firma es un HMAC que calcula la plataforma; lo que se puede
    // hacer mal —y lo que aquí se comprueba— es esta cadena.
    const base = oauth1BaseString("POST", new URL("http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b"), [
      ["b5", "=%3D"],
      ["a3", "a"],
      ["c@", ""],
      ["a2", "r b"],
      ["c2", ""],
      ["a3", "2 q"],
      ["oauth_consumer_key", "9djdj82h48djs9d2"],
      ["oauth_token", "kkk9d7dh3k39sjv7"],
      ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", "137131201"],
      ["oauth_nonce", "7d8f3e4a"],
    ]);
    assert.equal(
      base,
      "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D" +
        "%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a" +
        "%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
    );
  });

  it("firma esa misma petición con el HMAC de la clave del ejemplo", () => {
    const result = signAuth(
      {
        type: "oauth1",
        params: {
          consumerKey: "9djdj82h48djs9d2",
          consumerSecret: "j49sk3j29djd",
          token: "kkk9d7dh3k39sjv7",
          tokenSecret: "dh893hdasih9",
          signatureMethod: "HMAC-SHA1",
          timestamp: "137131201",
          nonce: "7d8f3e4a",
          realm: "Example",
          // El ejemplo del RFC no manda `oauth_version`, que es opcional; mandarlo cambia la firma.
          version: "",
        },
      },
      {
        method: "POST",
        url: "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "c2&a3=2+q",
      },
    );
    const sent = header(result, "authorization");
    assert.match(sent, /^OAuth realm="Example", /);
    // El HMAC-SHA1 de la cadena base del RFC con `consumerSecret&tokenSecret`, calculado aparte.
    const expected = createHmac("sha1", "j49sk3j29djd&dh893hdasih9")
      .update(
        "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D" +
          "%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a" +
          "%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
      )
      .digest("base64");
    assert.match(sent, new RegExp(`oauth_signature="${percent(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  });

  it("firma el formulario cuando el cuerpo es urlencoded, y solo entonces", () => {
    const params = {
      consumerKey: "k",
      consumerSecret: "s",
      signatureMethod: "HMAC-SHA1",
      timestamp: "1",
      nonce: "n",
    };
    const asForm = signAuth(
      { type: "oauth1", params },
      {
        method: "POST",
        url: "http://example.com/x",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1",
      },
    );
    const asJson = signAuth(
      { type: "oauth1", params },
      { method: "POST", url: "http://example.com/x", headers: { "content-type": "application/json" }, body: '{"a":1}' },
    );
    assert.notEqual(header(asForm, "authorization"), header(asJson, "authorization"));
  });

  it("puede ir en la query en vez de en la cabecera", () => {
    const result = signAuth(
      {
        type: "oauth1",
        params: {
          consumerKey: "k",
          consumerSecret: "s",
          timestamp: "1",
          nonce: "n",
          addParamsToHeader: "false",
        },
      },
      { method: "GET", url: "http://example.com/x", headers: {} },
    );
    assert.deepEqual(result.headers, []);
    assert.ok(result.query.some((pair) => pair.name === "oauth_signature"));
  });
});

describe("AWS Signature v4", () => {
  const keys = {
    accessKey: "AKIDEXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
  };
  const when = Date.parse("2015-08-30T12:36:00Z");

  it("reproduce get-vanilla de la suite de pruebas de AWS", () => {
    const result = signAuth(
      { type: "awsv4", params: keys },
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, now: when },
    );
    assert.equal(
      header(result, "authorization"),
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("y get-vanilla-query-order-key, donde el orden de la query es parte de la firma", () => {
    const result = signAuth(
      { type: "awsv4", params: keys },
      { method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: {}, now: when },
    );
    assert.match(
      header(result, "authorization"),
      /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500/,
    );
  });

  it("una cabecera firmada cambia la firma, y va en minúsculas y ordenada", () => {
    const result = signAuth(
      { type: "awsv4", params: keys },
      {
        method: "POST",
        url: "https://example.amazonaws.com/",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "Param1=value1",
        now: when,
      },
    );
    assert.match(header(result, "authorization"), /SignedHeaders=content-type;host;x-amz-date/);
  });

  it("el cuerpo entra en la firma: cambiarlo cambia el hash", () => {
    const one = signAuth(
      { type: "awsv4", params: keys },
      { method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "a", now: when },
    );
    const two = signAuth(
      { type: "awsv4", params: keys },
      { method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "b", now: when },
    );
    assert.notEqual(header(one, "authorization"), header(two, "authorization"));
  });

  it("solo S3 lleva el hash del cuerpo también como cabecera", () => {
    const s3 = signAuth(
      { type: "awsv4", params: { ...keys, service: "s3" } },
      { method: "GET", url: "https://bucket.s3.amazonaws.com/key", headers: {}, now: when },
    );
    assert.ok(header(s3, "x-amz-content-sha256"));
    const other = signAuth(
      { type: "awsv4", params: keys },
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, now: when },
    );
    assert.equal(header(other, "x-amz-content-sha256"), "");
  });

  it("el token de sesión viaja y se firma", () => {
    const result = signAuth(
      { type: "awsv4", params: { ...keys, sessionToken: "tok" } },
      { method: "GET", url: "https://example.amazonaws.com/", headers: {}, now: when },
    );
    assert.equal(header(result, "x-amz-security-token"), "tok");
    assert.match(header(result, "authorization"), /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  });

  it("saca servicio y región del host cuando no se los dan", () => {
    const result = signAuth(
      { type: "awsv4", params: { accessKey: keys.accessKey, secretKey: keys.secretKey } },
      { method: "GET", url: "https://s3.eu-west-1.amazonaws.com/b/k", headers: {}, now: when },
    );
    assert.match(header(result, "authorization"), /20150830\/eu-west-1\/s3\/aws4_request/);
  });
});

describe("Hawk", () => {
  it("reproduce el mac del ejemplo de la especificación", () => {
    const result = signAuth(
      {
        type: "hawk",
        params: {
          authId: "dh37fgj492je",
          authKey: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn",
          algorithm: "sha256",
          timestamp: "1353832234",
          nonce: "j4h3g2",
          extraData: "some-app-ext-data",
        },
      },
      { method: "GET", url: "http://example.com:8000/resource/1?b=1&a=2", headers: {} },
    );
    assert.match(header(result, "authorization"), /mac="6R4rV5iE\+NPoym\+WwjeHzjAGXUtLNIxmo1vpMofpLAE="/);
  });

  it("con cuerpo añade su hash, y el hash entra en el mac", () => {
    const params = {
      authId: "dh37fgj492je",
      authKey: "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn",
      timestamp: "1353832234",
      nonce: "j4h3g2",
    };
    const withBody = signAuth(
      { type: "hawk", params },
      {
        method: "POST",
        url: "http://example.com:8000/resource/1",
        headers: { "content-type": "text/plain" },
        body: "Thank you for flying Hawk",
      },
    );
    assert.match(header(withBody, "authorization"), /hash="Yi9LfIIFRtBEPt74PVmbTF\/xVAwPn7ub15ePICfgnuY="/);
  });
});

describe("EdgeGrid y NTLM", () => {
  it("EdgeGrid firma con la marca de tiempo como clave, y el cuerpo solo cuenta en POST", () => {
    const params = {
      clientToken: "ct",
      accessToken: "at",
      clientSecret: "cs",
      timestamp: "20140321T19:34:21+0000",
      nonce: "n",
    };
    const post = signAuth(
      { type: "edgegrid", params },
      { method: "POST", url: "https://akaa-x.luna.akamaiapis.net/x", headers: {}, body: "{}" },
    );
    const get = signAuth(
      { type: "edgegrid", params },
      { method: "GET", url: "https://akaa-x.luna.akamaiapis.net/x", headers: {}, body: "{}" },
    );
    assert.match(header(post, "authorization"), /^EG1-HMAC-SHA256 client_token=ct;access_token=at;.*signature=/);
    assert.notEqual(header(post, "authorization"), header(get, "authorization"));
  });

  it("NTLM se reconoce y se dice que no, en vez de mandar media negociación", () => {
    const result = signAuth(
      { type: "ntlm", params: { username: "a", password: "b" } },
      { method: "GET", url: "/x", headers: {} },
    );
    assert.deepEqual(result.headers, []);
    assert.match(result.unsupported ?? "", /tres vueltas/i);
  });
});

describe("OAuth 2.0", () => {
  it("pone el token con su prefijo, o en la query si se le pide", () => {
    const asHeader = signAuth(
      { type: "oauth2", params: { accessToken: "abc" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    assert.equal(header(asHeader, "authorization"), "Bearer abc");
    const asQuery = signAuth(
      { type: "oauth2", params: { accessToken: "abc", addTokenTo: "queryParams" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    assert.deepEqual(asQuery.query, [{ name: "access_token", value: "abc" }]);
  });

  it("sin token y con un flujo de navegador lo dice en vez de sugerir un botón que no sirve", () => {
    const result = signAuth(
      { type: "oauth2", params: { grantType: "authorization_code" } },
      { method: "GET", url: "https://example.com/", headers: {} },
    );
    assert.match(result.unsupported ?? "", /navegador/i);
  });

  it("client_credentials va con la credencial en Basic, que es la que todo servidor acepta", () => {
    const made = tokenRequestFor({
      type: "oauth2",
      params: { accessTokenUrl: "https://id.example.com/token", clientId: "id", clientSecret: "secret", scope: "read" },
    });
    assert.ok("request" in made);
    assert.equal(made.request.headers.authorization, `Basic ${Buffer.from("id:secret").toString("base64")}`);
    assert.equal(made.request.body, "grant_type=client_credentials&scope=read");
  });

  it("y en el cuerpo cuando el servidor solo acepta eso", () => {
    const made = tokenRequestFor({
      type: "oauth2",
      params: {
        accessTokenUrl: "https://id.example.com/token",
        clientId: "id",
        clientSecret: "secret",
        client_authentication: "body",
      },
    });
    assert.ok("request" in made);
    assert.equal(made.request.headers.authorization, undefined);
    assert.match(made.request.body, /client_id=id&client_secret=secret/);
  });

  it("password lleva usuario y contraseña, y el grant que espera el RFC", () => {
    const made = tokenRequestFor({
      type: "oauth2",
      params: {
        grantType: "password_credentials",
        accessTokenUrl: "https://id.example.com/token",
        clientId: "id",
        username: "u",
        password: "p",
      },
    });
    assert.ok("request" in made);
    assert.match(made.request.body, /^grant_type=password&username=u&password=p$/);
  });

  it("una respuesta sin access_token no es un token", () => {
    assert.equal(readTokenResponse({ error: "invalid_client" }), null);
    assert.equal(readTokenResponse("abc"), null);
    assert.deepEqual(readTokenResponse({ access_token: "t", expires_in: 3600, scope: "read" }), {
      accessToken: "t",
      expiresIn: 3600,
      scope: "read",
    });
  });
});
