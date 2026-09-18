/**
 * Capturar tráfico: el proxy de captura y sus sesiones.
 *
 * No importa `SpecsModule` ni `SAFE_FETCH`: el proxy no hace peticiones propias, reenvía las de
 * otro, así que sale por `resolveTarget` y `pinnedAgent` —las piezas de `safe-fetch.ts`— con la
 * política leída de `policyFromEnv`, que es el mismo sitio del que la leen `SAFE_FETCH` y los
 * sockets. Tres consumidores, una lectura.
 */
import { Module, forwardRef } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CaptureItemEntity, CaptureSessionEntity } from "@/shared/database/entities";
import { AuthModule } from "@/modules/auth/auth.module";
import { IamModule } from "@/modules/iam/iam.module";
import { ProjectsModule } from "@/modules/projects/projects.module";
import { CAPTURE_REPOSITORY } from "./domain/ports";
import { TypeOrmCaptureRepository } from "./infrastructure/persistence/typeorm-capture.repository";
import { CaptureProxyService } from "./infrastructure/capture-proxy.service";
import { CAPTURE_COMMAND_HANDLERS } from "./application/commands/manage-captures";
import { CAPTURE_QUERY_HANDLERS } from "./application/queries/read-captures";
import { CapturesController } from "./presentation/captures.controller";

export { CAPTURE_COMMAND_HANDLERS, CAPTURE_QUERY_HANDLERS };
export const CAPTURE_ADAPTERS = [
  { provide: CAPTURE_REPOSITORY, useClass: TypeOrmCaptureRepository },
  CaptureProxyService,
];

@Module({
  imports: [
    CqrsModule,
    AuthModule,
    IamModule,
    TypeOrmModule.forFeature([CaptureSessionEntity, CaptureItemEntity]),
    forwardRef(() => ProjectsModule),
  ],
  controllers: [CapturesController],
  providers: [...CAPTURE_ADAPTERS, ...CAPTURE_COMMAND_HANDLERS, ...CAPTURE_QUERY_HANDLERS],
})
export class CapturesModule {}
