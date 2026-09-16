/**
 * Qué es cada sección de «Contrato y configuración», en las palabras de quien la va a rellenar.
 *
 * Las secciones son las del motor (`CONFIG_SECTIONS`) y su nombre es su clave: `parameters`,
 * `envelope`, `implemented`… Esa clave es exacta y es la que viaja en el export, pero no dice
 * nada a quien abre la pantalla por primera vez y se encuentra nueve acordeones iguales. Aquí
 * vive lo que sí lo dice: un nombre en castellano, una línea que se lee sin abrir el acordeón y,
 * dentro, las cuatro cosas que hay que saber antes de tocar nada — qué es, cuándo hace falta, qué
 * pasa si se deja como está y cómo suele quedar cuando alguien la rellena.
 *
 * Ninguna sección sobra: cada una alimenta un trozo del generador de casos. Lo que sí sobra es
 * enseñarlas todas con el mismo peso, porque en un proyecto nuevo solo tres piden atención. De
 * ahí los grupos de abajo.
 */

export type ConfigSectionGuide = {
  /** El nombre en castellano; la clave se sigue enseñando al lado, en mono. */
  title: string;
  /** Una línea, visible con el acordeón cerrado: para qué sirve la sección. */
  summary: string;
  /** Qué es, con el detalle que la línea de arriba no cabe. */
  what: string;
  /** La señal que indica que hay que abrirla. */
  when: string;
  /** Qué hace el motor si nadie la toca. «Por defecto» no siempre significa «vacío». */
  fallback: string;
  /** Cómo queda una bien rellenada, con un ejemplo concreto. */
  recommended: string;
};

export const SECTION_GUIDE: Record<string, ConfigSectionGuide> = {
  parameters: {
    title: "Valores de prueba",
    summary: "Con qué datos se rellenan los {id} de la ruta y los filtros de la query.",
    what: "Una operación como GET /pedidos/{id} no se puede ejecutar sin un id. Aquí se dice cuál: un valor por parámetro de ruta, un valor que se usa cuando el parámetro no tiene el suyo, el identificador que debe fallar (el del caso 404) y con qué valores ejercitar cada filtro de query. Se puede afinar por operación cuando un endpoint necesita un id distinto del resto.",
    when: "Cuando los casos de lectura salen en rojo con 404 aunque el endpoint funcione: el motor está pidiendo el recurso «1» y en ese entorno no existe. También cuando el caso de «no existe» sale verde por casualidad porque el identificador inventado sí existía.",
    fallback:
      "Los parámetros de ruta valen «1», el identificador que no debe existir es «999999» y los filtros de query no se ejercitan con ningún valor concreto.",
    recommended:
      "Un valor real por cada parámetro de ruta del entorno de pruebas (id → 42, slug → pedido-demo) y un identificador que nunca vaya a existir, del formato correcto: si los ids son UUID, un UUID, no «999999».",
  },
  bodies: {
    title: "Cuerpos de las peticiones",
    summary: "El JSON que se manda en POST, PUT y PATCH, uno por operación.",
    what: "Una plantilla de cuerpo por operación. El contrato dice qué campos acepta un POST, pero no qué valores son válidos hoy en esa base de datos: no sabe qué cliente existe para poner en clienteId ni que el email tiene que ser nuevo. Eso se escribe aquí.",
    when: "En cuanto se quiera probar algo que escriba. Sin plantilla, los casos de creación y actualización no se pueden generar con datos que la API acepte.",
    fallback: "Vacío: no hay plantillas y los casos de escritura se quedan sin cuerpo que mandar.",
    recommended:
      "Una entrada por cada operación de escritura, con claves ajenas que apunten a algo que exista y con los campos únicos (email, código, referencia) escritos de forma que no choquen con lo que ya hay.",
  },
  implemented: {
    title: "Operaciones ya implementadas",
    summary: "Qué operaciones del contrato enruta la API hoy, para no juzgar lo que aún no existe.",
    what: "Un hecho sobre el código, no sobre el documento: el contrato puede declarar una operación que todavía nadie ha escrito. Marcadas las que sí existen, la matriz ejecuta solo esas y las demás no cuentan como fallo.",
    when: "Cuando el contrato va por delante del código y la corrida se llena de 404 que no son un error, sino trabajo pendiente.",
    fallback: "Sin decidir: se ejecutan todas las operaciones que declara el contrato.",
    recommended:
      "Dejarlo sin decidir mientras contrato y código vayan juntos. En cuanto el contrato se adelante, marcar solo lo que ya responde y revisarlo al cerrar cada entrega.",
  },
  authorization: {
    title: "Casos de 401 y 403",
    summary: "Qué se espera cuando se llama sin token o con un token que no llega.",
    what: "Las reglas que generan la matriz de autorización. Cada regla dice con qué credencial se llama (ninguna, una insuficiente o una api-key), qué estado debe contestar la API y a qué operaciones aplica: normalmente a las que el propio contrato declara que pueden contestar ese estado. Debajo, la lista de operaciones que no deben recibir ninguno de estos casos.",
    when: "Cuando hay endpoints públicos de verdad —login, health, webhooks— que salen en rojo por no pedir token, o cuando la API contesta 403 donde el contrato declaró 401.",
    fallback:
      "Dos reglas: sin credencial se espera 401 en las operaciones que declaran 401, y con credencial insuficiente se espera 403 en las que declaran 403.",
    recommended:
      "Las dos reglas por defecto, más la lista de operaciones públicas excluidas. Tocar los estados solo si la API contesta otra cosa a propósito y el contrato lo refleja.",
  },
  budgets: {
    title: "Presupuestos de latencia",
    summary: "Cuántos milisegundos puede tardar cada tipo de petición antes de dar el caso por lento.",
    what: "Una lista ordenada de reglas: método, final de la ruta y umbral en milisegundos. Gana la primera regla que casa con la operación, así que el orden es dato y no decoración — las flechas de cada fila lo cambian. Una operación que no casa con ninguna regla no recibe ninguna aserción de tiempo.",
    when: "Cuando importe que una respuesta lenta cuente como fallo. Hasta entonces, el tiempo se mide y se enseña, pero no juzga.",
    fallback:
      "Sin presupuestos: no se emite ninguna aserción de latencia, que no es lo mismo que una que pasa siempre.",
    recommended:
      "De lo estrecho a lo ancho: primero las reglas concretas (GET que acaba en /health, 100 ms), al final una general por método (GET 500 ms, POST 1000 ms). Al revés, la general se come a las demás.",
  },
  envelope: {
    title: "Forma de la respuesta",
    summary: "Si la API envuelve el recurso —{ data: … }— o lo devuelve pelado, y cómo son sus errores.",
    what: "Solo se usa cuando el documento en vivo no declara schema para ese estado: entonces hay que saber qué se espera. Una forma por defecto, una forma para los errores y, si la API no es uniforme, reglas que dicen qué forma usa cada familia de operaciones. Las reglas también son de primera coincidencia.",
    when: "Cuando el contrato tiene huecos —respuestas sin schema— y las aserciones de forma se quejan de una envoltura que sí es la correcta.",
    fallback: "Todo se espera como { data: Resource }, y los errores como ProblemDetails (RFC 7807).",
    recommended:
      "Ajustar las dos formas por defecto a lo que de verdad devuelve la API y añadir reglas solo para las familias que se salen: normalmente los listados paginados.",
  },
  labels: {
    title: "Etiquetas del equipo",
    summary: "Palabras propias por operación —«crítico», «pagos»— para lanzar corridas por ellas.",
    what: "Las etiquetas del equipo al lado de las del contrato. Sirven para lanzar una corrida por una palabra en vez de enumerar treinta identificadores que se quedan viejos en cuanto alguien añade una operación.",
    when: "Cuando una tubería tenga que correr un subconjunto: «lo crítico» en cada push, todo lo demás por la noche.",
    fallback: "Sin etiquetas: las corridas se lanzan sobre todo el contrato o eligiendo operaciones a mano.",
    recommended: "Pocas y estables. Dos o tres que signifiquen algo para todo el equipo valen más que una por módulo.",
  },
  scenarios: {
    title: "Casos condicionales y excepciones",
    summary: "Casos que solo aparecen con ciertos parámetros, y operaciones que necesitan trato aparte.",
    what: "Lo que no se deduce del contrato ni cabe en las demás secciones: casos que solo tienen sentido si la operación acepta un conjunto de parámetros, excepciones para una operación concreta, y cómo se reconoce un listado o una operación masiva (por método y por prefijo del identificador).",
    when: "Rara vez. Cuando la API nombra sus listados de otra forma, o cuando una operación necesita un caso escrito a mano que el generador no puede derivar.",
    fallback:
      "Se considera listado todo GET cuyo identificador empieza por «list», y masiva la que empieza por «bulk».",
    recommended:
      "Dejarla por defecto salvo que los nombres del contrato no sigan esa convención. Es la sección más avanzada de la pantalla y la que menos proyectos tocan.",
  },
  text: {
    title: "Idioma y textos",
    summary: "En qué idioma se nombran los casos generados, y cómo cambiar una frase concreta.",
    what: "El idioma del paquete de textos (es o en) y, debajo, cada cadena por si alguna hay que reescribirla. Cambia cómo se leen los casos y los informes, nunca lo que se ejecuta.",
    when: "Cuando el informe se lea fuera del equipo, o cuando una frase generada no sea la que el equipo usa para esa cosa.",
    fallback: "Español, con los textos que trae el motor.",
    recommended: "Elegir idioma y no tocar lo demás. Reescribir una cadena suelta solo si la que viene confunde.",
  },
  access: {
    title: "Permisos por rol",
    summary: "Quién puede llegar a qué: lo único que el contrato nunca puede decir.",
    what: "Los roles del proyecto, qué estados cuentan como rechazo (403 y 404, porque esconder que el recurso existe también es negar el acceso) y, por operación, qué rol debe pasar y cuál debe ser rechazado. Además, las reglas entre roles: uno crea un recurso y otro intenta alcanzarlo.",
    when: "En cuanto la API tenga más de un tipo de usuario. Se edita desde Roles, no desde aquí.",
    fallback: "Sin roles declarados no se genera ningún caso de permisos: el silencio no es una decisión.",
    recommended:
      "Declarar los roles, decidir celda a celda lo que se sepa y dejar sin decidir lo que no. Una celda a medias inventa un requisito.",
  },
};

export type ConfigSectionGroup = {
  id: string;
  title: string;
  intro: string;
  sections: string[];
  /** El grupo se enseña plegado mientras ninguna de sus secciones esté configurada. */
  advanced?: boolean;
};

/**
 * El orden de la pantalla, que no es el del motor.
 *
 * Primero lo que un proyecto nuevo necesita para que su primera corrida signifique algo, luego lo
 * que decide cuándo un caso es rojo, y al final lo que casi nadie toca. Una sección configurada
 * nunca se esconde, aunque esté en el grupo avanzado: lo que alguien decidió tiene que verse.
 */
export const SECTION_GROUPS: ConfigSectionGroup[] = [
  {
    id: "datos",
    title: "Datos de la corrida",
    intro: "Con qué valores se ejecuta el contrato. Es lo que hay que rellenar primero.",
    sections: ["parameters", "bodies", "implemented"],
  },
  {
    id: "criterios",
    title: "Cuándo un caso es rojo",
    intro: "Qué se exige a la respuesta además del estado: permisos, tiempo y forma.",
    sections: ["authorization", "budgets", "envelope"],
  },
  {
    id: "avanzado",
    title: "Ajustes avanzados",
    intro: "Casi ningún proyecto los toca. Los valores por defecto ya funcionan.",
    sections: ["labels", "scenarios", "text"],
    advanced: true,
  },
];
