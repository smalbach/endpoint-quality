/**
 * Fills in the request-body schemas from the validation that actually runs.
 *
 * Nest generates `{"type": "object", "properties": {}}` for every DTO here, because the classes
 * carry `class-validator` decorators and no `@ApiProperty`. So the contract said each write takes
 * "an object" and nothing more — which is the same fault as declaring only the happy path, one
 * level down. A consumer could not tell what to send, and this product, pointed at its own
 * contract, generated 22 write cases with no payload at all.
 *
 * The obvious fix is `@ApiProperty` on all fifty-three properties. It was not taken, for one
 * reason: it would restate every constraint a second time, next to the first, with nothing keeping
 * the two in agreement. A `@MinLength(12)` and an `@ApiProperty({ minLength: 8 })` on the same
 * field both compile, and the document would be lying about the rule the API enforces.
 *
 * This reads the rules instead. `class-validator` keeps them in a metadata storage, each entry
 * naming the validator that produced it — `isEmail`, `maxLength`, `min` — and that is enough to
 * write the same rule as JSON Schema. **The document cannot drift from the validation, because it
 * is derived from it.**
 *
 * The other sanctioned route is `@nestjs/swagger`'s CLI plugin, which reads the TypeScript types.
 * It needs the transformer wired into the build, and this build is plain `tsc`; adding a patched
 * compiler for this is a heavier dependency than eighty lines.
 */
import "reflect-metadata";
import { getMetadataStorage } from "class-validator";
import {
  BulkDeleteEndpointsDto,
  BulkEndpointStatusDto,
  CreateEndpointDto,
  ImportEndpointCurlDto,
  SaveExampleDto,
  UpdateEndpointDto,
  UpdateExampleDto,
} from "@/modules/endpoints/presentation/dto/endpoints.dto";
import { CreateMockDto, UpdateMockDto } from "@/modules/mocks/presentation/dto/mocks.dto";
import { CreateDocSiteDto, UpdateDocSiteDto } from "@/modules/docs/presentation/dto/doc-sites.dto";
import { CreateMonitorDto, UpdateMonitorDto } from "@/modules/monitors/presentation/dto/monitors.dto";
import {
  CreateChannelDto,
  OpenChannelSessionDto,
  SendChannelMessageDto,
  UpdateChannelDto,
} from "@/modules/channels/presentation/dto/channels.dto";
import { ReflectGrpcDto, SaveProtosDto } from "@/modules/channels/presentation/dto/grpc.dto";
import { ImportCaptureDto } from "@/modules/captures/presentation/dto/captures.dto";
import type { OpenAPIObject } from "@nestjs/swagger";

import {
  ChangePasswordDto,
  CreateApiTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
} from "@/modules/auth/presentation/dto/auth.dto";
import {
  CreateEnvironmentDto,
  CredentialDto,
  ImportPostmanEnvironmentDto,
  SetCookieDto,
  UpdateEnvironmentDto,
} from "@/modules/environments/presentation/dto/environments.dto";
import {
  AcceptInvitationDto,
  ChangeRoleDto,
  CreateOrganizationDto,
  InviteMemberDto,
} from "@/modules/iam/presentation/dto/iam.dto";
import {
  ArchiveProjectDto,
  ForkProjectDto,
  SyncForkDto,
  CreateMergeRequestDto,
  MergeRequestCommentDto,
  MergeRequestReviewDto,
  ImportElementsDto,
  ImportProjectBundleDto,
  ImportAnythingDto,
  ImportSourceDto,
  ImportUrlAuthDto,
  CreateProjectDto,
  ImportSpecDto,
  ProjectAuthDto,
  SpecSourceDto,
  UpdateProjectDto,
} from "@/modules/projects/presentation/dto/projects.dto";
import { PreviewRequestDto, ResumeRunDto, StartRunDto } from "@/modules/runs/presentation/dto/runs.dto";
import {
  CreateRoleDto,
  EndpointRoleAccessItemDto,
  ReplaceRoleRulesDto,
  RolePermissionItemDto,
  RoleRuleItemDto,
  SetEndpointRoleAccessDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from "@/modules/roles/presentation/dto/roles.dto";
import {
  SecurityRunVisibilityDto,
  StartSecurityRunDto,
} from "@/modules/security-runs/presentation/dto/security-runs.dto";
import {
  CreatePlanDto,
  StartPerformanceRunDto,
  UpdatePlanDto,
} from "@/modules/performance/presentation/dto/performance.dto";
import { ImportScanDto, SaveConnectorDto, ScanUploadDto } from "@/modules/code-scan/presentation/dto/code-scan.dto";
import {
  CreateDatasetDto,
  CreateRequestTemplateDto,
  CreateSuiteDto,
  CreateWorkflowDto,
  ImportRequestTemplatesDto,
  ImportPostmanFlowsDto,
  UpdateDatasetDto,
  UpdateRequestTemplateDto,
  UpdateSuiteDto,
  UpdateWorkflowDto,
} from "@/modules/workflows/presentation/dto/workflows.dto";

/**
 * Every DTO whose schema should be filled in, listed by hand.
 *
 * A decorator that registered them would be one more thing to forget on a new DTO and would fail
 * silently. This list fails loudly instead: `describeBodies` reports any schema it was asked about
 * and could not find, and the suite asserts that no request body is left empty — so a DTO added
 * without being added here breaks a test rather than quietly publishing `{}`.
 */
const DTOS = [
  StartSecurityRunDto,
  SecurityRunVisibilityDto,
  CreateRoleDto,
  UpdateRoleDto,
  RolePermissionItemDto,
  SetRolePermissionsDto,
  EndpointRoleAccessItemDto,
  SetEndpointRoleAccessDto,
  RoleRuleItemDto,
  ReplaceRoleRulesDto,
  RegisterDto,
  LoginDto,
  RefreshDto,
  LogoutDto,
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ProjectAuthDto,
  CreateApiTokenDto,
  CreateOrganizationDto,
  InviteMemberDto,
  AcceptInvitationDto,
  ChangeRoleDto,
  CreateProjectDto,
  UpdateProjectDto,
  ArchiveProjectDto,
  ForkProjectDto,
  SyncForkDto,
  CreateMergeRequestDto,
  MergeRequestCommentDto,
  MergeRequestReviewDto,
  ImportElementsDto,
  ImportProjectBundleDto,
  ImportAnythingDto,
  ImportSourceDto,
  ImportUrlAuthDto,
  SpecSourceDto,
  ImportSpecDto,
  CreateEnvironmentDto,
  UpdateEnvironmentDto,
  ImportPostmanEnvironmentDto,
  SetCookieDto,
  CredentialDto,
  CreateRequestTemplateDto,
  ImportRequestTemplatesDto,
  ImportPostmanFlowsDto,
  UpdateRequestTemplateDto,
  CreateWorkflowDto,
  UpdateWorkflowDto,
  CreateDatasetDto,
  UpdateDatasetDto,
  CreateSuiteDto,
  UpdateSuiteDto,
  StartRunDto,
  ResumeRunDto,
  PreviewRequestDto,
  CreateEndpointDto,
  UpdateEndpointDto,
  BulkEndpointStatusDto,
  BulkDeleteEndpointsDto,
  ImportEndpointCurlDto,
  SaveExampleDto,
  UpdateExampleDto,
  CreateMockDto,
  UpdateMockDto,
  CreateDocSiteDto,
  UpdateDocSiteDto,
  CreateMonitorDto,
  UpdateMonitorDto,
  CreateChannelDto,
  UpdateChannelDto,
  OpenChannelSessionDto,
  SendChannelMessageDto,
  SaveProtosDto,
  ReflectGrpcDto,
  ImportCaptureDto,
  CreatePlanDto,
  UpdatePlanDto,
  StartPerformanceRunDto,
  SaveConnectorDto,
  ScanUploadDto,
  ImportScanDto,
];

type Schema = Record<string, unknown>;

export function describeBodies(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  const schemas = (document.components.schemas ??= {});

  for (const dto of DTOS) {
    const existing = schemas[dto.name] as Schema | undefined;
    // Only the empty ones. A schema somebody wrote by hand knows something this cannot.
    if (!existing || Object.keys((existing.properties as object) ?? {}).length > 0) continue;
    const derived = schemaForClass(dto);
    if (derived) schemas[dto.name] = derived as (typeof schemas)[string];
  }
  return document;
}

/** The DTO as JSON Schema, or null when it declares no validation at all. */
export function schemaForClass(target: new () => unknown, seen: Set<unknown> = new Set()): Schema | null {
  const metadata = getMetadataStorage().getTargetValidationMetadatas(target, target.name, true, false);
  if (!metadata.length) return null;

  const properties: Record<string, Schema> = {};
  const optional = new Set<string>();

  for (const entry of metadata) {
    const name = entry.propertyName;
    if (!name) continue;
    // What `@IsOptional()` leaves behind. It is the only thing that decides `required`, and it is
    // the one rule whose absence changes the meaning of every other one on the property.
    if (entry.type === "conditionalValidation") {
      optional.add(name);
      continue;
    }
    /**
     * `@ValidateNested()`. The nested class comes from `design:type`, which TypeScript emits for
     * any decorated property, and the schema is **inlined** rather than `$ref`-ed: Nest never put
     * the nested DTO in `components` — there is no `@ApiProperty` pointing at it — so a reference
     * would dangle.
     *
     * Without this, `ImportSpecDto.source` was `{}`: the one field the whole import endpoint takes,
     * declared as "some object". A cycle is cut by leaving the property empty, which is what it
     * was before.
     */
    if (entry.type === "nestedValidation") {
      const nested = Reflect.getMetadata("design:type", target.prototype as object, name) as
        (new () => unknown) | undefined;
      properties[name] ??= {};
      if (nested && typeof nested === "function" && !seen.has(nested)) {
        const schema = schemaForClass(nested, new Set(seen).add(target));
        if (schema) properties[name] = schema;
      }
      continue;
    }
    properties[name] ??= {};
    apply(properties[name], entry.name ?? "", entry.constraints ?? []);
  }

  const names = Object.keys(properties);
  if (!names.length) return null;
  const required = names.filter((name) => !optional.has(name));

  return {
    type: "object",
    ...(required.length ? { required } : {}),
    properties,
  };
}

/**
 * One validator, written as the JSON Schema keyword that means the same thing.
 *
 * Unknown validators are ignored rather than guessed at: a property that ends up with no `type` is
 * still declared, still named, and still shows in the document. Inventing a type for a rule this
 * does not understand would put a claim in the contract that nothing enforces.
 */
function apply(schema: Schema, validator: string, constraints: unknown[]): void {
  const first = constraints[0];
  switch (validator) {
    case "isString":
      schema.type = "string";
      break;
    case "isEmail":
      schema.type = "string";
      schema.format = "email";
      break;
    case "isUrl":
      schema.type = "string";
      schema.format = "uri";
      break;
    case "isUuid":
      schema.type = "string";
      schema.format = "uuid";
      break;
    case "isBoolean":
      schema.type = "boolean";
      break;
    case "isInt":
      schema.type = "integer";
      break;
    case "isNumber":
    case "isPositive":
      schema.type ??= "number";
      if (validator === "isPositive") schema.exclusiveMinimum = 0;
      break;
    case "isArray":
      schema.type = "array";
      break;
    case "isObject":
      schema.type ??= "object";
      break;
    case "isIn":
      // The enum carries the type with it, so there is nothing else to say about the property.
      if (Array.isArray(first)) schema.enum = first;
      break;
    case "minLength":
      schema.type ??= "string";
      if (typeof first === "number") schema.minLength = first;
      break;
    case "maxLength":
      schema.type ??= "string";
      if (typeof first === "number") schema.maxLength = first;
      break;
    case "min":
      schema.type ??= "number";
      if (typeof first === "number") schema.minimum = first;
      break;
    case "max":
      schema.type ??= "number";
      if (typeof first === "number") schema.maximum = first;
      break;
    case "arrayMinSize":
      schema.type = "array";
      if (typeof first === "number") schema.minItems = first;
      break;
    case "arrayMaxSize":
      schema.type = "array";
      if (typeof first === "number") schema.maxItems = first;
      break;
    default:
      break;
  }
}
