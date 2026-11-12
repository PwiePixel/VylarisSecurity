"use client";

import { useActionState, useState, type ChangeEvent } from "react";
import { useFormStatus } from "react-dom";
import { saveLegalAction, type FormState } from "@/app/admin/actions";
import { legalForms, registerTypes, vatModes, type LegalData } from "@/lib/server/legal-shared";

function Save() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={pending} aria-busy={pending}>
      {pending ? "Wird gespeichert …" : "Änderungen speichern"}
    </button>
  );
}

type TextProps = { label: string; name: keyof LegalData; value: string; hint?: string; max?: number; type?: "text" | "email" | "tel"; autoComplete?: string };

function Text({ label, name, value, hint, max = 200, type = "text", autoComplete }: TextProps) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" name={name} type={type} defaultValue={value} maxLength={max} autoComplete={autoComplete ?? "off"} spellCheck={false} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Area({ label, name, value, hint, max = 600, rows = 4 }: { label: string; name: keyof LegalData; value: string; hint?: string; max?: number; rows?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="input" name={name} defaultValue={value} maxLength={max} rows={rows} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function Check({ name, checked, onChange, children }: { name: string; checked: boolean; onChange?: (v: boolean) => void; children: React.ReactNode }) {
  // Mit onChange gesteuert (blendet Felder ein/aus), sonst einfaches Kontrollkästchen
  return (
    <label className="check">
      {onChange ? (
        <input type="checkbox" name={name} checked={checked} onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)} />
      ) : (
        <input type="checkbox" name={name} defaultChecked={checked} />
      )}
      <span>{children}</span>
    </label>
  );
}

/** Alle Angaben für Impressum und Datenschutz. Wird nach dem Speichern über `key` neu aufgebaut. */
export function LegalForm({ data }: { data: LegalData }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveLegalAction, undefined);
  const [legalForm, setLegalForm] = useState(data.legalForm);
  const [registerEnabled, setRegisterEnabled] = useState(data.registerEnabled);
  const [vatMode, setVatMode] = useState(data.vatMode);
  const [contentResp, setContentResp] = useState(data.contentResponsibleEnabled);
  const [dispute, setDispute] = useState(data.disputeMode);
  const needsRep = legalForms.find((f) => f.value === legalForm)?.needsRepresentative ?? false;

  return (
    <form action={formAction} className="legal-form">
      {/* ---------------------------------------------------------------- Anbieter */}
      <div className="admin-card">
        <fieldset>
          <legend>Anbieter</legend>
          <div className="cols-2">
            <Text label="Markenname" name="brandName" value={data.brandName} max={80} />
            <Text label="Unternehmen / Firma" name="companyName" value={data.companyName} max={120} hint="z. B. CircleUpWilms" />
          </div>
          <div className="cols-2">
            <label className="field">
              <span>Rechtsform</span>
              <select className="input" name="legalForm" value={legalForm} onChange={(e) => setLegalForm(e.target.value as LegalData["legalForm"])}>
                {legalForms.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <Text label="Inhaber / Name des Anbieters" name="ownerName" value={data.ownerName} max={120} autoComplete="name" />
          </div>
          {needsRep && <Text label="Vertretungsberechtigte Person(en)" name="representative" value={data.representative} hint="z. B. Geschäftsführer oder alle Gesellschafter" />}
          {!needsRep && <input type="hidden" name="representative" value="" />}
        </fieldset>
      </div>

      {/* ---------------------------------------------------------------- Anschrift */}
      <div className="admin-card">
        <fieldset>
          <legend>Anschrift</legend>
          <Text label="Straße und Hausnummer" name="street" value={data.street} max={120} autoComplete="street-address" />
          <div className="cols-3">
            <Text label="PLZ" name="zip" value={data.zip} max={12} autoComplete="postal-code" />
            <Text label="Ort" name="city" value={data.city} max={80} autoComplete="address-level2" />
          </div>
          <Text label="Land" name="country" value={data.country} max={60} autoComplete="country-name" />
        </fieldset>
      </div>

      {/* ------------------------------------------------------------------ Kontakt */}
      <div className="admin-card">
        <fieldset>
          <legend>Kontakt</legend>
          <div className="cols-2">
            <Text label="E-Mail-Adresse" name="email" type="email" value={data.email} max={120} autoComplete="email" hint="Pflicht: schnelle elektronische Kontaktaufnahme." />
            <Text label="Telefon (optional)" name="phone" type="tel" value={data.phone} max={40} autoComplete="tel" />
          </div>
          <Check name="showGroupContactPath" checked={data.showGroupContactPath}>
            Zusätzlich auf „Kontakt und Tickets“ der VylarisGroup (vylaris.eu/contact) verweisen
          </Check>
        </fieldset>
      </div>

      {/* ----------------------------------------------------------------- Register */}
      <div className="admin-card">
        <fieldset>
          <legend>Registereintrag</legend>
          <Check name="registerEnabled" checked={registerEnabled} onChange={setRegisterEnabled}>
            Es gibt einen Registereintrag (Angaben erscheinen im Impressum)
          </Check>
          {registerEnabled && (
            <div className="sub-fields">
              <label className="field">
                <span>Register</span>
                <select className="input" name="registerType" defaultValue={data.registerType}>
                  {registerTypes.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="cols-2">
                <Text label="Registergericht" name="registerCourt" value={data.registerCourt} max={120} hint="z. B. Amtsgericht Musterstadt" />
                <Text label="Registernummer" name="registerNumber" value={data.registerNumber} max={40} hint="z. B. HRB 12345" />
              </div>
            </div>
          )}
          {!registerEnabled && (
            <>
              <input type="hidden" name="registerType" value={data.registerType} />
              <input type="hidden" name="registerCourt" value={data.registerCourt} />
              <input type="hidden" name="registerNumber" value={data.registerNumber} />
            </>
          )}
        </fieldset>
      </div>

      {/* ------------------------------------------------------------ Umsatzsteuer */}
      <div className="admin-card">
        <fieldset>
          <legend>Umsatzsteuer</legend>
          <div className="choice" role="radiogroup" aria-label="Umsatzsteuer-Status">
            {vatModes.map((m) => (
              <label className="check" key={m.value}>
                <input type="radio" name="vatMode" value={m.value} checked={vatMode === m.value} onChange={() => setVatMode(m.value)} />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
          {vatMode === "small" && (
            <p className="muted small">
              Im Impressum erscheint: „Kleinunternehmer im Sinne von § 19 UStG. Es wird keine Umsatzsteuer berechnet und ausgewiesen.“ Eine USt-IdNr. wird dann nicht
              angezeigt.
            </p>
          )}
          {vatMode === "regular" && (
            <Text label="Umsatzsteuer-Identifikationsnummer (falls vorhanden)" name="vatId" value={data.vatId} max={20} hint="Format z. B. DE123456789 – erscheint gemäß § 27a UStG im Impressum." />
          )}
          {vatMode !== "regular" && <input type="hidden" name="vatId" value="" />}
        </fieldset>
      </div>

      {/* -------------------------------------------------------- Weitere Pflichten */}
      <div className="admin-card">
        <fieldset>
          <legend>Weitere Angaben im Impressum</legend>
          <Area label="Zuständige Aufsichtsbehörde / berufsrechtliche Angaben (optional)" name="supervisoryAuthority" value={data.supervisoryAuthority} max={400} rows={3} hint="Nur nötig, wenn deine Tätigkeit einer behördlichen Zulassung bedarf." />
          <Check name="contentResponsibleEnabled" checked={contentResp} onChange={setContentResp}>
            Verantwortliche Person für journalistisch-redaktionelle Inhalte angeben (§ 18 Abs. 2 MStV)
          </Check>
          {contentResp && (
            <div className="sub-fields">
              <Text label="Name" name="contentResponsibleName" value={data.contentResponsibleName} max={120} hint="Leer lassen = Inhaber." />
              <Area label="Anschrift" name="contentResponsibleAddress" value={data.contentResponsibleAddress} max={300} rows={3} hint="Leer lassen = Anschrift des Anbieters." />
            </div>
          )}
          {!contentResp && (
            <>
              <input type="hidden" name="contentResponsibleName" value={data.contentResponsibleName} />
              <input type="hidden" name="contentResponsibleAddress" value={data.contentResponsibleAddress} />
            </>
          )}
          <div className="choice" role="radiogroup" aria-label="Verbraucherstreitbeilegung">
            <span className="strong">Verbraucherstreitbeilegung</span>
            {[
              { v: "none", l: "Keinen Hinweis anzeigen" },
              { v: "not_willing", l: "Hinweis anzeigen: nicht bereit und nicht verpflichtet teilzunehmen" },
              { v: "willing", l: "Hinweis anzeigen: bereit teilzunehmen" },
            ].map((o) => (
              <label className="check" key={o.v}>
                <input type="radio" name="disputeMode" value={o.v} checked={dispute === o.v} onChange={() => setDispute(o.v as LegalData["disputeMode"])} />
                <span>{o.l}</span>
              </label>
            ))}
          </div>
          {dispute === "willing" ? (
            <Area label="Zuständige Verbraucherschlichtungsstelle (Name, Anschrift, Website)" name="disputeNote" value={data.disputeNote} max={600} rows={3} />
          ) : (
            <input type="hidden" name="disputeNote" value={data.disputeNote} />
          )}
          <Area label="Weitere Hinweise (optional, erscheinen am Ende des Impressums)" name="extraImpressum" value={data.extraImpressum} max={2000} rows={4} hint="Absätze durch eine Leerzeile trennen. Reiner Text, kein HTML." />
        </fieldset>
      </div>

      {/* -------------------------------------------------------------- Datenschutz */}
      <div className="admin-card">
        <fieldset>
          <legend>Datenschutz</legend>
          <Text
            label="Speicherdauer der Server-Logfiles (Tage)"
            name="logRetentionDays"
            value={data.logRetentionDays}
            max={5}
            hint="Erscheint in der Datenschutzerklärung. Sorge dafür, dass Logs tatsächlich nach dieser Frist gelöscht werden."
          />
          <div className="cols-2">
            <Text label="Datenschutzbeauftragte(r) – Name (optional)" name="dpoName" value={data.dpoName} max={120} />
            <Text label="Datenschutzbeauftragte(r) – E-Mail (optional)" name="dpoEmail" type="email" value={data.dpoEmail} max={120} />
          </div>
          <Area label="Zuständige Datenschutz-Aufsichtsbehörde (optional)" name="privacyAuthority" value={data.privacyAuthority} max={400} rows={3} hint="Name und Anschrift der Landesbehörde, bei der Beschwerden möglich sind." />
          <Area label="Weitere Datenschutz-Hinweise (optional)" name="extraPrivacy" value={data.extraPrivacy} max={3000} rows={5} hint="Absätze durch eine Leerzeile trennen. Reiner Text, kein HTML." />
        </fieldset>
      </div>

      <div className="sticky-save">
        <Save />
        {state?.error && (
          <span className="alert error" role="alert" style={{ margin: 0 }}>
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
