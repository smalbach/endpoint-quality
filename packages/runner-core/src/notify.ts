/**
 * The `notify` node: a message sent mid-flow to a chat channel or a webhook.
 *
 * «pedido creado: {{orderId}}» after a create, or «falló el pago» on the «no» side of an `If`. The
 * node carries the *name* of an environment variable, never the URL: an incoming-webhook URL is a
 * bearer credential (whoever holds it can post into the channel), so it lives in the environment —
 * ideally as a sensitive variable — and the flow document, which is exported, diffed and shared,
 * only says where to look.
 *
 * Pure: the payload each channel expects, the checks on the URL and the redaction of what gets
 * stored. Sending it is the API's job, through SAFE_FETCH like every other outbound call.
 */
import { z } from "zod";

import { VARIABLE_NAME } from "./variables.ts";

export const NOTIFY_CHANNELS = ["slack", "teams", "webhook"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** What a delivery failure (non-2xx, no answer) does to the node. A config problem — the variable
 * is missing, the message names a variable nobody defined — fails it either way. */
export const NOTIFY_ON_ERROR = ["fail", "continue"] as const;
export type NotifyOnError = (typeof NOTIFY_ON_ERROR)[number];

/**
 * A `notify` node.
 *
 * - `channel` picks the payload shape, see {@link notifyPayload}.
 * - `urlVariable` names the environment (or run) variable whose value is the webhook URL.
 * - `message` is a template over what the run knows (`{{orderId}}`, `{{$now}}`), resolved when the
 *   node runs.
 * - `onError` absent is `continue`: a notification is a side channel, and a Slack outage should not
 *   turn a green flow red unless the author says the message is part of what is being tested.
 */
export type StepNotify = {
  channel: NotifyChannel;
  urlVariable: string;
  message: string;
  onError?: NotifyOnError;
};

export const stepNotifySchema = z.object({
  channel: z.enum(NOTIFY_CHANNELS),
  // A name and not a URL: the regex alone keeps `https://hooks.slack.com/…` out of the document.
  urlVariable: z.string().regex(VARIABLE_NAME, "el nombre de la variable con la URL es inválido").max(120),
  message: z.string().trim().min(1, "una notificación necesita un mensaje").max(10_000),
  onError: z.enum(NOTIFY_ON_ERROR).optional(),
});

/** Who sent it, for a generic webhook that has to route or deduplicate. */
export type NotifyOrigin = { runId: string; workflowId: string; stepId: string };

/**
 * The JSON body each channel accepts.
 *
 * - `slack` — an incoming webhook takes `{text}` (mrkdwn allowed in it).
 * - `teams` — the Office 365 connector's legacy `MessageCard` with only `text`: the smallest body
 *   an incoming webhook renders. A Power Automate «Workflows» webhook wants an Adaptive Card
 *   instead; point one of those at the `webhook` channel and shape it in the flow.
 * - `webhook` — `{text, runId, workflowId, stepId}`, enough for a receiver to link back to the run.
 */
export function notifyPayload(channel: NotifyChannel, text: string, origin: NotifyOrigin): Record<string, unknown> {
  switch (channel) {
    case "slack":
      return { text };
    case "teams":
      return { "@type": "MessageCard", "@context": "https://schema.org/extensions", text };
    case "webhook":
      return { text, runId: origin.runId, workflowId: origin.workflowId, stepId: origin.stepId };
  }
}

/** Why the value found in `urlVariable` cannot be posted to, or null. SAFE_FETCH still decides
 * whether the host may be reached; this only catches what is not a web URL at all. */
export function notifyUrlProblem(name: string, value: string | undefined): string | null {
  if (!value?.trim()) return `La variable «${name}» no está definida en el entorno: debe contener la URL del webhook`;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return `La variable «${name}» no contiene una URL http(s)`;
  } catch {
    return `La variable «${name}» no contiene una URL válida`;
  }
  return null;
}

/**
 * `text` with every secret replaced by a mask — the same rule the script sandbox output follows:
 * values shorter than four characters are left alone (masking every `1` would shred the text), and
 * longer ones go first so a secret that contains another is not half-revealed.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  const hidden = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
  return hidden.reduce((result, secret) => result.split(secret).join("••••••••"), text);
}
