-- La base que usa `pnpm --filter @eq/api test:db`. Separada de la de desarrollo porque esa
-- suite aplica y revierte migraciones, y hacerlo sobre la base de trabajo la vaciaría.
CREATE DATABASE endpoint_quality_test OWNER eq;
