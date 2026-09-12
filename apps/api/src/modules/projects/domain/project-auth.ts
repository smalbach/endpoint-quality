/**
 * How a project logs in to the API it points at.
 *
 * The analyzer's four types, with the same fields: `none`, `bearer` (a fixed token, or a login
 * request and where the token is in its answer), `basic` and `api_key`.
 *
 * Stored in two halves. What is not secret — the login URL, the method, the token path, the user
 * name, the header name — is plain JSON anyone with read access sees. What is — the token, the
 * password, the key and the login body, which is almost always an e-mail and a password — is one
 * AES-256-GCM ciphertext. `secretFields` names which secrets exist so a screen can show «hay uno»
 * without the key being needed to answer a GET.
 *
 * On the way in, a secret equal to {@link MASKED_VALUE} means «leave it as it was», exactly like a
 * sensitive environment variable. Otherwise saving the settings form without retyping the token
 * would store eight dots as the token.
 */
import type { MaskedValue } from "@eq/contracts";

export const PROJECT_AUTH_TYPES = ["none", "bearer", "basic", "api_key"] as const;
export type ProjectAuthType = (typeof PROJECT_AUTH_TYPES)[number];

export const LOGIN_METHODS = ["POST", "GET", "PUT", "PATCH"] as const;

type SecretField = "token" | "loginBody" | "password" | "apiKey";

export const MASK: MaskedValue = "••••••••";

export type ProjectAuthSettings = {
  loginUrl?: string;
  loginMethod?: string;
  tokenPath?: string;
  username?: string;
  headerName?: string;
  secretFields?: SecretField[];
};

export type StoredProjectAuth = {
  type: ProjectAuthType;
  settings: ProjectAuthSettings;
  secretCiphertext: string | null;
};

export const NO_AUTH: StoredProjectAuth = { type: "none", settings: {}, secretCiphertext: null };

/** What a client sends. Every field is a string so a form can send what it has. */
export type ProjectAuthInput = {
  type: ProjectAuthType;
  token?: string;
  loginUrl?: string;
  loginMethod?: string;
  loginBody?: string;
  tokenPath?: string;
  username?: string;
  password?: string;
  headerName?: string;
  apiKey?: string;
};

/** What a client reads: the settings, and each secret as the mask or empty. */
export type ProjectAuthView = {
  type: ProjectAuthType;
  loginUrl: string;
  loginMethod: string;
  tokenPath: string;
  username: string;
  headerName: string;
  token: string;
  loginBody: string;
  password: string;
  apiKey: string;
};

type Cipher = { encrypt(plain: string): string; decrypt(payload: string): string };

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Which secrets each type keeps. A `basic` project that used to be `bearer` must not keep the
 * old token around in its ciphertext. */
const SECRETS_BY_TYPE: Record<ProjectAuthType, SecretField[]> = {
  none: [],
  bearer: ["token", "loginBody"],
  basic: ["password"],
  api_key: ["apiKey"],
};

export function viewProjectAuth(stored: StoredProjectAuth): ProjectAuthView {
  const has = (field: SecretField) => (stored.settings.secretFields ?? []).includes(field);
  return {
    type: stored.type,
    loginUrl: stored.settings.loginUrl ?? "",
    loginMethod: stored.settings.loginMethod ?? "",
    tokenPath: stored.settings.tokenPath ?? "",
    username: stored.settings.username ?? "",
    headerName: stored.settings.headerName ?? "",
    token: has("token") ? MASK : "",
    loginBody: has("loginBody") ? MASK : "",
    password: has("password") ? MASK : "",
    apiKey: has("apiKey") ? MASK : "",
  };
}

/**
 * The problems with an input, given what is stored now.
 *
 * A required secret is satisfied by the mask only when there is a stored one behind it: sending
 * the mask for a secret that was never set is sending nothing.
 */
export function projectAuthProblems(
  input: ProjectAuthInput,
  previous: StoredProjectAuth,
): { field: string; detail: string }[] {
  const problems: { field: string; detail: string }[] = [];
  const kept = (field: SecretField) =>
    input.type === previous.type && (previous.settings.secretFields ?? []).includes(field);
  const present = (field: SecretField) => {
    const value = input[field]?.trim() ?? "";
    return value === MASK ? kept(field) : value.length > 0;
  };
  const problem = (field: string, detail: string) => problems.push({ field: `auth.${field}`, detail });

  if (input.type === "bearer") {
    const loginUrl = input.loginUrl?.trim() ?? "";
    if (!present("token") && !loginUrl) problem("token", "Hace falta un token o una URL de login");
    if (loginUrl && !/^https?:\/\//i.test(loginUrl) && !loginUrl.startsWith("/"))
      problem("loginUrl", "Una URL http(s) o una ruta que empiece por /");
    if (input.loginMethod && !(LOGIN_METHODS as readonly string[]).includes(input.loginMethod.toUpperCase()))
      problem("loginMethod", `Uno de ${LOGIN_METHODS.join(", ")}`);
    const body = input.loginBody?.trim() ?? "";
    if (body && body !== MASK) {
      try {
        const parsed = JSON.parse(body) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          problem("loginBody", "Tiene que ser un objeto JSON");
      } catch {
        problem("loginBody", "No es JSON válido");
      }
    }
  }
  if (input.type === "basic") {
    if (!input.username?.trim()) problem("username", "Falta el usuario");
    if (!present("password")) problem("password", "Falta la contraseña");
  }
  if (input.type === "api_key") {
    const header = input.headerName?.trim() || "X-API-Key";
    if (!HEADER_NAME.test(header)) problem("headerName", "No es un nombre de cabecera válido");
    if (!present("apiKey")) problem("apiKey", "Falta la clave");
  }
  return problems;
}

/**
 * The input, stored. Assumes {@link projectAuthProblems} returned nothing.
 *
 * The cipher is only touched when there is a secret to keep, so a project with `none`, or with a
 * login URL and no body, saves on an install that never configured `SECRETS_KEY`.
 */
export function storeProjectAuth(
  input: ProjectAuthInput,
  previous: StoredProjectAuth,
  cipher: Cipher,
): StoredProjectAuth {
  if (input.type === "none") return NO_AUTH;

  const previousSecrets: Partial<Record<SecretField, string>> =
    previous.secretCiphertext && previous.type === input.type
      ? (JSON.parse(cipher.decrypt(previous.secretCiphertext)) as Partial<Record<SecretField, string>>)
      : {};

  const secrets: Partial<Record<SecretField, string>> = {};
  for (const field of SECRETS_BY_TYPE[input.type]) {
    const value = input[field]?.trim() ?? "";
    const resolved = value === MASK ? previousSecrets[field] : value;
    if (resolved) secrets[field] = resolved;
  }
  const secretFields = Object.keys(secrets) as SecretField[];

  const trimmed = (value: string | undefined) => value?.trim() || undefined;
  const settings: ProjectAuthSettings =
    input.type === "bearer"
      ? {
          loginUrl: trimmed(input.loginUrl),
          // A login flow without a method is a POST, which is what every login form is.
          loginMethod: input.loginUrl?.trim() ? (trimmed(input.loginMethod)?.toUpperCase() ?? "POST") : undefined,
          tokenPath: trimmed(input.tokenPath),
        }
      : input.type === "basic"
        ? { username: trimmed(input.username) }
        : { headerName: trimmed(input.headerName) ?? "X-API-Key" };

  return {
    type: input.type,
    settings: {
      ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)),
      ...(secretFields.length ? { secretFields } : {}),
    },
    secretCiphertext: secretFields.length ? cipher.encrypt(JSON.stringify(secrets)) : null,
  };
}
