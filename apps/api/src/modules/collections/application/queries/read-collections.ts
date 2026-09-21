import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import type {
  CollectionRunViewOf,
  CollectionRunOf,
  CollectionSummaryOf,
  CollectionViewOf,
} from "@eq/contracts";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { completeResult, countItems, type CollectionRow, type CollectionRun } from "../../domain/model";
import { writePostmanFile } from "../../domain/postman";
import {
  COLLECTION_REPOSITORY,
  COLLECTION_RUN_REPOSITORY,
  type CollectionRepositoryPort,
  type CollectionRunRepositoryPort,
} from "../../domain/ports";
import { ownedCollection } from "../commands/manage-collection";
import { ownedRun } from "../commands/run-collection";

export const collectionView = (row: CollectionRow): CollectionViewOf<Date> => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  description: row.description,
  auth: row.document.auth,
  variables: row.document.variables,
  preRequestScript: row.document.preRequestScript,
  postResponseScript: row.document.postResponseScript,
  items: row.document.items,
  ...countItems(row.document.items),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const runView = (run: CollectionRun): CollectionRunOf<Date> => ({
  id: run.id,
  collectionId: run.collectionId,
  collectionName: run.collectionName,
  environmentId: run.environmentId,
  environmentName: run.environmentName,
  status: run.status,
  iterations: run.iterations,
  delayMs: run.delayMs,
  stopOnFailure: run.stopOnFailure,
  folderId: run.folderId,
  folderName: run.folderName,
  totals: run.totals,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  error: run.error,
});

export const runDetailView = (run: CollectionRun): CollectionRunViewOf<Date> => ({
  ...runView(run),
  // Las corridas guardadas antes de que el informe enseñara la petición y la respuesta salen por
  // aquí con esos campos vacíos y no ausentes: la pantalla no tiene por qué saber que existieron.
  results: run.results.map(completeResult),
});

export class ListCollectionsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
  ) {}
}
export class GetCollectionQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId: string,
  ) {}
}
/** La colección como el fichero de Postman que se descarga. */
export class ExportCollectionQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId: string,
  ) {}
}
export class ListCollectionRunsQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly collectionId?: string,
  ) {}
}
export class GetCollectionRunQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly runId: string,
  ) {}
}

/**
 * La lista: lo que hay dentro de cada colección, contado, y cómo acabó su última corrida.
 *
 * El árbol entero no sale aquí. Una colección de ochenta peticiones son cientos de kilobytes que
 * la lista no enseña, y devolverlos por tarjeta haría de la pantalla de entrada la más pesada del
 * producto.
 */
@QueryHandler(ListCollectionsQuery)
export class ListCollectionsHandler implements IQueryHandler<ListCollectionsQuery, CollectionSummaryOf<Date>[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
  ) {}

  async execute(query: ListCollectionsQuery): Promise<CollectionSummaryOf<Date>[]> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const [rows, latest] = await Promise.all([
      this.collections.list(query.projectId),
      this.runs.latestByCollection(query.projectId),
    ]);
    return rows.map((row) => {
      const run = latest.get(row.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        ...countItems(row.document.items),
        updatedAt: row.updatedAt,
        lastRun: run
          ? { id: run.id, status: run.status, startedAt: run.startedAt, failed: run.totals.failed }
          : null,
      };
    });
  }
}

@QueryHandler(GetCollectionQuery)
export class GetCollectionHandler implements IQueryHandler<GetCollectionQuery, CollectionViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
  ) {}

  async execute(query: GetCollectionQuery): Promise<CollectionViewOf<Date>> {
    const row = await ownedCollection(
      this.projects,
      this.collections,
      query.organizationId,
      query.projectId,
      query.collectionId,
    );
    return collectionView(row);
  }
}

/** Qué se descarga y qué credencial se quedó fuera, para poder decirlo. */
export type ExportedCollection = { name: string; file: unknown; redacted: string[] };

@QueryHandler(ExportCollectionQuery)
export class ExportCollectionHandler implements IQueryHandler<ExportCollectionQuery, ExportedCollection> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_REPOSITORY) private readonly collections: CollectionRepositoryPort,
  ) {}

  async execute(query: ExportCollectionQuery): Promise<ExportedCollection> {
    const row = await ownedCollection(
      this.projects,
      this.collections,
      query.organizationId,
      query.projectId,
      query.collectionId,
    );
    const written = writePostmanFile(row);
    return { name: row.name, file: written.file, redacted: written.redacted };
  }
}

@QueryHandler(ListCollectionRunsQuery)
export class ListCollectionRunsHandler implements IQueryHandler<ListCollectionRunsQuery, CollectionRunOf<Date>[]> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
  ) {}

  async execute(query: ListCollectionRunsQuery): Promise<CollectionRunOf<Date>[]> {
    await ownedProject(this.projects, query.organizationId, query.projectId);
    const runs = await this.runs.list(query.projectId, query.collectionId);
    return runs.map(runView);
  }
}

@QueryHandler(GetCollectionRunQuery)
export class GetCollectionRunHandler implements IQueryHandler<GetCollectionRunQuery, CollectionRunViewOf<Date>> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COLLECTION_RUN_REPOSITORY) private readonly runs: CollectionRunRepositoryPort,
  ) {}

  async execute(query: GetCollectionRunQuery): Promise<CollectionRunViewOf<Date>> {
    const run = await ownedRun(this.projects, this.runs, query.organizationId, query.projectId, query.runId);
    return runDetailView(run);
  }
}
