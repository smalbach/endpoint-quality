import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { NOTIFY_CHANNELS, type NotifyChannel } from "@eq/runner-core";

import { MAX_MONITOR_NAME, type MonitorAlert, type MonitorPlan } from "../../domain/model";
import type { MonitorSchedule } from "../../domain/schedule";

/**
 * El horario y el plan van como objetos y se validan en el dominio, no en decoradores.
 *
 * No es pereza: el horario son tres formas distintas con reglas entre campos —un `weekly` necesita
 * días, un `interval` tiene mínimo, la zona tiene que existir en `Intl`— y el plan se valida entero
 * en `StartRunCommand`, que es donde se valida el de cualquier corrida. Repetir esas reglas en
 * decoradores sería tenerlas en dos sitios, y el que se olvidaría de actualizar es este.
 */
export class MonitorAlertDto {
  @IsIn(NOTIFY_CHANNELS) channel: NotifyChannel;
  /** El **nombre** de la variable del entorno que contiene la URL. Nunca la URL. */
  @IsString() @MinLength(1) @MaxLength(120) urlVariable: string;
  @IsOptional() afterFailures?: number;
}

export class CreateMonitorDto {
  @IsString() @MinLength(1) @MaxLength(MAX_MONITOR_NAME) name: string;
  @IsObject() schedule: MonitorSchedule;
  @IsObject() plan: MonitorPlan;
  @IsOptional() @ValidateNested() @Type(() => MonitorAlertDto) alert?: MonitorAlert | null;
}

export class UpdateMonitorDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(MAX_MONITOR_NAME) name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() schedule?: MonitorSchedule;
  @IsOptional() @IsObject() plan?: MonitorPlan;
  /** `null` quita el aviso. Ausente lo deja como estaba. */
  @IsOptional() alert?: MonitorAlert | null;
}
