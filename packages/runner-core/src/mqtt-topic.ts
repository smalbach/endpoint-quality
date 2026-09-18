/**
 * Los temas de MQTT: qué es un tema válido, qué es un filtro válido y si un tema casa con un filtro.
 *
 * Aquí y no en la API porque lo usan dos sitios que no pueden discrepar: la API, al guardar un canal
 * —«`sensores/#/temp` no es un filtro»—, y el motor de comprobaciones, al elegir los mensajes de un
 * tema. Si cada uno tuviera su idea de qué casa con `+`, una comprobación guardada como válida
 * podría no mirar nunca ningún mensaje, y saldría en rojo por «no llegó ninguno» con los mensajes
 * delante.
 *
 * Las reglas son las de la especificación (3.1.1 §4.7 y 5.0 §4.7), sin extensiones: `+` ocupa un
 * nivel entero, `#` va solo y al final, y un tema que empieza por `$` no casa con un comodín inicial
 * —así un `#` no se traga los `$SYS/…` del broker—.
 */

/** Lo que admite la especificación: 65.535 bytes en UTF-8. */
export const MAX_TOPIC_BYTES = 65_535;

/**
 * Por qué un tema no sirve para publicar, o `null` si sirve.
 *
 * Publicar en un comodín no existe: el broker cierra la conexión, y se descubre en la sesión con un
 * error que no nombra el tema. Se dice antes.
 */
export function publishTopicProblem(topic: unknown): string | null {
  const base = topicTextProblem(topic);
  if (base) return base;
  if (/[+#]/.test(topic as string)) return "Un tema para publicar no lleva comodines (+ ni #)";
  return null;
}

/** Por qué un filtro de suscripción no es válido, o `null` si lo es. */
export function topicFilterProblem(filter: unknown): string | null {
  const base = topicTextProblem(filter);
  if (base) return base;
  const levels = (filter as string).split("/");
  for (const [index, level] of levels.entries()) {
    if (level.includes("#") && (level !== "#" || index !== levels.length - 1))
      return "# va solo y en el último nivel: sensores/#";
    if (level.includes("+") && level !== "+") return "+ ocupa un nivel entero: sensores/+/temp";
  }
  return null;
}

/** Si `topic` casa con `filter`. Un filtro inválido no casa con nada. */
export function topicMatches(filter: string, topic: string): boolean {
  if (topicFilterProblem(filter) !== null) return false;
  const wanted = filter.split("/");
  const levels = topic.split("/");
  // Un tema de sistema no lo recoge un comodín inicial: hay que pedirlo con su `$`.
  if (topic.startsWith("$") && (wanted[0] === "+" || wanted[0] === "#")) return false;
  for (let index = 0; index < wanted.length; index++) {
    const level = wanted[index];
    if (level === "#") return true;
    if (index >= levels.length) return false;
    if (level !== "+" && level !== levels[index]) return false;
  }
  return wanted.length === levels.length;
}

function topicTextProblem(topic: unknown): string | null {
  if (typeof topic !== "string" || topic === "") return "Falta el tema";
  if (topic.includes("\u0000")) return "Un tema no lleva el carácter nulo";
  if (new TextEncoder().encode(topic).length > MAX_TOPIC_BYTES) return `Como mucho ${MAX_TOPIC_BYTES} bytes`;
  return null;
}
