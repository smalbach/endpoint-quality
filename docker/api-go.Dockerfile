# syntax=docker/dockerfile:1
#
# La API en Go, una de las tres implementaciones del mismo contrato.
#
# **No aplica migraciones**: el esquema es de `apps/api` y solo de él. Ver
# `docs/backends-poliglotas.md` §2.
FROM golang:1.24-alpine AS build
WORKDIR /src

# Los manifiestos primero: la capa de dependencias sobrevive a cualquier cambio de código.
COPY apps/api-go/go.mod apps/api-go/go.sum ./
RUN go mod download

COPY apps/api-go/ ./
# Estático y sin información de depuración: la imagen final no lleva ni libc ni el compilador, y
# un binario de 8 MB en `scratch` es una superficie de ataque que se puede enumerar entera.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/eq-api .

FROM alpine:3.21 AS runtime
WORKDIR /app
# Las raíces de certificación, para cuando este backend tenga que hablar con algo por TLS.
RUN apk add --no-cache ca-certificates \
 && adduser -S -u 10001 eq

COPY --from=build /out/eq-api /app/eq-api

USER eq
EXPOSE 3003
CMD ["/app/eq-api"]
