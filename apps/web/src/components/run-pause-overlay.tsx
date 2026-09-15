import { ViewportPortal, useInternalNode } from "@xyflow/react";

/**
 * What a paused run looks like on the canvas: an amber, breathing ring and an «En pausa» tag around
 * the node the run is waiting before, and a small mark on each node a person asked it to stop at.
 *
 * Drawn in the viewport beside the nodes rather than by each node shape, so every kind of node gets
 * it without knowing pauses exist, and it follows a node that is dragged while the run waits. It
 * never takes a click: the node underneath stays the thing that is selected and moved.
 */
export function RunPauseOverlay({ pausedId, breakpoints }: { pausedId: string | null; breakpoints: readonly string[] }) {
  if (!pausedId && !breakpoints.length) return null;
  return (
    <ViewportPortal>
      {breakpoints.map((id) => (
        <BreakpointMark key={id} id={id} />
      ))}
      {pausedId && <PausedRing id={pausedId} />}
    </ViewportPortal>
  );
}

/** A node's box in flow coordinates, once React Flow has measured it. */
function useNodeBox(id: string) {
  const node = useInternalNode(id);
  const width = node?.measured.width;
  const height = node?.measured.height;
  if (!node || !width || !height) return null;
  return { ...node.internals.positionAbsolute, width, height };
}

const RING_GAP = 6;

function PausedRing({ id }: { id: string }) {
  const box = useNodeBox(id);
  if (!box) return null;
  return (
    <div
      data-testid="paused-node"
      className="pointer-events-none absolute top-0 left-0"
      style={{
        transform: `translate(${box.x - RING_GAP}px, ${box.y - RING_GAP}px)`,
        width: box.width + RING_GAP * 2,
        height: box.height + RING_GAP * 2,
      }}
    >
      <div className="absolute inset-0 animate-pulse rounded-2xl border-2 border-amber-400 shadow-[0_0_0_6px_rgba(251,191,36,0.3)]" />
      {/* Above the node rather than on it, so a node drawn over the portal cannot hide it. */}
      <span
        role="status"
        className="absolute bottom-full left-2 mb-1 flex items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-slate-950 shadow"
      >
        <span aria-hidden>⏸</span> En pausa
      </span>
    </div>
  );
}

function BreakpointMark({ id }: { id: string }) {
  const box = useNodeBox(id);
  if (!box) return null;
  return (
    <span
      aria-label="Punto de parada"
      className="pointer-events-none absolute top-0 left-0 h-3 w-3 rounded-full bg-rose-500 ring-2 ring-white"
      style={{ transform: `translate(${box.x - 5}px, ${box.y - 5}px)` }}
    />
  );
}
