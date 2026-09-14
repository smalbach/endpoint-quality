/**
 * The loop that sends the security matrix, off the browser and behind the SSRF guard.
 *
 * The analyzer ran this from a React component pointed at any URL a user typed. Here every probe
 * goes through `SAFE_FETCH` — the same guard the contract runs use — so a run cannot be turned into
 * a request to `169.254.169.254`. The plan and the judgement live in `@eq/security-rules`; this
 * class only resolves credentials, opens sockets, and records what came back.
 *
 * Load-bearing decisions, the analyzer's mistakes turned around:
 * - **Cancellation is checked between probes**, never inside one, so a created resource is not left
 *   half-made.
 * - **Progress and probes are persisted as they go**, so a worker that dies mid-run leaves evidence.
 * - **The console never sees a secret**: rules read bodies, but the credentials themselves stay in
 *   this method and the masked request is what is stored.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  evaluateRules,
  extractRealIds,
  forgeAttackToken,
  planDiscovery,
  planProbes,
  summarize,
  type EndpointMeta,
  type PlanRole,
  type Probe,
  type ProbeResult,
  type RuleContext,
} from "@eq/security-rules";

import { SAFE_FETCH, BlockedTargetError, type SafeFetchPort } from "@/shared/http/safe-fetch";
import { SECRET_CIPHER, type SecretCipherPort } from "@/shared/crypto/secret-cipher";
import { CLOCK, type ClockPort } from "@/shared/clock/clock.port";
import { PROJECT_REPOSITORY, type ProjectRepositoryPort } from "@/modules/projects/domain/ports";
import { ENVIRONMENT_REPOSITORY, type EnvironmentRepositoryPort } from "@/modules/environments/domain/ports";
import { credentialHeader } from "@/modules/environments/domain/model";
import { ENDPOINT_REPOSITORY, type EndpointRepositoryPort } from "@/modules/endpoints/domain/ports";
import { pathParameterNames } from "@/modules/endpoints/domain/model";
import { ROLE_REPOSITORY, type RoleRepositoryPort } from "@/modules/roles/domain/ports";
import type { SecurityRun } from "../domain/model";
import { statusFromFindings } from "../domain/model";
import {
  SECURITY_RUN_QUEUE,
  SECURITY_RUN_REPOSITORY,
  type SecurityRunQueuePort,
  type SecurityRunRepositoryPort,
} from "../domain/ports";
import { SecurityRunProgressStream } from "./security-run-progress.stream";

const MAX_BODY = 200_000;

@Injectable()
export class SecurityRunExecutor {
  private readonly logger = new Logger(SecurityRunExecutor.name);

  constructor(
    @Inject(SECURITY_RUN_REPOSITORY) private readonly runs: SecurityRunRepositoryPort,
    @Inject(SECURITY_RUN_QUEUE) private readonly queue: SecurityRunQueuePort,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepositoryPort,
    @Inject(ENVIRONMENT_REPOSITORY) private readonly environments: EnvironmentRepositoryPort,
    @Inject(ENDPOINT_REPOSITORY) private readonly endpoints: EndpointRepositoryPort,
    @Inject(ROLE_REPOSITORY) private readonly roles: RoleRepositoryPort,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipherPort,
    @Inject(SAFE_FETCH) private readonly http: SafeFetchPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly progress: SecurityRunProgressStream,
  ) {}

  /** Wired once at boot. */
  listen(): void {
    this.queue.process((runId) => this.execute(runId));
  }

  async execute(runId: string): Promise<void> {
    const run = await this.runs.findById(runId);
    if (!run) return;
    try {
      await this.walk(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Security run ${runId} failed: ${message}`);
      await this.finish({ ...run, status: "error", error: message, finishedAt: this.clock.now() });
    }
  }

  private async walk(run: SecurityRun): Promise<void> {
    await this.advance(run, { status: "running", startedAt: this.clock.now() });

    const environment = await this.environments.findById(run.environmentId);
    if (!environment) throw new Error("El entorno ya no existe");
    const project = await this.projects.findById(run.projectId);
    if (!project) throw new Error("El proyecto ya no existe");

    const allEndpoints = (await this.endpoints.listAll(run.projectId)).filter(
      (endpoint) => endpoint.status === "active",
    );
    const chosen = run.options.endpointIds.length
      ? allEndpoints.filter((endpoint) => run.options.endpointIds.includes(endpoint.id))
      : allEndpoints;
    if (!chosen.length) throw new Error("No hay endpoints activos que probar");

    const endpointMeta: EndpointMeta[] = chosen.map((endpoint) => ({
      id: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      requiresAuth: endpoint.requiresAuth,
      operationId: endpoint.operationId,
      pathParameters: pathParameterNames(endpoint.path),
      body: endpoint.body.mode === "json" && endpoint.body.text ? safeObject(endpoint.body.text) : null,
    }));

    // Each declared role's Authorization, decrypted here and nowhere else.
    const credentials = await this.environments.listCredentials(environment.id);
    const roleAuth = new Map<string, string>();
    for (const credential of credentials)
      roleAuth.set(
        credential.role,
        Object.values(credentialHeader(credential, this.cipher.decrypt(credential.secretCiphertext)))[0],
      );
    const roleHeaderName = new Map<string, string>();
    for (const credential of credentials)
      roleHeaderName.set(credential.role, Object.keys(credentialHeader(credential, "x"))[0]);

    const roles = await this.roles.list(run.projectId);
    const planRoles: PlanRole[] = roles.map((role) => ({ name: role.name, hasCredential: roleAuth.has(role.name) }));
    const permissions = await this.roles.listPermissions(run.projectId);
    const rules = await this.roles.listRules(run.projectId);

    const context: RuleContext = {
      authEnforced: environment.authEnforced,
      endpoints: endpointMeta,
      roles: roles.map((role) => ({ name: role.name, sameRoleDataIsolation: role.sameRoleDataIsolation })),
      permissions: permissions
        .map((permission) => ({
          roleName: roles.find((role) => role.id === permission.roleId)?.name ?? "",
          endpointId: permission.endpointId,
          access: permission.access,
          dataScope: permission.dataScope,
        }))
        .filter((permission) => permission.roleName),
      crossRoleRules: rules
        .map((rule) => ({
          source: roles.find((role) => role.id === rule.sourceRoleId)?.name ?? "",
          target: roles.find((role) => role.id === rule.targetRoleId)?.name ?? "",
          canRead: rule.canRead,
          canWrite: rule.canWrite,
          canDelete: rule.canDelete,
        }))
        .filter((rule) => rule.source && rule.target),
    };

    const send = (probe: Probe) => this.send(probe, environment.baseUrl, roleAuth, roleHeaderName);

    // Phase 1: discovery.
    await this.advance(run, { progress: prog("Descubriendo ids", 5, "", 0, endpointMeta.length) });
    const discovery: ProbeResult[] = [];
    for (const probe of planDiscovery(endpointMeta, run.options.adminRole)) {
      if (this.queue.isCancelled(run.id)) return this.cancel(run);
      discovery.push(await send(probe));
    }
    const realIds = extractRealIds(discovery);

    // Phase 2: the matrix.
    const planned = planProbes(
      endpointMeta,
      {
        roles: planRoles,
        adminRole: run.options.adminRole,
        rules: run.rules,
        rateLimitIterations: run.options.rateLimitIterations,
        crossUserPermutations: run.options.crossUserPermutations,
      },
      realIds,
    );
    const results: ProbeResult[] = [];
    const tested = new Set<string>();
    for (let index = 0; index < planned.length; index += 1) {
      if (this.queue.isCancelled(run.id)) return this.cancel(run);
      const probe = this.withForgedToken(planned[index], roleAuth);
      results.push(await send(probe));
      tested.add(probe.endpointId);
      if (index % 10 === 0 || index === planned.length - 1) {
        const pct = 5 + Math.round((index / planned.length) * 75);
        await this.advance(run, {
          probes: [...discovery, ...results],
          progress: prog("Ejecutando sondas", pct, `${index + 1}/${planned.length}`, tested.size, endpointMeta.length),
        });
      }
    }

    // Phase 3: judge.
    await this.advance(run, { progress: prog("Analizando con las reglas", 85, "", tested.size, endpointMeta.length) });
    const findings = evaluateRules(results, context, run.rules);
    const summary = summarize(findings, results, endpointMeta);

    await this.finish({
      ...run,
      status: statusFromFindings(findings),
      findings,
      probes: [...discovery, ...results],
      summary,
      score: summary.score,
      risk: summary.risk,
      progress: prog("Terminado", 100, "", tested.size, endpointMeta.length),
      finishedAt: this.clock.now(),
    });
  }

  /** For a jwt-attack probe, forge the token from the role's real one. */
  private withForgedToken(probe: Probe, roleAuth: Map<string, string>): Probe {
    if (!probe.testType.startsWith("jwt-attack:") || !probe.credential) return probe;
    const real = (roleAuth.get(probe.credential) ?? "").replace(/^Bearer\s+/i, "");
    const attack = probe.testType.split(":")[1] ?? "";
    const forged = real ? forgeAttackToken(attack, real) : null;
    return forged ? { ...probe, token: `Bearer ${forged}` } : probe;
  }

  private async send(
    probe: Probe,
    baseUrl: string,
    roleAuth: Map<string, string>,
    roleHeaderName: Map<string, string>,
  ): Promise<ProbeResult> {
    const headers: Record<string, string> = { ...probe.headers };
    let sentAuthorization = false;
    if (probe.token) {
      headers.Authorization = probe.token;
      sentAuthorization = true;
    } else if (probe.credential && roleAuth.has(probe.credential)) {
      headers[roleHeaderName.get(probe.credential) ?? "Authorization"] = roleAuth.get(probe.credential)!;
      sentAuthorization = true;
    }
    if (probe.contentType) headers["Content-Type"] = probe.contentType;

    const url = `${baseUrl.replace(/\/+$/, "")}${probe.path.startsWith("/") ? "" : "/"}${probe.path}`;
    const base: ProbeResult = {
      ...probe,
      // The stored probe shows Authorization masked; the rules ran on the real one already.
      headers: sentAuthorization ? { ...headers, Authorization: "••••••••" } : headers,
      status: 0,
      responseHeaders: {},
      bodyText: "",
      bodyBytes: 0,
      durationMs: 0,
      error: null,
      sentAuthorization,
    };
    try {
      const response = await this.http.request(url, {
        method: probe.method,
        headers,
        ...(probe.body && probe.method !== "GET" && probe.method !== "HEAD" ? { body: probe.body } : {}),
      });
      return {
        ...base,
        status: response.status,
        responseHeaders: response.headers,
        bodyText: response.body.slice(0, MAX_BODY),
        bodyBytes: Buffer.byteLength(response.body),
        durationMs: response.durationMs,
      };
    } catch (error) {
      // A blocked or unreachable target is a probe with status 0, not a dead run: the next probe
      // may reach a different host, and «no respondió» is itself a result the rules can read.
      return {
        ...base,
        error:
          error instanceof BlockedTargetError
            ? error.message
            : error instanceof Error
              ? error.message
              : "sin respuesta",
      };
    }
  }

  private cancel(run: SecurityRun): Promise<void> {
    return this.finish({ ...run, status: "cancelled", finishedAt: this.clock.now() });
  }

  private async advance(run: SecurityRun, patch: Partial<SecurityRun>): Promise<void> {
    Object.assign(run, patch);
    await this.runs.save(run);
    this.progress.publish(run.id, { type: "progress", status: run.status, progress: run.progress });
  }

  private async finish(run: SecurityRun): Promise<void> {
    await this.runs.save(run);
    this.progress.publish(run.id, {
      type: "finished",
      status: run.status,
      progress: run.progress,
      score: run.score,
      risk: run.risk,
    });
  }
}

const prog = (phase: string, percentage: number, detail: string, endpointsTested: number, endpointsTotal: number) => ({
  phase,
  percentage,
  detail,
  endpointsTested,
  endpointsTotal,
});

function safeObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
