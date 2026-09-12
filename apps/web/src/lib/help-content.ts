/**
 * The «Ayuda y documentación» panel, one topic per section of a project.
 *
 * Written for what this product does, not copied from the analyzer's: a help text that describes
 * a button that is not there teaches people to stop reading the help.
 */
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
        body: "En Settings → Entornos: una URL base, sus variables y las credenciales de cada rol. Elige cuál es el activo desde el botón de entorno de la barra superior.",
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
    intro: "Las operaciones del proyecto y los casos que se generan para cada una.",
    steps: [
      {
        title: "De dónde salen",
        body: "Del contrato importado. Cada operación trae los casos que su documento permite derivar: lectura, no encontrado, cuerpo inválido, creación y relectura, autorización.",
      },
      {
        title: "Filtrar y elegir",
        body: "Busca por método, ruta o resumen; filtra por la etiqueta del contrato o por las etiquetas del equipo. Marca operaciones para lanzar solo esas.",
      },
      {
        title: "Casos que no se ejecutarán",
        body: "Un entorno de solo lectura bloquea las escrituras. El caso sigue en la lista, en ámbar, con el motivo.",
        tip: "El orden «Lecturas primero» evita que un DELETE deje sin recurso a una lectura que venía después.",
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
        body: "Escribe los roles de la API (vendedor, comprador, admin…). Cada entorno guarda la credencial de cada uno.",
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
    intro: "Cada ejecución, guardada con lo que envió y lo que recibió.",
    steps: [
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
    id: "settings",
    title: "Settings",
    intro: "El proyecto, su contrato, su configuración y sus entornos.",
    steps: [
      { title: "General", body: "Nombre y descripción del proyecto, y archivarlo cuando deja de usarse." },
      {
        title: "Contrato y configuración",
        body: "Importar o releer el contrato, copiar de otro proyecto y las secciones: presupuestos, envelope, parámetros, autorización, etiquetas…",
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
