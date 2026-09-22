// Package config lee el entorno una vez y se niega a arrancar sin lo que no puede inventarse.
//
// Los nombres de las variables son los mismos que los de la API de NestJS a propósito: los tres
// backends se levantan con el mismo `.env` y la única diferencia es el puerto. Un segundo juego de
// nombres sería la forma más segura de firmar con claves distintas y enterarse el día que una
// sesión abierta en un backend no valga en otro.
package config

import (
	"errors"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type Settings struct {
	Port                  string
	DatabaseURL           string
	JWTAccessSecret       []byte
	JWTRefreshSecret      []byte
	AccessTokenTTLSeconds int
	RefreshTokenTTLDays   int
	CORSOrigins           []string
	CookieDomain          string
	Production            bool
	AppURL                string
}

var durationPattern = regexp.MustCompile(`^(\d+)([smhd])?$`)

// ParseDuration entiende `15m`, `2h` y `900`. Un valor que no se entiende son 900 segundos, como
// en `parseDuration` de Nest — y no cero, que acuñaría tokens sin caducidad en silencio.
func ParseDuration(value string) int {
	match := durationPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 900
	}
	amount, err := strconv.Atoi(match[1])
	if err != nil {
		return 900
	}
	unit := match[2]
	if unit == "" {
		unit = "s"
	}
	return amount * map[string]int{"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func Load() (Settings, error) {
	access := os.Getenv("JWT_ACCESS_SECRET")
	refresh := os.Getenv("JWT_REFRESH_SECRET")
	if access == "" || refresh == "" {
		return Settings{}, errors.New("JWT_ACCESS_SECRET y JWT_REFRESH_SECRET son obligatorias: la API no arranca sin ellas")
	}

	days, err := strconv.Atoi(env("REFRESH_TOKEN_TTL_DAYS", "30"))
	if err != nil {
		days = 30
	}

	origins := []string{}
	for _, origin := range strings.Split(env("CORS_ORIGINS", "http://localhost:8080,http://localhost:5173"), ",") {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}

	return Settings{
		// Puerto propio: los tres corren a la vez contra la misma base, que es lo que hace que el
		// selector del front pueda cambiar de uno a otro sin apagar nada.
		Port:                  env("PORT_GO", "3003"),
		DatabaseURL:           env("DATABASE_URL", "postgres://eq:eq@localhost:5432/endpoint_quality"),
		JWTAccessSecret:       []byte(access),
		JWTRefreshSecret:      []byte(refresh),
		AccessTokenTTLSeconds: ParseDuration(env("ACCESS_TOKEN_TTL", "15m")),
		RefreshTokenTTLDays:   days,
		CORSOrigins:           origins,
		CookieDomain:          os.Getenv("COOKIE_DOMAIN"),
		Production:            env("NODE_ENV", "development") == "production",
		AppURL:                env("APP_URL", "http://localhost:5173"),
	}, nil
}
