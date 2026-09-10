export class SpecVersionImportedEvent {
  constructor(
    readonly projectId: string,
    readonly specVersionId: string,
    readonly hash: string,
    readonly operationCount: number,
    readonly at: Date,
  ) {}
}
