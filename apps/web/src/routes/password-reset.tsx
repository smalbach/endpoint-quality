import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { Button, Card, Field, inputClass } from "@/components/ui";
import { PasswordChecklist } from "@/components/password-checklist";
import { passwordIsStrong } from "@/lib/password-rules";

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        {children}
      </Card>
    </div>
  );
}

/**
 * «¿Olvidaste tu contraseña?»
 *
 * The confirmation is the same whether the address has an account or not, and whether the request
 * worked or not — the API answers 204 either way, and saying «no existe» here would undo that.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/auth/forgot-password", { method: "POST", body: { email }, retryOnUnauthorized: false });
    } catch {
      // Deliberately swallowed: see above.
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <AuthCard title="Restablecer la contraseña" subtitle="Escribe tu correo y te mandamos un enlace para elegir otra.">
      {sent ? (
        <div className="mt-6 space-y-4">
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
            Si hay una cuenta con ese correo, le hemos enviado un enlace. Funciona una vez durante una hora.
          </p>
          <Link className="block text-center text-xs font-medium text-slate-900 underline" to="/login">
            Volver a entrar
          </Link>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <Field label="Correo">
            <input
              className={inputClass}
              type="email"
              value={email}
              required
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Button className="w-full" type="submit" disabled={busy || !email}>
            {busy ? "Enviando…" : "Enviar el enlace"}
          </Button>
          <p className="text-center text-xs text-slate-500">
            <Link className="font-medium text-slate-900 underline" to="/login">
              Volver a entrar
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}

/** The page the mail links to: `?token=`, a new password twice, and back to sign in. */
export function ResetPasswordPage() {
  const token = useSearchParams()[0].get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: { token, newPassword: password },
        retryOnUnauthorized: false,
      });
      setDone(true);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthCard title="Enlace incompleto" subtitle="A este enlace le falta el token.">
        <Link className="mt-6 block text-center text-xs font-medium text-slate-900 underline" to="/forgot-password">
          Pedir un enlace nuevo
        </Link>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard
        title="Contraseña cambiada"
        subtitle="Las sesiones que tenías abiertas se han cerrado. Entra con la nueva."
      >
        <Link
          className="mt-6 flex h-9 items-center justify-center rounded-lg bg-slate-900 text-sm font-medium text-white"
          to="/login"
        >
          Entrar
        </Link>
      </AuthCard>
    );
  }

  const tokenProblem = error instanceof ApiError && error.fields.some((field) => field.field === "token");

  return (
    <AuthCard title="Elige una contraseña nueva" subtitle="Al guardarla se cierran las sesiones abiertas.">
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <Field label="Contraseña nueva">
          <input
            className={inputClass}
            type="password"
            value={password}
            required
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <PasswordChecklist password={password} />
        <Field label="Repítela" error={mismatch ? "No coinciden" : undefined}>
          <input
            className={inputClass}
            type="password"
            value={confirm}
            required
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        {error && (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <p>{error.message}</p>
            {tokenProblem && (
              <Link className="mt-1 inline-block font-medium underline" to="/forgot-password">
                Pedir un enlace nuevo
              </Link>
            )}
          </div>
        )}
        <Button className="w-full" type="submit" disabled={busy || !passwordIsStrong(password) || confirm !== password}>
          {busy ? "Guardando…" : "Guardar la contraseña"}
        </Button>
      </form>
    </AuthCard>
  );
}
