/**
 * The `notify` node's delivery: a message posted mid-flow to Slack, Teams or a generic webhook.
 *
 * Kept out of the orchestrator because the rules are about secrets more than about flow:
 *
 * - **The URL is a credential.** Whoever holds an incoming-webhook URL can post into the channel, so
 *   it comes from the run's variables (the environment, decrypted when sensitive) and is never
 *   written anywhere: the stored request names the variable (`{{SLACK_WEBHOOK}}`), and every text
 *   that could echo it — the message, the receiver's answer, a SAFE_FETCH error, which quotes the
 *   target — is redacted against it and the environment's other secrets before it is stored.
 * - **Through SAFE_FETCH**, like every outbound call: the author chooses the URL, so it is exactly
 *   the request the SSRF guard exists for.
 * - **Config is not delivery.** A missing variable or a `{{name}}` nobody defined fails the node
 *   whatever `onError` says — that is a broken flow. A non-2xx or no answer is the receiver's
 *   problem, and fails the node only when the author set `onError: "fail"`; otherwise the node
 *   passes with a warning, because a chat outage is not a finding about the API under test.
 */
import {
  interpolateValue,
  notifyPayload,
  notifyUrlProblem,
  redactSecrets,
  unresolvedVariables,
  type Assertion,
  type FailureKind,
  type NotifyOrigin,
  type StepNotify,
} from "@eq/runner-core";

import type { SafeFetchPort } from "@/shared/http/safe-fetch";
import { computedSeed, type ExecutedStep, type ExecutionTarget } from "./case-executor";

export type NotifyOutcome = {
  ok: boolean;
  failure: FailureKind | null;
  assertions: Assertion[];
  sent: ExecutedStep["sent"];
  durationMs: number;
};

/** How much of the receiver's answer is kept: enough for Slack's `invalid_token`, not a page of HTML. */
const ANSWER_CHARS = 300;

export async function sendNotification(
  http: SafeFetchPort,
  input: { notify: StepNotify; target: ExecutionTarget; origin: NotifyOrigin },
): Promise<NotifyOutcome> {
  const started = Date.now();
  const { notify, target, origin } = input;
  const url = target.variables[notify.urlVariable]?.trim() ?? "";
  const secrets = [
    ...(target.secrets ?? []),
    ...(target.session ? [target.session.value] : []),
    ...(url ? [url, normalized(url)] : []),
  ];
  const redact = (text: string) => redactSecrets(text, secrets);

  const text = interpolateValue(notify.message, target.variables, computedSeed());
  const headers = { "Content-Type": "application/json" };
  const sent: ExecutedStep["sent"] = {
    method: "POST",
    // The variable's name, never its value: the row is readable by everyone on the project.
    url: `{{${notify.urlVariable}}}`,
    headers,
    body: notifyPayload(notify.channel, redact(text), origin),
  };
  const finish = (ok: boolean, failure: FailureKind | null, assertions: Assertion[]): NotifyOutcome => ({
    ok,
    failure,
    assertions,
    sent,
    durationMs: Date.now() - started,
  });

  const config: Assertion[] = [];
  const urlProblem = notifyUrlProblem(notify.urlVariable, url);
  if (urlProblem) config.push({ label: "URL del webhook", pass: false, detail: urlProblem });
  const missing = unresolvedVariables([text]);
  if (missing.length) config.push({ label: "Variables del entorno", pass: false, detail: `Faltan variables: ${missing.join(", ")}` });
  if (config.length) return finish(false, "config", config);

  let delivered: { pass: boolean; failure: FailureKind; detail: string };
  try {
    const response = await http.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(notifyPayload(notify.channel, text, origin)),
    });
    const answer = response.body.trim().slice(0, ANSWER_CHARS);
    delivered = {
      pass: response.status >= 200 && response.status < 300,
      failure: response.status >= 500 ? "server" : "status",
      detail: `${notify.channel} respondió ${response.status}${answer ? `: ${redact(answer)}` : ""}`,
    };
  } catch (error) {
    // SAFE_FETCH's errors quote the target («El destino https://hooks… está bloqueado»): redacted.
    delivered = {
      pass: false,
      failure: "network",
      detail: redact(error instanceof Error ? error.message : "La notificación no se pudo enviar"),
    };
  }

  if (delivered.pass) return finish(true, null, [{ label: "Notificación", pass: true, detail: delivered.detail }]);
  if (notify.onError === "fail") {
    return finish(false, delivered.failure, [{ label: "Notificación", pass: false, detail: delivered.detail }]);
  }
  return finish(true, null, [
    {
      label: "Notificación",
      pass: false,
      severity: "warning",
      detail: `${delivered.detail} · no se entregó, pero el nodo está en «continuar si falla»`,
    },
  ]);
}

/** `new URL` adds a trailing slash to a bare origin, and a fetch error may quote that spelling. */
function normalized(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}
