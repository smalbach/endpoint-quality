import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { DocSiteEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { EndpointsModule } from "@/modules/endpoints/endpoints.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { DOC_SITE_REPOSITORY } from "./domain/ports";
import { TypeOrmDocSiteRepository } from "./infrastructure/persistence/typeorm-doc-site.repository";
import {
  CreateDocSiteHandler,
  DeleteDocSiteHandler,
  RotateDocSiteKeyHandler,
  UpdateDocSiteHandler,
} from "./application/commands/manage-doc-sites";
import { ListDocSitesHandler } from "./application/queries/list-doc-sites";
import { ReadDocSiteHandler } from "./application/queries/read-doc-site";
import { DocSitesController } from "./presentation/doc-sites.controller";
import { PublishedDocsController } from "./presentation/published-docs.controller";

export const DOC_SITE_COMMAND_HANDLERS = [
  CreateDocSiteHandler,
  UpdateDocSiteHandler,
  RotateDocSiteKeyHandler,
  DeleteDocSiteHandler,
];
export const DOC_SITE_QUERY_HANDLERS = [ListDocSitesHandler, ReadDocSiteHandler];
export const DOC_SITE_ADAPTERS = [{ provide: DOC_SITE_REPOSITORY, useClass: TypeOrmDocSiteRepository }];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([DocSiteEntity]),
    forwardRef(() => EndpointsModule),
    forwardRef(() => ProjectsModule),
  ],
  controllers: [PublishedDocsController, DocSitesController],
  providers: [...DOC_SITE_ADAPTERS, ...DOC_SITE_COMMAND_HANDLERS, ...DOC_SITE_QUERY_HANDLERS],
  exports: [DOC_SITE_REPOSITORY],
})
export class DocsModule {}
