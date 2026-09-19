/**
 * Los secretos de una corrida, tapados por su valor en lo que se guarda de ella.
 *
 * Tapar la petición por el nombre de la cabecera no basta, y salió probando contra un servidor de
 * verdad: httpbin devuelve en su cuerpo las cabeceras que recibe, así que un `Bearer {{token}}` con
 * el token sensible del entorno volvía entero en la respuesta y quedaba en claro en `run_steps`. El
 * informe lo lee gente a la que el botón de revelar se lo niega, y la respuesta es de un tercero que
 * puede repetir lo que quiera. Así que se busca el **valor**, donde esté: petición, respuesta y
 * aserciones, claves incluidas.
 *
 * Los nodos siguientes leen la respuesta sin tapar —es lo que capturan—; esto es solo lo guardado.
 */
export const SECRET_MASK = "••••••••";

/** Los secretos que merece la pena buscar: sin repetidos, sin los muy cortos, el más largo primero. */
function searchable(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length >= 4))].sort((a, b) => b.length - a.length);
}

/** Un valor cualquiera con cada secreto, y su forma escapada en JSON, cambiados por la máscara. */
export function maskSecrets<T>(value: T, secrets: readonly string[]): T {
  const hidden = searchable(secrets);
  if (!hidden.length) return value;
  const forms = hidden.flatMap((secret) => [...new Set([secret, JSON.stringify(secret).slice(1, -1)])]);
  const text = (input: string) => forms.reduce((result, form) => result.split(form).join(SECRET_MASK), input);
  const deep = (input: unknown): unknown =>
    typeof input === "string"
      ? text(input)
      : Array.isArray(input)
        ? input.map(deep)
        : input && typeof input === "object" && !(input instanceof Date)
          ? Object.fromEntries(Object.entries(input).map(([key, item]) => [text(key), deep(item)]))
          : input;
  return deep(value) as T;
}
