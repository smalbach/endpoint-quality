/**
 * What every kind of flow node does, written for the person wiring one for the first time.
 *
 * One entry per kind, and a test holds the list against the palette: a node that lands on the canvas
 * without its help is the node nobody knows how to configure. The pitfalls are the ones people
 * actually hit — a poll that never runs because the step it repeats failed, a path parameter left
 * empty — not a restatement of the form.
 */
import type { WorkflowStepView } from "@/lib/types";

export type NodeKind = NonNullable<WorkflowStepView["kind"]>;

export type NodeHelp = {
  title: string;
  /** One sentence: what it is for. */
  summary: string;
  /** How it runs, in order. */
  how: string[];
  /** A concrete use, with the values someone would type. */
  example: string;
  /** What goes wrong and how to tell. */
  pitfalls: string[];
};

export const NODE_HELP: Record<NodeKind, NodeHelp> = {
  request: {
    title: "Petición",
    summary: "Envía una operación del contrato (una prueba reutilizable) y juzga su respuesta.",
    how: [
      "Arma la petición con la operación, los parámetros, las cabeceras y el body de la pestaña «Petición»/«Body». Todo acepta {{variables}} del entorno o capturadas por pasos anteriores.",
      "Espera a que terminen los pasos conectados a su entrada (o el primero, si en «Cuándo» eliges «cualquiera»).",
      "Pasa si el estado HTTP es el «Estado» esperado, si el body cumple el esquema que el contrato declara para ese estado y si pasan sus «Comprobaciones».",
      "Si pasa, aplica sus «Capturas» y los pasos siguientes pueden usarlas. Si falla, se aplica «Si falla»: por defecto se saltan los que dependen de él.",
    ],
    example:
      'POST /widgets con body {"name": "w-{{$uuid}}"}, Estado 201 y captura widgetId ← body data.id. El siguiente paso GET /widgets/{id} lleva el parámetro id = {{widgetId}}.',
    pitfalls: [
      "Un parámetro de ruta sin valor no se queda vacío: el motor usa un valor de ejemplo (p. ej. /widgets/1). Si el paso trabaja sobre lo que creó otro, pon id = {{variable}}.",
      "«Estado» es lo que esperas, no lo que suele responder: si esperas 404 tras borrar y la API responde 200, el paso falla, y eso es un hallazgo, no un error del flujo.",
      "Para repetir este paso cuando falla, conecta a su salida un nodo Reintento (puede repetir desde un paso anterior), o usa «Si falla → Reintentar» aquí para reenviar solo esta petición. El nodo Sondeo no reintenta fallos: repite un paso que ya pasó.",
      "Si la petición la comparten varios nodos, editarla cambia todos; usa «Hacer independiente este nodo».",
    ],
  },
  login: {
    title: "Login",
    summary: "Una petición que inicia sesión: el token de su respuesta lo presentan los pasos siguientes.",
    how: [
      "Se envía y se juzga igual que una petición.",
      "Si pasa, lee el token de donde indica «Este paso inicia sesión» (body con una ruta, cabecera, cookie o regex).",
      "Los pasos posteriores con Auth «default» envían ese token en la cabecera indicada (Authorization por defecto) con el prefijo (Bearer por defecto), en lugar de la credencial guardada en el entorno.",
    ],
    example:
      'POST /auth/login con body {"user": "{{usuario}}", "password": "{{clave}}"}, token ← body data.token, cabecera Authorization, prefijo «Bearer ».',
    pitfalls: [
      "Los pasos con Auth none, insufficient o api-key no reciben la sesión: existen para comprobar que la API los rechaza.",
      "Si la ruta del token es incorrecta, los pasos siguientes siguen con la credencial del entorno y fallarán con 401.",
    ],
  },
  branch: {
    title: "If (bifurcación)",
    summary: "Lee la respuesta de un paso anterior y parte el flujo en dos salidas: «sí» y «no».",
    how: [
      "Conecta a su entrada el paso cuya respuesta decide.",
      "Evalúa la condición: origen (status, body, header, durationMs), ruta, operador y valor.",
      "Lo conectado a la salida «sí» se ejecuta si se cumple; lo conectado a «no», si no se cumple. La rama no tomada queda «saltada», no en rojo.",
    ],
    example: "Lee «crear», status equals 201 → «sí» continúa con leer y actualizar; «no» notifica a Slack.",
    pitfalls: [
      "Solo puede leer pasos conectados a su entrada.",
      "Una salida sin nada conectado no hace nada: arrastra desde su punto al siguiente nodo.",
      "equals compara como texto: 200 y «200» son lo mismo.",
    ],
  },
  wait: {
    title: "Espera",
    summary: "Pausa el flujo unos milisegundos antes de dejar pasar a lo conectado después.",
    how: ["Espera a que terminen sus pasos de entrada.", "Pausa el tiempo indicado (máximo 60 000 ms) y siempre pasa."],
    example: "Tras DELETE /widgets/{id}, espera 1000 ms para que la API propague el borrado antes de volver a leer.",
    pitfalls: [
      "No es un reintento: si después el paso falla, no se repite. Para eso, «Si falla → Reintentar» en ese paso o un nodo Reintento.",
    ],
  },
  merge: {
    title: "Merge (unión)",
    summary: "Junta varias ramas en una sola salida.",
    how: [
      "Conecta a su entrada las ramas que quieres unir.",
      "Con «Cuando llegan todas» espera a que terminen todas; con «Basta con que llegue una» sigue con la primera.",
      "Lo conectado a su salida se ejecuta después.",
    ],
    example: "Tras un If, une las ramas «sí» y «no» con «Basta con que llegue una» y sigue con el paso de limpieza.",
    pitfalls: [
      "Con ramas alternativas (las dos salidas de un If) solo una se ejecuta: elige «Basta con que llegue una».",
    ],
  },
  validate: {
    title: "Validación",
    summary: "Juzga la respuesta de un paso anterior con comprobaciones y/o un script, sin enviar nada.",
    how: [
      "Conecta a su entrada el paso que quieres validar y elígelo en «Lee el paso».",
      "Evalúa las comprobaciones sobre esa respuesta y, si hay script, lo ejecuta en un proceso aislado con pm.response.",
      "Pasa si pasan todas las comprobaciones y todos los pm.test. Si no, lo que dependa de la validación se salta.",
    ],
    example: "Lee «listar», body data is_not_empty y script pm.test('ordenados', …).",
    pitfalls: ["Sin nada conectado no tiene respuesta que leer y falla."],
  },
  fetch: {
    title: "Fetch",
    summary: "Una petición HTTP escrita a mano, fuera del contrato: cualquier URL, método, cabeceras y body.",
    how: [
      "La URL puede ser absoluta (https://…) o una ruta (/cosas), que cuelga de la URL base del entorno.",
      "Sustituye las {{variables}} en URL, cabeceras y body y envía.",
      "Pasa si el estado es el esperado (vacío = cualquier 2xx) y pasan sus comprobaciones; después aplica capturas.",
    ],
    example: 'POST https://hooks.proveedor.com/ordenes con body {"id": "{{orderId}}"}, estado esperado 202.',
    pitfalls: [
      "No se valida contra el contrato: si necesitas validar su forma, conecta un nodo Esquema con un esquema propio.",
      "«Enviar sesión del login» manda el token a esa URL: úsalo solo con hosts de confianza.",
      "Si el entorno no permite escrituras, POST/PUT/PATCH/DELETE al mismo origen se bloquean.",
    ],
  },
  set: {
    title: "Set (variables)",
    summary: "Escribe variables para los pasos siguientes sin hacer ninguna petición.",
    how: [
      "Para cada fila resuelve la plantilla del valor: {{otra}}, pedido-{{$uuid}}…",
      "Guarda el resultado en la variable, solo durante esta corrida (el entorno guardado no cambia).",
    ],
    example: "email = qa+{{$uuid}}@ejemplo.com, y el paso de registro usa {{email}}.",
    pitfalls: ["Si la plantilla usa una variable que no existe en ese momento, el nodo falla."],
  },
  script: {
    title: "Script",
    summary: "JavaScript en un proceso aislado: lee una respuesta, calcula y escribe variables, comprueba con pm.test.",
    how: [
      "Si eliges «Lee la respuesta de», esa respuesta está en pm.response.",
      "Lee variables con pm.variables.get y escribe con pm.variables.set o pm.environment.set (solo para esta corrida).",
      "Falla si el código lanza un error o si un pm.test falla. console.log queda en el informe con los secretos ocultos.",
    ],
    example: "const body = pm.response.json(); pm.variables.set('total', String(body.data.length));",
    pitfalls: [
      "No tiene red ni ficheros: no puede hacer peticiones (usa un Fetch).",
      "Solo puede leer la respuesta de un paso conectado a su entrada.",
    ],
  },
  retry: {
    title: "Reintento",
    summary: "Si el paso conectado a su entrada falla, vuelve a ejecutar el flujo desde el nodo que elijas hasta ese paso; si se agotan los intentos, el flujo sigue por otra salida.",
    how: [
      "Conecta a su entrada el paso que puede fallar: una petición, un login, un fetch, GraphQL, una validación, un esquema o un script.",
      "Arrastra su salida «reintentar» al nodo desde el que repetir: el mismo paso, o uno anterior (por ejemplo, el que crea lo que el paso lee).",
      "Si el paso pasa, el Reintento no hace nada y el flujo sigue por la salida normal del paso.",
      "Si falla, espera «Espera antes de cada uno», vuelve a ejecutar ese tramo del flujo y mira otra vez el paso, hasta «Reintentos (máx.)» veces. En cuanto pase, el flujo sigue desde el paso.",
      "Si se agotan, el Reintento queda en rojo y se ejecuta lo conectado a «si se agota»; lo que colgaba del paso queda saltado.",
    ],
    example:
      "eliminar → espera 1000 ms → un-widget (GET /widgets/{id}, espera 404) → Reintento: «reintentar» a espera, 3 reintentos; «si se agota» → Notificar al equipo.",
    pitfalls: [
      "Se vuelve a ejecutar todo el tramo: si incluye POST o DELETE, vuelven a escribir en cada reintento.",
      "Lo que cuelga del paso vigilado espera a que el Reintento termine.",
      "El tramo no puede pasar por bucles, sub-flujos, sondeos, otros reintentos ni pasos con «por cada elemento».",
      "Para reenviar solo una petición sin volver atrás, también vale «Si falla → Reintentar» en ese paso.",
    ],
  },
  poll: {
    title: "Sondeo (polling)",
    summary: "Repite la petición de un paso que ya pasó hasta que su respuesta cumpla las comprobaciones de este nodo.",
    how: [
      "Conecta a su entrada una petición o un fetch (sin «por cada elemento» ni login) y elígelo en «Repite el paso».",
      "Primero juzga la respuesta que ese paso ya obtuvo con las «Comprobaciones» de este nodo. Si cumplen, pasa sin reenviar nada.",
      "Si no cumplen, espera «Cada (ms)» y reenvía la petición, hasta «Reenvíos (máx.)» veces. Pasa en cuanto una respuesta cumple; falla si se agotan.",
      "Sus capturas y los nodos conectados después leen la última respuesta.",
    ],
    example:
      "POST /exportaciones responde 202 con estado «pendiente» → Reintento repite GET /exportaciones/{id}, 10 reenvíos cada 2000 ms, con la comprobación body data.estado equals «listo».",
    pitfalls: [
      "El paso que repite tiene que haber PASADO. Si falla (p. ej. esperaba 404 y llegó 200), el Sondeo queda «saltado» y no repite nada. Para repetir un paso que falla, usa el nodo Reintento.",
      "Sin comprobaciones no tiene con qué decidir: añade al menos una.",
      "Si la petición escribe (POST, DELETE…), cada reenvío vuelve a escribir.",
    ],
  },
  loop: {
    title: "Bucle",
    summary: "Recorre una lista de una respuesta y ejecuta un trozo del flujo una vez por elemento.",
    how: [
      "Lee la lista en «Ruta a la lista en el body» de la respuesta del paso elegido.",
      "Por cada elemento (hasta «Máx. vueltas») ejecuta en orden lo conectado a la salida «cada» y todo lo que cuelgue de ello. El elemento está en {{item}} (o el nombre elegido), campo a campo como {{item.id}}.",
      "Cada vuelta deja su propio caso por nodo (#1, #2…). Al acabar todas, sigue por la salida «fin».",
    ],
    example: "Lee «listar» en data, cada elemento = widget → GET /widgets/{id} con id = {{widget.id}}.",
    pitfalls: [
      "Nada conectado a «cada» = el bucle no ejecuta nada.",
      "No se anidan bucles, no hay pausas dentro del cuerpo, ni sub-flujos ni «por cada elemento» dentro.",
      "Si la ruta no apunta a una lista, el nodo falla.",
    ],
  },
  schema: {
    title: "Esquema",
    summary: "Valida el body de la respuesta de un paso contra un JSON Schema.",
    how: [
      "Elige el paso a validar (conectado a la entrada).",
      "«El contrato»: usa el esquema que el OpenAPI declara para esa operación y el código que respondió (solo peticiones y logins). «Un esquema propio»: el JSON Schema escrito en el nodo.",
      "Con «Estricto», también falla si el body trae campos que el esquema no declara.",
    ],
    example: 'Tras un Fetch a un servicio externo: esquema propio {"type": "object", "required": ["data"]}.',
    pitfalls: [
      "Con «El contrato», si el contrato no declara esquema para ese estado, el nodo falla.",
      "Un esquema propio no puede usar «pattern».",
    ],
  },
  notify: {
    title: "Notificar",
    summary: "Envía un mensaje a Slack, Teams o un webhook en mitad del flujo.",
    how: [
      "Lee la URL del webhook de la variable del entorno indicada (se escribe su nombre, no la URL).",
      "Resuelve las {{variables}} del mensaje y lo envía con el formato del canal.",
      "Si el envío falla, deja un aviso en verde, salvo que marques «Fallar el nodo si el mensaje no llega».",
    ],
    example:
      "En la rama «no» de un If: canal Slack, variable SLACK_WEBHOOK_URL, mensaje «Falló crear widget en {{baseUrl}}».",
    pitfalls: [
      "Si la variable no existe en el entorno activo o el mensaje usa una variable indefinida, el nodo falla sin enviar.",
      "Marca la variable del webhook como sensible: en el informe aparece enmascarada.",
    ],
  },
  subflow: {
    title: "Sub-flujo",
    summary: "Ejecuta otro flujo del proyecto como un paso de este.",
    how: [
      "El hijo empieza con una copia de las variables de la corrida más sus «Entradas».",
      "Sus pasos salen en el informe bajo este nodo; el nodo pasa si pasan todos.",
      "Al terminar vuelven solo las variables de «Salidas» (también como id-del-nodo.nombre) y la sesión, si el hijo inicia una.",
    ],
    example: "Sub-flujo «Login admin» sin entradas, salida token; los pasos siguientes ya van autenticados.",
    pitfalls: [
      "Como mucho 3 niveles, no dentro de un bucle, sin ciclos (un flujo que ya ejecuta este) y no archivados.",
      "Si una variable de «Salidas» no aparece en el hijo, el nodo falla.",
    ],
  },
  graphql: {
    title: "GraphQL",
    summary: "Envía una operación GraphQL (query, variables, operationName) como POST JSON.",
    how: [
      "La URL puede ser absoluta o una ruta bajo la URL base del entorno.",
      "Sustituye {{variables}} en URL, query, variables y cabeceras; las variables deben ser un objeto JSON.",
      "Pasa si el estado es el esperado (vacío = 2xx), la respuesta no trae errors (salvo «Admitir errors») y pasan las comprobaciones.",
    ],
    example:
      'query Widget($id: ID!) { widget(id: $id) { id name } } con variables {"id": "{{widgetId}}"} y comprobación body data.widget.id exists.',
    pitfalls: [
      "Un 200 con errors en el body falla: GraphQL informa de errores así.",
      "Las rutas de capturas y comprobaciones empiezan por data.…",
      "No se puede repetir con un nodo Reintento.",
    ],
  },
  mock: {
    title: "Mock (respuesta simulada)",
    summary:
      "No hace ninguna petición: responde lo que escribas, y los nodos siguientes lo leen como una respuesta real.",
    how: [
      "Tras el retardo indicado, produce la respuesta con el estado, las cabeceras y el body escritos (con {{variables}} sustituidas).",
      "Aplica comprobaciones y capturas sobre esa respuesta como si fuera real.",
      "El informe lo marca como simulado.",
    ],
    example:
      'Mientras el servicio de pagos no existe: estado 200, body {"estado": "aprobado", "id": "pago-{{$uuid}}"}.',
    pitfalls: [
      "Una variable que no existe hace fallar el nodo.",
      "Un flujo verde con mocks no prueba la API real: quítalos cuando exista el servicio.",
    ],
  },
  channel: {
    title: "Canal (WebSocket, MQTT o gRPC)",
    summary:
      "Ejecuta un canal del proyecto como un paso del flujo: abre la sesión, manda un guion, espera y la cierra, y la juzga con lo que el canal espera.",
    how: [
      "Abre con el entorno de la corrida: misma guarda de red, mismos topes, misma autenticación y mismos secretos tapados que al pulsar «Conectar».",
      "Manda el guion (enviar, esperar N mensajes, terminar el stream). Sin guion, los mensajes guardados del canal, en orden; en gRPC, la petición de la llamada.",
      "Cierra al recibir los mensajes esperados, cuando el otro lado cierra o cuando salta un tope del canal. El veredicto es el del canal.",
      "Las capturas leen la conversación: last.campo es el último mensaje, messages.0.campo el primero, y una regex busca en todos.",
    ],
    example:
      'Un chat: enviar {"auth": "{{token}}"}, esperar 1 mensaje, enviar {"join": "sala-1"}; el canal espera 2 mensajes y que el último tenga type = "joined". Captura last.sessionId.',
    pitfalls: [
      "Las comprobaciones son las del canal: escríbelas en el canal, no en el nodo.",
      "En un entorno sin escrituras se escucha pero no se manda, y en gRPC solo se invocan métodos sin efectos: el nodo falla diciéndolo.",
      "Sin mensajes esperados, un socket que no cierra dura hasta su tope de inactividad: baja la inactividad en el nodo o pon cuántos mensajes esperar.",
    ],
  },
};
