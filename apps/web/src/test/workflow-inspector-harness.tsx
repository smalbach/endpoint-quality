/**
 * Arnés compartido por las pruebas del inspector de flujos: el inspector de verdad con estado propio,
 * para que lo que se edita vuelva a entrar como en la pantalla, y un atajo para encontrar el control
 * de un `Field` por su etiqueta (la «i» de ayuda vive dentro de la misma etiqueta).
 */
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { WorkflowInspector } from "@/components/workflow-inspector";
import type {
  ChannelView,
  Environment,
  RequestTemplateView,
  WorkflowStepView,
  WorkflowView,
} from "@/lib/types";
import type { OperationSummary } from "@/lib/workflow-draft";

export type HarnessProps = {
  steps: WorkflowStepView[];
  selected: string;
  canEdit?: boolean;
  templates?: RequestTemplateView[];
  operations?: OperationSummary[];
  environments?: Environment[];
  environmentId?: string;
  flows?: WorkflowView[];
  channels?: ChannelView[];
  workflowId?: string;
  templateUsage?: (id: string) => number;
  forking?: boolean;
  running?: boolean;
  runSummary?: string | null;
};

export type Spies = {
  last: () => WorkflowStepView[];
  onSteps: ReturnType<typeof vi.fn>;
  onTemplate: ReturnType<typeof vi.fn>;
  onFork: ReturnType<typeof vi.fn>;
  onWorkflow: ReturnType<typeof vi.fn>;
  onEnvironment: ReturnType<typeof vi.fn>;
  onRunSettings: ReturnType<typeof vi.fn>;
  onRun: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
};

/** Monta el inspector y devuelve los espías de cada salida. `last()` son los pasos tras la última edición. */
export function renderInspector(props: HarnessProps) {
  const spies: Spies = {
    last: () => current,
    onSteps: vi.fn(),
    onTemplate: vi.fn(),
    onFork: vi.fn(),
    onWorkflow: vi.fn(),
    onEnvironment: vi.fn(),
    onRunSettings: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
  };
  let current = props.steps;

  function Harness() {
    const [steps, setSteps] = useState<WorkflowStepView[]>(props.steps);
    const [templates, setTemplates] = useState<RequestTemplateView[]>(props.templates ?? []);
    return (
      <WorkflowInspector
        base="/orgs/o/projects/p"
        workflow={
          {
            id: props.workflowId ?? "w1",
            name: "Flujo",
            description: null,
            status: "draft",
            steps,
            updatedAt: "2026-01-01T00:00:00Z",
          } as WorkflowView
        }
        steps={steps}
        selectedStep={props.selected}
        templates={templates}
        operations={props.operations ?? []}
        environments={props.environments ?? []}
        environmentId={props.environmentId ?? ""}
        canEdit={props.canEdit ?? true}
        onEnvironment={spies.onEnvironment}
        onRunSettings={spies.onRunSettings}
        runSummary={props.runSummary ?? null}
        onWorkflow={spies.onWorkflow}
        onSteps={(next) => {
          current = next;
          setSteps(next);
          spies.onSteps(next);
        }}
        onTemplate={(template) => {
          setTemplates((list) => list.map((item) => (item.id === template.id ? template : item)));
          spies.onTemplate(template);
        }}
        templateUsage={props.templateUsage ?? (() => 1)}
        onFork={spies.onFork}
        forking={props.forking ?? false}
        onRun={spies.onRun}
        onDelete={spies.onDelete}
        running={props.running ?? false}
        flows={props.flows}
        channels={props.channels}
      />
    );
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { ...utils, ...spies };
}

/** El control (input, select o textarea) del `Field` cuya etiqueta es exactamente `label`, en la pestaña abierta. */
export function field<T extends HTMLElement = HTMLInputElement>(label: string, index = 0): T {
  const found = screen
    .getAllByText(label, { selector: "span" })
    .map((span) => span.closest("label")?.querySelector("input, select, textarea"))
    .filter((control): control is HTMLElement => Boolean(control) && !control!.closest("[hidden]"));
  const control = found[index];
  if (!control) throw new Error(`Sin control para «${label}»`);
  return control as T;
}

/** Abre una pestaña del nodo por su nombre. */
export function openTab(name: RegExp | string) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.click(tab);
  return tab;
}

/** Los paneles de pestaña ocultos no cuentan: el visible es el de la pestaña abierta. */
export function visiblePanel(): HTMLElement {
  const panel = screen.getAllByRole("tabpanel", { hidden: true }).find((item) => !item.hidden);
  if (!panel) throw new Error("Sin panel visible");
  return panel;
}
