/**
 * A string that satisfies a `pattern`, for the subset of regular expressions contracts actually
 * use.
 *
 * `exampleFromSchema` used to hand every unformatted string the same placeholder, and a field
 * declaring `pattern: "^[A-Z]{3}-\\d{4}$"` got `"ejemplo"` — a 422 written by this tool, about a
 * rule the contract had already published in full. That is the one case where "guessing past the
 * document" is not guessing: the pattern *is* the document.
 *
 * The subset is literals, character classes, escapes, groups, alternation and counted repetition.
 * What is deliberately not supported — backreferences, lookaround with a body that must be
 * satisfied, `\p{…}` — makes this **bail rather than approximate**: it returns `undefined` and the
 * caller keeps the placeholder. A value that looks like it honours a rule and does not is worse
 * than one that visibly does not, because the first sends somebody looking at the endpoint.
 *
 * Everything generated is checked against the real `RegExp` before it is used, in
 * `stringExample`. This file can be wrong; the result cannot pass unnoticed.
 */

/** Longer than any pattern-derived identifier, and short enough that `{1,1000}` cannot be used to
 * build a payload nobody asked for. */
const MAX_OUTPUT = 200;
/** Alternation and nesting are explored depth-first; a pattern nested deeper than this is past
 * what any contract writes and into what a fuzzer writes. */
const MAX_DEPTH = 12;

type Cursor = { readonly source: string; index: number; readonly minLength: number; depth: number };

/**
 * The example, or `undefined` when the pattern uses something this does not implement.
 *
 * `minLength` is a hint, not a guarantee: a repetition that may grow (`+`, `*`, `{2,8}`) is
 * expanded towards it, and a pattern of fixed length simply ignores it — the caller compares the
 * result against both bounds and discards it if the two rules cannot be satisfied at once.
 */
export function exampleFromPattern(pattern: string, minLength = 0): string | undefined {
  if (!pattern || pattern.length > 400) return undefined;
  const cursor: Cursor = { source: pattern, index: 0, minLength, depth: 0 };
  const value = alternation(cursor);
  if (value === undefined || cursor.index < pattern.length) return undefined;
  return value.length <= MAX_OUTPUT ? value : undefined;
}

/** `a|b`: the first branch that can be built. A choice in a contract is a choice, and the first
 * one is as good as any — but if it uses something unsupported the others may not. */
function alternation(cursor: Cursor): string | undefined {
  if (cursor.depth++ > MAX_DEPTH) return undefined;
  let chosen: string | undefined;
  for (;;) {
    const start = cursor.index;
    const branch = sequence(cursor);
    if (branch !== undefined && chosen === undefined) chosen = branch;
    if (branch === undefined) {
      // Skip to the next `|` at this level so a broken branch does not poison a good one.
      if (!skipBranch(cursor, start)) return undefined;
    }
    if (cursor.source[cursor.index] !== "|") break;
    cursor.index += 1;
  }
  cursor.depth -= 1;
  return chosen;
}

/** Walks a failed branch to the `|` or `)` that ends it, respecting nesting and escapes. */
function skipBranch(cursor: Cursor, start: number): boolean {
  let depth = 0;
  for (let index = start; index < cursor.source.length; index += 1) {
    const character = cursor.source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) {
        cursor.index = index;
        return true;
      }
      depth -= 1;
    } else if (character === "|" && depth === 0) {
      cursor.index = index;
      return true;
    }
  }
  cursor.index = cursor.source.length;
  return true;
}

function sequence(cursor: Cursor): string | undefined {
  let out = "";
  while (cursor.index < cursor.source.length) {
    const character = cursor.source[cursor.index];
    if (character === "|" || character === ")") break;
    const piece = quantified(cursor, out.length);
    if (piece === undefined) return undefined;
    out += piece;
    if (out.length > MAX_OUTPUT) return undefined;
  }
  return out;
}

/** One atom and whatever repeats it. */
function quantified(cursor: Cursor, produced: number): string | undefined {
  const unit = atom(cursor);
  if (unit === undefined) return undefined;
  const bounds = quantifier(cursor);
  if (!bounds) return unit;

  const [minimum, maximum] = bounds;
  if (minimum > maximum) return undefined;
  let count = minimum;
  // Grown towards `minLength` when the pattern allows it. `[a-z]{2,8}` under `minLength: 6` should
  // produce six characters, not two and then a value the caller has to throw away.
  if (unit.length > 0) {
    const missing = cursor.minLength - (produced + minimum * unit.length);
    if (missing > 0) count = Math.min(maximum, minimum + Math.ceil(missing / unit.length));
  }
  if (count * Math.max(unit.length, 1) > MAX_OUTPUT) return undefined;
  return unit.repeat(count);
}

/** `*` `+` `?` `{n}` `{n,}` `{n,m}`, lazy or not — laziness changes nothing about what matches. */
function quantifier(cursor: Cursor): [number, number] | null {
  const character = cursor.source[cursor.index];
  const lazy = () => {
    if (cursor.source[cursor.index] === "?" || cursor.source[cursor.index] === "+") cursor.index += 1;
  };
  if (character === "*") {
    cursor.index += 1;
    lazy();
    return [0, 32];
  }
  if (character === "+") {
    cursor.index += 1;
    lazy();
    return [1, 32];
  }
  if (character === "?") {
    cursor.index += 1;
    lazy();
    return [0, 1];
  }
  if (character !== "{") return null;
  const close = cursor.source.indexOf("}", cursor.index);
  if (close < 0) return null;
  const body = cursor.source.slice(cursor.index + 1, close);
  const counted = /^(\d+)(,(\d*)?)?$/.exec(body);
  if (!counted) return null;
  cursor.index = close + 1;
  lazy();
  const minimum = Number(counted[1]);
  if (!counted[2]) return [minimum, minimum];
  return [minimum, counted[3] ? Number(counted[3]) : Math.max(minimum, 32)];
}

function atom(cursor: Cursor): string | undefined {
  const character = cursor.source[cursor.index];
  // Anchors and word boundaries match a position, not a character.
  if (character === "^" || character === "$") {
    cursor.index += 1;
    return "";
  }
  if (character === "(") return group(cursor);
  if (character === "[") return characterClass(cursor);
  if (character === "\\") return escaped(cursor);
  if (character === ".") {
    cursor.index += 1;
    return "a";
  }
  // `*`, `+`, `?`, `{` here means a quantifier with nothing to repeat: not a valid pattern.
  if (character === "*" || character === "+" || character === "?") return undefined;
  cursor.index += 1;
  return character;
}

function group(cursor: Cursor): string | undefined {
  cursor.index += 1;
  let lookaround = false;
  if (cursor.source[cursor.index] === "?") {
    const kind = cursor.source[cursor.index + 1];
    if (kind === ":") cursor.index += 2;
    else if (kind === "=" || kind === "!") {
      // A lookahead constrains what comes *after* without consuming it. Producing nothing for it
      // is right for `(?!…)` and wrong for `(?=…)`, which is why the caller re-checks the result:
      // if the assertion mattered, the generated string fails the real regular expression and is
      // discarded.
      lookaround = true;
      cursor.index += 2;
    } else if (kind === "<" && (cursor.source[cursor.index + 2] === "=" || cursor.source[cursor.index + 2] === "!")) {
      lookaround = true;
      cursor.index += 3;
    } else if (kind === "<") {
      const close = cursor.source.indexOf(">", cursor.index);
      if (close < 0) return undefined;
      cursor.index = close + 1;
    } else return undefined;
  }
  const body = alternation(cursor);
  if (cursor.source[cursor.index] !== ")") return undefined;
  cursor.index += 1;
  if (body === undefined) return undefined;
  return lookaround ? "" : body;
}

/** The first character the class admits, or the first printable one it does not exclude. */
function characterClass(cursor: Cursor): string | undefined {
  cursor.index += 1;
  const negated = cursor.source[cursor.index] === "^";
  if (negated) cursor.index += 1;

  const allowed: string[] = [];
  const excluded = new Set<string>();
  let closed = false;

  while (cursor.index < cursor.source.length) {
    if (cursor.source[cursor.index] === "]") {
      cursor.index += 1;
      closed = true;
      break;
    }
    if (cursor.source[cursor.index] === "\\") {
      const shorthand = classEscape(cursor);
      if (shorthand === undefined) return undefined;
      if (negated) for (const value of shorthand) excluded.add(value);
      else allowed.push(...shorthand);
      continue;
    }
    const character = cursor.source[cursor.index];
    cursor.index += 1;
    // A range: `a-z`. The `-` is a literal when it is the last thing before the `]`.
    if (
      cursor.source[cursor.index] === "-" &&
      cursor.source[cursor.index + 1] !== undefined &&
      cursor.source[cursor.index + 1] !== "]"
    ) {
      const upper = cursor.source[cursor.index + 1];
      cursor.index += 2;
      if (character.charCodeAt(0) > upper.charCodeAt(0)) return undefined;
      if (negated)
        for (let code = character.charCodeAt(0); code <= upper.charCodeAt(0); code += 1)
          excluded.add(String.fromCharCode(code));
      else allowed.push(character);
      continue;
    }
    if (negated) excluded.add(character);
    else allowed.push(character);
  }
  if (!closed) return undefined;
  if (!negated) return allowed.length ? allowed[0] : undefined;

  // `[^…]`: the first ordinary character the class leaves alone. Letters before digits before
  // punctuation, so a negated class most often yields something that reads as a value.
  for (const candidate of "abcdefghijklmnopqrstuvwxyz0123456789-_.") if (!excluded.has(candidate)) return candidate;
  return undefined;
}

/** `\d`, `\w`, `\s` and friends inside a class, as the characters they stand for. */
function classEscape(cursor: Cursor): string[] | undefined {
  const character = cursor.source[cursor.index + 1];
  if (character === undefined) return undefined;
  cursor.index += 2;
  const shorthand = SHORTHAND[character];
  if (shorthand) return shorthand;
  if (
    character === "d" ||
    character === "w" ||
    character === "s" ||
    character === "D" ||
    character === "W" ||
    character === "S"
  )
    return undefined;
  return [LITERAL_ESCAPE[character] ?? character];
}

const SHORTHAND: Record<string, string[] | undefined> = {
  d: ["0"],
  w: ["a"],
  s: [" "],
};

const LITERAL_ESCAPE: Record<string, string | undefined> = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", 0: "\0" };

function escaped(cursor: Cursor): string | undefined {
  const character = cursor.source[cursor.index + 1];
  if (character === undefined) return undefined;
  cursor.index += 2;
  // A backreference has to equal a group this does not track, and `\p{…}` needs the Unicode
  // tables. Both bail, and the placeholder stands.
  if (/[1-9pPkbBu]/.test(character)) {
    if (character === "b" || character === "B") return "";
    return undefined;
  }
  if (character === "d") return "0";
  if (character === "w") return "a";
  if (character === "s") return " ";
  // `\\W` is a *non*-word character, so "a" would be exactly wrong.
  if (character === "D" || character === "S") return "a";
  if (character === "W") return "-";
  if (character === "x") {
    const hex = cursor.source.slice(cursor.index, cursor.index + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
    cursor.index += 2;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }
  return LITERAL_ESCAPE[character] ?? character;
}
