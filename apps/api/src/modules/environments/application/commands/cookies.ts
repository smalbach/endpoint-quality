/**
 * El tarro de cookies de quien pregunta: verlo, borrar una, vaciarlo, y escribir una a mano.
 *
 * Postman tiene esta pantalla porque hace falta: cuando una petición contesta 401 y no se sabe por
 * qué, lo primero que hay que poder mirar es qué cookie se está mandando. Sin la lista, el tarro es
 * un estado invisible que cambia la respuesta y no se puede inspeccionar.
 *
 * El valor **no sale** salvo que se pida. Una cookie de sesión es una credencial, y una lista que
 * la enseña de serie la deja en el historial del navegador, en una captura de pantalla y en el log
 * de quien esté mirando por encima del hombro.
 */
import { Inject } from "@nestjs/common";
import {
  CommandHandler,
  QueryHandler,
  type ICommand,
  type ICommandHandler,
  type IQuery,
  type IQueryHandler,
} from "@nestjs/cqrs";

import { liveCookies, parseSetCookie, type Cookie } from "@eq/runner-core";
import type { CookieView } from "@eq/contracts";

import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { InvalidInputError } from "@/shared/errors/domain-error";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ownedProject } from "@/modules/projects/application/commands/update-project";
import { COOKIE_JAR_REPOSITORY, type CookieJarRepositoryPort } from "../../domain/ports";

const MASK = "•".repeat(8);

/** La cookie como sale. Con `reveal`, con su valor; sin él, con la misma máscara que todo lo demás. */
export const viewCookie = (cookie: Cookie, reveal: boolean): CookieView => ({
  name: cookie.name,
  value: reveal ? cookie.value : MASK,
  domain: cookie.domain,
  path: cookie.path,
  expiresAt: cookie.expiresAt === null ? null : new Date(cookie.expiresAt).toISOString(),
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
  hostOnly: cookie.hostOnly,
});

export class ListCookiesQuery implements IQuery {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
    readonly reveal: boolean,
  ) {}
}

@QueryHandler(ListCookiesQuery)
export class ListCookiesHandler implements IQueryHandler<ListCookiesQuery, { cookies: CookieView[] }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COOKIE_JAR_REPOSITORY) private readonly jar: CookieJarRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(query: ListCookiesQuery): Promise<{ cookies: CookieView[] }> {
    const project = await ownedProject(this.projects, query.organizationId, query.projectId);
    const now = this.clock.now();
    // Lo caducado ni se enseña ni se conserva: es una credencial que ya no sirve, y dejarla en la
    // lista hace pensar que la petición la lleva.
    await this.jar.purgeExpired(query.actorId, project.id, now);
    const cookies = liveCookies(await this.jar.list(query.actorId, project.id), now.getTime());
    return {
      cookies: cookies
        .sort((left, right) => left.domain.localeCompare(right.domain) || left.name.localeCompare(right.name))
        .map((cookie) => viewCookie(cookie, query.reveal)),
    };
  }
}

/** Borrar una, o vaciarlo entero. Vaciar es «ciérrame la sesión», que es para lo que se usa. */
export class DeleteCookiesCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
    /** Cuando viene, solo esa cookie. Sin ella, el tarro entero. */
    readonly key: { domain: string; path: string; name: string } | null,
  ) {}
}

@CommandHandler(DeleteCookiesCommand)
export class DeleteCookiesHandler implements ICommandHandler<DeleteCookiesCommand, void> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COOKIE_JAR_REPOSITORY) private readonly jar: CookieJarRepositoryPort,
  ) {}

  async execute(command: DeleteCookiesCommand): Promise<void> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    if (command.key) await this.jar.remove(command.actorId, project.id, [command.key]);
    else await this.jar.clear(command.actorId, project.id);
  }
}

/**
 * Una cookie escrita a mano, en el mismo formato que la manda un servidor.
 *
 * Se escribe como una línea `Set-Cookie` y no como un formulario con seis campos porque es el
 * formato que la gente ya tiene: se copia del inspector del navegador y se pega aquí. Y porque
 * pasa por el **mismo lector** que las de verdad, así que las reglas de dominio, de ruta y de
 * `Secure` son las mismas y no una segunda versión que puede diferir.
 */
export class SetCookieCommand implements ICommand {
  constructor(
    readonly organizationId: string,
    readonly projectId: string,
    readonly actorId: string,
    /** Para qué URL se está poniendo: es lo que decide qué dominios puede declarar. */
    readonly url: string,
    readonly setCookie: string,
  ) {}
}

@CommandHandler(SetCookieCommand)
export class SetCookieHandler implements ICommandHandler<SetCookieCommand, { cookie: CookieView }> {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(COOKIE_JAR_REPOSITORY) private readonly jar: CookieJarRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(command: SetCookieCommand): Promise<{ cookie: CookieView }> {
    const project = await ownedProject(this.projects, command.organizationId, command.projectId);
    if (!/^https?:\/\//i.test(command.url.trim())) {
      throw new InvalidInputError(
        "Hace falta la URL para la que vale la cookie",
        [{ field: "url", detail: "Una URL http(s) completa: es lo que decide qué dominio puede declarar" }],
        "cookie-url-missing",
      );
    }
    const read = parseSetCookie(command.setCookie, command.url.trim(), this.clock.now().getTime());
    if ("rejected" in read) {
      throw new InvalidInputError(
        "Esa cookie no se puede guardar",
        [{ field: "setCookie", detail: read.rejected }],
        "cookie-rejected",
      );
    }
    await this.jar.save(command.actorId, project.id, [read.cookie]);
    // Vuelve con su valor: lo acaba de escribir quien pregunta, y ocultárselo sería teatro.
    return { cookie: viewCookie(read.cookie, true) };
  }
}
