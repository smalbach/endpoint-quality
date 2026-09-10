/**
 * P6, the parity cut: the same matrix, the same target, two runners, one diff.
 *
 * **Each side runs against a freshly reset backend, and that is why this is three commands and
 * not one.** The matrix writes: it creates stores, mutates them, deletes them, and the coupled
 * dashboard cleans up after itself precisely so it can be run twice. "Precisely so it can" is not
 * "provably does" — and if the first side leaves one row behind, the second side's `POST` meets a
 * UNIQUE and answers 409. That difference would be reported as a decoupling failure when it is
 * nothing of the kind. So `e2e_env.py run` resets the database before each side, each side writes
 * its verdicts to a file, and the comparison reads the two files.
 *
 *     cd digital-catalog-back-end
 *     uv run --frozen python scripts/e2e_env.py run -- node --experimental-strip-types \
 *       ../endpoint-quality/tools/parity-cut/cut.ts legacy   --out /tmp/cut/legacy.json
 *     uv run --frozen python scripts/e2e_env.py run -- node --experimental-strip-types \
 *       ../endpoint-quality/tools/parity-cut/cut.ts product  --out /tmp/cut/product.json
 *     node --experimental-strip-types tools/parity-cut/cut.ts diff /tmp/cut/legacy.json /tmp/cut/product.json
 *
 * Add `--auth` to both run commands **and** to `e2e_env.py` for the pass that exercises the 97
 * credential cases. `scripts/parity-cut.sh` does the whole thing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { legacyVerdicts, type Verdict } from "./legacy-verdicts.ts";
import { openSession, prepareEnvironment, productVerdicts } from "./product-verdicts.ts";

/** `e2e_env.py run` exports both of these for the command it wraps. Preferring them over a flag of
 * mine removes the way this could go wrong quietly: pointing at one backend while asking the other
 * one's question, or comparing a 214-case pass against a 311-case one. */
const TARGET = process.env.EQ_TARGET ?? process.env.E2E_BASE_URL ?? "http://127.0.0.1:8100";
const API = process.env.EQ_API ?? "http://localhost:3001";
const PROJECT = process.env.EQ_PROJECT ?? "Digital Catalog";

type Side = { side: "legacy" | "product"; authEnabled: boolean; target: string; verdicts: Verdict[] };

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function save(path: string, payload: Side): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
  const failed = payload.verdicts.filter((verdict) => !verdict.ok).length;
  console.log(
    `\n${payload.side}: ${payload.verdicts.length} casos · ${payload.verdicts.length - failed} en verde · ${failed} en rojo → ${path}`,
  );
}

async function runLegacy(authEnabled: boolean, out: string): Promise<void> {
  // `--legacy-single-credential` is not a knob, it is the isolation of one finding. See the
  // `singleCredential` field in `legacy/orchestrate.ts`.
  const singleCredential = process.argv.includes("--legacy-single-credential");
  const verdicts = await legacyVerdicts(TARGET, authEnabled, singleCredential, (index, total, key) => {
    process.stdout.write(`\r  legacy ${String(index).padStart(3)}/${total}  ${key.padEnd(52).slice(0, 52)}`);
  });
  save(out, { side: "legacy", authEnabled, target: TARGET, verdicts });
}

async function runProduct(authEnabled: boolean, out: string): Promise<void> {
  const email = process.env.EQ_EMAIL;
  const password = process.env.EQ_PASSWORD;
  if (!email || !password) throw new Error("Faltan EQ_EMAIL y EQ_PASSWORD");
  const session = await openSession(API, email, password, PROJECT);
  const environmentId = await prepareEnvironment(session, authEnabled ? "parity-auth" : "parity", TARGET, authEnabled);
  const verdicts = await productVerdicts(session, environmentId, (completed, total) => {
    process.stdout.write(`\r  product ${String(completed).padStart(3)}/${total}`);
  });
  save(out, { side: "product", authEnabled, target: TARGET, verdicts });
}

/**
 * The comparison. What counts as a difference is deliberately narrow: **the verdict**.
 *
 * Latency is not compared — the two sides measure different processes on a shared machine, and a
 * budget assertion that flips because the laptop was busy is noise. Which assertion labels failed
 * *is* reported when the verdict already differs, because "both red" is parity and "red for
 * different reasons" is not.
 */
function diff(legacyPath: string, productPath: string): void {
  const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as Side;
  const product = JSON.parse(readFileSync(productPath, "utf8")) as Side;
  if (legacy.authEnabled !== product.authEnabled)
    throw new Error("Los dos lados corrieron con distinta configuración de autenticación");

  const byKey = (verdicts: Verdict[]) => new Map(verdicts.map((verdict) => [verdict.key, verdict]));
  const legacyByKey = byKey(legacy.verdicts);
  const productByKey = byKey(product.verdicts);

  const onlyLegacy = [...legacyByKey.keys()].filter((key) => !productByKey.has(key));
  const onlyProduct = [...productByKey.keys()].filter((key) => !legacyByKey.has(key));
  const disagreements = [...legacyByKey.entries()]
    .filter(([key, verdict]) => productByKey.has(key) && productByKey.get(key)!.ok !== verdict.ok)
    .map(([key, verdict]) => ({ key, legacy: verdict, product: productByKey.get(key)! }));

  const mode = legacy.authEnabled ? "con --auth" : "sin --auth";
  console.log(`\nCorte de paridad ${mode} contra ${legacy.target}\n`);
  console.log(`  casos legacy    ${legacy.verdicts.length}`);
  console.log(`  casos producto  ${product.verdicts.length}`);
  console.log(`  verdes legacy   ${legacy.verdicts.filter((verdict) => verdict.ok).length}`);
  console.log(`  verdes producto ${product.verdicts.filter((verdict) => verdict.ok).length}`);

  for (const [label, keys] of [
    ["Solo en legacy", onlyLegacy],
    ["Solo en el producto", onlyProduct],
  ] as const) {
    if (keys.length) {
      console.log(`\n${label} (${keys.length}):`);
      for (const key of keys) console.log(`  ${key}`);
    }
  }

  if (disagreements.length) {
    console.log(`\nVeredictos que no coinciden (${disagreements.length}):`);
    for (const { key, legacy: left, product: right } of disagreements) {
      console.log(`  ${key}`);
      console.log(
        `    legacy   ${left.ok ? "verde" : "rojo"}  pasos=${left.steps}  falló: ${left.failedAssertions.join(", ") || "—"}`,
      );
      console.log(
        `    producto ${right.ok ? "verde" : "rojo"}  pasos=${right.steps}  falló: ${right.failedAssertions.join(", ") || "—"}`,
      );
    }
  }

  const identical = !onlyLegacy.length && !onlyProduct.length && !disagreements.length;
  console.log(
    identical
      ? "\nParidad: idéntica, caso por caso.\n"
      : `\nParidad: ROTA — ${onlyLegacy.length + onlyProduct.length} casos ausentes, ${disagreements.length} veredictos distintos.\n`,
  );
  process.exitCode = identical ? 0 : 1;
}

const [command] = process.argv.slice(2);
const authEnabled = process.argv.includes("--auth");
const out = argument("out");

// A cut that asks for the credential cases against a backend started without `--auth` produces 97
// red rows and a confident-looking report about nothing: with `AUTH_ENABLED=false` the API grants
// `catalog:admin` to everyone, so every 401 and 403 case fails for a reason outside the endpoint.
if (process.env.E2E_AUTH_ENABLED && (process.env.E2E_AUTH_ENABLED === "true") !== authEnabled) {
  console.error(
    `El backend arrancó con auth ${process.env.E2E_AUTH_ENABLED === "true" ? "activada" : "desactivada"} y el corte se pidió al revés.`,
  );
  process.exit(2);
}

const actions: Record<string, () => Promise<void> | void> = {
  legacy: () => runLegacy(authEnabled, out ?? "/tmp/parity-cut/legacy.json"),
  product: () => runProduct(authEnabled, out ?? "/tmp/parity-cut/product.json"),
  diff: () => diff(process.argv[3], process.argv[4]),
};

const action = actions[command ?? ""];
if (!action) {
  console.error("Uso: cut.ts legacy|product [--auth] [--out fichero]  |  cut.ts diff legacy.json product.json");
  process.exitCode = 2;
} else {
  await action();
}
