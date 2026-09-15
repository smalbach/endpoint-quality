import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Badge } from "@/components/ui";
import { ConfirmDialog } from "@/components/overlay";
import { RunPauseOverlay } from "@/components/run-pause-overlay";
import { cn, methodStyle } from "@/lib/format";
import {
  addControlStep,
  addedNodeId,
  applyPositions,
  connectStep,
  CONTROL_PALETTE,
  disconnectEdges,
  duplicateStep,
  mergeNodes,
  removeStep,
  toEdges,
  toNodes,
  waitRemainingMs,
} from "@/lib/workflow-draft";
import type { OperationSummary } from "@/lib/workflow-draft";
import { NOTIFY_CHANNELS, type NotifyNodeData } from "@/lib/workflow-notify";
import type { CaseStatus, RequestTemplateView, WorkflowStepView } from "@/lib/types";

const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  running: "Ejecutando",
  passed: "Correcto",
  failed: "Fallido",
  skipped: "No ejecutado",
  queued: "En cola",
};

/**
 * How a node looks for each live status: border and a soft wash so the eye lands on the one
 * running. Absent (no run being watched) leaves the node in its plain editor skin.
 */
const RUN_NODE_CLASS: Record<CaseStatus, string> = {
  running: "border-sky-400 bg-sky-50 ring-2 ring-sky-200",
  passed: "border-emerald-300 bg-emerald-50",
  failed: "border-rose-400 bg-rose-50 ring-2 ring-rose-200",
  skipped: "border-amber-300 bg-amber-50",
  queued: "border-slate-300 bg-white",
};
const RUN_DOT: Record<CaseStatus, string> = {
  running: "bg-sky-500 animate-pulse",
  passed: "bg-emerald-500",
  failed: "bg-rose-500",
  skipped: "bg-amber-400",
  queued: "bg-slate-300",
};

/** The pulse a live run puts on a node, shared by every shape. */
function RunDot({ status }: { status?: CaseStatus }) {
  if (!status) return null;
  return <span className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", RUN_DOT[status])} title={CASE_STATUS_LABEL[status]} />;
}

type StepNodeData = {
  name: string;
  method: string;
  path: string;
  expectedStatus: number;
  captures: number;
  checks: number;
  authorizes: boolean;
  retries: boolean;
  loops: boolean;
  runStatus?: CaseStatus;
};

/** A request node: one HTTP call, one input, one output. */
function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-64 rounded-xl border bg-white p-3 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-slate-200",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Badge className={cn("w-14 justify-center", methodStyle(data.method))}>{data.method}</Badge>
        <span className="truncate text-xs font-semibold text-slate-800">{data.name}</span>
        {data.loops && <span title="Una vez por elemento (bucle en el paso)">↻</span>}
        {data.checks > 0 && <span title={`${data.checks} comprobaciones`}>✓</span>}
        {data.retries && <span title="Reintenta al fallar">↺</span>}
        <RunDot status={status} />
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-slate-500">{data.path}</p>
      <div className="mt-2 flex justify-between text-[10px] text-slate-400">
        <span>espera {data.expectedStatus}</span>
        <span>
          {data.captures} capturas{data.checks > 0 && ` · ${data.checks} comprob.`}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** A login node: the request whose answer becomes the run's credential. Wears a key, and the
 * amber skin of a control node that changes the run around it. */
function LoginNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-64 rounded-xl border bg-white p-3 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-amber-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-amber-100 text-amber-700" title="Login">
          🔑
        </span>
        <Badge className={cn("w-14 justify-center", methodStyle(data.method))}>{data.method}</Badge>
        <span className="truncate text-xs font-semibold text-slate-800">{data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-slate-500">{data.path}</p>
      <p className="mt-1 text-[10px] text-amber-700">
        {data.authorizes ? "Reescribe la credencial de los siguientes" : "Falta de dónde sale la credencial"}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type BranchNodeData = { name: string; from: string; runStatus?: CaseStatus };

/** The standalone `If`: reads a step and splits the flow. A target handle on the left, and two
 * source handles on the right — «sí» above, «no» below — that the next steps are wired to. */
function BranchNode({ data, selected }: NodeProps<Node<BranchNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-amber-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-amber-100 text-amber-700" title="Bifurcación">
          ◇
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">If · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">{data.from ? `lee ${data.from}` : "conéctalo a un paso"}</p>
      <div className="mt-2 flex flex-col gap-1 text-[10px] font-semibold">
        <span className="self-end text-emerald-600">sí ▸</span>
        <span className="self-end text-rose-500">no ▸</span>
      </div>
      <Handle id="then" type="source" position={Position.Right} style={{ top: "60%" }} />
      <Handle id="else" type="source" position={Position.Right} style={{ top: "82%" }} />
    </div>
  );
}

type WaitNodeData = { name: string; ms: number; runStatus?: CaseStatus; startedAt?: string };

/** Milliseconds left of a running wait, ticking; null while the node is not counting down. */
function useWaitCountdown(ms: number, startedAt: string | undefined, running: boolean): number | null {
  const counting = running && Boolean(startedAt) && ms > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [counting, startedAt]);
  return counting && startedAt ? waitRemainingMs(ms, startedAt, now) : null;
}

/** A delay: pause, then let the flow through. While a run waits on it, it counts down what is left. */
function WaitNode({ data, selected }: NodeProps<Node<WaitNodeData>>) {
  const status = data.runStatus;
  const remaining = useWaitCountdown(data.ms, data.startedAt, status === "running");
  return (
    <div
      className={cn(
        "w-40 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-slate-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-slate-100 text-slate-600" title="Espera">
          ⏱
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Espera · {data.name}</span>
        <RunDot status={status} />
      </div>
      {remaining === null ? (
        <p className="mt-1 font-mono text-[10px] text-slate-500">{data.ms} ms</p>
      ) : (
        <div className="mt-1" role="timer" aria-live="off" title={`Faltan ${(remaining / 1000).toFixed(1)} s de ${data.ms} ms`}>
          <div className="flex items-baseline justify-between font-mono text-[10px]">
            <span className="font-semibold text-sky-700 tabular-nums">{(remaining / 1000).toFixed(1)} s</span>
            <span className="text-slate-400">de {data.ms} ms</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-sky-100">
            <div className="h-full rounded-full bg-sky-500" style={{ width: `${(remaining / data.ms) * 100}%` }} />
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type MergeNodeData = { name: string; count: number; any: boolean; runStatus?: CaseStatus };

/** A join: waits for the branches into it (all, or the first when «any»), then continues. */
function MergeNode({ data, selected }: NodeProps<Node<MergeNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-44 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-slate-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-slate-100 text-slate-600" title="Merge">
          ⇉
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Merge · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 text-[10px] text-slate-500">
        {data.any ? "basta con una" : "espera a todas"} · {data.count} {data.count === 1 ? "rama" : "ramas"}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type ValidateNodeData = { name: string; from: string; checks: number; script: boolean; runStatus?: CaseStatus };

/** A validation: reads a step's response and judges it with checks and/or a script. Can fail. */
function ValidateNode({ data, selected }: NodeProps<Node<ValidateNodeData>>) {
  const status = data.runStatus;
  const parts = [data.checks > 0 ? `${data.checks} comprob.` : null, data.script ? "script" : null].filter(Boolean);
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-indigo-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-indigo-100 text-indigo-700" title="Validación">
          ✓
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Valida · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">{data.from ? `lee ${data.from}` : "conéctalo a un paso"}</p>
      <p className="mt-0.5 text-[10px] text-indigo-700">{parts.length ? parts.join(" · ") : "sin comprobaciones"}</p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type FetchNodeData = {
  name: string;
  method: string;
  url: string;
  captures: number;
  checks: number;
  useSession: boolean;
  runStatus?: CaseStatus;
};

/** A fetch: an HTTP call written on the node — any URL — rather than one of the saved requests. */
function FetchNode({ data, selected }: NodeProps<Node<FetchNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-64 rounded-xl border bg-white p-3 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-teal-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-teal-100 text-teal-700" title="Fetch">
          ⇄
        </span>
        <Badge className={cn("w-14 justify-center", methodStyle(data.method))}>{data.method}</Badge>
        <span className="truncate text-xs font-semibold text-slate-800">{data.name}</span>
        {data.useSession && <span title="Presenta la sesión del login">🔑</span>}
        <RunDot status={status} />
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-slate-500">{data.url || "sin URL"}</p>
      <p className="mt-1 text-[10px] text-slate-400">
        {data.captures} capturas{data.checks > 0 && ` · ${data.checks} comprob.`}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type SetNodeData = { name: string; variables: string[]; runStatus?: CaseStatus };

/** A set: variables written from templates, no request. */
function SetNode({ data, selected }: NodeProps<Node<SetNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-violet-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-violet-100 text-violet-700" title="Set">
          𝑥
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Set · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
        {data.variables.length ? data.variables.join(", ") : "sin variables"}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type ScriptNodeData = { name: string; from: string; lines: number; runStatus?: CaseStatus };

/** A script: code in the isolated sandbox, optionally over a step's response. */
function ScriptNode({ data, selected }: NodeProps<Node<ScriptNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-slate-400",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-slate-800 font-mono text-[10px] text-white" title="Script">
          {"{ }"}
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Script · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">{data.from ? `lee ${data.from}` : "sin respuesta que leer"}</p>
      <p className="mt-0.5 text-[10px] text-slate-500">{data.lines ? `${data.lines} ${data.lines === 1 ? "línea" : "líneas"}` : "sin código"}</p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type PollNodeData = { name: string; from: string; attempts: number; delayMs: number; checks: number; runStatus?: CaseStatus };

/** A poll: repeats a step's request until its checks pass — the job that is pending until it is done. */
function PollNode({ data, selected }: NodeProps<Node<PollNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-orange-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-orange-100 text-orange-700" title="Reintento">
          ↻
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Reintento · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
        {data.from ? `repite ${data.from}` : "conéctalo a una petición"}
      </p>
      <p className="mt-0.5 text-[10px] text-orange-700">
        hasta {data.attempts} × cada {data.delayMs} ms · {data.checks ? `${data.checks} comprob.` : "sin comprobaciones"}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type SchemaNodeData = { name: string; from: string; source: "contract" | "custom"; strict: boolean; runStatus?: CaseStatus };

/** A schema check: a step's body against the contract's JSON Schema or one written on the node. */
function SchemaNode({ data, selected }: NodeProps<Node<SchemaNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-teal-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-teal-100 text-teal-700" title="Esquema">
          ⊨
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Esquema · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">{data.from ? `valida ${data.from}` : "conéctalo a un paso"}</p>
      <p className="mt-0.5 text-[10px] text-teal-700">
        {data.source === "contract" ? "del contrato" : "esquema propio"}
        {data.strict ? " · estricto" : ""}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type SubflowNodeData = { name: string; chosen: boolean; inputs: number; outputs: number; runStatus?: CaseStatus };

/** A subflow: another flow of the project, run as one step of this one. */
function SubflowNode({ data, selected }: NodeProps<Node<SubflowNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-indigo-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-indigo-100 text-indigo-700" title="Sub-flujo">
          ⧉
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Sub-flujo · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className={cn("mt-1 truncate text-[10px]", data.chosen ? "text-slate-500" : "text-amber-700")}>
        {data.chosen ? "ejecuta otro flujo" : "elige el flujo que ejecuta"}
      </p>
      <p className="mt-0.5 text-[10px] text-indigo-700">
        {data.inputs} {data.inputs === 1 ? "entrada" : "entradas"} · {data.outputs} {data.outputs === 1 ? "salida" : "salidas"}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type LoopNodeData = {
  name: string;
  from: string;
  path: string;
  as: string;
  max: number;
  body: number;
  runStatus?: CaseStatus;
};

/** A loop: walks a list a step returned. «cada» is its body, run once per element; «fin» runs after. */
function LoopNode({ data, selected }: NodeProps<Node<LoopNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-fuchsia-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-fuchsia-100 text-fuchsia-700" title="Bucle">
          ∀
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Bucle · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
        {data.from ? `${data.as} ∈ ${data.from}.${data.path}` : "conéctalo a un paso con una lista"}
      </p>
      <p className="mt-0.5 text-[10px] text-fuchsia-700">
        {data.body ? `${data.body} ${data.body === 1 ? "nodo" : "nodos"} por vuelta` : "nada en «cada»"} · máx. {data.max}
      </p>
      <div className="mt-2 flex flex-col gap-1 text-[10px] font-semibold">
        <span className="self-end text-fuchsia-600">cada ▸</span>
        <span className="self-end text-slate-500">fin ▸</span>
      </div>
      <Handle id="each" type="source" position={Position.Right} style={{ top: "64%" }} />
      <Handle id="done" type="source" position={Position.Right} style={{ top: "85%" }} />
    </div>
  );
}

/** A notification: a message to Slack, Teams or a webhook whose URL an environment variable holds. */
function NotifyNode({ data, selected }: NodeProps<Node<NotifyNodeData>>) {
  const status = data.runStatus;
  const channel = NOTIFY_CHANNELS.find((item) => item.value === data.channel)?.label ?? data.channel;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-sky-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-sky-100 text-sky-700" title="Notificar">
          ✉
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Notificar · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate text-[10px] text-slate-500">{data.message || "sin mensaje"}</p>
      <p className="mt-0.5 truncate text-[10px] text-sky-700">
        {channel}
        {data.urlVariable ? ` · ${data.urlVariable}` : " · sin variable"}
        {data.failsFlow ? " · falla si no llega" : ""}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type GraphqlNodeData = {
  name: string;
  url: string;
  operationName: string;
  captures: number;
  checks: number;
  useSession: boolean;
  allowErrors: boolean;
  runStatus?: CaseStatus;
};

/** A GraphQL operation: a POST of query and variables, red when the answer carries `errors`. */
function GraphqlNode({ data, selected }: NodeProps<Node<GraphqlNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-64 rounded-xl border bg-white p-3 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-fuchsia-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-fuchsia-100 text-fuchsia-700" title="GraphQL">
          ◈
        </span>
        <Badge className="w-14 justify-center border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700">GQL</Badge>
        <span className="truncate text-xs font-semibold text-slate-800">{data.name}</span>
        {data.useSession && <span title="Presenta la sesión del login">🔑</span>}
        <RunDot status={status} />
      </div>
      <p className="mt-2 truncate font-mono text-[10px] text-slate-500">
        {data.operationName ? `${data.operationName} · ` : ""}
        {data.url || "sin URL"}
      </p>
      <p className="mt-1 text-[10px] text-slate-400">
        {data.captures} capturas{data.checks > 0 && ` · ${data.checks} comprob.`}
        {data.allowErrors && " · admite errors"}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type MockNodeData = { name: string; status: number; delayMs: number; captures: number; checks: number; runStatus?: CaseStatus };

/** A mock: a response written on the node, no network. Dashed, so it never reads as a real call. */
function MockNode({ data, selected }: NodeProps<Node<MockNodeData>>) {
  const status = data.runStatus;
  return (
    <div
      className={cn(
        "w-52 rounded-xl border border-dashed bg-white px-3 py-2 shadow-sm transition-colors",
        status ? RUN_NODE_CLASS[status] : "border-fuchsia-300",
        selected && "border-slate-900 ring-2 ring-slate-200",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-fuchsia-100 text-fuchsia-700" title="Mock">
          ◌
        </span>
        <span className="truncate text-xs font-semibold text-slate-800">Mock · {data.name}</span>
        <RunDot status={status} />
      </div>
      <p className="mt-1 truncate font-mono text-[10px] text-slate-500">
        responde {data.status || "?"}
        {data.delayMs > 0 && ` tras ${data.delayMs} ms`}
      </p>
      <p className="mt-0.5 text-[10px] text-fuchsia-700">
        simulado · sin red
        {data.captures > 0 && ` · ${data.captures} capturas`}
        {data.checks > 0 && ` · ${data.checks} comprob.`}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = {
  graphql: GraphqlNode,
  notify: NotifyNode,
  subflow: SubflowNode,
  mock: MockNode,
  schema: SchemaNode,
  loop: LoopNode,
  poll: PollNode,
  set: SetNode,
  script: ScriptNode,
  fetch: FetchNode,
  step: StepNode,
  login: LoginNode,
  branch: BranchNode,
  wait: WaitNode,
  merge: MergeNode,
  validate: ValidateNode,
};

/**
 * The graph. Everything it changes goes back into the document through `workflow-draft`, which is
 * where those rules are tested — this component only wires the canvas to them.
 *
 * The toolbar is a **palette**: every kind of node is added from it and dropped free, then wired to
 * the rest by dragging edges. Each button can also be dragged onto the canvas, and the node lands
 * where it is dropped (loose, not hung off the selection). A request and a login are minted from the operation catalogue (they
 * need an operation); the control kinds —If, Espera, Merge, Validación— land straight away with
 * sensible defaults and read whatever is connected into them. This is the shape the reference tool
 * draws, and the point of the restructure: control flow is nodes, not behaviours hidden on a
 * request.
 *
 * React Flow keeps its **own** copy of the nodes, and that is not duplication: it stores what it
 * measured of each one, and a node it has not measured stays `visibility: hidden`. So the canvas
 * owns the nodes, the document owns the steps, and `mergeNodes` is where that division is written.
 */
export function WorkflowCanvas({
  steps,
  templates,
  operations,
  onChange,
  onSelect,
  onAddRequest,
  onAddLogin,
  runStatus,
  runStartedAt,
  pausedStepId,
  breakpoints,
  onToggleBreakpoint,
  flowId,
}: {
  /** Which flow is open. Flows share step ids, so this — not the ids — tells a flow switch from an add. */
  flowId?: string;
  steps: WorkflowStepView[];
  templates: RequestTemplateView[];
  operations: OperationSummary[];
  onChange: (steps: WorkflowStepView[]) => void;
  onSelect: (stepId: string) => void;
  /** Open the operation catalogue to add a request node. The palette's «Petición» calls it; a drop
   * passes where on the canvas the node should land. */
  onAddRequest?: (at?: { x: number; y: number }) => void;
  /** Open the operation catalogue to add a login node (a request that authorizes). */
  onAddLogin?: (at?: { x: number; y: number }) => void;
  /** Per-step live status while a run is being watched; nodes light up by it. */
  runStatus?: Record<string, CaseStatus>;
  /** When each running node started, while a run is being watched; a wait node counts down from it. */
  runStartedAt?: Record<string, string>;
  /** The node a watched run is paused before, drawn apart until it resumes or ends. */
  pausedStepId?: string | null;
  /** The nodes the next run stops before, marked on the canvas. */
  breakpoints?: readonly string[];
  /** Mark or unmark a node as a place to stop, from its context menu. */
  onToggleBreakpoint?: (stepId: string) => void;
}) {
  const fromDocument = useMemo(
    () => toNodes(steps, templates, operations, runStatus, runStartedAt) as Node[],
    [steps, templates, operations, runStatus, runStartedAt],
  );
  const [nodes, setNodes] = useState<Node[]>(fromDocument);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    setNodes((current) => mergeNodes(current, fromDocument));
  }, [fromDocument]);

  // A node added from the palette (or the catalogue, or a duplicate) lands wherever its position
  // says, often off screen. Remember it, and once React Flow has measured it, take the view there.
  const [flow, setFlow] = useState<ReactFlowInstance<Node, Edge> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const seen = useRef<{ flowId?: string; ids?: string[] }>({});
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ids = steps.map((step) => step.id);
    const previous = seen.current.flowId === flowId ? seen.current.ids : undefined;
    seen.current = { flowId, ids };
    const added = addedNodeId(previous, ids);
    if (added) setFocusId(added);
  }, [steps, flowId]);

  useEffect(() => {
    if (!focusId || !flow) return;
    const node = nodes.find((entry) => entry.id === focusId);
    if (!node) return;
    const { width, height } = node.measured ?? {};
    if (!width || !height) return;
    const zoom = Math.max(flow.getZoom(), 1);
    // Adding a node opens its panel, a non-modal drawer laid over the canvas: centre the node in
    // the part of the canvas still in sight, not behind the panel.
    const pane = paneRef.current?.getBoundingClientRect();
    let shift = 0;
    if (pane) {
      let left = pane.left;
      let right = pane.right;
      for (const panel of document.querySelectorAll('[role="dialog"][aria-modal="false"]')) {
        const rect = panel.getBoundingClientRect();
        if (rect.left > pane.left + pane.width / 2) right = Math.min(right, rect.left);
        else if (rect.right < pane.right - pane.width / 2) left = Math.max(left, rect.right);
      }
      if (right - left > width * zoom) shift = (pane.left + pane.right - left - right) / 2 / zoom;
    }
    void flow.setCenter(node.position.x + width / 2 + shift, node.position.y + height / 2, { zoom, duration: 400 });
    setFocusId(null);
  }, [focusId, flow, nodes]);

  // The edges are rebuilt from the document, so React Flow cannot keep which one is selected: it
  // reports the click through onEdgesChange and the delete key only removes edges marked selected.
  // Without keeping that here, Backspace/Delete did nothing on a clicked edge.
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const edges: Edge[] = useMemo(
    () => toEdges(steps).map((edge) => (selectedEdges.has(edge.id) ? { ...edge, selected: true } : edge)),
    [steps, selectedEdges],
  );
  const menuStep = menu ? steps.find((step) => step.id === menu.id) : undefined;
  // The node a control-node add hangs off, for convenience: whichever one ReactFlow has selected.
  const selectedId = nodes.find((node) => node.selected)?.id;

  const editable = Boolean(onAddRequest);

  /** Add a control node from the palette, hanging it off the selected node when there is one. */
  const addControl = (kind: (typeof CONTROL_PALETTE)[number]["kind"]) => {
    const added = addControlStep(steps, kind, selectedId);
    onChange(added.steps);
    onSelect(added.id);
  };

  /** A palette button dropped on the canvas: the node's top centre lands under the pointer. */
  const dropPalette = (event: DragEvent<HTMLDivElement>) => {
    const kind = event.dataTransfer.getData(PALETTE_MIME);
    if (!kind || !flow) return;
    event.preventDefault();
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const at = { x: Math.round(point.x - NODE_WIDTH / 2), y: Math.round(point.y - 20) };
    if (kind === "request") return onAddRequest?.(at);
    if (kind === "login") return onAddLogin?.(at);
    const item = CONTROL_PALETTE.find((entry) => entry.kind === kind);
    if (!item) return;
    const added = addControlStep(steps, item.kind, undefined, at);
    onChange(added.steps);
    onSelect(added.id);
  };

  return (
    <div className="flex h-full flex-col">
      {editable && (
        <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2">
          <span className="mr-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Añadir</span>
          <PaletteButton
            glyph="＋"
            label="Petición"
            title="Añadir una petición al flujo (o arrástrala al lienzo)"
            drag="request"
            onClick={onAddRequest && (() => onAddRequest())}
          />
          <PaletteButton
            glyph="🔑"
            label="Login"
            title="Añadir un login (una petición que da la credencial)"
            drag="login"
            onClick={onAddLogin && (() => onAddLogin())}
          />
          <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden />
          {CONTROL_PALETTE.map((item) => (
            <PaletteButton
              key={item.kind}
              glyph={item.glyph}
              label={item.label}
              title={item.hint}
              drag={item.kind}
              onClick={() => addControl(item.kind)}
            />
          ))}
          <span className="ml-auto text-[10px] text-slate-400">
            Clic o arrástralos al lienzo, conéctalos arrastrando · clic derecho para el menú de un nodo
          </span>
        </div>
      )}
      <div
        ref={paneRef}
        className="relative flex-1"
        onClick={() => setMenu(null)}
        onDragOver={(event) => {
          if (!editable || !event.dataTransfer.types.includes(PALETTE_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={editable ? dropPalette : undefined}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setFlow}
          fitView
          deleteKeyCode={["Backspace", "Delete"]}
          onNodesChange={(changes) => {
            const next = applyNodeChanges(changes, nodes);
            setNodes(next);
            if (changes.some((change) => change.type === "position" && !change.dragging)) {
              onChange(
                applyPositions(
                  steps,
                  next.map((node) => ({ id: node.id, position: node.position })),
                ),
              );
            }
          }}
          onConnect={(connection: Connection) =>
            onChange(connectStep(steps, connection.source, connection.target, connection.sourceHandle))
          }
          onEdgesChange={(changes) =>
            setSelectedEdges((current) => {
              const next = new Set(current);
              for (const change of changes) {
                if (change.type === "select") {
                  if (change.selected) next.add(change.id);
                  else next.delete(change.id);
                } else if (change.type === "remove") next.delete(change.id);
              }
              return next;
            })
          }
          onEdgesDelete={(deleted) =>
            onChange(
              disconnectEdges(
                steps,
                deleted.map((edge) => ({ source: edge.source, target: edge.target })),
              ),
            )
          }
          onNodeClick={(_event, node) => onSelect(node.id)}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            onSelect(node.id);
            setMenu({ id: node.id, x: event.clientX, y: event.clientY });
          }}
          onPaneClick={() => setMenu(null)}
        >
          <Background gap={20} size={1} />
          <MiniMap pannable zoomable />
          <Controls />
          <RunPauseOverlay pausedId={pausedStepId ?? null} breakpoints={breakpoints ?? []} />
        </ReactFlow>

        {menu && menuStep && editable && (
          <div
            className="fixed z-50 w-48 rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-lg"
            style={{ top: menu.y, left: menu.x }}
            onClick={(event) => event.stopPropagation()}
          >
            <MenuItem onClick={() => (onSelect(menu.id), setMenu(null))}>Editar…</MenuItem>
            <MenuItem
              onClick={() => {
                onChange(duplicateStep(steps, menu.id));
                setMenu(null);
              }}
            >
              Duplicar nodo
            </MenuItem>
            {onToggleBreakpoint && (
              <MenuItem onClick={() => (onToggleBreakpoint(menu.id), setMenu(null))}>
                {breakpoints?.includes(menu.id) ? "Quitar punto de parada" : "Detenerse antes de este nodo"}
              </MenuItem>
            )}
            <div className="my-1 border-t border-slate-100" />
            <MenuItem
              danger
              onClick={() => {
                setConfirmId(menu.id);
                setMenu(null);
              }}
            >
              Eliminar nodo
            </MenuItem>
          </div>
        )}

        {confirmId && (
          <ConfirmDialog
            title="Eliminar nodo"
            message="Se quita del flujo junto con las conexiones que llegan a él. Esta acción no borra la petición reutilizable."
            confirmLabel="Eliminar"
            onClose={() => setConfirmId(null)}
            onConfirm={() => {
              onChange(removeStep(steps, confirmId));
              setConfirmId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** What a dragged palette button carries: the kind of node to add. */
const PALETTE_MIME = "application/x-eq-node-kind";
/** The nodes' `w-64`, to centre a dropped one under the pointer. */
const NODE_WIDTH = 256;

function PaletteButton({
  glyph,
  label,
  title,
  onClick,
  drag,
}: {
  glyph: string;
  label: string;
  title: string;
  onClick?: () => void;
  /** The node kind a drag onto the canvas adds. */
  drag?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      title={title}
      draggable={Boolean(onClick && drag)}
      onDragStart={(event) => {
        if (!drag) return;
        event.dataTransfer.setData(PALETTE_MIME, drag);
        event.dataTransfer.effectAllowed = "copy";
      }}
      className="flex cursor-grab items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span aria-hidden>{glyph}</span> {label}
    </button>
  );
}

function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={cn(
        "block w-full px-3 py-1.5 text-left hover:bg-slate-50",
        danger ? "text-rose-600 hover:bg-rose-50" : "text-slate-700",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
