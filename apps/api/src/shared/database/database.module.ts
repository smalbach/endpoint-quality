import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ENV, type Env } from "../config/env";
import { ConfigModule } from "../config/config.module";
import { ENTITIES } from "./entities";
import { buildDataSourceOptions } from "./data-source";

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => buildDataSourceOptions(env.DATABASE_URL),
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
