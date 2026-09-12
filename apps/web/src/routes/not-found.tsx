import { Link } from "react-router-dom";

/** An address that matches nothing says so, instead of dropping you on the project list as if you
 * had asked for it. */
export function NotFoundPage() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <p className="font-mono text-5xl font-semibold text-slate-200">404</p>
        <p className="mt-3 text-sm font-semibold text-slate-900">Página no encontrada</p>
        <p className="mt-1 text-xs text-slate-500">La dirección que buscas no existe o ya no está aquí.</p>
        <Link
          to="/projects"
          className="mt-5 inline-flex h-9 items-center rounded-lg bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800"
        >
          Ir a proyectos
        </Link>
      </div>
    </div>
  );
}
