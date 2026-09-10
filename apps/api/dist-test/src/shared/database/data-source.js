"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGRATIONS = void 0;
exports.buildDataSourceOptions = buildDataSourceOptions;
/**
 * The TypeORM data source, used by the CLI for migrations and by the module at boot.
 *
 * `synchronize` is false and stays false, in every environment. Inferring the schema from
 * entities is convenient exactly until two environments disagree about what was inferred.
 */
const typeorm_1 = require("typeorm");
const entities_1 = require("./entities");
const _1700000000000_InitialSchema_1 = require("./migrations/1700000000000-InitialSchema");
exports.MIGRATIONS = [_1700000000000_InitialSchema_1.InitialSchema1700000000000];
function buildDataSourceOptions(databaseUrl) {
    return {
        type: "postgres",
        url: databaseUrl,
        entities: entities_1.ENTITIES,
        migrations: exports.MIGRATIONS,
        synchronize: false,
        migrationsRun: false,
        logging: process.env.TYPEORM_LOGGING === "true",
    };
}
exports.default = new typeorm_1.DataSource(buildDataSourceOptions(process.env.DATABASE_URL ?? "postgres://eq:eq@localhost:5432/endpoint_quality"));
//# sourceMappingURL=data-source.js.map