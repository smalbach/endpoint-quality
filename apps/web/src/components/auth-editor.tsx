/**
 * Cómo entra una petición: los mismos tipos que Postman, con sus campos.
 *
 * Antes aquí había tres opciones —heredar, ninguna, y un `Bearer` escrito a mano— y la
 * autenticación de una colección importada no tenía dónde aparecer. Una API real pide una de estas
 * trece, y la que pide no es siempre la que este editor sabía escribir.
 *
 * Los campos se declaran en una tabla y no en trece formularios: cada tipo dice qué necesita, y el
 * formulario sale de ahí. Trece formularios a mano son trece sitios donde se olvida el mismo campo.
 *
 * **Un secreto escrito aquí no se guarda.** El valor viaja para enviar la petición, pero al guardar
 * el endpoint se queda vacío si no es una `{{variable}}`: la columna es `jsonb` y una contraseña ahí
 * es una contraseña en claro en la base de datos. El aviso lo dice en el campo, no en una nota al
 * pie, porque quien lo escribe tiene que saberlo antes de darle a guardar.
 */
import { useState } from "react";

import { cn } from "@/lib/format";
import { VariableSuggest } from "@/components/variable-suggest";
import type { AuthTypeView, RequestAuthView } from "@/lib/types";

type FieldKind = "text" | "secret" | "select" | "area";

type Field = {
  name: string;
  label: string;
  kind?: FieldKind;
  placeholder?: string;
  options?: { value: string; label: string }[];
  hint?: string;
  /** Lo que se usa cuando nadie lo escribe, que es lo que hace el que envía. */
  fallback?: string;
};

const IN_OPTIONS = [
  { value: "header", label: "Cabecera" },
  { value: "query", label: "Query" },
];
const TOKEN_TO = [
  { value: "header", label: "Cabecera" },
  { value: "queryParams", label: "Query" },
];

/** Qué campos lleva cada tipo. El orden es el del formulario. */
export const AUTH_FIELDS: Record<AuthTypeView, Field[]> = {
  inherit: [],
  none: [],
  basic: [
    { name: "username", label: "Usuario" },
    { name: "password", label: "Contraseña", kind: "secret" },
  ],
  bearer: [{ name: "token", label: "Token", kind: "secret", placeholder: "eyJ… o {{token}}" }],
  apikey: [
    { name: "key", label: "Nombre", placeholder: "X-API-Key" },
    { name: "value", label: "Valor", kind: "secret" },
    { name: "in", label: "Va en", kind: "select", options: IN_OPTIONS, fallback: "header" },
  ],
  jwt: [
    {
      name: "algorithm",
      label: "Algoritmo",
      kind: "select",
      fallback: "HS256",
      options: ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512"].map((value) => ({
        value,
        label: value,
      })),
    },
    { name: "secret", label: "Secreto o clave privada", kind: "secret" },
    {
      name: "secretBase64Encoded",
      label: "El secreto está en base64",
      kind: "select",
      fallback: "false",
      options: [
        { value: "false", label: "No" },
        { value: "true", label: "Sí" },
      ],
      hint: "Un secreto publicado en base64 firmado como texto da un token que no valida en ningún sitio.",
    },
    { name: "payload", label: "Payload", kind: "area", placeholder: '{"sub": "1234567890"}' },
    { name: "headers", label: "Cabeceras del JWT", kind: "area", placeholder: '{"kid": "…"}' },
    { name: "headerPrefix", label: "Prefijo", fallback: "Bearer" },
    { name: "addTokenTo", label: "Va en", kind: "select", options: TOKEN_TO, fallback: "header" },
  ],
  digest: [
    { name: "username", label: "Usuario" },
    { name: "password", label: "Contraseña", kind: "secret" },
    {
      name: "algorithm",
      label: "Algoritmo",
      kind: "select",
      fallback: "MD5",
      options: ["MD5", "MD5-sess", "SHA-256", "SHA-256-sess", "SHA-512-256"].map((value) => ({ value, label: value })),
      hint: "El nonce lo pone el servidor en su 401: se le pide primero y se firma con él.",
    },
    { name: "realm", label: "Realm", hint: "Vacío: se usa el que mande el servidor." },
  ],
  oauth1: [
    { name: "consumerKey", label: "Consumer key" },
    { name: "consumerSecret", label: "Consumer secret", kind: "secret" },
    { name: "token", label: "Token" },
    { name: "tokenSecret", label: "Token secret", kind: "secret" },
    {
      name: "signatureMethod",
      label: "Firma",
      kind: "select",
      fallback: "HMAC-SHA1",
      options: ["HMAC-SHA1", "HMAC-SHA256", "HMAC-SHA512", "RSA-SHA1", "PLAINTEXT"].map((value) => ({
        value,
        label: value,
      })),
    },
    { name: "realm", label: "Realm" },
    {
      name: "addParamsToHeader",
      label: "Los parámetros van en",
      kind: "select",
      fallback: "true",
      options: [
        { value: "true", label: "La cabecera" },
        { value: "false", label: "La query o el cuerpo" },
      ],
    },
  ],
  oauth2: [
    {
      name: "accessToken",
      label: "Token",
      kind: "secret",
      hint: "Vacío con un flujo sin navegador: se pide al enviar.",
    },
    {
      name: "grantType",
      label: "Flujo",
      kind: "select",
      fallback: "client_credentials",
      options: [
        { value: "client_credentials", label: "Client credentials" },
        { value: "password_credentials", label: "Contraseña" },
        { value: "authorization_code", label: "Código de autorización" },
        { value: "implicit", label: "Implícito" },
      ],
      hint: "Los dos últimos necesitan un navegador: pide el token y pégalo arriba.",
    },
    { name: "accessTokenUrl", label: "URL del servidor de token" },
    { name: "clientId", label: "Client id" },
    { name: "clientSecret", label: "Client secret", kind: "secret" },
    { name: "scope", label: "Scope" },
    { name: "username", label: "Usuario" },
    { name: "password", label: "Contraseña", kind: "secret" },
    {
      name: "client_authentication",
      label: "La credencial del cliente va en",
      kind: "select",
      fallback: "header",
      options: [
        { value: "header", label: "Cabecera (Basic)" },
        { value: "body", label: "El cuerpo" },
      ],
    },
    { name: "headerPrefix", label: "Prefijo", fallback: "Bearer" },
    { name: "addTokenTo", label: "Va en", kind: "select", options: TOKEN_TO, fallback: "header" },
  ],
  hawk: [
    { name: "authId", label: "Hawk auth id" },
    { name: "authKey", label: "Hawk auth key", kind: "secret" },
    {
      name: "algorithm",
      label: "Algoritmo",
      kind: "select",
      fallback: "sha256",
      options: [
        { value: "sha256", label: "sha256" },
        { value: "sha1", label: "sha1" },
      ],
    },
    { name: "extraData", label: "Ext" },
    { name: "app", label: "App id" },
    { name: "delegation", label: "Delegación" },
  ],
  awsv4: [
    { name: "accessKey", label: "Access key" },
    { name: "secretKey", label: "Secret key", kind: "secret" },
    { name: "sessionToken", label: "Session token", kind: "secret" },
    { name: "region", label: "Región", hint: "Vacío: se saca del host, y si no, us-east-1." },
    { name: "service", label: "Servicio", hint: "Vacío: se saca del host." },
  ],
  edgegrid: [
    { name: "clientToken", label: "Client token" },
    { name: "accessToken", label: "Access token" },
    { name: "clientSecret", label: "Client secret", kind: "secret" },
  ],
  ntlm: [
    { name: "username", label: "Usuario" },
    { name: "password", label: "Contraseña", kind: "secret" },
    { name: "domain", label: "Dominio" },
  ],
};

/** El nombre con el que la gente los reconoce, que es el que usa Postman. */
export const AUTH_LABELS: Record<AuthTypeView, string> = {
  inherit: "Heredar",
  none: "Sin autenticación",
  basic: "Basic",
  bearer: "Bearer token",
  apikey: "Clave de API",
  jwt: "JWT",
  digest: "Digest",
  oauth1: "OAuth 1.0",
  oauth2: "OAuth 2.0",
  hawk: "Hawk",
  awsv4: "AWS Signature",
  edgegrid: "Akamai EdgeGrid",
  ntlm: "NTLM",
};

/** Lo que este producto no puede hacer, dicho en el propio selector y no después de enviar. */
const CAVEATS: Partial<Record<AuthTypeView, string>> = {
  ntlm: "NTLM negocia en tres vueltas con el servidor: no se puede firmar. Usa un proxy que lo haga.",
};

/** Un parámetro cuyo valor no se guarda si no es una variable. */
const isSecret = (field: Field): boolean => field.kind === "secret";
const ONLY_VARIABLES = /^(?:\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}\s*)+$/;

export function AuthEditor({
  auth,
  onChange,
  variables,
  disabled,
  inheritHint,
  order,
}: {
  auth: RequestAuthView;
  onChange: (auth: RequestAuthView) => void;
  variables: string[];
  disabled?: boolean;
  /** Qué significa «heredar» aquí: lo que hará el proyecto si se elige. */
  inheritHint?: string;
  /** Los tipos a ofrecer, en orden. El editor de un endpoint ofrece todos. */
  order?: AuthTypeView[];
}) {
  const types = order ?? (Object.keys(AUTH_LABELS) as AuthTypeView[]);
  const fields = AUTH_FIELDS[auth.type] ?? [];
  const set = (name: string, value: string) => onChange({ ...auth, params: { ...auth.params, [name]: value } });

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Tipo</span>
        <select
          aria-label="Tipo de autenticación"
          className="h-8 w-full rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-900 disabled:bg-slate-50"
          value={auth.type}
          disabled={disabled}
          // Los parámetros se conservan al cambiar de tipo, igual que el cuerpo conserva lo que
          // tenía cada modo: quien prueba `basic` y vuelve a `bearer` espera su token todavía ahí.
          onChange={(event) => onChange({ ...auth, type: event.target.value as AuthTypeView })}
        >
          {types.map((type) => (
            <option key={type} value={type}>
              {AUTH_LABELS[type]}
            </option>
          ))}
        </select>
      </label>

      {auth.type === "inherit" && inheritHint && <p className="text-[11px] text-slate-500">{inheritHint}</p>}
      {auth.type === "none" && <p className="text-[11px] text-slate-500">No se añade ninguna credencial.</p>}
      {CAVEATS[auth.type] && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{CAVEATS[auth.type]}</p>
      )}

      {fields.map((field) => (
        <AuthField
          key={field.name}
          field={field}
          value={auth.params[field.name] ?? ""}
          onChange={(value) => set(field.name, value)}
          variables={variables}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function AuthField({
  field,
  value,
  onChange,
  variables,
  disabled,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
  variables: string[];
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const secret = isSecret(field);
  const stored = !secret || !value.trim() || ONLY_VARIABLES.test(value.trim());

  // Un `div` y no un `label`: el botón de «Ver» va al lado del título, y dentro de un `label` el
  // texto del botón acabaría siendo parte del nombre del campo.
  return (
    <div className="block">
      <span className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{field.label}</span>
        {secret && value.trim() !== "" && (
          <button
            type="button"
            className="text-[10px] text-slate-400 hover:text-slate-700"
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? "Ocultar" : "Ver"}
          </button>
        )}
      </span>
      {field.kind === "select" ? (
        <select
          aria-label={field.label}
          className="h-8 w-full rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-900 disabled:bg-slate-50"
          value={value || field.fallback || ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === "area" ? (
        <textarea
          aria-label={field.label}
          className="min-h-20 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 font-mono text-xs outline-none focus:border-slate-900 disabled:bg-slate-50"
          value={value}
          disabled={disabled}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <VariableSuggest variables={variables} value={value} onChange={onChange}>
          {(suggest) => (
            <input
              {...suggest}
              aria-label={field.label}
              type={secret && !revealed ? "password" : "text"}
              autoComplete="off"
              className={cn(
                "h-8 w-full rounded-lg border px-3 font-mono text-xs outline-none focus:border-slate-900 disabled:bg-slate-50",
                stored ? "border-slate-200" : "border-amber-300 bg-amber-50/40",
              )}
              disabled={disabled}
              placeholder={field.placeholder ?? (field.fallback ? `${field.fallback} por defecto` : "")}
              spellCheck={false}
            />
          )}
        </VariableSuggest>
      )}
      {!stored && (
        <span className="mt-1 block text-[11px] text-amber-700">
          Se envía, pero no se guarda: escríbelo como {"{{variable}}"} y guarda el valor en el entorno como sensible.
        </span>
      )}
      {field.hint && stored && <span className="mt-1 block text-[11px] text-slate-400">{field.hint}</span>}
    </div>
  );
}
