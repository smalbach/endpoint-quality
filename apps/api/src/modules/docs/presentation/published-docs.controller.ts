/**
 * La ruta pública de una documentación: `GET /shared/docs/<publicId>`.
 *
 * Es el segundo controlador de este producto que contesta con datos de un proyecto sin sesión —el
 * primero es el mock—, así que hace deliberadamente lo mínimo: **lee y devuelve una proyección.**
 * Qué campos entran en esa proyección lo decide `doc-page.ts`, con una lista de lo que sale y no de
 * lo que se quita.
 *
 * ## Dos direcciones para lo mismo, a propósito
 *
 * Esta devuelve JSON, y es la que consume una máquina o el programa del navegador. La que se le da a
 * una persona es `/docs/<publicId>` en el origen del navegador, que pinta esta misma respuesta. Un
 * `publicId` sirve para las dos y no hay dos identificadores que mantener.
 *
 * ## `noindex`, y no por pudor
 *
 * Una documentación «pública» de este producto está protegida solo por que su URL no se adivine. Un
 * buscador que la indexe convierte eso en nada: deja de hacer falta adivinar la URL porque está en
 * una lista. Así que la respuesta lleva `X-Robots-Tag: noindex, nofollow` y la página del navegador
 * lo lleva también, puesto por nginx. Quien quiera que se indexe, lo publica en su sitio.
 */
import { Controller, Get, Headers, Param, Res } from "@nestjs/common";
import { QueryBus } from "@nestjs/cqrs";
import type { Response } from "express";

import { Public } from "@/modules/auth/infrastructure/guards/auth.guard";
import { DOC_KEY_HEADER, ReadDocSiteQuery } from "../application/queries/read-doc-site";
import type { DocPage } from "../domain/doc-page";

@Controller("shared/docs")
export class PublishedDocsController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get(":publicId")
  @Public()
  async read(
    @Param("publicId") publicId: string,
    @Headers(DOC_KEY_HEADER) apiKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocPage> {
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    // Sin caché: la documentación cambia cuando cambia el proyecto, y una página cacheada de una
    // documentación que se apagó hace diez minutos sigue enseñando lo que ya no se publica.
    response.setHeader("Cache-Control", "no-store");
    return this.queryBus.execute(new ReadDocSiteQuery(publicId, apiKey));
  }
}
