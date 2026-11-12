"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import {
  changePasswordAction,
  codeAction,
  disableTotpAction,
  enableTotpAction,
  loginAction,
  logoutAction,
  regenerateRecoveryAction,
  setupAction,
  startTotpAction,
  type FormState,
} from "@/app/admin/actions";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

export function Submit({ children, variant = "primary" }: { children: ReactNode; variant?: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <button className={`btn btn-${variant}`} type="submit" disabled={pending} aria-busy={pending}>
      {pending ? "Bitte warten …" : children}
    </button>
  );
}

export function Feedback({ state }: { state: FormState }) {
  if (!state) return null;
  return (
    <>
      {state.error && (
        <p className="alert error" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="alert ok" role="status">
          {state.ok}
        </p>
      )}
      {state.codes && (
        <div className="codes">
          <p>Wiederherstellungscodes (jeder nur einmal verwendbar):</p>
          <ul>
            {state.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

type FieldProps = {
  label: string;
  name: string;
  type?: "text" | "password";
  autoComplete?: string;
  hint?: string;
  inputMode?: "numeric" | "text";
  maxLength?: number;
  defaultValue?: string;
  required?: boolean;
  autoFocus?: boolean;
};

function Field({ label, name, type = "text", autoComplete, hint, inputMode, maxLength, defaultValue, required = true, autoFocus }: FieldProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        name={name}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        defaultValue={defaultValue}
        required={required}
        autoFocus={autoFocus}
        spellCheck={false}
        autoCapitalize="none"
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function useForm(action: Action) {
  return useActionState<FormState, FormData>(action, undefined);
}

export function LoginForm() {
  const [state, formAction] = useForm(loginAction);
  return (
    <form action={formAction} className="form" noValidate={false}>
      <Field label="Benutzername" name="username" autoComplete="username" maxLength={64} defaultValue={state?.fields?.username} autoFocus />
      <Field label="Passwort" name="password" type="password" autoComplete="current-password" maxLength={256} />
      <Feedback state={state} />
      <Submit>Anmelden</Submit>
    </form>
  );
}

export function CodeForm() {
  const [state, formAction] = useForm(codeAction);
  return (
    <form action={formAction} className="form">
      <Field
        label="Code aus der Authenticator-App"
        name="code"
        autoComplete="one-time-code"
        inputMode="text"
        maxLength={32}
        hint="6-stelliger Code – oder ein Wiederherstellungscode (XXXX-XXXX-XXXX)."
        autoFocus
      />
      <Feedback state={state} />
      <Submit>Bestätigen</Submit>
    </form>
  );
}

export function SetupForm() {
  const [state, formAction] = useForm(setupAction);
  return (
    <form action={formAction} className="form">
      <Field label="Einrichtungs-Schlüssel" name="token" type="password" autoComplete="off" maxLength={128} hint="Den Schlüssel zeigt dir ./install.sh admin auf dem Server." autoFocus />
      <Field label="Benutzername" name="username" autoComplete="username" maxLength={32} defaultValue={state?.fields?.username} hint="3–32 Zeichen: Kleinbuchstaben, Zahlen, Punkt, Unterstrich, Bindestrich." />
      <Field label="Passwort" name="password" type="password" autoComplete="new-password" maxLength={128} hint="Mindestens 14 Zeichen mit Groß-/Kleinbuchstaben und Zahlen/Sonderzeichen – oder eine Passphrase ab 20 Zeichen." />
      <Field label="Passwort wiederholen" name="password2" type="password" autoComplete="new-password" maxLength={128} />
      <Feedback state={state} />
      <Submit>Admin-Zugang einrichten</Submit>
    </form>
  );
}

export function PasswordForm() {
  const [state, formAction] = useForm(changePasswordAction);
  return (
    <form action={formAction} className="form">
      <Field label="Aktuelles Passwort" name="current" type="password" autoComplete="current-password" maxLength={256} />
      <Field label="Neues Passwort" name="next" type="password" autoComplete="new-password" maxLength={128} />
      <Field label="Neues Passwort wiederholen" name="next2" type="password" autoComplete="new-password" maxLength={128} />
      <Feedback state={state} />
      <Submit>Passwort ändern</Submit>
    </form>
  );
}

export function StartTotpForm() {
  const [state, formAction] = useForm(startTotpAction);
  return (
    <form action={formAction} className="form">
      <Field label="Aktuelles Passwort" name="current" type="password" autoComplete="current-password" maxLength={256} hint="Zur Sicherheit bestätigst du die Einrichtung mit deinem Passwort." />
      <Feedback state={state} />
      <Submit>Einrichtung starten</Submit>
    </form>
  );
}

/**
 * Einrichtung der Zwei-Faktor-Anmeldung. Bleibt auch nach dem Aktivieren eingebunden, damit die einmal
 * angezeigten Wiederherstellungscodes nicht verschwinden, wenn die Seite wegen der neuen Sitzung neu lädt.
 */
export function TotpEnrollment({ secret, uri, enabled }: { secret: string; uri: string; enabled: boolean }) {
  const [state, formAction] = useForm(enableTotpAction);
  if (state?.codes) {
    return (
      <div className="form">
        <Feedback state={state} />
      </div>
    );
  }
  if (enabled) return null;
  return (
    <>
      <ol className="admin-steps">
        <li>Authenticator-App öffnen und ein neues Konto hinzufügen („Schlüssel manuell eingeben“).</li>
        <li>
          Diesen Schlüssel eintragen (Zeitbasiert, 6 Stellen, 30 Sekunden):
          <code className="secret">{secret.match(/.{1,4}/g)?.join(" ")}</code>
        </li>
        <li>
          Alternativ in Apps, die es unterstützen, diesen Link verwenden:
          <code className="secret small">{uri}</code>
        </li>
        <li>Den angezeigten 6-stelligen Code unten zur Bestätigung eingeben.</li>
      </ol>
      <form action={formAction} className="form">
        <Field label="Aktuelles Passwort" name="current" type="password" autoComplete="current-password" maxLength={256} />
        <Field label="Code aus der App" name="code" autoComplete="one-time-code" inputMode="numeric" maxLength={8} hint="Zur Bestätigung den aktuellen 6-stelligen Code eingeben." />
        <Feedback state={state} />
        <Submit>Zwei-Faktor aktivieren</Submit>
      </form>
    </>
  );
}

export function DisableTotpForm() {
  const [state, formAction] = useForm(disableTotpAction);
  return (
    <form action={formAction} className="form">
      <Field label="Aktuelles Passwort" name="current" type="password" autoComplete="current-password" maxLength={256} />
      <Feedback state={state} />
      <Submit variant="secondary">Zwei-Faktor deaktivieren</Submit>
    </form>
  );
}

export function RecoveryForm() {
  const [state, formAction] = useForm(regenerateRecoveryAction);
  return (
    <form action={formAction} className="form">
      <Field label="Aktuelles Passwort" name="current" type="password" autoComplete="current-password" maxLength={256} />
      <Feedback state={state} />
      <Submit variant="secondary">Neue Wiederherstellungscodes erzeugen</Submit>
    </form>
  );
}

export function LogoutForm() {
  return (
    <form action={logoutAction}>
      <Submit variant="secondary">Abmelden</Submit>
    </form>
  );
}

