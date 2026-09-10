import { Global, Module } from "@nestjs/common";
import { ENV, loadEnv, type Env } from "./env";

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
