import { Controller, Get } from "@nestjs/common";
import { Public } from "@/modules/auth/infrastructure/guards/auth.guard";
import { NODE_BACKEND, type BackendDescriptor } from "./backend-descriptor";

/**
 * Quién está contestando.
 *
 * Pública y sin base de datos a propósito: el front la pide **antes** de tener sesión, cuando
 * todavía está decidiendo a qué backend conectarse, y una ruta que necesitara credencial para
 * decir su nombre haría imposible elegir. `GET /health` sigue siendo la sonda; esta es la
 * identidad.
 */
@Controller("backend")
export class BackendController {
  @Public()
  @Get()
  describe(): BackendDescriptor {
    return NODE_BACKEND;
  }
}
