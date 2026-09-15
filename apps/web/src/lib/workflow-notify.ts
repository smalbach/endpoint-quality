/**
 * The editor side of the `notify` node, kept apart from `workflow-draft.ts` so the node's rules
 * stay in one place.
 *
 * The one rule that shapes all of it: the node stores the *name* of an environment variable, and the
 * webhook URL lives in that variable. An incoming-webhook URL is a credential — anyone holding it
 * can post into the channel — and a flow document is exported, diffed and shared. So the editor
 * offers the environment's names, says when the chosen one is missing or not marked sensitive, and
 * refuses a pasted URL in the name field.
 */
import type { CaseStatus, Environment, WorkflowStepView } from "@/lib/types";
import type { FlowProblem } from "@/lib/workflow-draft";

/** One environment variable as the API lists it (`sensitive` is what matters here). */
export type EnvironmentVariableView = Environment["variables"][string];

export type StepNotify = NonNullable<WorkflowStepView["notify"]>;
export type NotifyChannel = StepNotify["channel"];

export const NOTIFY_CHANNELS: { value: NotifyChannel; label: string; hint: string }[] = [
  { value: "slack", label: "Slack", hint: "Incoming webhook de Slack. Recibe {text}." },
  {
    value: "teams",
    label: "Microsoft Teams",
    hint: "Webhook entrante de Teams (conector de Office 365). Recibe una MessageCard con text.",
  },
  {
    value: "webhook",
    label: "Webhook genérico",
    hint: "Cualquier URL. Recibe {text, runId, workflowId, stepId} en JSON.",
  },
];

/** What a freshly dropped node carries: Slack, nothing chosen yet, and «continuar» on a failed delivery. */
export function defaultNotify(): StepNotify {
  return { channel: "slack", urlVariable: "", message: "" };
}

/** What the canvas node reads; `toNodes` fills it. */
export type NotifyNodeData = {
  name: string;
  channel: NotifyChannel;
  urlVariable: string;
  message: string;
  /** `onError: "fail"`: a failed delivery fails the node. */
  failsFlow: boolean;
  runStatus?: CaseStatus;
};

/** The server's variable-name rule (runner-core `VARIABLE_NAME`). */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** What the server would refuse on save, pointed at the node. */
export function notifyProblems(step: WorkflowStepView): FlowProblem[] {
  const notify = step.notify;
  const problems: FlowProblem[] = [];
  const name = notify?.urlVariable.trim() ?? "";
  if (!name)
    problems.push({
      message: `La notificación «${step.id}» no dice qué variable del entorno tiene la URL del webhook.`,
      stepId: step.id,
    });
  else if (name.includes("://"))
    problems.push({
      message: `La notificación «${step.id}» lleva una URL donde va el nombre de una variable: guarda la URL en el entorno y escribe aquí su nombre.`,
      stepId: step.id,
    });
  else if (!VARIABLE_NAME.test(name))
    problems.push({ message: `La notificación «${step.id}» tiene un nombre de variable inválido.`, stepId: step.id });
  if (!notify?.message.trim())
    problems.push({ message: `La notificación «${step.id}» no tiene mensaje.`, stepId: step.id });
  return problems;
}

/** Names that look like a webhook go first, then the rest alphabetically. */
const HOOK_LIKE = /url|hook|slack|teams/i;

/** The chosen environment's variables, as the URL picker offers them. */
export function webhookVariables(variables: Record<string, EnvironmentVariableView>): { name: string; sensitive: boolean }[] {
  return Object.entries(variables)
    .map(([name, variable]) => ({ name, sensitive: variable.sensitive }))
    .sort((a, b) => Number(HOOK_LIKE.test(b.name)) - Number(HOOK_LIKE.test(a.name)) || a.name.localeCompare(b.name));
}

/**
 * A word about the chosen variable against the chosen environment, or null when there is nothing to
 * say. Advice, not a problem: another environment may define it, and a set or script node earlier
 * in the flow can write it too.
 */
export function notifyVariableHint(
  name: string,
  variables: Record<string, EnvironmentVariableView> | undefined,
): { tone: "warn" | "info"; text: string } | null {
  if (!name.trim() || !variables) return null;
  const variable = variables[name];
  if (!variable)
    return { tone: "warn", text: `El entorno elegido no define «${name}»: la corrida fallará si nada la escribe antes.` };
  if (!variable.sensitive)
    return {
      tone: "info",
      text: `«${name}» no está marcada como sensible: quien vea el entorno ve la URL. En la corrida se oculta igual.`,
    };
  return null;
}
