/**
 * The password rules, said before the request leaves.
 *
 * The API decides — `modules/auth/domain/password-policy.ts` — and this mirrors it so the form can
 * tick the rules off while somebody types instead of answering 422 four times. If the two ever
 * disagree the server wins, and the form shows what the server said.
 */
export const PASSWORD_RULES: { label: string; holds: (password: string) => boolean }[] = [
  { label: "12 caracteres o más", holds: (password) => password.length >= 12 },
  { label: "una minúscula", holds: (password) => /\p{Ll}/u.test(password) },
  { label: "una mayúscula", holds: (password) => /\p{Lu}/u.test(password) },
  { label: "un número", holds: (password) => /\p{Nd}/u.test(password) },
  { label: "un símbolo", holds: (password) => /[^\p{L}\p{Nd}]/u.test(password) },
];

export function passwordIsStrong(password: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.holds(password));
}
