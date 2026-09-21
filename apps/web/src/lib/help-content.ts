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
        body: "Se agrupan por el primer segmento de la ruta, y por módulo y versión cuando empieza por v1, v2… Filtra por estado, busca por ruta o descripción y marca varios para archivarlos, desactivarlos, activarlos o eliminarlos a la vez. Lo eliminado no se pierde: el filtro «Eliminados» es la papelera del proyecto, y desde ahí se restaura o se borra del todo.",
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
    id: "collections",
    title: "Colecciones",
    intro: "Las colecciones de Postman, tal cual: su árbol, sus scripts y el runner que las corre en orden.",
    steps: [
      {
        title: "Importa la que ya tienes",
        body: "Importar (Cmd+O) y suelta el .postman_collection.json. Entra con sus carpetas, sus peticiones, sus variables y sus tests, en su orden. Importar la misma otra vez la actualiza en vez de duplicarla.",
      },
      {
        title: "Edítala como allí",
        body: "El árbol a la izquierda; a la derecha, Params, Headers, Body, Auth y Scripts. Una carpeta y la colección tienen también los suyos, y una petición hereda la autenticación de su carpeta, de la colección y al final del proyecto.",
      },
      {
        title: "Envía una petición",
        body: "«Enviar» manda la que hay en pantalla —guardada o no— con los scripts de encima ya compuestos, y enseña el cuerpo, las cabeceras, los pm.test y la consola.",
        tip: "Escribe {{ en cualquier campo para ver las variables del entorno activo.",
      },
      {
        title: "Córrela entera",
        body: "«Correr» lanza la colección o una carpeta: elige entorno, vueltas y espera entre peticiones. Lo que un pm.collectionVariables.set escribe viaja a las siguientes, que es lo que hace que «crear, leer lo creado, borrarlo» funcione.",
      },
      {
        title: "Léela y llévatela",
        body: "El informe enseña cada petición con su estado, su tiempo y sus tests, en vivo mientras corre. «Exportar» devuelve el fichero de Postman, listo para newman — sin los secretos escritos a mano.",
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
    id: "mocks",
    title: "Mocks",
    intro: "Una URL que contesta con los ejemplos guardados del proyecto, sin tocar la API de verdad.",
    steps: [
      {
        title: "Antes: guarda ejemplos",
        body: "Un mock no inventa nada: sirve lo que alguien guardó. Envía una petición desde el editor de un endpoint y pulsa «Guardar la respuesta». La pantalla de Mocks dice cuántas rutas tienen ya al menos un ejemplo.",
        tip: "Una ruta sin ejemplo contesta 501 diciendo que falta, no un 404 que parecería un mock roto.",
      },
      {
        title: "Crea el mock y elige quién lo llama",
        body: "Privado pide la cabecera x-api-key, y la clave se enseña una sola vez. Público lo lee cualquiera que tenga la URL. No hay opción marcada de antemano: los ejemplos van sin credenciales dentro, pero siguen siendo datos reales.",
        tip: "La URL no se adivina, y eso es todo lo que protege a un mock público. Una URL que ya circula sigue circulando aunque después se cambie a privada: para cortar, se borra el mock o se apaga.",
      },
      {
        title: "Apúntale el front",
        body: "La URL se pega tal cual donde iría la API. Abre CORS a cualquier origen —el caso normal es un front en un puerto que cambia cada día— y por eso mismo no admite cookies: lo que autoriza es la cabecera.",
      },
      {
        title: "Pide el ejemplo que quieras",
        body: "Por defecto contesta el 2xx más bajo de la ruta. La misma petición con «x-eq-mock-status: 404» o «x-eq-mock-example: nombre» devuelve otro, que es como se prueba el camino de error sin tocar nada. Las cabeceras de Postman valen igual.",
        tip: "Si hay varios ejemplos de la misma ruta, la cadena de consulta y el cuerpo JSON deciden: «?page=2» contesta el ejemplo que se guardó con «?page=2».",
      },
      {
        title: "Cuando conteste algo raro",
        body: "Cada respuesta lleva x-eq-mock-endpoint, x-eq-mock-example y x-eq-mock-reason: qué ruta encajó, qué ejemplo salió y por qué. Un 405 trae Allow, y un 404 dice a qué ruta se parecía la que pediste.",
      },
    ],
  },
  {
    id: "doc-sites",
    title: "Docs",
    intro: "Los endpoints de este proyecto como una página que se le puede mandar a alguien que no tiene cuenta aquí.",
    steps: [
      {
        title: "Antes: escribe las descripciones",
        body: "La página saca el nombre, la ruta, los parámetros y las cabeceras de cada endpoint. Lo que no puede sacar de ningún sitio es qué hace cada uno: eso se escribe en el editor del endpoint. La pantalla dice cuántas rutas tienen descripción antes de publicar nada.",
        tip: "Sin descripciones la página sale igual, y es una lista de paths: quien la lea sabrá qué rutas hay y no para qué sirven.",
      },
      {
        title: "Publica y elige quién la lee",
        body: "Privada pide una clave al abrirla, y la clave se enseña una sola vez. Pública la abre cualquiera que tenga la URL. No hay opción marcada de antemano.",
        tip: "La URL no se adivina, y eso es todo lo que protege a una pública. La página lleva «noindex» para que un buscador no la convierta en una lista.",
      },
      {
        title: "Escribe la URL base",
        body: "Es contra qué se pega el código de ejemplo de la página. Se escribe entera y sin variables, porque la página no tiene entorno con el que resolverlas. Hay un botón para copiar la del proyecto, y hay que pulsarlo: así se ve el valor que va a salir publicado.",
      },
      {
        title: "Decide si salen los ejemplos",
        body: "Empieza apagado. Las respuestas guardadas son lo que convierte una documentación en algo que se entiende, y a la vez son datos reales: nombres, correos e identificadores de alguien. Las credenciales no están —se quitaron al guardarlas—, el resto sí.",
      },
      {
        title: "Qué no sale nunca",
        body: "El token de la autenticación de un endpoint, sus scripts, y el valor de cualquier cabecera que sea una credencial: de esas sale el nombre, que es lo que hay que documentar. Las variables se quedan escritas como {{variable}}.",
        tip: "Despublicar corta desde ese momento. Lo que ya se leyó sigue leído: una dirección que circula no se retira de donde esté pegada.",
      },
    ],
  },
  {
    id: "monitors",
    title: "Monitores",
    intro: "Una corrida guardada que se lanza sola cada tanto y avisa cuando se pone en rojo.",
    steps: [
      {
        title: "Es la misma corrida que el botón",
        body: "Un monitor guarda un plan y un entorno y ejecuta lo mismo que «Ejecutar»: la matriz del contrato, un flujo o una suite. Por eso no puede correr nada que no se pueda probar a mano antes.",
        tip: "En el historial de corridas aparecen como lanzadas por el monitor, no por una persona.",
      },
      {
        title: "El horario es en tu hora",
        body: "«Todos los días a las 9:00» se guarda con tu zona, no en UTC: así sigue siendo a las 9:00 cuando cambie la hora. El mínimo son cinco minutos, porque cada turno es una corrida entera contra un servicio real.",
        tip: "Crear el monitor no lanza nada: el primer turno es el siguiente del horario. Para lanzarla ya, «Correr ahora».",
      },
      {
        title: "No se solapan ni se acumulan",
        body: "Si la corrida anterior sigue en marcha, el turno se salta y lo dice. Y un proceso que estuvo horas parado no debe las corridas perdidas: al volver lanza una y sigue con su cadencia.",
      },
      {
        title: "El aviso pide el nombre de una variable",
        body: "La URL del webhook de Slack, Teams o el tuyo vive en una variable del entorno —cifrada si la marcas como sensible—, y el monitor guarda solo su nombre. Quien tiene esa URL puede escribir en ese canal: es una credencial.",
        tip: "«Avisar tras dos fallos seguidos» avisa una vez al llegar a dos, no en cada turno. Un canal que avisa cada cinco minutos acaba silenciado, y entonces tampoco avisa de lo grave.",
      },
      {
        title: "Cuando algo va mal",
        body: "La racha de fallos seguidos sale en la pantalla aunque no haya ningún canal configurado, y cada vuelta dice cuántos casos fallaron de cuántos. Una vuelta saltada no cuenta como fallo: no se midió nada.",
      },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    intro: "El proyecto, su contrato, su configuración y sus entornos.",
    steps: [
      {
        title: "General",
        body: "Nombre y descripción del proyecto, y archivarlo cuando deja de usarse.",
        tip: "Lo mismo vale dentro: mocks, monitores, documentaciones, planes de carga, entornos, canales, roles, flujos, conjuntos de datos y suites se pueden archivar —salen de la lista sin perderse— y lo que se elimina espera en el filtro «Eliminados» de su pantalla hasta que se restaura o se borra para siempre.",
      },
      {
        title: "Contrato y configuración",
        body: "Importar o releer el contrato, traer piezas sueltas de otro proyecto y las secciones que rellenan lo que el documento no dice. Van en tres grupos: «Datos de la corrida» (con qué valores y qué cuerpos se ejecuta, y qué operaciones existen ya), «Cuándo un caso es rojo» (401/403, latencia y forma de la respuesta) y «Ajustes avanzados», que casi nadie toca. Cada sección se abre con qué es, cuándo tocarla, qué pasa si no se toca y cómo suele quedar.",
        tip: "«por defecto» no es «vacío»: la sección dice, al abrirla, qué usa el motor cuando nadie la ha rellenado.",
      },
      {
        title: "Bifurcar, traer y fusionar",
        body: "Desde el menú «⋯» junto al nombre del proyecto. Bifurcar crea un proyecto nuevo con todo lo de este, que recuerda de dónde salió; desde la bifurcación se traen los cambios del original y se fusionan los propios en él, elemento a elemento y eligiendo lado en cada conflicto.",
        tip: "Los secretos no cruzan: una bifurcación nace con ellos vacíos, y fusionar un entorno conserva los que el original ya tenía.",
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
