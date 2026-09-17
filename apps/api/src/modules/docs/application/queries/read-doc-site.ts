/**
 * Leer una documentación publicada por su URL pública.
 *
 * Es el gemelo de `answer-mock.ts`, y tiene la misma escalera de negativas por la misma razón: aquí
 * viven las dos cosas que la proyección pura no puede saber —si el `publicId` existe y si la clave
 * que trae la petición es la del sitio— y nada más. Lo que se publica de cada endpoint lo decide
 * `doc-page.ts`, que se prueba con dos arrays.
 *
 * Una consulta y no un comando: leer una página no escribe nada. No hay contador de visitas, y eso
 * es deliberado — un contador por `publicId` es un registro de quién mira qué y cuándo, que no hace
 * falta para servir una página.
 */
import { Inject } from "@nestjs/common";
import { QueryHandler, type IQuery, type IQueryHandler } from "@nestjs/cqrs";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { opaqueTokenMatches } from "@/shared/crypto/opaque-token";
import { NotFoundError, UnauthenticatedError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import {
  ENDPOINT_REPOSITORY,
  EXAMPLE_REPOSITORY,
  type EndpointRepositoryPort,
  type ExampleRepositoryPort,
} from "@/modules/endpoints/domain/ports";
import { buildDocPage, projectAuthType, type DocPage } from "../../domain/doc-page";
import { DOC_SITE_REPOSITORY, type DocSiteRepositoryPort } from "../../domain/ports";

/** La cabecera de una documentación privada. La misma que un mock privado: ya la saben todos. */
export const DOC_KEY_HEADER = "x-api-key";

export class ReadDocSiteQuery implements IQuery {
  constructor(
    readonly publicId: string,
    /** La clave que trajo la petición, si trajo alguna. */
    readonly apiKey: string | undefined,
  ) {}
}

@QueryHandler(ReadDocSiteQuery)
export class ReadDocSiteHandler implements IQueryHandler<ReadDocSiteQuery, DocPage> {
  constructor(
    @Inject(DOC_SITE_REPOSITORY) private readonly sites: DocSiteRepositoryPort,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(EXAMPLE_REPOSITORY) private readonly examples: ExampleRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(query: ReadDocSiteQuery): Promise<DocPage> {
    const site = await this.sites.findByPublicId(query.publicId);
    // Uno que no existe y uno que existió y se borró dan lo mismo, y tienen que darlo: distinguirlos
    // convertiría esta ruta en un oráculo para adivinar URLs de documentaciones.
    if (!site) throw new NotFoundError("Esa documentación no existe", "doc-site-not-found");

    if (!site.enabled) throw new NotFoundError("Esta documentación no está publicada ahora mismo", "doc-site-disabled");

    if (site.visibility === "private") {
      const key = query.apiKey?.trim();
      // `opaqueTokenMatches` compara en tiempo constante, y el hash nulo no puede abrir nada.
      if (!key || !site.apiKeyHash || !opaqueTokenMatches(key, site.apiKeyHash))
        throw new UnauthenticatedError(
          `Esta documentación es privada: manda la clave en la cabecera «${DOC_KEY_HEADER}».`,
          "doc-site-key-invalid",
        );
    }

    // Por `projectId` directo y no por organización: la petición no trae sesión, así que no hay
    // organización que comprobar. Lo que ata la página a un proyecto es el `publicId` y nada más.
    const project = await this.projects.findById(site.projectId);
    if (!project || project.deletedAt) throw new NotFoundError("Esa documentación no existe", "doc-site-not-found");

    const [endpoints, examples] = await Promise.all([
      this.endpoints.listAll(site.projectId),
      site.includeExamples ? this.examples.listByProject(site.projectId) : Promise.resolve([]),
    ]);
    const byEndpoint = new Map<string, typeof examples>();
    for (const example of examples) {
      byEndpoint.set(example.endpointId, [...(byEndpoint.get(example.endpointId) ?? []), example]);
    }

    return buildDocPage({
      project: {
        name: project.name,
        description: project.description,
        // El tipo, y de los ajustes **solo el nombre de la cabecera** de la clave: sin él, quien lea
        // la página no sabe dónde poner la suya. La URL de login y el nombre de usuario se quedan
        // dentro: son del proyecto, no de la API que documenta.
        authType: projectAuthType(project.auth.type),
        apiKeyName: project.auth.settings.headerName ?? "",
      },
      site,
      endpoints,
      examplesOf: (endpointId) => byEndpoint.get(endpointId) ?? [],
      generatedAt: this.clock.now(),
    });
  }
}
