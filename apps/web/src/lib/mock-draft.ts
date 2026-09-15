/**
 * The editor's half of the `mock` node: what it lands with, what the canvas says about it, and what
 * the server would refuse — said before the save.
 *
 * The JSON rule is the engine's (`mockBodyProblem` in runner-core), written again because the web
 * does not load that package at runtime: a body whose content type says JSON has to parse, with every
 * `{{token}}` standing in as `0` so `{"n": {{total}}}` is not flagged for a variable it cannot see yet.
 */
import type { WorkflowStepView } from "@/lib/types";

export type MockView = NonNullable<WorkflowStepView["mock"]>;

/** What a mock dropped from the palette answers until somebody edits it. */
export const defaultMock = (): MockView => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: '{\n  "id": "mock-1"\n}',
});

const ANY_TOKEN = /\{\{[^{}]*\}\}/g;

/** The content type a mock declares, whatever the case of the header name. */
export function mockContentType(mock: Pick<MockView, "headers"> | undefined): string | undefined {
  return Object.entries(mock?.headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1];
}

/** The body with its templates as `0`, parsed — or `undefined` when it is not JSON. What capture
 * suggestions read, so a mock offers its own fields as chips before it ever ran. */
export function mockSampleBody(mock: MockView | undefined): unknown {
  let body = mock?.body ?? "";
  if (!body.trim()) return undefined;
  for (let previous = ""; previous !== body; ) {
    previous = body;
    body = body.replace(ANY_TOKEN, "0");
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Why a mock's body is not the JSON its content type promises, or null. */
export function mockBodyProblem(mock: MockView | undefined): string | null {
  if (!mock?.body?.trim() || !mockContentType(mock)?.toLowerCase().includes("json")) return null;
  return mockSampleBody(mock) === undefined ? "el body no es JSON válido y el content-type dice JSON." : null;
}

/** Every reason the server would refuse this mock node, as sentences about it. */
export function mockProblems(step: WorkflowStepView): string[] {
  const problems: string[] = [];
  const mock = step.mock;
  if (!mock) return [`El mock «${step.id}» no tiene respuesta.`];
  if (!Number.isInteger(mock.status) || mock.status < 100 || mock.status > 599)
    problems.push(`El mock «${step.id}» tiene un código de estado fuera de 100–599.`);
  if (mock.delayMs !== undefined && (!Number.isInteger(mock.delayMs) || mock.delayMs < 0 || mock.delayMs > 60_000))
    problems.push(`El mock «${step.id}» espera más de 60 000 ms.`);
  const body = mockBodyProblem(mock);
  if (body) problems.push(`El mock «${step.id}»: ${body}`);
  return problems;
}
