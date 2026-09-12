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

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { SAFE_FETCH, BlockedTargetError, type RequestTiming, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import type { Project } from "@/modules/projects/domain/model";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { credentialHeader, resolveVariables, type Environment } from "@/modules/environments/domain/model";
import {
  blockedUpload,
  buildUrl,
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
  ) {}
}

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
  /** Why there is no response: the target could not be reached, or the guard refused it. */
  error: string | null;
  /** Where the credential came from, in words, because «¿con qué token fue?» is the first question. */
  auth: string;
  environment: { id: string; name: string } | null;
};

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * One request from the endpoint editor, sent now and answered in the same response.
 *
 * Nothing is stored: no run, no history row. What makes it safe to offer to an editor is what every
 * other request of this product already goes through — the SSRF guard, the environment's
 * `writesAllowed`, credentials decrypted here and masked in the echo.
 *
 * Where the credential comes from, in order:
 * 1. an `Authorization` header typed in the editor wins, because typing one means exactly that;
 * 2. `auth.mode: "bearer"` with a token (usually `{{token}}`) for this request only;
 * 3. `inherit`: the project's authentication — a fixed token, a login it performs, basic or an API
 *    key — and when the project has none, the environment's `primary` credential.
 */
@CommandHandler(SendEndpointRequestCommand)
export class SendEndpointRequestHandler implements ICommandHandler<SendEndpointRequestCommand, SentRequestView> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
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

    const variables = withEnvironmentNamespace(
      environment ? resolveVariables(environment.variables, (payload) => this.cipher.decrypt(payload)) : {},
    );
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
    const url = buildUrl(
      base,
      path,
      input.pathParameters.map((parameter) => ({ ...parameter, value: interpolate(parameter.value) })),
      input.query.map((row) => ({ ...row, value: interpolate(row.value) })),
    );
    const headers: Record<string, string> = {};
    for (const header of input.headers)
      if (header.enabled && header.name) headers[header.name] = interpolate(header.value);

    const body = serializeBody(input.body, command.files, interpolate);
    if (!body.ok) throw new InvalidInputError("Falta un fichero", [body.problem], "file-missing");

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

    const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
    const auth = hasAuthorization
      ? "Cabecera Authorization escrita en la petición"
      : await this.applyAuth(input, project, environment, base, headers, interpolate);

    if (body.value?.contentType && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type"))
      headers["Content-Type"] = body.value.contentType;

    const echo = {
      method: input.method,
      url,
      headers: maskHeaders(headers),
      body: body.value?.preview ?? null,
    };
    const environmentView = environment ? { id: environment.id, name: environment.name } : null;

    try {
      const result = await this.http.request(url, {
        method: input.method,
        headers,
        ...(body.value && input.method !== "GET" && input.method !== "HEAD" ? { body: body.value.payload } : {}),
      });
      return {
        request: echo,
        response: {
          status: result.status,
          headers: result.headers,
          body: result.body,
          sizeBytes: Buffer.byteLength(result.body),
          durationMs: result.durationMs,
          timing: result.timing,
        },
        error: null,
        auth,
        environment: environmentView,
      };
    } catch (error) {
      if (!(error instanceof BlockedTargetError)) throw error;
      return { request: echo, response: null, error: error.message, auth, environment: environmentView };
    }
  }

  /** Adds the credential to `headers` and says where it came from. */
  private async applyAuth(
    input: SendInput,
    project: Project,
    environment: Environment | null,
    base: string,
    headers: Record<string, string>,
    interpolate: (value: string) => string,
  ): Promise<string> {
    if (input.auth.mode === "none") return "Sin autenticación";
    if (input.auth.mode === "bearer") {
      const token = interpolate(input.auth.token).trim();
      if (!token) return "Sin autenticación: el token de la petición está vacío";
      headers.Authorization = `Bearer ${token}`;
      return "Token de esta petición";
    }

    const stored = project.auth;
    const secrets = stored.secretCiphertext
      ? (JSON.parse(this.cipher.decrypt(stored.secretCiphertext)) as Record<string, string | undefined>)
      : {};
    switch (stored.type) {
      case "bearer": {
        if (secrets.token) {
          headers.Authorization = `Bearer ${secrets.token}`;
          return "Token del proyecto";
        }
        if (stored.settings.loginUrl) {
          headers.Authorization = `Bearer ${await this.login(project, base, secrets.loginBody ?? "", interpolate)}`;
          return "Login del proyecto";
        }
        return "Sin autenticación: el proyecto no tiene token";
      }
      case "basic":
        headers.Authorization = `Basic ${Buffer.from(`${stored.settings.username ?? ""}:${secrets.password ?? ""}`).toString("base64")}`;
        return "Basic auth del proyecto";
      case "api_key":
        headers[stored.settings.headerName || "X-API-Key"] = secrets.apiKey ?? "";
        return "API key del proyecto";
      default: {
        if (!environment) return "Sin autenticación";
        const primary = (await this.environments.listCredentials(environment.id)).find(
          (credential) => credential.role === "primary",
        );
        if (!primary) return "Sin autenticación";
        Object.assign(headers, credentialHeader(primary, this.cipher.decrypt(primary.secretCiphertext)));
        return `Credencial «${primary.name}» del entorno`;
      }
    }
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
