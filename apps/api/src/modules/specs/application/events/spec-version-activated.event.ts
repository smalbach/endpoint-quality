/**
 * The project now runs against this version.
 *
 * Separate from «imported», because the two happen apart: a drift check imports without activating,
 * and switching back to an older version activates without importing. What depends on «the
 * contract of this project» — its endpoints — listens to this one.
 */
export class SpecVersionActivatedEvent {
  constructor(
    readonly projectId: string,
    readonly specVersionId: string,
    readonly actorId: string,
  ) {}
}
