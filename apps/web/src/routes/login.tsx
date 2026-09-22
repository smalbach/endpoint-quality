import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, Field, inputClass } from "@/components/ui";
import { PasswordChecklist } from "@/components/password-checklist";
import { BackendSwitcher } from "@/components/backend-switcher";

/**
 * Sign in and sign up, on one screen each.
 *
 * The error is whatever the API said, verbatim, including its field list. The server answers the
 * same thing for a wrong password and an unknown address — deliberately, so the page cannot leak
 * which — and inventing a friendlier local message here would either repeat that answer or
 * undo it.
 */
export function LoginPage({ mode }: { mode: "login" | "register" }) {
  const { status, signIn, signUp, reload, selectOrganization } = useAuth();
  /**
   * An invitation carried in the URL.
   *
   * The API accepts an invitation on behalf of a signed-in user, which means the token has to
   * survive the sign-up: the invitee follows a link, creates the account the link was meant for,
   * and would otherwise land in an organization of their own with no way back to the one that
   * invited them. Accepting right after the session exists is what closes that.
   */
  const invitation = useSearchParams()[0].get("invitation");
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "authenticated") return <Navigate to="/" replace />;

  const fieldError = (field: string) =>
    error instanceof ApiError ? error.fields.find((entry) => entry.field.includes(field))?.detail : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await signIn(email, password);
      else await signUp({ email, password, name, ...(organizationName ? { organizationName } : {}) });
      if (invitation) {
        const accepted = await api<{ organizationId: string }>("/invitations/accept", {
          method: "POST",
          body: { token: invitation },
        });
        // And land *in* it. Registering also founds an organization of your own, so without this
        // the invitee arrives at an empty one and the invitation looks like it did nothing.
        selectOrganization(accepted.organizationId);
        await reload();
      }
      void navigate("/", { replace: true });
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-50 px-4">
      <Card className="w-full max-w-lg p-6">
        <h1 className="text-lg font-semibold text-slate-900">Endpoint Quality</h1>
        <p className="mt-1 text-xs text-slate-500">
          {invitation
            ? "Te han invitado a una organización. Crea tu cuenta y entrarás directamente en ella."
            : mode === "login"
              ? "Entra para ver tus proyectos y sus corridas."
              : "Crea una cuenta y la organización que la contiene."}
        </p>

        {/* Antes del formulario y no en un ajuste escondido: con cuál de las tres
            implementaciones de la API se entra es una decisión que se toma **antes** de entrar, y
            a partir de ahí la sigue todo el flujo. */}
        <div className="mt-5">
          <BackendSwitcher variant="full" />
        </div>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          {mode === "register" && (
            <Field label="Nombre" error={fieldError("name")}>
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="Correo" error={fieldError("email")}>
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
            />
          </Field>
          <Field label="Contraseña" error={fieldError("password")}>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </Field>
          {mode === "register" ? (
            <PasswordChecklist password={password} />
          ) : (
            <div className="-mt-2 text-right">
              <Link
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
                to="/forgot-password"
              >
                ¿Olvidaste tu contraseña?
              </Link>
            </div>
          )}
          {mode === "register" && !invitation && (
            <Field label="Organización" hint="Opcional. Si la dejas vacía se crea una con tu nombre.">
              <input
                className={inputClass}
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                autoComplete="organization"
              />
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
              ¿Sin cuenta?{" "}
              <Link className="font-medium text-slate-900 underline" to="/register">
                Crear una
              </Link>
            </>
          ) : (
            <>
              ¿Ya tienes cuenta?{" "}
              <Link className="font-medium text-slate-900 underline" to="/login">
                Entrar
              </Link>
            </>
          )}
        </p>
      </Card>
    </div>
  );
}
