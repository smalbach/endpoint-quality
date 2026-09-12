/**
 * The authentication block of a project, as a form draft.
 *
 * The draft is the view the API returns — every secret empty or the eight-dot mask — and what goes
 * back is only the fields of the chosen type. A secret left as the mask means «unchanged» to the
 * API, so the form never has to know the value to keep it.
 */
import type { ProjectAuthType, ProjectAuthView } from "./types";

export const MASK = "•".repeat(8);

export const AUTH_TYPES: { value: ProjectAuthType; label: string }[] = [
  { value: "none", label: "Ninguna" },
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "Basic auth" },
  { value: "api_key", label: "API key" },
];

export const LOGIN_METHODS = ["POST", "GET", "PUT", "PATCH"];

export const EMPTY_AUTH: ProjectAuthView = {
  type: "none",
  loginUrl: "",
  loginMethod: "POST",
  tokenPath: "",
  username: "",
  headerName: "X-API-Key",
  token: "",
  loginBody: "",
  password: "",
  apiKey: "",
};

/** A view from the API, with the defaults a form wants where the API has nothing. */
export function authDraft(view: ProjectAuthView | undefined): ProjectAuthView {
  if (!view) return EMPTY_AUTH;
  return {
    ...view,
    loginMethod: view.loginMethod || "POST",
    headerName: view.headerName || "X-API-Key",
  };
}

export function authPayload(draft: ProjectAuthView): Record<string, string> {
  switch (draft.type) {
    case "none":
      return { type: "none" };
    case "bearer":
      return {
        type: "bearer",
        token: draft.token,
        loginUrl: draft.loginUrl.trim(),
        loginMethod: draft.loginMethod,
        loginBody: draft.loginBody,
        tokenPath: draft.tokenPath.trim(),
      };
    case "basic":
      return { type: "basic", username: draft.username.trim(), password: draft.password };
    default:
      return { type: "api_key", headerName: draft.headerName.trim(), apiKey: draft.apiKey };
  }
}

/** What would come back as a 422, said while typing. Field names match the API's `auth.*`. */
export function authProblems(draft: ProjectAuthView): Record<string, string> {
  const problems: Record<string, string> = {};
  if (draft.type === "bearer") {
    if (!draft.token && !draft.loginUrl.trim()) problems["auth.token"] = "Hace falta un token o una URL de login";
    const url = draft.loginUrl.trim();
    if (url && !/^https?:\/\//i.test(url) && !url.startsWith("/"))
      problems["auth.loginUrl"] = "Una URL http(s) o una ruta que empiece por /";
    if (draft.loginBody && draft.loginBody !== MASK) {
      try {
        const parsed = JSON.parse(draft.loginBody) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          problems["auth.loginBody"] = "Tiene que ser un objeto JSON";
      } catch {
        problems["auth.loginBody"] = "No es JSON válido";
      }
    }
  }
  if (draft.type === "basic") {
    if (!draft.username.trim()) problems["auth.username"] = "Falta el usuario";
    if (!draft.password) problems["auth.password"] = "Falta la contraseña";
  }
  if (draft.type === "api_key") {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(draft.headerName.trim()))
      problems["auth.headerName"] = "No es un nombre de cabecera válido";
    if (!draft.apiKey) problems["auth.apiKey"] = "Falta la clave";
  }
  return problems;
}

/** Tags as typed in one input: comma separated, trimmed, once each. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
