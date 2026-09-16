/**
 * The «Ayuda y documentación» panel, one topic per section of a project.
 *
 * Written for what this product does, not copied from the analyzer's: a help text that describes
 * a button that is not there teaches people to stop reading the help.
 */
import { NODE_HELP } from "@/lib/node-help";

export type HelpStep = { title: string; body: string; tip?: string };
export type HelpTopic = { id: string; title: string; intro: string; steps: HelpStep[] };

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "primeros-pasos",
    title: "Primeros pasos",
    intro: "De un proyecto vacío a la primera corrida en cuatro pasos.",
    steps: [
      {
        title: "Crea un proyecto",
        body: "Desde Proyectos → «Nuevo proyecto». Un proyecto agrupa un contrato, sus entornos, sus flujos y sus corridas.",
      },
      {
        title: "Importa el contrato",
        body: "En Settings → Contrato, desde la URL de su /openapi.json o pegando el documento. Cada operación declarada aparece en Endpoints con sus casos.",
        tip: "Si el contrato está detrás de login, escribe la cabecera Authorization una vez: se guarda cifrada y las siguientes lecturas la reutilizan.",
      },
      {
        title: "Crea un entorno",
        body: "En Settings → Entornos: una URL base, sus variables y las credenciales de cada rol. Elige cuál es el activo —el mismo para todo el proyecto— desde el botón de entorno de la barra superior, que también abre el gestor de entornos y enseña el token de sesión capturado.",
      },
      {
        title: "Lanza la corrida",
        body: "En Endpoints, con el entorno elegido, «Ejecutar». La corrida queda guardada con cada petición y cada aserción.",
      },
    ],
  },
  {
    id: "endpoints",
    title: "Endpoints",
    intro: "Los endpoints del proyecto, un editor para probarlos y la matriz que genera el contrato.",
    steps: [
      {
        title: "De dónde salen",
        body: "Se crean a mano con «+ Nuevo», se importan desde un fichero (OpenAPI, Postman, Insomnia o un markdown con curls) o desde un cURL suelto, y al importar el contrato en Settings cada operación se añade como endpoint. Una ruta que ya existe no se duplica: la importación dice cuáles se saltó y por qué.",
      },
      {
        title: "Organizar",
        body: "Se agrupan por el primer segmento de la ruta, y por módulo y versión cuando empieza por v1, v2… Filtra por estado, busca por ruta o descripción y marca varios para archivarlos, desactivarlos, activarlos o eliminarlos a la vez.",
        tip: "«fuera» junto a un endpoint significa que el contrato activo ya no lo declara.",
      },
      {
        title: "Probar",
        body: "El editor manda lo que hay en pantalla, guardado o no, contra el entorno elegido: parámetros, cabeceras, cuerpo (JSON, texto, form-data con ficheros, urlencoded o binario) y la autenticación heredada del proyecto —o el token de sesión que capturó el login— o un token solo para esa petición. Los scripts previo y posterior corren en un proceso aislado con la API pm (pm.environment, pm.variables, pm.request.headers, pm.response, pm.test, pm.expect) y console.log; la pestaña Consola enseña su salida con los secretos ocultos. Ctrl+Enter envía y Ctrl+S guarda.",
        tip: "Un entorno sin escrituras permitidas no deja enviar POST, PUT, PATCH ni DELETE.",
      },
      {
        title: "La matriz del contrato",
        body: "En la pestaña «Matriz del contrato» siguen los casos que el documento permite derivar, con el entorno y el orden, y el botón para lanzar la corrida.",
      },
    ],
  },
  {
    id: "roles",
    title: "Roles",
    intro: "Quién puede llegar a qué. Es lo único que el contrato no puede decir.",
    steps: [
      {
        title: "Declara los roles",
        body: "En Roles → «+ Nuevo rol»: nombre, descripción, color y si dos usuarios del mismo rol deben estar aislados. Luego decide por endpoint —o por carpeta— si el rol debe pasar, debe ser rechazado o queda sin decidir, y qué datos ve. Cada entorno guarda la credencial de cada rol.",
      },
      {
        title: "Rellena la matriz",
        body: "Por operación y rol: debe pasar, no debe pasar o sin decidir. Cada celda decidida es un caso.",
        tip: "Un rechazo acepta 403 y 404: esconder que el recurso existe también es negar el acceso.",
      },
      {
        title: "Reglas entre roles",
        body: "Un rol crea un recurso y otro intenta alcanzarlo. El recurso se crea durante la corrida, así que prueba el permiso de verdad y no el de una fixture.",
      },
    ],
  },
  {
    id: "test-runs",
    title: "Test Runs",
    intro: "Corridas de seguridad con las 17 reglas, y las corridas de la matriz del contrato.",
    steps: [
      {
        title: "Lanzar una corrida de seguridad",
        body: "En la pestaña Seguridad → «Nueva corrida»: elige entorno, reglas (o un preset) y alcance. Las credenciales de cada rol salen del entorno, no del formulario. La matriz sale detrás del guard SSRF, nunca desde el navegador.",
        tip: "Los casos de permisos solo se juzgan si el entorno aplica autorización; actívalo en sus ajustes.",
      },
      {
        title: "Leer los hallazgos",
        body: "Cada hallazgo trae severidad, la regla, el endpoint, cómo corregirlo y la petición que lo produjo. La puntuación baja según lo peor encontrado; «endpoints sin proteger» son los que responden 2xx sin token.",
      },
      {
        title: "Seguir una corrida",
        body: "La página de la corrida se actualiza en vivo: casos terminados, fallos por tipo y reintentos en curso.",
      },
      {
        title: "De quién es el fallo",
        body: "Cada caso rojo dice su tipo: red, configuración, 5xx, estado, contrato, comprobación, flujo o presupuesto.",
      },
      {
        title: "Leer un caso",
        body: "Elige un caso para ver cada paso, sus aserciones con el motivo y la petición y respuesta completas.",
        tip: "Pasados los días de retención los cuerpos se retiran, pero el veredicto y sus aserciones se quedan.",
      },
    ],
  },
  {
    id: "flow-testing",
    title: "Flow Testing",
    intro: "Pasos encadenados que se pasan valores entre sí.",
    steps: [
      {
        title: "Crea un flujo",
        body: "«+ Nuevo» en la columna de flujos. Añade pasos desde las pruebas reutilizables y conéctalos en el lienzo.",
      },
      {
        title: "Captura y reutiliza",
        body: "Un paso captura de su respuesta (cuerpo, cabecera, cookie o expresión regular) y los siguientes lo usan como {{variable}}.",
      },
      {
        title: "Condiciones, bucles y reintentos",
        body: "Un paso puede ejecutarse solo si otro contestó algo, repetirse por cada elemento de una lista y reintentarse con espera creciente.",
      },
      {
        title: "Datos y suites",
        body: "Un conjunto de datos recorre el flujo una vez por fila. Una suite ejecuta varios flujos en orden con un solo veredicto.",
        tip: "Escribe {{ en cualquier campo para ver las variables disponibles.",
      },
    ],
  },
  {
    id: "nodos",
    title: "Nodos de flujo",
    intro:
      "Qué hace cada nodo del lienzo. Dentro del flujo, cada nodo tiene además su pestaña «Ayuda» y una «i» en cada campo.",
    steps: Object.values(NODE_HELP).map((help) => ({
      title: help.title,
      body: `${help.summary} Ejemplo: ${help.example}`,
      tip: help.pitfalls[0],
    })),
  },
  {
    id: "performance",
    title: "Performance",
    intro: "Pruebas de carga: un plan que se ejecuta con usuarios virtuales y se juzga por umbrales.",
    steps: [
      {
        title: "Escribe un plan",
        body: "Escenarios con peso (mayor peso, más veces), cada uno con sus peticiones y una pausa entre ellas. Un escenario captura de una respuesta y las siguientes lo gastan como {{variable}}.",
      },
      {
        title: "Elige la forma de la carga",
        body: "Constante mantiene los usuarios; rampa sube de un número a otro; pico sube en el tercio central. La duración es en segundos.",
      },
      {
        title: "Pon los umbrales",
        body: "p95, p99, tasa de error máxima y peticiones por segundo mínimas. La corrida pasa si cumple todos; el que falta no se comprueba.",
        tip: "El tráfico sale siempre desde el servidor y detrás del guard SSRF, con la credencial del entorno.",
      },
      {
        title: "Lee la corrida",
        body: "Timeline en vivo por ventanas de 5 s, resumen con percentiles, desglose por endpoint y el veredicto de cada umbral. El historial guarda cada corrida del plan.",
      },
    ],
  },
  {
    id: "code-scan",
    title: "Escáner de código",
    intro: "Lee el código NestJS y lo compara con lo que el proyecto tiene declarado.",
    steps: [
      {
        title: "Conecta o sube",
        body: "Conecta un repositorio de GitHub (owner/repo, rama, base path y prefijo; el token va cifrado y no se muestra), o sube los ficheros del código. Ambos caminos valen.",
      },
      {
        title: "Escanea",
        body: "Se leen los controladores y sus rutas, guards y roles, siempre desde el servidor y detrás del guard SSRF. El resultado es un diff contra los endpoints del proyecto.",
      },
      {
        title: "Mira el impacto",
        body: "Roles que el código nombra y el proyecto no define, y endpoints que el código ya no tiene pero un permiso o un flujo aún referencian.",
        tip: "Nada se borra al importar: quitar un endpoint que algo usa es una decisión tuya, no del escaneo.",
      },
      {
        title: "Importa",
        body: "Crea los endpoints nuevos y actualiza los cambiados; opcionalmente crea los roles que faltan. Un segundo import no duplica lo que ya existe.",
      },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    intro: "El proyecto, su contrato, su configuración y sus entornos.",
    steps: [
      { title: "General", body: "Nombre y descripción del proyecto, y archivarlo cuando deja de usarse." },
      {
        title: "Contrato y configuración",
        body: "Importar o releer el contrato, copiar de otro proyecto y las secciones que rellenan lo que el documento no dice. Van en tres grupos: «Datos de la corrida» (con qué valores y qué cuerpos se ejecuta, y qué operaciones existen ya), «Cuándo un caso es rojo» (401/403, latencia y forma de la respuesta) y «Ajustes avanzados», que casi nadie toca. Cada sección se abre con qué es, cuándo tocarla, qué pasa si no se toca y cómo suele quedar.",
        tip: "«por defecto» no es «vacío»: la sección dice, al abrirla, qué usa el motor cuando nadie la ha rellenado.",
      },
      {
        title: "Entornos",
        body: "URL base, variables con valor inicial y actual, secretos cifrados, permisos de escritura y credenciales por rol.",
        tip: "Una variable secreta devuelve ocho puntos. Guardarlos sin tocarlos deja el valor como estaba.",
      },
    ],
  },
  {
    id: "informes",
    title: "Informes",
    intro: "Lo que sale de una corrida hacia fuera.",
    steps: [
      {
        title: "Formatos",
        body: "JSON para leerlo con otra herramienta, HTML autocontenido para adjuntarlo y JUnit XML para que un CI enseñe los casos rojos.",
      },
      {
        title: "Desde una pipeline",
        body: "tools/eq-run.mjs lanza una corrida, la espera y termina con 0, 1 o 2 según pasó, falló o no se pudo ejecutar.",
      },
    ],
  },
];
