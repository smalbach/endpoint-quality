import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

/** The connector form. The token is optional: absent leaves the stored one, empty clears it. */
export class SaveConnectorDto {
  @IsOptional() @IsString() @MaxLength(200) repo?: string;
  @IsOptional() @IsString() @MaxLength(200) branch?: string;
  @IsOptional() @IsString() @MaxLength(300) basePath?: string;
  @IsOptional() @IsString() @MaxLength(100) prefix?: string;
  @IsOptional() @IsString() @MaxLength(500) token?: string | null;
}

export class UploadFileDto {
  @IsString() @MaxLength(500) path: string;
  @IsString() @MaxLength(500_000) content: string;
}

export class ScanUploadDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => UploadFileDto)
  files: UploadFileDto[];
  @IsOptional() @IsString() @MaxLength(100) prefix?: string;
}

export class ImportScanDto {
  /** Whether to also create the roles the code names that the project does not have. */
  @IsOptional() @IsBoolean() createRoles?: boolean;
}
