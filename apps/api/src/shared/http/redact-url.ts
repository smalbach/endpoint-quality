/**
 * La URL de una petición, sin lo que dentro de ella es una credencial.
 *
 * La URL de un nodo webhook lleva su token en la ruta, y el token es la credencial: ni la
 * respuesta de error ni la línea de registro de esa petición la repiten. Vive aquí y no en el
 * filtro de errores porque ahora hay dos sitios que escriben una URL a un registro —el filtro y
 * el interceptor que mide cada operación— y dos expresiones regulares iguales son una que algún
 * día se queda vieja.
 *
 * Se reconoce por el prefijo y no con la constante de `runs`, porque nada de `shared` debería
 * depender de un módulo.
 */
const HOOK_TOKEN_IN_PATH = /^(\/hooks\/flows\/)[^/?#]+/;

export function withoutHookToken(url: string): string {
  return url.replace(HOOK_TOKEN_IN_PATH, "$1[token-redactado]");
}
