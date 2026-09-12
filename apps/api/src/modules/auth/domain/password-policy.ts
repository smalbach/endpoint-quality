/**
 * What a password has to be, decided once for register, change and reset.
 *
 * Length stays the rule that buys the entropy — twelve characters, as before. The composition
 * rules on top (a lower-case letter, an upper-case one, a digit and a symbol) are the analyzer's,
 * brought over for parity: on their own they mostly push people towards `Password1!`, which is why
 * the minimum length did not come down to meet them.
 *
 * Three callers and one list of problems, so the three cannot drift into accepting different
 * passwords — the one that is laxer is the one an attacker resets to.
 */
import { InvalidInputError } from "@/shared/errors/domain-error";

export const PASSWORD_MIN_LENGTH = 12;

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (!/\p{Ll}/u.test(password)) problems.push("Debe incluir una minúscula");
  if (!/\p{Lu}/u.test(password)) problems.push("Debe incluir una mayúscula");
  if (!/\p{Nd}/u.test(password)) problems.push("Debe incluir un número");
  if (!/[^\p{L}\p{Nd}]/u.test(password)) problems.push("Debe incluir un símbolo");
  return problems;
}

export function assertStrongPassword(password: string, field: string): void {
  const problems = passwordProblems(password);
  if (problems.length === 0) return;
  throw new InvalidInputError(
    "La contraseña no cumple los requisitos",
    problems.map((detail) => ({ field, detail })),
    "weak-password",
  );
}
