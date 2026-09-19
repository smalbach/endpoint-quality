/**
 * Entrar, crear cuenta y recuperar la contraseña.
 *
 * Lo que decide algo:
 *
 * - **El error es el del servidor, tal cual**, y el de un campo va junto a ese campo.
 * - **Una invitación en la URL sobrevive al registro**: se acepta en cuanto hay sesión y se entra
 *   en esa organización, no en la recién fundada.
 * - **«¿Olvidaste tu contraseña?» dice lo mismo haya cuenta o no**, falle o no la petición.
 * - **Restablecer no deja guardar una contraseña débil o que no coincide**, y un token caducado
 *   ofrece pedir otro.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { LoginPage } from "@/routes/login";
import { ForgotPasswordPage, ResetPasswordPage } from "@/routes/password-reset";
import { NotFoundPage } from "@/routes/not-found";
import { ApiError } from "@/lib/api";

const call = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({
  status: "anonymous" as string,
  signIn: vi.fn(),
  signUp: vi.fn(),
  reload: vi.fn(),
  selectOrganization: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({ ...(await original<object>()), api: call }));
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));

function draw(element: React.ReactNode, at = "/login") {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/login" element={element} />
        <Route path="/register" element={element} />
        <Route path="/reset-password" element={element} />
        <Route path="/forgot-password" element={element} />
        <Route path="/" element={<p>Inicio</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const problem = (detail: string, errors?: { field: string; detail: string }[]) =>
  new ApiError(422, { type: "", title: "Invalid", status: 422, detail, ...(errors ? { errors } : {}) });

function reset() {
  call.mockReset();
  auth.status = "anonymous";
  auth.signIn.mockReset().mockResolvedValue(undefined);
  auth.signUp.mockReset().mockResolvedValue(undefined);
  auth.reload.mockReset().mockResolvedValue(undefined);
  auth.selectOrganization.mockReset();
}

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("LoginPage", () => {
  test("entra con correo y contraseña y va al inicio", async () => {
    reset();
    draw(<LoginPage mode="login" />);
    expect(screen.getByText("Entra para ver tus proyectos y sus corridas.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "¿Olvidaste tu contraseña?" }).getAttribute("href")).toBe(
      "/forgot-password",
    );
    type(/Correo/, "ana@example.com");
    type(/Contraseña/, "secreta");
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Inicio")).toBeTruthy();
    expect(auth.signIn).toHaveBeenCalledWith("ana@example.com", "secreta");
    expect(call).not.toHaveBeenCalled();
  });

  test("el error del servidor se enseña tal cual, y vuelve a estar disponible el botón", async () => {
    reset();
    auth.signIn.mockRejectedValue(problem("Credenciales incorrectas"));
    draw(<LoginPage mode="login" />);
    type(/Correo/, "ana@example.com");
    type(/Contraseña/, "mala");
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Credenciales incorrectas")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Entrar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("un error de campo va junto a su campo y no se repite arriba", async () => {
    reset();
    auth.signUp.mockRejectedValue(problem("Datos inválidos", [{ field: "body.email", detail: "Correo ya usado" }]));
    draw(<LoginPage mode="register" />, "/register");
    type(/Nombre/, "Ana");
    type(/Correo/, "ana@example.com");
    type(/Contraseña/, "Muy-Segura-123");
    type(/Organización/, "Acme");
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
    expect(await screen.findByText("Correo ya usado")).toBeTruthy();
    expect(screen.queryByText("Datos inválidos")).toBeNull();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "ana@example.com",
      password: "Muy-Segura-123",
      name: "Ana",
      organizationName: "Acme",
    });
  });

  test("registrarse con una invitación la acepta y entra en esa organización", async () => {
    reset();
    call.mockResolvedValue({ organizationId: "org-invita" });
    draw(<LoginPage mode="register" />, "/register?invitation=tok-1");
    expect(screen.getByText(/Te han invitado a una organización/)).toBeTruthy();
    // Con invitación no se pide nombre de organización: se entra en la que invita.
    expect(screen.queryByLabelText(/Organización/)).toBeNull();
    type(/Nombre/, "Ana");
    type(/Correo/, "ana@example.com");
    type(/Contraseña/, "Muy-Segura-123");
    fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
    expect(await screen.findByText("Inicio")).toBeTruthy();
    expect(auth.signUp).toHaveBeenCalledWith({ email: "ana@example.com", password: "Muy-Segura-123", name: "Ana" });
    expect(call).toHaveBeenCalledWith("/invitations/accept", { method: "POST", body: { token: "tok-1" } });
    expect(auth.selectOrganization).toHaveBeenCalledWith("org-invita");
    expect(auth.reload).toHaveBeenCalled();
  });

  test("con la sesión abierta no enseña el formulario: va al inicio", () => {
    reset();
    auth.status = "authenticated";
    draw(<LoginPage mode="login" />);
    expect(screen.getByText("Inicio")).toBeTruthy();
  });
});

describe("ForgotPasswordPage", () => {
  test("dice lo mismo aunque la petición falle", async () => {
    reset();
    call.mockRejectedValue(new Error("red"));
    draw(<ForgotPasswordPage />, "/forgot-password");
    const button = screen.getByRole("button", { name: "Enviar el enlace" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    type(/Correo/, "nadie@example.com");
    fireEvent.click(button);
    expect(await screen.findByText(/Si hay una cuenta con ese correo/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/auth/forgot-password", {
      method: "POST",
      body: { email: "nadie@example.com" },
      retryOnUnauthorized: false,
    });
  });
});

describe("ResetPasswordPage", () => {
  test("sin token no hay formulario, sino un enlace para pedir otro", () => {
    reset();
    draw(<ResetPasswordPage />, "/reset-password");
    expect(screen.getByText("Enlace incompleto")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pedir un enlace nuevo" })).toBeTruthy();
  });

  test("no deja guardar hasta que es fuerte y coincide, y al guardar lo confirma", async () => {
    reset();
    call.mockResolvedValue(undefined);
    draw(<ResetPasswordPage />, "/reset-password?token=abc");
    const save = () => screen.getByRole("button", { name: "Guardar la contraseña" }) as HTMLButtonElement;
    type(/Contraseña nueva/, "corta");
    expect(save().disabled).toBe(true);
    type(/Contraseña nueva/, "Muy-Segura-123");
    type(/Repítela/, "Muy-Segura-12");
    expect(screen.getByText("No coinciden")).toBeTruthy();
    expect(save().disabled).toBe(true);
    type(/Repítela/, "Muy-Segura-123");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    expect(await screen.findByText("Contraseña cambiada")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("/auth/reset-password", {
      method: "POST",
      body: { token: "abc", newPassword: "Muy-Segura-123" },
      retryOnUnauthorized: false,
    });
  });

  test("un token caducado enseña el error y ofrece pedir un enlace nuevo", async () => {
    reset();
    call.mockRejectedValue(problem("El enlace ha caducado", [{ field: "token", detail: "caducado" }]));
    draw(<ResetPasswordPage />, "/reset-password?token=viejo");
    type(/Contraseña nueva/, "Muy-Segura-123");
    type(/Repítela/, "Muy-Segura-123");
    fireEvent.click(screen.getByRole("button", { name: "Guardar la contraseña" }));
    expect(await screen.findByText("El enlace ha caducado")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("link", { name: "Pedir un enlace nuevo" })).toBeTruthy());
  });
});

describe("NotFoundPage", () => {
  test("dice que no existe y lleva a los proyectos", () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("Página no encontrada")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ir a proyectos" }).getAttribute("href")).toBe("/projects");
  });
});
