import { PASSWORD_RULES } from "@/lib/password-rules";
import { cn } from "@/lib/format";

/** The rules ticked off while typing, so nobody finds them out one 422 at a time. */
export function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" aria-label="Requisitos de la contraseña">
      {PASSWORD_RULES.map((rule) => {
        const holds = rule.holds(password);
        return (
          <li
            key={rule.label}
            className={cn("flex items-center gap-1.5", holds ? "text-emerald-700" : "text-slate-400")}
          >
            <span
              className={cn(
                "grid size-3.5 place-items-center rounded-full text-[8px] font-bold text-white",
                holds ? "bg-emerald-500" : "bg-slate-200",
              )}
            >
              {holds ? "✓" : ""}
            </span>
            {rule.label}
          </li>
        );
      })}
    </ul>
  );
}
