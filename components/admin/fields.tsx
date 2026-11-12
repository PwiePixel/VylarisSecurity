import type { ReactNode } from "react";

/* Schlichte Formularfelder (ohne Zustand, in Server- und Client-Komponenten nutzbar). */

type Common = { label: string; name: string; hint?: string; required?: boolean; defaultValue?: string | number; placeholder?: string };

export function Field({ label, name, hint, required = false, defaultValue, placeholder, type = "text", mono, maxLength = 253, inputMode }: Common & { type?: string; mono?: boolean; maxLength?: number; inputMode?: "numeric" | "text" }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className={`input${mono ? " mono" : ""}`} name={name} type={type} defaultValue={defaultValue} placeholder={placeholder} required={required} maxLength={maxLength} inputMode={inputMode} spellCheck={false} autoCapitalize="none" autoComplete="off" />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Area({ label, name, hint, defaultValue, placeholder, rows = 3 }: Common & { rows?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="input mono" name={name} defaultValue={defaultValue} placeholder={placeholder} rows={rows} spellCheck={false} autoCapitalize="none" />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Pick({ label, name, hint, defaultValue, options, required }: Omit<Common, "placeholder"> & { options: readonly { value: string; label: string }[] }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="input" name={name} defaultValue={defaultValue} required={required}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Check({ label, name, defaultChecked, hint }: { label: ReactNode; name: string; defaultChecked?: boolean; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>
        {label}
        {hint && <small className="block muted">{hint}</small>}
      </span>
    </label>
  );
}

export const Hidden = ({ name, value }: { name: string; value: string }) => <input type="hidden" name={name} value={value} />;
