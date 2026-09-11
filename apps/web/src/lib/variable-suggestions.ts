/**
 * What `{{` is the start of, and what to put after it.
 *
 * The engine has interpolated `{{nombre}}` since the beginning and the editor never helped: the
 * names live on another screen, so writing one meant remembering it exactly, and getting it wrong
 * is not a typo you see. It is a run that goes out with `{{userID}}` in the path, comes back 404,
 * and reads as a broken endpoint — the failure kind says `config`, and only because somebody
 * thought to make it say that.
 *
 * The logic is here and not in the component because the interesting part has no DOM in it: where
 * the token being typed starts, whether it is still open, and which names match it. A dropdown is
 * easy to eyeball and impossible to be sure about; these are the cases that were wrong at some
 * point and are pinned now.
 */

/** The token under the caret: where its `{{` is, and what has been typed since. */
export type OpenToken = { start: number; query: string };

/**
 * The `{{` the caret is inside, or `null`.
 *
 * Read **backwards from the caret**, which is the whole trick: a value very often holds more than
 * one token — `/{{tenant}}/pedidos/{{pedidoId}}` — and scanning forwards finds the first one
 * rather than the one being written. The scan stops at the first `}}` it meets, because a token
 * that is already closed is not being typed any more.
 *
 * A name cannot contain `{`, `}` or a space, so any of those between the `{{` and the caret means
 * this is not a name in progress — `{{ no es` is text somebody wrote, not a variable.
 */
export function openTokenAt(text: string, caret: number): OpenToken | null {
  const before = text.slice(0, caret);
  const opened = before.lastIndexOf("{{");
  if (opened === -1) return null;
  const query = before.slice(opened + 2);
  if (query.includes("}") || /[{\s]/.test(query)) return null;
  return { start: opened, query };
}

/**
 * The names worth offering for what has been typed, best first.
 *
 * A prefix match sorts above a match in the middle, because the prefix is what somebody typing
 * means: after `us`, `userId` has to come before `previousUser`. Beyond that it is alphabetical,
 * so the list does not reorder itself between two keystrokes that match the same set.
 *
 * Capped, and not because a long list is slow. It is drawn over the form; twenty names would
 * cover the field being typed into and the one below it.
 */
export function suggestionsFor(names: string[], query: string, limit = 8): string[] {
  const wanted = query.toLowerCase();
  const matching = names.filter((name) => name.toLowerCase().includes(wanted));
  return matching
    .sort((left, right) => {
      const byPrefix = Number(right.toLowerCase().startsWith(wanted)) - Number(left.toLowerCase().startsWith(wanted));
      return byPrefix || left.localeCompare(right);
    })
    .slice(0, limit);
}

/**
 * The text with the chosen name written in, and where the caret goes.
 *
 * The closing `}}` is added here and **not** when it is already there: somebody who went back to
 * fix the middle of `{{userld}}` would otherwise end up with `{{userId}}}}`, which interpolates to
 * nothing and looks like a typo they made. The caret lands after the braces, which is where the
 * next thing they type belongs.
 */
export function applySuggestion(
  text: string,
  token: OpenToken,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const closed = text.slice(caret).startsWith("}}");
  const inserted = `{{${name}}}`;
  const after = text.slice(caret + (closed ? 2 : 0));
  return { text: `${text.slice(0, token.start)}${inserted}${after}`, caret: token.start + inserted.length };
}
