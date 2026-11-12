"use client";

import { useActionState, useRef, useTransition, type FormEvent, type ReactNode } from "react";
import type { FormState } from "@/lib/server/action";
import { Feedback } from "./Forms";

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

/**
 * Formular für eine Server-Aktion. Die Eingaben bleiben bei einem Fehler stehen (das Formular wird nicht
 * zurückgesetzt); bei Erfolg optional (resetOnOk). Mit `confirm` fragt der Browser vorher nach.
 */
export function ActionForm({ action, children, submit = "Speichern", variant = "primary", className = "form", resetOnOk, confirm }: {
  action: Action;
  children?: ReactNode;
  submit?: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  resetOnOk?: boolean;
  confirm?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      await formAction(fd);
      if (resetOnOk) form.reset();
    });
  };
  return (
    <form ref={ref} onSubmit={onSubmit} className={className}>
      {children}
      <Feedback state={state} />
      <button className={`btn btn-${variant === "danger" ? "secondary danger" : variant}`} type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Bitte warten …" : submit}
      </button>
    </form>
  );
}

/** Kleine Schaltfläche in einer Tabellenzeile (z. B. „Löschen“). */
export function RowAction({ action, fields, label, confirm, danger }: { action: Action; fields: Record<string, string>; label: string; confirm?: string; danger?: boolean }) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);
  const [pending, start] = useTransition();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const fd = new FormData(e.currentTarget);
    start(async () => {
      await formAction(fd);
    });
  };
  return (
    <form onSubmit={onSubmit} className="row-action">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button className={`link-btn${danger ? " danger" : ""}`} type="submit" disabled={pending}>
        {pending ? "…" : label}
      </button>
      {state?.error && <span className="row-err" role="alert">{state.error}</span>}
    </form>
  );
}
