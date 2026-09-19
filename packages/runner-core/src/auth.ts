/**
 * Autenticación de una petición, con los mismos tipos que Postman y las firmas de verdad.
 *
 * Hasta ahora aquí había tres modos —heredar, ninguno, y un `Bearer` escrito a mano— y el bloque
 * `auth` de una colección importada se tiraba entero sin decirlo. Eso convierte «importa tu
 * colección» en «importa tu colección y vuelve a escribir cómo entra en tu API», que es
 * exactamente el trabajo que el import existe para no hacer.
 *
 * Todo lo que decide qué viaja está aquí y es **puro**: entra un descriptor y una petición, sale
 * una lista de cabeceras y de parámetros. Una firma AWS o un `qop` de Digest mal puestos son un
 * fallo que no se ve —la respuesta es un 403 idéntico al de una credencial caducada— así que cada
 * algoritmo se comprueba contra el ejemplo de su propia especificación, que es lo único que
 * distingue «firma» de «cadena con pinta de firma».
 *
 * Lo que **no** hace, dicho en vez de fingido:
 *
 * - **NTLM** necesita tres vueltas con el servidor negociando por `Authorization`, y una de ellas
 *   depende de la respuesta anterior. No es una firma: es un protocolo. Se reconoce y se dice.
 * - **OAuth 2.0 con redirección** (`authorization_code`, `implicit`) necesita un navegador donde la
 *   persona se identifique. Los flujos que no lo necesitan —`client_credentials`, `password`— sí se
 *   piden aquí, contra el servidor de token, con la misma red guardada que el resto.
 * - **Digest** y NTLM no se pueden firmar a ciegas: el `nonce` lo pone el servidor en su 401. Si no
 *   hay reto, esto lo pide (`needsChallenge`) en vez de mandar una cabecera inventada.
 */
import { constants, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";

/** Los tipos de Postman, con sus mismos nombres: un fichero suyo se lee sin traducir. */
export const AUTH_TYPES = [
  "none",
  "inherit",
  "basic",
  "bearer",
  "apikey",
  "jwt",
  "digest",
  "oauth1",
  "oauth2",
  "hawk",
  "awsv4",
  "edgegrid",
  "ntlm",
] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const isAuthType = (value: unknown): value is AuthType =>
  typeof value === "string" && (AUTH_TYPES as readonly string[]).includes(value);

/**
 * Cómo entra una petición, tal cual lo guarda Postman: un tipo y sus parámetros por nombre.
 *
 * Los parámetros van en un mapa plano y no en una unión por tipo, por lo mismo que el cuerpo de un
 * endpoint: quien cambia de `basic` a `bearer` y vuelve espera que su usuario siga escrito.
 */
export type RequestAuth = { type: AuthType; params: Record<string, string> };

export const NO_AUTH: RequestAuth = { type: "none", params: {} };

/** La petición ya resuelta —sin `{{variables}}`— que se va a firmar. */
export type AuthRequest = {
  method: string;
  /** Absoluta. La firma de AWS, Hawk y OAuth 1 depende del host, del puerto y de la query. */
  url: string;
  headers: Record<string, string>;
  /** El cuerpo tal cual sale. AWS lo hashea; Hawk lo hashea si se le pide. */
  body?: string | Uint8Array | null;
  /** El `WWW-Authenticate` de un 401 anterior, que es de donde Digest saca su `nonce`. */
  challenge?: string | null;
  /** Fijos en las pruebas, para que una firma sea comparable. */
  now?: number;
  nonce?: string;
};

export type AuthPair = { name: string; value: string };

export type AuthResult = {
  headers: AuthPair[];
  query: AuthPair[];
  /** El cuerpo, cuando el modo lo toca: OAuth 1 puede firmar dentro de un formulario. */
  bodyFields: AuthPair[];
  /** Hay que pedir el 401 primero: sin el reto del servidor no hay firma posible. */
  needsChallenge: boolean;
  /** Por qué no se firmó, cuando no se firmó. Se enseña; no se calla. */
  unsupported: string | null;
};

const empty = (): AuthResult => ({ headers: [], query: [], bodyFields: [], needsChallenge: false, unsupported: null });

const value = (auth: RequestAuth, name: string, fallback = ""): string => {
  const raw = auth.params[name];
  return typeof raw === "string" && raw !== "" ? raw : fallback;
};

const flag = (auth: RequestAuth, name: string): boolean => /^(true|1|yes)$/i.test(value(auth, name));

/**
 * La cabecera —o el parámetro— con el que la petición entra.
 *
 * No lanza nunca. Una credencial a medio escribir es lo normal mientras alguien la escribe, y un
 * editor que explota a la mitad de un campo no se puede usar; lo que sale es un resultado vacío con
 * el motivo puesto.
 */
export function signAuth(auth: RequestAuth, request: AuthRequest): AuthResult {
  switch (auth.type) {
    case "none":
    case "inherit":
      return empty();
    case "basic":
      return basic(auth);
    case "bearer":
      return bearer(auth);
    case "apikey":
      return apikey(auth);
    case "jwt":
      return jwt(auth, request);
    case "digest":
      return digest(auth, request);
    case "oauth1":
      return oauth1(auth, request);
    case "oauth2":
      return oauth2(auth);
    case "hawk":
      return hawk(auth, request);
    case "awsv4":
      return awsv4(auth, request);
    case "edgegrid":
      return edgegrid(auth, request);
    case "ntlm":
      return {
        ...empty(),
        unsupported:
          "NTLM necesita tres vueltas negociando con el servidor, no una firma. Usa un proxy que lo haga o otra autenticación.",
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Los dos de siempre

function basic(auth: RequestAuth): AuthResult {
  const user = value(auth, "username");
  const password = value(auth, "password");
  const encoded = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  return { ...empty(), headers: [{ name: "Authorization", value: `Basic ${encoded}` }] };
}

function bearer(auth: RequestAuth): AuthResult {
  const token = value(auth, "token").trim();
  if (!token) return { ...empty(), unsupported: "Falta el token" };
  return { ...empty(), headers: [{ name: "Authorization", value: `Bearer ${token}` }] };
}

/**
 * Una clave, en la cabecera o en la query.
 *
 * `in` se llama `in` porque así se llama en el fichero de Postman. Por defecto va en la cabecera,
 * que es lo que hace Postman y además lo único que no acaba en el log de accesos del servidor.
 */
function apikey(auth: RequestAuth): AuthResult {
  const key = value(auth, "key");
  const secret = value(auth, "value");
  if (!key) return { ...empty(), unsupported: "Falta el nombre de la clave" };
  const where = value(auth, "in", "header").toLowerCase();
  const pair = { name: key, value: secret };
  return where === "query" ? { ...empty(), query: [pair] } : { ...empty(), headers: [pair] };
}

// ---------------------------------------------------------------------------------------------
// JWT, firmado aquí

const JWT_ALGORITHMS = ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512"] as const;

/**
 * El JWT que Postman construye y firma en el momento, no uno pegado a mano.
 *
 * `secretBase64Encoded` existe porque la mitad de los secretos HMAC del mundo se publican en
 * base64 y firmarlos como texto da un token que valida en ningún sitio.
 */
function jwt(auth: RequestAuth, request: AuthRequest): AuthResult {
  const algorithm = value(auth, "algorithm", "HS256").toUpperCase();
  if (!(JWT_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return { ...empty(), unsupported: `Algoritmo ${algorithm} no soportado; usa ${JWT_ALGORITHMS.join(", ")}` };
  }
  const secret = value(auth, "secret");
  if (!secret) return { ...empty(), unsupported: "Falta el secreto o la clave privada" };

  let payload: Record<string, unknown>;
  try {
    const raw = value(auth, "payload", "{}");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("no es un objeto");
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ...empty(), unsupported: "El payload del JWT tiene que ser un objeto JSON" };
  }

  let headerExtra: Record<string, unknown> = {};
  if (auth.params.headers) {
    try {
      const parsed: unknown = JSON.parse(auth.params.headers);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        headerExtra = parsed as Record<string, unknown>;
      }
    } catch {
      return { ...empty(), unsupported: "Las cabeceras del JWT tienen que ser un objeto JSON" };
    }
  }

  const header = { ...headerExtra, alg: algorithm, typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  let signature: string;
  try {
    signature = signJwt(algorithm, signingInput, secret, flag(auth, "secretBase64Encoded"));
  } catch (error) {
    return { ...empty(), unsupported: `No se pudo firmar el JWT: ${(error as Error).message}` };
  }

  const token = `${signingInput}.${signature}`;
  const prefix = value(auth, "headerPrefix", "Bearer").trim();
  if (value(auth, "addTokenTo", "header").toLowerCase() === "queryparams") {
    return { ...empty(), query: [{ name: value(auth, "queryParamKey", "token"), value: token }] };
  }
  void request;
  return { ...empty(), headers: [{ name: "Authorization", value: prefix ? `${prefix} ${token}` : token }] };
}

function signJwt(algorithm: string, input: string, secret: string, base64Secret: boolean): string {
  const bits = algorithm.slice(2);
  if (algorithm.startsWith("HS")) {
    const key = base64Secret ? Buffer.from(secret, "base64") : Buffer.from(secret, "utf8");
    return createHmac(`sha${bits}`, key).update(input).digest("base64url");
  }
  const signer = createSign(`sha${bits}`);
  signer.update(input);
  // `PS*` es la misma clave RSA con relleno probabilístico y sal del tamaño del resumen, que es lo
  // que dice la RFC 7518 para esa familia; `RS*` es el relleno clásico, el que asume `sign` solo.
  const key = algorithm.startsWith("PS")
    ? { key: secret, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(bits) / 8 }
    : { key: secret };
  return signer.sign(key).toString("base64url");
}

const base64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

// ---------------------------------------------------------------------------------------------
// Digest: RFC 7616, y hace falta el 401 primero

const DIGEST_ALGORITHMS = ["MD5", "MD5-SESS", "SHA-256", "SHA-256-SESS", "SHA-512-256", "SHA-512-256-SESS"];

/**
 * Digest, con el `nonce` del servidor y no con uno inventado.
 *
 * Firmar sin reto es imposible por diseño del esquema: el `nonce` y el `realm` los pone el
 * servidor en su 401, y son parte de la firma. Cuando el reto no está, esto devuelve
 * `needsChallenge` para que quien haga la I/O pida el 401 y vuelva; mandar una cabecera a medias
 * solo cambia un 401 claro por un 400 raro.
 *
 * `MD5` sigue aquí porque sigue en los servidores: el esquema lo exige como valor por defecto y una
 * API que solo habla MD5 no se vuelve más segura porque este cliente se niegue a hablarle. Es
 * autenticación contra el objetivo del cliente, no almacenamiento de credenciales nuestro.
 */
function digest(auth: RequestAuth, request: AuthRequest): AuthResult {
  const challenge = parseChallenge(request.challenge ?? "", "digest");
  const realm = value(auth, "realm", challenge.realm ?? "");
  const nonce = value(auth, "nonce", challenge.nonce ?? "");
  if (!nonce) return { ...empty(), needsChallenge: true };

  const algorithm = value(auth, "algorithm", challenge.algorithm ?? "MD5").toUpperCase();
  if (!DIGEST_ALGORITHMS.includes(algorithm)) {
    return { ...empty(), unsupported: `Digest con ${algorithm} no soportado` };
  }
  const user = value(auth, "username");
  const password = value(auth, "password");
  const hash = digestHasher(algorithm);
  const sess = algorithm.endsWith("-SESS");

  const uri = value(auth, "uri", pathWithQuery(request.url));
  const method = request.method.toUpperCase();
  const qopOffered = value(auth, "qop", challenge.qop ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const qop = qopOffered.includes("auth") ? "auth" : qopOffered.includes("auth-int") ? "auth-int" : "";
  const cnonce = value(auth, "clientNonce", request.nonce ?? randomBytes(8).toString("hex"));
  const nc = value(auth, "nonceCount", "00000001");

  let ha1 = hash(`${user}:${realm}:${password}`);
  if (sess) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const a2 = qop === "auth-int" ? `${method}:${uri}:${hash(bodyText(request.body))}` : `${method}:${uri}`;
  const ha2 = hash(a2);
  const response = qop ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${escapeQuoted(user)}"`,
    `realm="${escapeQuoted(realm)}"`,
    `nonce="${escapeQuoted(nonce)}"`,
    `uri="${escapeQuoted(uri)}"`,
    `algorithm=${algorithm === "MD5" ? "MD5" : algorithm}`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${escapeQuoted(cnonce)}"`);
  const opaque = value(auth, "opaque", challenge.opaque ?? "");
  if (opaque) parts.push(`opaque="${escapeQuoted(opaque)}"`);
  return { ...empty(), headers: [{ name: "Authorization", value: `Digest ${parts.join(", ")}` }] };
}

function digestHasher(algorithm: string): (text: string) => string {
  const base = algorithm.replace(/-SESS$/, "");
  if (base === "MD5") return (text) => createHash("md5").update(text, "utf8").digest("hex");
  if (base === "SHA-256") return (text) => createHash("sha256").update(text, "utf8").digest("hex");
  // SHA-512-256 es SHA-512 truncado a 256 bits, que es lo que dice el RFC y no SHA-256.
  return (text) => createHash("sha512").update(text, "utf8").digest("hex").slice(0, 64);
}

/**
 * El `WWW-Authenticate` del 401, partido.
 *
 * Se parte con un recorrido y no con una expresión regular sobre la coma: un `qop="auth,auth-int"`
 * lleva comas *dentro* de las comillas, y partir por ellas da parámetros que no existen.
 */
export function parseChallenge(header: string, scheme: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const candidate of splitChallenges(header)) {
    if (!candidate.toLowerCase().startsWith(scheme.toLowerCase())) continue;
    const rest = candidate.slice(scheme.length).trim();
    for (const [, key, quoted, bare] of rest.matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) {
      // Una de las dos alternativas casa siempre: sin comillas, `bare` es el valor (quizá vacío).
      found[key.toLowerCase()] = (quoted ?? bare).replace(/\\(.)/g, "$1");
    }
    break;
  }
  return found;
}

/** Un 401 puede ofrecer varios esquemas en la misma cabecera, separados por comas fuera de comillas. */
function splitChallenges(header: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === '"' && header[index - 1] !== "\\") quoted = !quoted;
    // Un esquema nuevo empieza tras una coma con una palabra sin `=`: `Digest realm="x", Basic realm="y"`.
    if (
      !quoted &&
      char === "," &&
      /^\s*[A-Za-z][A-Za-z0-9-]*(\s|$)/.test(header.slice(index + 1).replace(/^\s+/, " "))
    ) {
      const ahead = header.slice(index + 1).trimStart();
      const word = /^([A-Za-z][A-Za-z0-9-]*)(\s+)([A-Za-z0-9_-]+\s*=)/.exec(ahead);
      if (word) {
        out.push(current.trim());
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const escapeQuoted = (text: string): string => text.replace(/(["\\])/g, "\\$1");

// ---------------------------------------------------------------------------------------------
// OAuth 1.0a

const OAUTH1_SIGNATURES = ["HMAC-SHA1", "HMAC-SHA256", "HMAC-SHA512", "RSA-SHA1", "PLAINTEXT"];

/**
 * OAuth 1.0a, con la cadena base montada como dice el RFC 5849.
 *
 * Lo delicado no es el HMAC: es que la cadena base lleva **todos** los parámetros —los de la query
 * y los del formulario y los `oauth_*`— codificados uno a uno, ordenados por clave y luego por
 * valor, y concatenados codificando otra vez. Un `+` o un `%20` de más aquí es un 401 sin
 * explicación.
 */
function oauth1(auth: RequestAuth, request: AuthRequest): AuthResult {
  const signatureMethod = value(auth, "signatureMethod", "HMAC-SHA1").toUpperCase();
  if (!OAUTH1_SIGNATURES.includes(signatureMethod)) {
    return { ...empty(), unsupported: `Firma ${signatureMethod} no soportada en OAuth 1.0` };
  }
  const consumerKey = value(auth, "consumerKey");
  if (!consumerKey) return { ...empty(), unsupported: "Falta la consumer key" };

  const url = safeUrl(request.url);
  if (!url) return { ...empty(), unsupported: "La URL no es absoluta y OAuth 1.0 firma el host" };

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_signature_method: signatureMethod,
    oauth_timestamp: value(auth, "timestamp", String(Math.floor((request.now ?? Date.now()) / 1000))),
    oauth_nonce: value(auth, "nonce", request.nonce ?? randomBytes(16).toString("hex")),
  };
  // `oauth_version` es opcional en el RFC 5849 y hay servidores que rechazan la petición si viaja.
  // Va por defecto porque es lo que manda Postman, y `version: ""` lo quita.
  const version = auth.params.version === undefined ? "1.0" : auth.params.version;
  if (version) oauthParams.oauth_version = version;
  const token = value(auth, "token");
  if (token) oauthParams.oauth_token = token;
  const realm = value(auth, "realm");
  const callback = value(auth, "callback");
  if (callback) oauthParams.oauth_callback = callback;
  const verifier = value(auth, "verifier");
  if (verifier) oauthParams.oauth_verifier = verifier;

  // El formulario entra en la firma solo si el cuerpo es urlencoded, que es lo que dice el RFC.
  const formParams: [string, string][] = [];
  const contentType = headerOf(request.headers, "content-type");
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    // En array y no en mapa: `a=1&a=2` son dos parámetros para la firma, y un mapa dejaría uno.
    for (const pair of new URLSearchParams(bodyText(request.body))) formParams.push([pair[0], pair[1]]);
  }

  const all: [string, string][] = [];
  for (const [key, item] of url.searchParams) all.push([key, item]);
  for (const [key, item] of formParams) all.push([key, item]);
  for (const [key, item] of Object.entries(oauthParams)) all.push([key, item]);

  const base = oauth1BaseString(request.method, url, all);

  const consumerSecret = value(auth, "consumerSecret");
  const tokenSecret = value(auth, "tokenSecret");
  const signingKey = `${percent(consumerSecret)}&${percent(tokenSecret)}`;

  let signature: string;
  try {
    signature = oauth1Signature(signatureMethod, base, signingKey, consumerSecret, request.url);
  } catch (error) {
    return { ...empty(), unsupported: `No se pudo firmar: ${(error as Error).message}` };
  }
  oauthParams.oauth_signature = signature;

  if (value(auth, "addParamsToHeader", "true") === "false") {
    const pairs = Object.entries(oauthParams).map(([name, item]) => ({ name, value: item }));
    return /application\/x-www-form-urlencoded/i.test(contentType) && request.method.toUpperCase() !== "GET"
      ? { ...empty(), bodyFields: pairs }
      : { ...empty(), query: pairs };
  }
  const parts = Object.entries(oauthParams).map(([name, item]) => `${percent(name)}="${percent(item)}"`);
  if (realm) parts.unshift(`realm="${escapeQuoted(realm)}"`);
  return { ...empty(), headers: [{ name: "Authorization", value: `OAuth ${parts.join(", ")}` }] };
}

function oauth1Signature(method: string, base: string, key: string, consumerSecret: string, url: string): string {
  if (method === "PLAINTEXT") return key;
  if (method === "RSA-SHA1") {
    const signer = createSign("sha1");
    signer.update(base);
    void url;
    return signer.sign(consumerSecret).toString("base64");
  }
  const bits = method.replace("HMAC-SHA", "");
  return createHmac(`sha${bits === "1" ? "1" : bits}`, key)
    .update(base)
    .digest("base64");
}

/**
 * La cadena base de OAuth 1, que es donde está la dificultad entera del esquema.
 *
 * Se exporta para poder compararla con la publicada en el RFC 5849 §3.4.1.1. Es la única forma de
 * comprobar esto contra algo ajeno: la firma en sí es un HMAC que calcula la plataforma, mientras
 * que la cadena —codificar cada parámetro, ordenar por clave y luego por valor, juntarlos y
 * codificar el resultado otra vez— la construye este fichero y es donde se falla.
 */
export function oauth1BaseString(method: string, url: URL, params: [string, string][]): string {
  const normalized = params
    .map(([key, item]) => [percent(key), percent(item)] as const)
    .sort(byBytes)
    .map(([key, item]) => `${key}=${item}`)
    .join("&");
  return [method.toUpperCase(), percent(`${url.origin}${url.pathname}`), percent(normalized)].join("&");
}

/**
 * El porcentaje de OAuth, que no es el de `encodeURIComponent`.
 *
 * `!`, `'`, `(`, `)` y `*` quedan sin codificar en `encodeURIComponent` y el RFC 5849 exige que se
 * codifiquen. Son cinco caracteres y son la diferencia entre firmar y no.
 */
/**
 * El orden de OAuth 1 (RFC 5849 §3.4.1.3.2) y de AWS: por clave y luego por valor, **byte a byte**.
 *
 * No `localeCompare`: ese pone `a` antes que `B` y `a_b` antes que `aZ`, y el servidor, que ordena
 * por bytes, calcula otra cadena y contesta 401. Las dos van ya codificadas, así que son ASCII y
 * comparar con `<` es comparar bytes.
 */
const byBytes = (left: readonly [string, string], right: readonly [string, string]): number =>
  compareBytes(left[0], right[0]) || compareBytes(left[1], right[1]);

const compareBytes = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export const percent = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

// ---------------------------------------------------------------------------------------------
// OAuth 2.0: el token puesto, y los flujos que no necesitan navegador

/** Lo que Postman llama `grant_type`. Los dos primeros se piden aquí; los otros dos, en un navegador. */
export const OAUTH2_GRANTS = ["client_credentials", "password_credentials", "authorization_code", "implicit"] as const;
export type Oauth2Grant = (typeof OAUTH2_GRANTS)[number];

function oauth2(auth: RequestAuth): AuthResult {
  const token = value(auth, "accessToken").trim();
  if (!token) {
    const grant = value(auth, "grantType", "client_credentials");
    return {
      ...empty(),
      unsupported:
        grant === "authorization_code" || grant === "implicit"
          ? "Ese flujo necesita que alguien se identifique en un navegador. Pide el token y pégalo aquí."
          : "Falta el token. Dale a «Pedir token» o pégalo.",
    };
  }
  const prefix = value(auth, "headerPrefix", "Bearer").trim();
  if (value(auth, "addTokenTo", "header").toLowerCase() === "queryparams") {
    return { ...empty(), query: [{ name: value(auth, "queryParamKey", "access_token"), value: token }] };
  }
  return { ...empty(), headers: [{ name: "Authorization", value: prefix ? `${prefix} ${token}` : token }] };
}

/** La petición al servidor de token, armada aquí para que la haga quien tenga la red guardada. */
export type TokenRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

/**
 * Qué mandarle al servidor de token para los flujos sin navegador.
 *
 * `client_secret_basic` es el que manda el RFC 6749 como obligatorio en el servidor, así que es el
 * de por defecto; `client_secret_post` existe porque hay servidores que solo aceptan ese.
 */
export function tokenRequestFor(auth: RequestAuth): { request: TokenRequest } | { unsupported: string } {
  const grant = value(auth, "grantType", "client_credentials");
  if (grant !== "client_credentials" && grant !== "password_credentials") {
    return { unsupported: "Solo se piden aquí los flujos que no necesitan navegador" };
  }
  const url = value(auth, "accessTokenUrl");
  if (!url) return { unsupported: "Falta la URL del servidor de token" };
  const clientId = value(auth, "clientId");
  if (!clientId) return { unsupported: "Falta el client id" };
  const clientSecret = value(auth, "clientSecret");

  const form = new URLSearchParams();
  form.set("grant_type", grant === "password_credentials" ? "password" : "client_credentials");
  const scope = value(auth, "scope");
  if (scope) form.set("scope", scope);
  if (grant === "password_credentials") {
    form.set("username", value(auth, "username"));
    form.set("password", value(auth, "password"));
  }
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (value(auth, "client_authentication", "header") === "body") {
    form.set("client_id", clientId);
    if (clientSecret) form.set("client_secret", clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
  }
  return { request: { url, method: "POST", headers, body: form.toString() } };
}

/** La respuesta del servidor de token, leída sin confiar en ella. */
export function readTokenResponse(
  raw: unknown,
): { accessToken: string; expiresIn: number | null; scope: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (!token) return null;
  const expires = typeof body.expires_in === "number" ? body.expires_in : Number(body.expires_in);
  return {
    accessToken: token,
    expiresIn: Number.isFinite(expires) && expires > 0 ? expires : null,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

// ---------------------------------------------------------------------------------------------
// Hawk

/**
 * Hawk, con su cadena `hawk.1.header`.
 *
 * El hash del cuerpo es opcional en el esquema y aquí se calcula cuando hay cuerpo, porque una
 * firma que no cubre el cuerpo deja que cualquiera lo cambie por el camino sin invalidarla.
 */
function hawk(auth: RequestAuth, request: AuthRequest): AuthResult {
  const id = value(auth, "authId");
  const key = value(auth, "authKey");
  if (!id || !key) return { ...empty(), unsupported: "Faltan el id o la clave de Hawk" };
  const algorithm = value(auth, "algorithm", "sha256").toLowerCase();
  if (algorithm !== "sha256" && algorithm !== "sha1") {
    return { ...empty(), unsupported: `Hawk con ${algorithm} no soportado` };
  }
  const url = safeUrl(request.url);
  if (!url) return { ...empty(), unsupported: "La URL no es absoluta y Hawk firma el host" };

  const timestamp = value(auth, "timestamp", String(Math.floor((request.now ?? Date.now()) / 1000)));
  const nonce = value(auth, "nonce", request.nonce ?? randomBytes(3).toString("hex"));
  const extra = value(auth, "extraData");
  const app = value(auth, "app");
  const dlg = value(auth, "delegation");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  const body = bodyText(request.body);
  let payloadHash = "";
  if (body) {
    const contentType = headerOf(request.headers, "content-type").split(";")[0].trim().toLowerCase();
    payloadHash = createHash(algorithm).update(`hawk.1.payload\n${contentType}\n${body}\n`, "utf8").digest("base64");
  }

  const normalized = [
    "hawk.1.header",
    timestamp,
    nonce,
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    url.hostname.toLowerCase(),
    port,
    payloadHash,
    extra,
    "",
  ].join("\n");
  const mac = createHmac(algorithm, key).update(normalized, "utf8").digest("base64");

  const parts = [`id="${escapeQuoted(id)}"`, `ts="${timestamp}"`, `nonce="${escapeQuoted(nonce)}"`];
  if (payloadHash) parts.push(`hash="${payloadHash}"`);
  if (extra) parts.push(`ext="${escapeQuoted(extra)}"`);
  if (app) parts.push(`app="${escapeQuoted(app)}"`);
  if (dlg) parts.push(`dlg="${escapeQuoted(dlg)}"`);
  parts.push(`mac="${mac}"`);
  return { ...empty(), headers: [{ name: "Authorization", value: `Hawk ${parts.join(", ")}` }] };
}

// ---------------------------------------------------------------------------------------------
// AWS Signature v4

/**
 * La firma de AWS, entera: petición canónica, cadena a firmar y clave derivada por fecha.
 *
 * Es el algoritmo más quisquilloso de todos los que hay aquí. Las cabeceras firmadas van en
 * minúsculas y ordenadas, sus valores con los espacios colapsados, la ruta y la query codificadas
 * dos veces en unos servicios y una en S3, y el hash del cuerpo va **también** como cabecera. El
 * caso de la propia documentación de AWS está en las pruebas, que es la única forma de saber que
 * esto firma de verdad.
 */
function awsv4(auth: RequestAuth, request: AuthRequest): AuthResult {
  const accessKey = value(auth, "accessKey");
  const secretKey = value(auth, "secretKey");
  if (!accessKey || !secretKey) return { ...empty(), unsupported: "Faltan las claves de AWS" };
  const url = safeUrl(request.url);
  if (!url) return { ...empty(), unsupported: "La URL no es absoluta y la firma de AWS cubre el host" };

  const service = value(auth, "service") || serviceFromHost(url.hostname);
  const region = value(auth, "region") || regionFromHost(url.hostname) || "us-east-1";
  if (!service) return { ...empty(), unsupported: "Falta el servicio de AWS" };

  const stamp = new Date(request.now ?? Date.now()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8);
  const sessionToken = value(auth, "sessionToken");

  const signed: Record<string, string> = {};
  for (const [name, item] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "connection" || lower === "content-length") continue;
    signed[lower] = String(item).trim().replace(/\s+/g, " ");
  }
  signed.host = url.host;
  signed["x-amz-date"] = stamp;
  if (sessionToken) signed["x-amz-security-token"] = sessionToken;
  const payloadHash = createHash("sha256").update(bodyText(request.body), "utf8").digest("hex");
  // Solo S3 y Glacier piden el hash del cuerpo *también* como cabecera, y por tanto solo ahí entra
  // en las cabeceras firmadas. Ponerlo siempre da una firma que no coincide con la de AWS.
  const hashHeader = service === "s3" || service === "glacier";
  if (hashHeader) signed["x-amz-content-sha256"] = payloadHash;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join("");
  const signedHeaders = names.join(";");

  const query = [...url.searchParams.entries()]
    .map(([key, item]) => [percent(key), percent(item)] as const)
    .sort(byBytes)
    .map(([key, item]) => `${key}=${item}`)
    .join("&");

  const canonicalPath = service === "s3" ? url.pathname || "/" : canonicalUri(url.pathname);
  const canonical = [
    request.method.toUpperCase(),
    canonicalPath,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonical, "utf8").digest("hex")].join(
    "\n",
  );

  let key = createHmac("sha256", `AWS4${secretKey}`).update(date).digest();
  for (const part of [region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");

  const headers: AuthPair[] = [
    { name: "X-Amz-Date", value: stamp },
    ...(hashHeader ? [{ name: "X-Amz-Content-Sha256", value: payloadHash }] : []),
    {
      name: "Authorization",
      value: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  ];
  if (sessionToken) headers.splice(1, 0, { name: "X-Amz-Security-Token", value: sessionToken });
  return { ...empty(), headers };
}

/** La ruta canónica: cada segmento codificado, y la codificación aplicada dos veces salvo en S3. */
const canonicalUri = (pathname: string): string =>
  pathname
    .split("/")
    .map((segment) => percent(decodeURIComponent(segment)))
    .join("/") || "/";

const serviceFromHost = (host: string): string => {
  const parts = host.split(".");
  const index = parts.indexOf("amazonaws");
  return index > 0 ? parts[0] : "";
};

const regionFromHost = (host: string): string => {
  const match = /\.([a-z]{2}-[a-z]+-\d)\./.exec(host);
  return match?.[1] ?? "";
};

// ---------------------------------------------------------------------------------------------
// Akamai EdgeGrid

/**
 * EG1-HMAC-SHA256, de Akamai.
 *
 * Lo llamativo del esquema: la clave con la que se firma es el HMAC de la *marca de tiempo*, y la
 * cabecera se firma **incluyéndose a sí misma** sin el `signature=` final. Quien lo lea sin saberlo
 * dará por hecho que falta un paso.
 */
function edgegrid(auth: RequestAuth, request: AuthRequest): AuthResult {
  const token = value(auth, "accessToken");
  const clientToken = value(auth, "clientToken");
  const secret = value(auth, "clientSecret");
  if (!token || !clientToken || !secret) return { ...empty(), unsupported: "Faltan credenciales de EdgeGrid" };
  const url = safeUrl(request.url);
  if (!url) return { ...empty(), unsupported: "La URL no es absoluta" };

  const timestamp = value(auth, "timestamp", edgegridStamp(request.now ?? Date.now()));
  const nonce = value(auth, "nonce", request.nonce ?? randomBytes(16).toString("hex"));
  const head = `EG1-HMAC-SHA256 client_token=${clientToken};access_token=${token};timestamp=${timestamp};nonce=${nonce};`;

  const body = bodyText(request.body);
  const maxBody = Number(value(auth, "maxBodySize", "131072")) || 131072;
  const contentHash =
    request.method.toUpperCase() === "POST" && body
      ? createHash("sha256").update(body.slice(0, maxBody), "utf8").digest("base64")
      : "";

  const data = [
    request.method.toUpperCase(),
    url.protocol.replace(":", ""),
    url.host,
    `${url.pathname}${url.search}`,
    "",
    contentHash,
    head,
  ].join("\t");
  const signingKey = createHmac("sha256", secret).update(timestamp).digest("base64");
  const signature = createHmac("sha256", signingKey).update(data, "utf8").digest("base64");
  return { ...empty(), headers: [{ name: "Authorization", value: `${head}signature=${signature}` }] };
}

const edgegridStamp = (now: number): string => {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}:${iso.slice(14, 16)}:${iso.slice(17, 19)}+0000`;
};

// ---------------------------------------------------------------------------------------------

const bodyText = (body: string | Uint8Array | null | undefined): string => {
  if (!body) return "";
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
};

const headerOf = (headers: Record<string, string>, name: string): string => {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? String(found[1]) : "";
};

const safeUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const pathWithQuery = (raw: string): string => {
  const url = safeUrl(raw);
  if (url) return `${url.pathname}${url.search}`;
  return raw.startsWith("/") ? raw : `/${raw}`;
};

/** Para comparar firmas en pruebas sin filtrar por tiempo cuál falló. */
export const sameSignature = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
