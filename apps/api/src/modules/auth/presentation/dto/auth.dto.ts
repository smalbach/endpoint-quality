import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * The request bodies, validated before a handler sees them.
 *
 * `MaxLength` on the password is not a strength rule — it is a denial-of-service guard. The KDF
 * is memory-hard by design, so an unbounded password is an unbounded amount of work per login
 * attempt, and the attempt does not need to succeed to cost it.
 */
export class RegisterDto {
  @IsEmail({}, { message: "email debe ser una dirección válida" })
  @MaxLength(320)
  email: string;

  @IsString()
  @MinLength(12, { message: "password debe tener al menos 12 caracteres" })
  @MaxLength(200, { message: "password no puede superar los 200 caracteres" })
  password: string;

  @IsString() @MaxLength(200) name: string;

  @IsOptional() @IsString() @MaxLength(200) organizationName?: string;
}

export class LoginDto {
  @IsEmail({}, { message: "email debe ser una dirección válida" }) @MaxLength(320) email: string;
  @IsString() @MaxLength(200) password: string;
}

export class RefreshDto {
  /** Optional in the body because the browser sends it as an httpOnly cookie; a CLI or a test
   * has no cookie jar and sends it here. */
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}

export class LogoutDto {
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
  @IsOptional() @IsBoolean() everywhere?: boolean;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(200) currentPassword: string;
  @IsString()
  @MinLength(12, { message: "newPassword debe tener al menos 12 caracteres" })
  @MaxLength(200)
  newPassword: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: "email debe ser una dirección válida" }) @MaxLength(320) email: string;
}

export class ResetPasswordDto {
  @IsString() @MaxLength(200) token: string;
  @IsString()
  @MinLength(12, { message: "newPassword debe tener al menos 12 caracteres" })
  @MaxLength(200)
  newPassword: string;
}

export class CreateApiTokenDto {
  @IsString() @MaxLength(120) name: string;
}
