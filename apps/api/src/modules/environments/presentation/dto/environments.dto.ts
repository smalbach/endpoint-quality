import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { CREDENTIAL_KINDS, CREDENTIAL_ROLES, type CredentialKind, type CredentialRole } from "../../domain/model";

/**
 * Creating an environment and amending one are two different requests, and they were one class.
 *
 * Sharing it meant every field had to be `@IsOptional()`, because a `PATCH` that only flips
 * `writesAllowed` must not be made to resend the name. The cost showed up in this API's own
 * published contract, which is derived from these validators: it said a `POST /environments`
 * requires nothing at all — that `{}` is a valid way to create an environment. It is not. The
 * handler rejects it with a 422 naming `name`, so the document was describing an API that does
 * not exist, which is the exact fault this product looks for in everybody else.
 *
 * The rule is in the pipe now, where the 422 comes from the request shape rather than from
 * business logic several layers down. The handler keeps its own checks: a command bus is
 * reachable from places no `ValidationPipe` runs, and the invariant belongs to the domain, not
 * to HTTP.
 */
export class CreateEnvironmentDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** Absolute and http(s). That rule lives in `normalizeBaseUrl`, once: repeating it here as an
   * `@IsUrl()` would be a second definition of "valid" free to disagree with the first. */
  @IsString() @MinLength(1) @MaxLength(2000) baseUrl: string;
  @IsOptional() @IsString() @MaxLength(2000) specUrl?: string | null;
  @IsOptional() @IsObject() variables?: Record<string, string>;
  @IsOptional() @IsObject() disabledVariables?: Record<string, string>;
  @IsOptional() @IsBoolean() writesAllowed?: boolean;
  @IsOptional() @IsBoolean() authEnforced?: boolean;
}

/** Every field optional, which is what a partial update *is*. An empty body is a no-op and is
 * accepted as one. */
export class UpdateEnvironmentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) specUrl?: string | null;
  @IsOptional() @IsObject() variables?: Record<string, string>;
  @IsOptional() @IsObject() disabledVariables?: Record<string, string>;
  @IsOptional() @IsBoolean() writesAllowed?: boolean;
  @IsOptional() @IsBoolean() authEnforced?: boolean;
}

export class CredentialDto {
  @IsString() @MaxLength(80) name: string;
  @IsIn(CREDENTIAL_ROLES as unknown as string[], { message: `role debe ser uno de: ${CREDENTIAL_ROLES.join(", ")}` })
  role: CredentialRole;
  @IsIn(CREDENTIAL_KINDS as unknown as string[], { message: `kind debe ser uno de: ${CREDENTIAL_KINDS.join(", ")}` })
  kind: CredentialKind;
  @IsOptional() @IsString() @MaxLength(80) headerName?: string | null;
  /** Write-only. It is encrypted on arrival and no query ever returns it, in any form. */
  @IsString() @MinLength(1) @MaxLength(4000) secret: string;
  @IsOptional() scopes?: string[];
}
