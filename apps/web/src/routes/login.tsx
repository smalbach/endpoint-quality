import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, Field, inputClass } from "@/components/ui";

/**
 * Sign in and sign up, on one screen each.
 *
 * The error is whatever the API said, verbatim, including its field list. The server answers the
 * same thing for a wrong password and an unknown address — deliberately, so the page cannot leak
 * which — and inventing a friendlier local message here would either repeat that answer or
 * undo it.
 */
export function LoginPage({ mode }: { mode: "login" | "register" }) {
  const { status, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "authenticated") return <Navigate to="/" replace />;

  const fieldError = (field: string) => (error instanceof ApiError ? error.fields.find((entry) => entry.field.includes(field))?.detail : undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await signIn(email, password);
      else await signUp({ email, password, name, ...(organizationName ? { organizationName } : {}) });
      navigate("/", { replace: true });
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 px-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-slate-900">Endpoint Quality</h1>
        <p className="mt-1 text-xs text-slate-500">
          {mode === "login" ? "Entra para ver tus proyectos y sus corridas." : "Crea una cuenta y la organización que la contiene."}
        </p>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          {mode === "register" && (
            <Field label="Nombre" error={fieldError("name")}>
              <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
            </Field>
          )}
          <Field label="Correo" error={fieldError("email")}>
            <input className={inputClass} type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </Field>
          <Field
            label="Contraseña"
            hint={mode === "register" ? "Al menos 12 caracteres. La longitud es lo único que se exige." : undefined}
            error={fieldError("password")}
          >
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </Field>
          {mode === "register" && (
            <Field label="Organización" hint="Opcional. Si la dejas vacía se crea una con tu nombre.">
              <input className={inputClass} value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} autoComplete="organization" />
            </Field>
          )}

          {error && !fieldError("email") && !fieldError("password") && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error.message}</p>
          )}

          <Button className="w-full" disabled={busy} type="submit">
            {busy ? "…" : mode === "login" ? "Entrar" : "Crear cuenta"}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          {mode === "login" ? (
            <>
              ¿Sin cuenta? <Link className="font-medium text-slate-900 underline" to="/register">Crear una</Link>
            </>
          ) : (
            <>
              ¿Ya tienes cuenta? <Link className="font-medium text-slate-900 underline" to="/login">Entrar</Link>
            </>
          )}
        </p>
      </Card>
    </div>
  );
}
