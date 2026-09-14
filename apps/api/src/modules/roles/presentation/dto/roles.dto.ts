import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from "class-validator";

import { DATA_SCOPES, ROLE_ACCESS, type DataScope, type RoleAccess } from "../../domain/model";

/** The name rule — the credential one — is checked in the command, once, next to the reserved names. */
export class CreateRoleDto {
  @IsString() @MaxLength(20) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(7) color?: string;
  @IsOptional() @IsBoolean() sameRoleDataIsolation?: boolean;
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(20) name?: string;
  /** An empty string clears it — the analyzer could not clear a description once written. */
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(7) color?: string;
  @IsOptional() @IsBoolean() sameRoleDataIsolation?: boolean;
}

export class RolePermissionItemDto {
  @IsUUID() endpointId: string;
  @IsIn(ROLE_ACCESS as unknown as string[]) access: RoleAccess;
  @IsOptional() @IsIn(DATA_SCOPES as unknown as string[]) dataScope?: DataScope;
}

export class SetRolePermissionsDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => RolePermissionItemDto)
  permissions: RolePermissionItemDto[];
}

export class EndpointRoleAccessItemDto {
  @IsUUID() roleId: string;
  @IsIn(ROLE_ACCESS as unknown as string[]) access: RoleAccess;
  @IsOptional() @IsIn(DATA_SCOPES as unknown as string[]) dataScope?: DataScope;
}

export class SetEndpointRoleAccessDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => EndpointRoleAccessItemDto)
  permissions: EndpointRoleAccessItemDto[];
}

export class RoleRuleItemDto {
  @IsUUID() sourceRoleId: string;
  @IsUUID() targetRoleId: string;
  @IsBoolean() canRead: boolean;
  @IsBoolean() canWrite: boolean;
  @IsBoolean() canDelete: boolean;
}

export class ReplaceRoleRulesDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => RoleRuleItemDto)
  rules: RoleRuleItemDto[];
}
