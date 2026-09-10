import { IsEmail, IsIn, IsString, MaxLength } from "class-validator";
import { ROLES, type Role } from "../../domain/model";

export class CreateOrganizationDto {
  @IsString() @MaxLength(200) name: string;
}

export class InviteMemberDto {
  @IsEmail({}, { message: "email debe ser una dirección válida" }) @MaxLength(320) email: string;
  @IsIn(ROLES as unknown as string[], { message: `role debe ser uno de: ${ROLES.join(", ")}` }) role: Role;
}

export class ChangeRoleDto {
  @IsIn(ROLES as unknown as string[], { message: `role debe ser uno de: ${ROLES.join(", ")}` }) role: Role;
}

export class AcceptInvitationDto {
  @IsString() @MaxLength(200) token: string;
}
