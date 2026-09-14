/**
 * Dashboard and history: org-level reads across every module.
 *
 * Gated by org membership (`viewer`), not a project role, because both span the organization's
 * projects. No writes here — it only aggregates what the modules already stored.
 */
import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { QueryBus } from "@nestjs/cqrs";

import { OrgRoleGuard, RequireRole } from "@/modules/auth/infrastructure/guards/auth.guard";
import { GetDashboardQuery } from "../application/queries/get-dashboard";
import { GetHistoryQuery, type HistoryFilters } from "../application/queries/get-history";
import type { HistoryKind } from "@eq/contracts";

@Controller("orgs/:organizationId")
@UseGuards(OrgRoleGuard)
export class DashboardController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get("dashboard")
  @RequireRole("viewer")
  async dashboard(@Param("organizationId") organizationId: string) {
    return this.queryBus.execute(new GetDashboardQuery(organizationId));
  }

  @Get("history")
  @RequireRole("viewer")
  async history(@Param("organizationId") organizationId: string, @Query() query: Record<string, string | undefined>) {
    const filters: HistoryFilters = {
      search: query.search ?? "",
      kind: (query.kind as HistoryKind | "all") || "all",
      page: Number(query.page) || 1,
      pageSize: Number(query.pageSize) || 25,
    };
    return this.queryBus.execute(new GetHistoryQuery(organizationId, filters));
  }
}
