# syntax=docker/dockerfile:1
#
# El destino de la demostración. Sin build y sin dependencias: es un fichero de Node y nada más,
# que es justo lo que lo hace un ejemplo legible en vez de otro proyecto que estudiar.
FROM node:24-alpine
WORKDIR /app
RUN addgroup -S eq && adduser -S eq -G eq
COPY --chown=eq:eq examples/sample-api/server.mjs ./
USER eq
EXPOSE 9000
CMD ["node", "server.mjs"]
