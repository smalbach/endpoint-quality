/**
 * Live progress, and how it crosses a process boundary.
 *
 * A run executes on one API instance and is watched from whichever instance the follower's
 * connection landed on. With one process those are always the same and there is nothing to solve;
 * with two behind a load balancer they are the same only half the time, and the other half the
 * progress screen sits still until the polling fallback catches up.
 *
 * The relay is the port that closes that gap. Its default adapter does nothing, because doing
 * nothing is correct for the single-process deployment that most installs are — the in-process
 * subject already delivers every event to every follower on that instance.
 */
export type ProgressEvent = {
  runId: string;
  type: "started" | "case" | "retrying" | "paused" | "resumed" | "finished";
  payload: unknown;
  /**
   * Which instance published it.
   *
   * Present only on events that crossed the relay, and the reason a relay cannot loop: an
   * instance drops what it receives back with its own stamp, so publishing to a channel it is
   * itself subscribed to delivers the event once and not twice.
   */
  origin?: string;
};

export const PROGRESS_RELAY = Symbol("PROGRESS_RELAY");

export interface ProgressRelayPort {
  /** Sends an event to the other instances. The local subject is fed separately and first: a
   * follower on this instance must not wait for a network round trip to see a case turn green. */
  publish(event: ProgressEvent): void;
  /** Registered once at boot. Called with events published by *other* instances. */
  subscribe(handler: (event: ProgressEvent) => void): void;
}
