import { Injectable } from "@nestjs/common";

import type { ProgressEvent, ProgressRelayPort } from "../../domain/progress";

/**
 * The relay for a deployment that is one process.
 *
 * It does nothing, and nothing is the correct behaviour: the in-process subject already delivers
 * every event to every follower there is. This exists so `RunProgressStream` has one code path
 * instead of a conditional, and so the single-process install carries no Redis client it never
 * opens.
 */
@Injectable()
export class InProcessRelay implements ProgressRelayPort {
  publish(_event: ProgressEvent): void {}
  subscribe(_handler: (event: ProgressEvent) => void): void {}
}
