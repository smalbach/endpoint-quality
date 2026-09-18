import { createHmac, randomUUID } from "node:crypto";
import { Inject } from "@nestjs/common";
import { CommandHandler, type ICommand, type ICommandHandler } from "@nestjs/cqrs";
import {
  interpolateText,
  unresolvedVariables,
  valueAtPath,
  withEnvironmentNamespace,
  type ComputedSeed,
} from "@eq/runner-core";

import {
  cookieKey,
  cookiesFrom,
  liveCookies,
  matchingCookies,
  withCookies,
  type Cookie,
} from "@eq/runner-core";
import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import {
  AUTH_LABELS,
  SECRET_PARAMS,
  readTokenResponse,
  signAuth,
  tokenRequestFor,
  type RequestAuth,
} from "./auth-bridge";
import { SAFE_FETCH, BlockedTargetError, type RequestTiming, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import {
  SCRIPT_SANDBOX,
  redactOutcome,
  type ScriptInput,
  type ScriptLogLevel,
  type ScriptOutcome,
  type ScriptSandboxPort,
} from "@/shared/scripts/script-sandbox";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Project } from "@/modules/projects/domain/model";
import {
  ENVIRONMENT_REPOSITORY,
  COOKIE_JAR_REPOSITORY,
  SESSION_TOKEN_REPOSITORY,
  type EnvironmentRepositoryPort,
  type CookieJarRepositoryPort,
  type SessionTokenRepositoryPort,
} from "@/modules/environments/domain/ports";
import {
  applyScriptWrites,
  credentialHeader,
  resolveVariables,
  type Environment,
} from "@/modules/environments/domain/model";
import { isExpired, type SessionTokenSource } from "@/modules/environments/domain/session-token";
import { captureSessionToken } from "@/modules/environments/application/commands/session-token";
import {
  blockedUpload,
  buildUrl,
  graphqlOverGet,
  maskHeaders,
  readSendInput,
  serializeBody,
  TOKEN_PATHS,
  unfilledPlaceholders,
  type SendInput,
  type UploadedPart,
} from "../../domain/send-request";

export class SendEndpointRequestCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    /** The `request` part of the form, still a JSON string. */
    readonly request: string | undefined,
    readonly files: UploadedPart[],
    /** Whose session token is used and captured. */
    readonly actorId: string,
  ) {}
}

export type ScriptRunView = {
  error: string | null;
  logs: { level: ScriptLogLevel; text: string }[];
  tests: { name: string; passed: boolean; message: string | null }[];
  environmentUpdates: string[];
  durationMs: number;
};

export type SentRequestView = {
  request: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    sizeBytes: number;
    durationMs: number;
    timing: RequestTiming;
  } | null;
  /** Why there is no response: the target could not be reached, the guard refused it, or the
   * pre-request script failed. */
  error: string | null;
  /** Where the credential came from, in words, because «¿con qué token fue?» is the first question. */
  auth: string;
  environment: { id: string; name: string } | null;
  scripts: { pre: ScriptRunView | null; post: ScriptRunView | null };
  sessionToken: SessionTokenSource | null;
  /**
   * Qué cookies se presentaron, qué se guardó de la respuesta, y qué no se guardó y por qué.
   *
   * Lo rechazado se enseña: una cookie que el servidor puso para otro dominio no se guarda, y sin
   * decirlo el resultado es un 401 en la petición siguiente que nadie puede explicar.
   */
  cookies: { sent: string[]; stored: string[]; rejected: { line: string; why: string }[] };
};

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * One request from the endpoint editor, sent now and answered in the same response.
 *
 * Nothing is stored but what the person asked for: no run, no history row — only the current values
 * a script wrote and the session token it or the login captured. What makes it safe to offer to an
 * editor is what every other request of this product already goes through — the SSRF guard, the
 * environment's `writesAllowed`, credentials decrypted here and masked in the echo — plus scripts in
 * a process of their own, whose console output has every secret masked.
 *
 * In order:
 * 1. the pre-request script, which may set variables and change headers; if it throws, nothing is
 *    sent — a signature it failed to compute is not a request worth making;
 * 2. the request, with the credential from, in order: an `Authorization` header typed in the editor;
 *    `auth.mode: "bearer"` with a token for this request only; and `inherit`, which is the person's
 *    captured session token while it has not expired, then the project's authentication, then the
 *    environment's `primary` credential;
 * 3. the post-response script, which may set variables and run tests.
 */
@CommandHandler(SendEndpointRequestCommand)
export class SendEndpointRequestHandler implements ICommandHandler<SendEndpointRequestCommand, SentRequestView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SESSION_TOKEN_REPOSITORY) private readonly sessionTokens: SessionTokenRepositoryPort,
    @Inject(COOKIE_JAR_REPOSITORY) private readonly cookieJar: CookieJarRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    @Inject(SCRIPT_SANDBOX) private readonly sandbox: ScriptSandboxPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SendEndpointRequestCommand): Promise<SentRequestView> {
    const read = readSendInput(command.request);
    if ("problems" in read) throw new InvalidInputError("La petición no es válida", read.problems);
    const input = read.input;
    const blocked = blockedUpload(command.files);
    if (blocked)
      throw new InvalidInputError("Fichero no permitido", [{ field: "files", detail: blocked }], "file-type-blocked");

    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    const environment = input.environmentId ? await this.environments.findById(input.environmentId) : null;
    if (input.environmentId && (!environment || environment.projectId !== project.id))
      throw new NotFoundError("El entorno no existe", "environment-not-found");

    if (environment && !environment.writesAllowed && !IDEMPOTENT.has(input.method)) {
      throw new ConflictError(
        `El entorno «${environment.name}» no permite escrituras: actívalas en sus ajustes para enviar un ${input.method}`,
        "writes-not-allowed",
      );
    }

    const decrypt = (payload: string) => this.cipher.decrypt(payload);
    const projectSecrets = project.auth.secretCiphertext
      ? (JSON.parse(decrypt(project.auth.secretCiphertext)) as Record<string, string | undefined>)
      : {};
    const run = new ScriptSession(this.sandbox, this.environments, this.cipher, environment, [
      ...Object.values(projectSecrets).filter((value): value is string => typeof value === "string"),
    ]);
    const environmentView = environment ? { id: environment.id, name: environment.name } : null;
    const scripts: SentRequestView["scripts"] = { pre: null, post: null };
    let captured: SessionTokenSource | null = null;

    let headerRows = input.headers;
    if (input.preRequestScript.trim()) {
      const outcome = await run.execute({
        phase: "pre",
        code: input.preRequestScript,
        variables: {},
        request: {
          method: input.method,
          url: input.path,
          headers: headerMap(headerRows),
          // Una operación GraphQL se enseña como su texto: es lo que el script puede leer antes de
          // que las variables tengan valor, y lo que un `pm.request.body` de Postman trae en `graphql.query`.
          body:
            input.body.mode === "json" || input.body.mode === "raw" || input.body.mode === "graphql"
              ? input.body.text
              : null,
        },
        response: null,
      });
      scripts.pre = outcome.view;
      captured = (await this.captureFromScript(command, outcome.raw)) ?? captured;
      if (outcome.raw.error) {
        return {
          request: { method: input.method, url: input.path, headers: {}, body: null },
          response: null,
          error: `El script previo falló y la petición no se envió: ${outcome.view.error}`,
          auth: "No se envió",
          environment: environmentView,
          // Nada salió, así que ninguna cookie se presentó ni se guardó.
          cookies: { sent: [], stored: [], rejected: [] },
          scripts,
          sessionToken: captured,
        };
      }
      if (outcome.raw.headers)
        headerRows = Object.entries(outcome.raw.headers).map(([name, value]) => ({ name, value, enabled: true }));
    }

    const variables = withEnvironmentNamespace({ ...run.values, ...run.requestVariables });
    const seed: ComputedSeed = {
      uuid: randomUUID(),
      now: new Date(),
      random: Math.random(),
      hmacSha256: (key, text) => createHmac("sha256", key).update(text).digest("hex"),
    };
    const interpolate = (value: string) => interpolateText(value, variables, seed);

    const base = interpolate(environment?.baseUrl || project.baseUrl);
    const path = interpolate(input.path);
    if (!/^https?:\/\//i.test(path) && !base) {
      throw new InvalidInputError(
        "Falta la URL base",
        [{ field: "path", detail: "Ponla en el entorno o en Settings del proyecto, o escribe una URL completa" }],
        "base-url-missing",
      );
    }
    let url = buildUrl(
      base,
      path,
      input.pathParameters.map((parameter) => ({ ...parameter, value: interpolate(parameter.value) })),
      input.query.map((row) => ({ ...row, value: interpolate(row.value) })),
    );
    const headers: Record<string, string> = {};
    for (const header of headerRows)
      if (header.enabled && header.name) headers[header.name] = interpolate(header.value);

    let body = serializeBody(input.body, command.files, interpolate);
    if (!body.ok) throw new InvalidInputError(body.message, [body.problem], body.code);

    const unresolved = unresolvedVariables([url, headers, body.value?.preview ?? ""]);
    if (unresolved.length) {
      throw new InvalidInputError(
        `Variables sin valor: ${unresolved.join(", ")}`,
        unresolved.map((name) => ({
          field: "variables",
          detail: `{{${name}}} no está definida en ${environment ? `«${environment.name}»` : "ningún entorno"}`,
        })),
        "unresolved-variables",
      );
    }
    const placeholders = unfilledPlaceholders(url);
    if (placeholders.length) {
      throw new InvalidInputError(
        `Parámetros de ruta sin valor: ${placeholders.join(", ")}`,
        placeholders.map((name) => ({ field: `pathParameters.${name}`, detail: "Falta el valor" })),
        "path-parameter-missing",
      );
    }

    // Un `GET` no lleva cuerpo —el cliente lo tiraría sin decirlo— y GraphQL sobre HTTP tiene su
    // forma para eso: la operación y las variables van en la query. Es lo que un servidor con
    // consultas cacheables espera, y lo único que hace que un `GET` mande algo.
    if (body.ok && body.value && input.body.mode === "graphql" && (input.method === "GET" || input.method === "HEAD")) {
      url = graphqlOverGet(url, body.value.payload as string);
      body = { ok: true, value: null };
    }

    if (body.value?.contentType && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
      headers["Content-Type"] = body.value.contentType;

    // La firma va después del `Content-Type` y no antes: AWS y Hawk lo firman, y OAuth 1 decide si
    // el formulario entra en la firma mirándolo. Firmar antes daba una firma de otra petición.
    const sending = { url, headers, method: input.method, body: body.value?.preview ?? null };
    const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
    const auth = hasAuthorization
      ? "Cabecera Authorization escrita en la petición"
      : await this.applyAuth(
          input,
          command.actorId,
          project,
          projectSecrets,
          environment,
          base,
          sending,
          interpolate,
          run,
        );

    const echo = {
      method: input.method,
      url: sending.url,
      headers: maskHeaders(headers),
      body: body.value?.preview ?? null,
    };

    // El tarro de esta persona en este proyecto. Se presenta en la petición salvo que quien la
    // escribió haya puesto su propia cabecera `Cookie`, que gana: está diciendo qué quiere mandar.
    const now = this.clock.now();
    const jar = liveCookies(await this.cookieJar.list(command.actorId, project.id), now.getTime());
    const cookiesSent = matchingCookies(sending.url, jar, now.getTime());
    for (const cookie of cookiesSent) run.secrets.push(cookie.value);

    let result;
    try {
      result = await this.http.request(sending.url, {
        method: input.method,
        headers,
        jar,
        ...(body.value && input.method !== "GET" && input.method !== "HEAD" ? { body: body.value.payload } : {}),
      });
    } catch (error) {
      if (!(error instanceof BlockedTargetError)) throw error;
      return {
        request: echo,
        response: null,
        error: error.message,
        auth,
        environment: environmentView,
        scripts,
        sessionToken: captured,
        // Nada llegó, así que nada se guardó; lo que se presentó sí se dice.
        cookies: { sent: cookiesSent.map((cookie) => `${cookie.name}=${cookie.domain}${cookie.path}`), stored: [], rejected: [] },
      };
    }

    const response = {
      status: result.status,
      headers: result.headers,
      body: result.body,
      sizeBytes: Buffer.byteLength(result.body),
      durationMs: result.durationMs,
      timing: result.timing,
    };

    const cookies = await this.storeCookies(command.actorId, project.id, result.setCookie, sending.url, jar, now);

    captured = (await this.captureFromLogin(command, project, base, url, response, interpolate)) ?? captured;

    if (input.postResponseScript.trim()) {
      const outcome = await run.execute({
        phase: "post",
        code: input.postResponseScript,
        variables: run.requestVariables,
        request: echo,
        response: {
          status: response.status,
          headers: response.headers,
          body: response.body,
          durationMs: response.durationMs,
        },
      });
      scripts.post = outcome.view;
      captured = (await this.captureFromScript(command, outcome.raw)) ?? captured;
    }

    return {
      request: echo,
      response,
      error: null,
      auth,
      environment: environmentView,
      scripts,
      sessionToken: captured,
      cookies: {
        sent: cookiesSent.map((cookie) => `${cookie.name}=${cookie.domain}${cookie.path}`),
        stored: cookies.stored,
        rejected: cookies.rejected,
      },
    };
  }

  /**
   * Las cookies de la respuesta, guardadas en el tarro de quien envió.
   *
   * De **todos** los saltos: un login suele contestar 302 con la cookie puesta, y la cookie de ese
   * salto es justo la que hace falta para la petición siguiente.
   *
   * Lo rechazado se devuelve para poder decirlo. Una cookie que no se guarda porque el servidor la
   * puso para otro dominio es una explicación; el silencio es un 401 que nadie entiende.
   */
  private async storeCookies(
    actorId: string,
    projectId: string,
    lines: string[],
    url: string,
    jar: Cookie[],
    now: Date,
  ): Promise<{ stored: string[]; rejected: { line: string; why: string }[] }> {
    if (!lines.length) return { stored: [], rejected: [] };
    const read = cookiesFrom(lines, url, now.getTime());
    const gone = read.cookies.filter((cookie) => cookie.expiresAt !== null && cookie.expiresAt <= now.getTime());
    const kept = withCookies(jar, read.cookies, now.getTime());
    // Una cookie con fecha pasada es un cierre de sesión: se borra de la tabla, no solo del tarro
    // en memoria, porque si no vuelve a cargarse en el envío siguiente.
    if (gone.length) await this.cookieJar.remove(actorId, projectId, gone);
    const live = read.cookies.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now.getTime());
    if (live.length) {
      // Se guardan con la fecha de creación que ya tenían, que es la que ordena la cabecera.
      const byKey = new Map(kept.map((cookie) => [cookieKey(cookie), cookie]));
      await this.cookieJar.save(
        actorId,
        projectId,
        live.map((cookie) => byKey.get(cookieKey(cookie)) ?? cookie),
      );
    }
    await this.cookieJar.purgeExpired(actorId, projectId, now);
    return {
      stored: [
        ...live.map((cookie) => `${cookie.name}=${cookie.domain}${cookie.path}`),
        ...gone.map((cookie) => `${cookie.name} (borrada)`),
      ],
      rejected: read.rejected,
    };
  }

  /** A script that set `token` captured one — the analyzer's convention, kept because people use it. */
  private async captureFromScript(
    command: SendEndpointRequestCommand,
    outcome: ScriptOutcome,
  ): Promise<SessionTokenSource | null> {
    const token = outcome.environmentSet.token?.trim();
    if (!token) return null;
    await captureSessionToken(this.sessionTokens, this.cipher, {
      actorId: command.actorId,
      projectId: command.projectId,
      token,
      source: "script",
      now: this.clock.now(),
    });
    return "script";
  }

  /**
   * The request *was* the project's login, and it worked: the token in its answer is the session.
   *
   * Recognised by path, the way the analyzer did it — a 2xx from a URL whose path ends with the
   * configured login URL — so logging in by hand from the editor is enough, with no separate button.
   */
  private async captureFromLogin(
    command: SendEndpointRequestCommand,
    project: Project,
    base: string,
    url: string,
    response: { status: number; body: string },
    interpolate: (value: string) => string,
  ): Promise<SessionTokenSource | null> {
    const settings = project.auth.settings;
    if (project.auth.type !== "bearer" || !settings.loginUrl || response.status < 200 || response.status >= 300)
      return null;
    const loginPath = pathOf(interpolate(settings.loginUrl), base);
    if (!loginPath || loginPath === "/" || !pathOf(url, base).endsWith(loginPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return null;
    }
    const token = (settings.tokenPath ? [settings.tokenPath] : TOKEN_PATHS)
      .map((candidate) => valueAtPath(parsed, candidate))
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (!token) return null;
    await captureSessionToken(this.sessionTokens, this.cipher, {
      actorId: command.actorId,
      projectId: command.projectId,
      token,
      source: "login",
      now: this.clock.now(),
    });
    return "login";
  }

  /** Adds the credential to `headers` and says where it came from. */
  private async applyAuth(
    input: SendInput,
    actorId: string,
    project: Project,
    secrets: Record<string, string | undefined>,
    environment: Environment | null,
    base: string,
    sending: { url: string; headers: Record<string, string>; method: string; body: string | null },
    interpolate: (value: string) => string,
    run: ScriptSession,
  ): Promise<string> {
    const headers = sending.headers;
    if (input.auth.type === "none") return "Sin autenticación";
    // Un tipo escrito en la petición se firma aquí y no hereda nada: es la decisión de quien la
    // escribió, y la cadena del proyecto es solo lo que pasa cuando no la hay.
    if (input.auth.type !== "inherit") {
      return this.signRequestAuth(input.auth, sending, interpolate, run);
    }

    const session = await this.sessionTokens.find(actorId, project.id);
    if (session && !isExpired(session, this.clock.now())) {
      const token = this.cipher.decrypt(session.tokenCiphertext);
      headers.Authorization = `Bearer ${token}`;
      run.secrets.push(token);
      return session.source === "login" ? "Token de sesión (del login)" : "Token de sesión (de un script)";
    }
    const expiredNote = session ? " · el token de sesión caducó" : "";

    const stored = project.auth;
    switch (stored.type) {
      case "bearer": {
        if (secrets.token) {
          headers.Authorization = `Bearer ${secrets.token}`;
          return `Token del proyecto${expiredNote}`;
        }
        if (stored.settings.loginUrl) {
          const token = await this.login(project, base, secrets.loginBody ?? "", interpolate);
          headers.Authorization = `Bearer ${token}`;
          run.secrets.push(token);
          return `Login del proyecto${expiredNote}`;
        }
        return `Sin autenticación: el proyecto no tiene token${expiredNote}`;
      }
      case "basic":
        headers.Authorization = `Basic ${Buffer.from(`${stored.settings.username ?? ""}:${secrets.password ?? ""}`).toString("base64")}`;
        return `Basic auth del proyecto${expiredNote}`;
      case "api_key":
        headers[stored.settings.headerName || "X-API-Key"] = secrets.apiKey ?? "";
        return `API key del proyecto${expiredNote}`;
      default: {
        if (!environment) return `Sin autenticación${expiredNote}`;
        const primary = (await this.environments.listCredentials(environment.id)).find(
          (credential) => credential.role === "primary",
        );
        if (!primary) return `Sin autenticación${expiredNote}`;
        const secret = this.cipher.decrypt(primary.secretCiphertext);
        Object.assign(headers, credentialHeader(primary, secret));
        run.secrets.push(secret);
        return `Credencial «${primary.name}» del entorno${expiredNote}`;
      }
    }
  }

  /**
   * La firma de un tipo escrito en la petición: cabeceras, query y —si hace falta— una vuelta más.
   *
   * Dos casos necesitan red antes de poder firmar, y los dos se hacen aquí porque el firmante es
   * puro y no la tiene:
   *
   * - **Digest** firma con el `nonce` del servidor, que solo llega en su 401. Se pide ese 401, se
   *   lee su `WWW-Authenticate` y se firma con él. Sin esto, Digest no es «no soportado»: es una
   *   cabecera inventada que el servidor rechaza.
   * - **OAuth 2.0 sin token**, con un flujo que no necesita navegador, se pide al servidor de token
   *   —por la misma red guardada que todo lo demás— y se firma con lo que conteste.
   *
   * La query que añada la firma se mete en la URL aquí: `?access_token=` es parte de la petición,
   * no de sus cabeceras.
   */
  private async signRequestAuth(
    auth: RequestAuth,
    request: { url: string; headers: Record<string, string>; method: string; body: string | null },
    interpolate: (value: string) => string,
    run: ScriptSession,
  ): Promise<string> {
    const resolved: RequestAuth = {
      type: auth.type,
      params: Object.fromEntries(Object.entries(auth.params).map(([key, value]) => [key, interpolate(value)])),
    };
    for (const [key, value] of Object.entries(resolved.params)) {
      if (SECRET_PARAMS.has(key) && value) run.secrets.push(value);
    }

    let note = "";
    if (resolved.type === "oauth2" && !resolved.params.accessToken?.trim()) {
      const asked = await this.askForToken(resolved);
      if (typeof asked !== "string") return asked.failed;
      resolved.params.accessToken = asked;
      run.secrets.push(asked);
      note = " · token pedido ahora";
    }

    let signed = signAuth(resolved, { ...request, url: request.url });
    if (signed.needsChallenge) {
      // El 401 que trae el `nonce`. Va sin cuerpo: lo único que se le pide es la cabecera del reto.
      let probe;
      try {
        probe = await this.http.request(request.url, { method: request.method, headers: { ...request.headers } });
      } catch (error) {
        if (error instanceof BlockedTargetError) throw error;
        return `${AUTH_LABELS[resolved.type]}: no se pudo pedir el reto al servidor`;
      }
      const challenge = probe.headers["www-authenticate"] ?? probe.headers["WWW-Authenticate"] ?? "";
      if (!challenge) return `${AUTH_LABELS[resolved.type]}: el servidor no pidió autenticación en su respuesta`;
      signed = signAuth(resolved, { ...request, challenge });
      note = " · con el reto del servidor";
    }
    if (signed.unsupported) return `${AUTH_LABELS[resolved.type]}: ${signed.unsupported}`;

    for (const pair of signed.headers) request.headers[pair.name] = pair.value;
    if (signed.query.length) {
      const separator = request.url.includes("?") ? "&" : "?";
      request.url += separator + signed.query.map((pair) => `${encodeURIComponent(pair.name)}=${encodeURIComponent(pair.value)}`).join("&");
    }
    // «de esta petición» porque es lo que la distingue de la del proyecto en la misma frase: quien
    // lee el eco quiere saber de dónde salió la credencial, no solo de qué tipo era.
    return `${AUTH_LABELS[resolved.type]} de esta petición${note}`;
  }

  /** El token de OAuth 2, pedido al servidor de token con el flujo que no necesita navegador. */
  private async askForToken(auth: RequestAuth): Promise<string | { failed: string }> {
    const made = tokenRequestFor(auth);
    if ("unsupported" in made) return { failed: `OAuth 2.0: ${made.unsupported}` };
    let result;
    try {
      result = await this.http.request(made.request.url, {
        method: made.request.method,
        headers: made.request.headers,
        body: made.request.body,
      });
    } catch (error) {
      if (error instanceof BlockedTargetError) throw error;
      return { failed: "OAuth 2.0: el servidor de token no respondió" };
    }
    if (result.status < 200 || result.status >= 300) {
      return { failed: `OAuth 2.0: el servidor de token contestó ${result.status}` };
    }
    let body: unknown;
    try {
      body = JSON.parse(result.body);
    } catch {
      return { failed: "OAuth 2.0: la respuesta del servidor de token no es JSON" };
    }
    const read = readTokenResponse(body);
    return read ? read.accessToken : { failed: "OAuth 2.0: la respuesta no trae access_token" };
  }

  /** The project's login, performed now, and the token read out of its answer. */
  private async login(
    project: Project,
    base: string,
    loginBody: string,
    interpolate: (value: string) => string,
  ): Promise<string> {
    const settings = project.auth.settings;
    const loginUrl = interpolate(settings.loginUrl ?? "");
    const url = /^https?:\/\//i.test(loginUrl) ? loginUrl : `${base.replace(/\/+$/, "")}${loginUrl}`;
    const method = settings.loginMethod ?? "POST";
    const fail = (detail: string) =>
      new InvalidInputError(
        "No se pudo iniciar sesión con el login del proyecto",
        [{ field: "auth", detail }],
        "project-login-failed",
      );

    let result;
    try {
      result = await this.http.request(url, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...(loginBody && method !== "GET" ? { body: interpolate(loginBody) } : {}),
      });
    } catch (error) {
      throw fail(error instanceof Error ? error.message : "El login no respondió");
    }
    if (result.status >= 400) throw fail(`${method} ${url} respondió ${result.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body);
    } catch {
      throw fail("La respuesta del login no es JSON");
    }
    const paths = settings.tokenPath ? [settings.tokenPath] : TOKEN_PATHS;
    for (const candidate of paths) {
      const token = valueAtPath(parsed, candidate);
      if (typeof token === "string" && token) return token;
    }
    throw fail(
      settings.tokenPath
        ? `La respuesta no tiene ${settings.tokenPath}`
        : `La respuesta no tiene ninguno de ${TOKEN_PATHS.join(", ")}`,
    );
  }
}

/**
 * The two scripts of one «Enviar», and the state they share.
 *
 * The values a pre script sets are the ones the request is interpolated with and the ones the post
 * script reads, so they live here rather than being re-read from the database between the two — the
 * analyzer re-read them and its post script saw the values from before the pre script ran.
 */
class ScriptSession {
  values: Record<string, string>;
  requestVariables: Record<string, string> = {};
  /** Everything the console must not print: sensitive variables, and every credential used. */
  readonly secrets: string[];
  private environment: Environment | null;

  constructor(
    private readonly sandbox: ScriptSandboxPort,
    private readonly environments: EnvironmentRepositoryPort,
    private readonly cipher: SecretCipherPort,
    environment: Environment | null,
    secrets: string[],
  ) {
    this.environment = environment;
    const decrypt = (payload: string) => cipher.decrypt(payload);
    this.values = environment ? resolveVariables(environment.variables, decrypt) : {};
    const sensitive = environment
      ? Object.entries(environment.variables)
          .filter(([, variable]) => variable.sensitive)
          .map(([name]) => this.values[name])
      : [];
    this.secrets = [...secrets, ...sensitive.filter((value): value is string => Boolean(value))];
  }

  async execute(script: Omit<ScriptInput, "environment">): Promise<{ raw: ScriptOutcome; view: ScriptRunView }> {
    const raw = await this.sandbox.run({
      ...script,
      environment: { name: this.environment?.name ?? null, values: this.values },
    });

    const names = [...Object.keys(raw.environmentSet), ...raw.environmentUnset];
    this.values = { ...this.values, ...raw.environmentSet };
    for (const name of raw.environmentUnset) delete this.values[name];
    this.requestVariables = { ...this.requestVariables, ...raw.variables };

    // A value written into a secret variable is a secret from now on too.
    for (const name of Object.keys(raw.environmentSet))
      if (this.environment?.variables[name]?.sensitive || this.environment?.disabledVariables[name]?.sensitive)
        this.secrets.push(raw.environmentSet[name]);

    let logs = raw.logs;
    if (names.length && this.environment) {
      this.environment = applyScriptWrites(this.environment, raw.environmentSet, raw.environmentUnset, (plain) =>
        this.cipher.encrypt(plain),
      );
      await this.environments.save(this.environment);
    } else if (names.length) {
      logs = [
        ...logs,
        {
          level: "warn",
          text: "Sin entorno: lo que el script guardó con pm.environment solo valió para esta petición",
        },
      ];
    }

    const shown = redactOutcome({ ...raw, logs }, this.secrets);
    return {
      raw,
      view: {
        error: shown.error,
        logs: shown.logs,
        tests: shown.tests,
        environmentUpdates: this.environment ? names : [],
        durationMs: raw.durationMs,
      },
    };
  }
}

/** The enabled headers as the map a script reads; a repeated name keeps its last value. */
function headerMap(rows: SendInput["headers"]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) if (row.enabled && row.name) map[row.name] = row.value;
  return map;
}

/** The path of a URL or of a relative one, without query and trailing slash. */
function pathOf(value: string, base: string): string {
  try {
    return new URL(value, base || "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}
