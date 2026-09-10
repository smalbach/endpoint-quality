import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { CREDENTIAL_KINDS, CREDENTIAL_ROLES, type CredentialKind, type CredentialRole } from "../../domain/model";

export class EnvironmentDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) baseUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) specUrl?: string | null;
  @IsOptional() @IsObject() variables?: Record<string, string>;
  @IsOptional() @IsBoolean() writesAllowed?: boolean;
  @IsOptional() @IsBoolean() authEnforced?: boolean;
}

export class CredentialDto {
  @IsString() @MaxLength(80) name: string;
  @IsIn(CREDENTIAL_ROLES as unknown as string[], { message: `role debe ser uno de: ${CREDENTIAL_ROLES.join(", ")}` }) role: CredentialRole;
  @IsIn(CREDENTIAL_KINDS as unknown as string[], { message: `kind debe ser uno de: ${CREDENTIAL_KINDS.join(", ")}` }) kind: CredentialKind;
  @IsOptional() @IsString() @MaxLength(80) headerName?: string | null;
  /** Write-only. It is encrypted on arrival and no query ever returns it, in any form. */
  @IsString() @MinLength(1) @MaxLength(4000) secret: string;
  @IsOptional() scopes?: string[];
}
