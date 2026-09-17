import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

import {
  MAX_ALERT_RECIPIENTS,
  MAX_MONITOR_NAME,
  MAX_RECIPIENT_LENGTH,
  MONITOR_ALERT_CHANNELS,
  type MonitorAlert,
  type MonitorAlertChannel,
  type MonitorPlan,
} from "../../domain/model";
import type { MonitorSchedule } from "../../domain/schedule";

/**
 * El horario y el plan van como objetos y se validan en el dominio, no en decoradores.
 *
 * No es pereza: el horario son tres formas distintas con reglas entre campos —un `weekly` necesita
 * días, un `interval` tiene mínimo, la zona tiene que existir en `Intl`— y el plan se valida entero
 * en `StartRunCommand`, que es donde se valida el de cualquier corrida. Repetir esas reglas en
 * decoradores sería tenerlas en dos sitios, y el que se olvidaría de actualizar es este.
 */
/**
 * El aviso. Aquí solo la **forma** del cuerpo: qué campo pide cada canal lo decide el dominio.
 *
 * `urlVariable` y `recipients` son los dos opcionales por eso: cuál de los dos hace falta depende
 * de `channel`, y un decorador no sabe mirar otro campo. Poner los dos como obligatorios pediría
 * un nombre de variable para un aviso por correo.
 */
export class MonitorAlertDto {
  @IsIn(MONITOR_ALERT_CHANNELS) channel: MonitorAlertChannel;
  /** El **nombre** de la variable del entorno que contiene la URL. Nunca la URL. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) urlVariable?: string;
  /** Las direcciones del aviso por correo, en claro: un destinatario no es una credencial. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ALERT_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(MAX_RECIPIENT_LENGTH, { each: true })
  recipients?: string[];
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
