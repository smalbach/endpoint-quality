/**
 * «Autenticación»: how the project logs in to its API.
 *
 * Shared by «Nuevo proyecto» and Settings, so the two cannot offer different fields. A stored
 * secret is never in the page: its input is empty with a placeholder saying one is saved, typing
 * replaces it, and «Quitar» deletes it.
 */
import type { ReactNode } from "react";
import { Field, inputClass } from "@/components/ui";
import { HelpTooltip } from "@/components/overlay";
import { AUTH_TYPES, LOGIN_METHODS, MASK } from "@/lib/project-auth";
import type { ProjectAuthType, ProjectAuthView } from "@/lib/types";

export function ProjectAuthFields({
  value,
  onChange,
  errors = {},
  disabled,
}: {
  value: ProjectAuthView;
  onChange: (next: ProjectAuthView) => void;
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ProjectAuthView>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-slate-800">Autenticación</span>
        <HelpTooltip content="Cómo se entra en la API del proyecto. Las credenciales se guardan cifradas y no vuelven a mostrarse. Cada entorno puede tener además credenciales propias por rol." />
      </div>

      <Field label="Tipo">
        <select
          className={inputClass}
          value={value.type}
          disabled={disabled}
          onChange={(event) => set({ type: event.target.value as ProjectAuthType })}
        >
          {AUTH_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </Field>

      {value.type === "bearer" && (
        <>
          <SecretInput
            label="Token"
            hint="Un token fijo. Déjalo vacío si se obtiene con el login de abajo."
            placeholder="eyJ…"
            value={value.token}
            error={errors["auth.token"]}
            disabled={disabled}
            onChange={(token) => set({ token })}
          />
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <Field label="URL de login" hint="Absoluta o una ruta que empiece por /." error={errors["auth.loginUrl"]}>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={value.loginUrl}
                placeholder="https://api.example.com/auth/login"
                disabled={disabled}
                onChange={(event) => set({ loginUrl: event.target.value })}
              />
            </Field>
            <Field label="Método">
              <select
                className={inputClass}
                value={value.loginMethod}
                disabled={disabled}
                onChange={(event) => set({ loginMethod: event.target.value })}
              >
                {LOGIN_METHODS.map((method) => (
                  <option key={method}>{method}</option>
                ))}
              </select>
            </Field>
          </div>
          <SecretInput
            label="Body del login (JSON)"
            hint="Opcional. Suele llevar el usuario y la contraseña, así que se guarda cifrado."
            placeholder={'{\n  "email": "qa@example.com",\n  "password": "…"\n}'}
            value={value.loginBody}
            error={errors["auth.loginBody"]}
            disabled={disabled}
            multiline
            onChange={(loginBody) => set({ loginBody })}
          />
          <Field label="Ruta del token en la respuesta" hint="Con puntos, por ejemplo data.access_token.">
            <input
              className={`${inputClass} font-mono text-xs`}
              value={value.tokenPath}
              placeholder="data.access_token"
              disabled={disabled}
              onChange={(event) => set({ tokenPath: event.target.value })}
            />
          </Field>
        </>
      )}

      {value.type === "basic" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Usuario" error={errors["auth.username"]}>
            <input
              className={inputClass}
              value={value.username}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) => set({ username: event.target.value })}
            />
          </Field>
          <SecretInput
            label="Contraseña"
            value={value.password}
            error={errors["auth.password"]}
            disabled={disabled}
            onChange={(password) => set({ password })}
          />
        </div>
      )}

      {value.type === "api_key" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cabecera" error={errors["auth.headerName"]}>
            <input
              className={`${inputClass} font-mono text-xs`}
              value={value.headerName}
              placeholder="X-API-Key"
              disabled={disabled}
              onChange={(event) => set({ headerName: event.target.value })}
            />
          </Field>
          <SecretInput
            label="Clave"
            value={value.apiKey}
            error={errors["auth.apiKey"]}
            disabled={disabled}
            onChange={(apiKey) => set({ apiKey })}
          />
        </div>
      )}
    </div>
  );
}

function SecretInput({
  label,
  hint,
  placeholder,
  value,
  error,
  disabled,
  multiline,
  onChange,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  error?: string;
  disabled?: boolean;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const saved = value === MASK;
  const shown = saved ? "" : value;
  const savedPlaceholder = "Guardado y cifrado · escribe para sustituirlo";
  let control: ReactNode;
  if (multiline) {
    control = (
      <textarea
        className={`${inputClass} h-24 font-mono text-[11px]`}
        value={shown}
        placeholder={saved ? savedPlaceholder : placeholder}
        disabled={disabled}
        spellCheck={false}
        // Emptying the box of a saved secret does not delete it; «Quitar» does. Otherwise clicking
        // into the field and out again would be a deletion nobody meant.
        onChange={(event) => onChange(event.target.value || (saved ? MASK : ""))}
      />
    );
  } else {
    control = (
      <input
        type="password"
        className={`${inputClass} font-mono text-xs`}
        value={shown}
        placeholder={saved ? savedPlaceholder : placeholder}
        disabled={disabled}
        autoComplete="new-password"
        onChange={(event) => onChange(event.target.value || (saved ? MASK : ""))}
      />
    );
  }
  return (
    <div>
      <Field label={label} hint={hint} error={error}>
        {control}
      </Field>
      {saved && !disabled && (
        <button
          className="mt-1 text-[11px] text-rose-600 hover:text-rose-700"
          type="button"
          onClick={() => onChange("")}
        >
          Quitar el guardado
        </button>
      )}
    </div>
  );
}
