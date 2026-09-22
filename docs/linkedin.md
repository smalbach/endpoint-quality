# Para enseñarlo en LinkedIn

Qué contar, con qué enseñarlo y por qué esto se sostiene mejor que «he reescrito un backend en
otro lenguaje».

---

## El gancho

**Tres backends. Un contrato. Una prueba que dice cuánto se parecen.**

Lo que hace que esto valga la pena contar no es que haya una API en Python y otra en Go: es que
las tres corren **a la vez, contra la misma base de datos**, y que el front deja elegir con cuál
hablar antes de entrar. Entras por Node, cambias a Go sin recargar la sesión, y sigues dentro.

Eso último no se puede fingir con una demo. Para que una sesión abierta en un backend siga viva en
otro tienen que coincidir, byte a byte:

- el KDF de la contraseña (scrypt, N=2¹⁷, r=8, p=1, y el digest con el mismo formato);
- el hash del token de refresco (SHA-256 **en base64**, no en hexadecimal);
- la firma del token de acceso (HS256, mismos claims, mismo secreto);
- y hasta cómo se escriben las columnas en SQL (`"camelCase"` entrecomillado, porque las creó
  TypeORM y Postgres pliega a minúsculas lo que no lleva comillas).

Si una sola de esas cuatro se desvía, la sesión no entra. No hay margen para el «más o menos».

## El texto, listo para publicar

> Llevo un tiempo con **Endpoint Quality**, un producto que verifica contratos HTTP: importa un
> OpenAPI, genera la matriz de casos que ese contrato declara y afirma sobre la respuesta real —
> schema, envelope, presupuesto de latencia, autorización y persistencia. La idea de fondo cabe en
> una frase: **un 200 no es un test que pasa**.
>
> Esta semana le he añadido algo que me apetecía probar: la API dejó de ser _la_ API.
>
> Ahora hay tres implementaciones del mismo contrato — NestJS, FastAPI y Go — corriendo a la vez
> contra el mismo Postgres, y el front tiene un selector para elegir con cuál hablar. Cambias de
> backend y la sesión sigue abierta: mismo esquema, mismos secretos, mismo formato de hash hasta el
> último byte.
>
> Lo interesante no fue escribir el código. Fue descubrir **dónde estaba el contrato de verdad**:
>
> · Un `422` con `errors[].field` no era un detalle del ValidationPipe de Nest: el formulario del
> front pinta ese texto debajo del input. Pydantic validaba igual de bien y decía otra cosa —
> mismo código de estado, otro producto.
> · Las columnas en `camelCase` entrecomilladas no eran un capricho del ORM: un backend que asuma
> `snake_case` compila perfectamente y falla en la primera consulta.
> · La sonda de salud contesta 200 aunque la base esté caída, con el veredicto en el cuerpo. No es
> lo que yo elegiría de cero, pero es lo que hace el original — y en paridad manda el original.
>
> Para no discutir de memoria escribí un guion de conformidad: corre la misma conversación HTTP
> contra los tres, normaliza lo que cambia entre corridas (ids, tokens, fechas) y compara el resto
> contra la implementación de referencia. **51 casos × 3 backends, 0 divergencias.** Un módulo está
> portado cuando su bloque pasa ahí, no cuando yo lo digo.
>
> De regalo, el guion encontró un fallo en la implementación original: un identificador mal escrito
> en la URL sale como error interno en vez de como «no existe», porque Postgres rechaza el valor
> antes de que nadie decida nada. Los tres backends lo reproducen igual — lo cual, siendo estrictos,
> es una buena noticia sobre la paridad y una mala sobre el original.
>
> El objetivo declarado es la paridad total de las 221 rutas. Hoy están `auth`, `iam` y el CRUD de
> `projects`. El resto va por módulos, y el guion dice en cada momento cuánto falta.
>
> #backend #arquitectura #golang #python #typescript #testing #apis

## Qué enseñar

Tres capturas o un GIF de veinte segundos, en este orden:

1. **La pantalla de acceso con el selector.** Los tres backends, cada uno con su runtime leído de
   `/backend` y su punto verde. Se ve que la elección se hace _antes_ de entrar.
2. **El cambio en caliente.** Cabecera → selector → Go. La página recarga y sigues dentro, con los
   mismos proyectos. Esta es la que convence.
3. **La salida del guion de conformidad.** `node tools/conformance/run.mjs` con las tres columnas
   en verde y la línea final. Es la que separa esto de una demo.

Si solo cabe una: la tercera. Un selector bonito lo tiene cualquiera; una prueba que compara tres
implementaciones contra una referencia, no.

## Lo que no hay que decir

- **«Reescrito en Go».** No lo está: están portados tres módulos de veinte. El descriptor de cada
  backend lo dice y el front lo enseña — decir otra cosa es lo único que puede convertir esto en
  una mentira comprobable en treinta segundos por cualquiera que abra el repo.
- **«Más rápido que».** No hay medición, y la comparación honesta necesitaría igualar el trabajo
  que hace cada uno. Cuando estén portadas las corridas, habrá algo que medir y será otra
  publicación.
- **«Arquitectura hexagonal» y demás vocabulario.** El resultado es más interesante que su
  etiqueta: cuenta que la sesión sobrevive al cambio de backend y deja que quien lea saque la
  conclusión.

## Si alguien pregunta «¿y para qué?»

Tres respuestas verdaderas, por orden de honestidad:

1. **Para que el contrato exista fuera de una implementación.** Mientras hay un solo backend, el
   contrato es «lo que hace el código». Con tres, tiene que estar escrito y probado, y eso vuelve
   al producto: es exactamente lo que este producto le exige a las APIs que analiza.
2. **Para poder cambiar de tecnología sin cambiar de producto.** Es la misma propiedad que se pide
   en una migración real, hecha en pequeño y verificada.
3. **Porque obliga a leerse el propio código con otros ojos.** Cada detalle que se había dado por
   supuesto aparece cuando hay que reproducirlo en un lenguaje que no comparte ninguna biblioteca.
