/**
 * Rechtliche Angaben für Impressum und Datenschutz – Typen, Auswahllisten, Prüfregeln und Vollständigkeitsprüfung.
 * Ohne Server-Abhängigkeiten, damit die Admin-Formulare (Client) und die Tests sie nutzen können.
 */

export const legalForms = [
  { value: "einzelunternehmen", label: "Einzelunternehmen", needsRepresentative: false },
  { value: "freiberufler", label: "Freiberufler", needsRepresentative: false },
  { value: "ek", label: "Eingetragener Kaufmann (e. K.)", needsRepresentative: false },
  { value: "gbr", label: "Gesellschaft bürgerlichen Rechts (GbR)", needsRepresentative: true },
  { value: "ohg", label: "Offene Handelsgesellschaft (OHG)", needsRepresentative: true },
  { value: "kg", label: "Kommanditgesellschaft (KG)", needsRepresentative: true },
  { value: "ug", label: "Unternehmergesellschaft (UG haftungsbeschränkt)", needsRepresentative: true },
  { value: "gmbh", label: "Gesellschaft mit beschränkter Haftung (GmbH)", needsRepresentative: true },
  { value: "ag", label: "Aktiengesellschaft (AG)", needsRepresentative: true },
  { value: "ev", label: "Eingetragener Verein (e. V.)", needsRepresentative: true },
  { value: "other", label: "Andere Rechtsform", needsRepresentative: true },
] as const;
export type LegalFormValue = (typeof legalForms)[number]["value"];

export const registerTypes = [
  { value: "handelsregister", label: "Handelsregister" },
  { value: "vereinsregister", label: "Vereinsregister" },
  { value: "genossenschaftsregister", label: "Genossenschaftsregister" },
  { value: "partnerschaftsregister", label: "Partnerschaftsregister" },
] as const;
export type RegisterTypeValue = (typeof registerTypes)[number]["value"];

/** unset = noch nicht festgelegt, small = Kleinunternehmerregelung (§ 19 UStG), regular = Regelbesteuerung */
export const vatModes = [
  { value: "unset", label: "Noch nicht festgelegt" },
  { value: "small", label: "Kleinunternehmerregelung (§ 19 UStG) – keine Umsatzsteuer" },
  { value: "regular", label: "Regelbesteuerung (Umsatzsteuer wird ausgewiesen)" },
] as const;
export type VatModeValue = (typeof vatModes)[number]["value"];

export type LegalData = {
  /** Anbieter */
  brandName: string;
  companyName: string;
  legalForm: LegalFormValue;
  ownerName: string;
  representative: string;
  /** Anschrift */
  street: string;
  zip: string;
  city: string;
  country: string;
  /** Kontakt */
  email: string;
  phone: string;
  showGroupContactPath: boolean;
  /** Registereintrag (ein-/ausschaltbar) */
  registerEnabled: boolean;
  registerType: RegisterTypeValue;
  registerCourt: string;
  registerNumber: string;
  /** Umsatzsteuer */
  vatMode: VatModeValue;
  vatId: string;
  /** Aufsichtsbehörde, Berufsrecht */
  supervisoryAuthority: string;
  /** Verantwortlich für Inhalte (§ 18 Abs. 2 MStV) */
  contentResponsibleEnabled: boolean;
  contentResponsibleName: string;
  contentResponsibleAddress: string;
  /** Verbraucherstreitbeilegung */
  disputeMode: "none" | "not_willing" | "willing";
  disputeNote: string;
  /** Datenschutz */
  logRetentionDays: string;
  dpoName: string;
  dpoEmail: string;
  privacyAuthority: string;
  /** Freitext */
  extraImpressum: string;
  extraPrivacy: string;
  updatedAt?: string;
};

export const defaultLegal: LegalData = {
  brandName: "VylarisSecurity",
  companyName: "CircleUpWilms",
  legalForm: "einzelunternehmen",
  ownerName: "Lucas Wilms",
  representative: "",
  street: "",
  zip: "",
  city: "",
  country: "Deutschland",
  email: "",
  phone: "",
  showGroupContactPath: true,
  registerEnabled: false,
  registerType: "handelsregister",
  registerCourt: "",
  registerNumber: "",
  vatMode: "unset",
  vatId: "",
  supervisoryAuthority: "",
  contentResponsibleEnabled: false,
  contentResponsibleName: "",
  contentResponsibleAddress: "",
  disputeMode: "none",
  disputeNote: "",
  logRetentionDays: "",
  dpoName: "",
  dpoEmail: "",
  privacyAuthority: "",
  extraImpressum: "",
  extraPrivacy: "",
};

/* ------------------------------------------------------------------ Prüfung */
const oneOf = <T extends string>(list: readonly { value: T }[], v: string, fallback: T): T =>
  list.some((x) => x.value === v) ? (v as T) : fallback;

const clean = (v: unknown, max: number): string =>
  String(v ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // Steuerzeichen entfernen (Zeilenumbruch bleibt)
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);

const oneLine = (v: unknown, max = 200) => clean(v, max).replace(/\s*\n+\s*/g, " ");

export type LegalInput = Partial<Record<keyof LegalData, string>> & Record<string, string | undefined>;

export type ValidationResult = { ok: true; data: LegalData } | { ok: false; errors: string[] };

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const PHONE_RE = /^[+()\d][\d\s()./+-]{4,30}$/;
const VAT_RE = /^[A-Z]{2}[A-Z0-9]{2,12}$/;

/** Prüft und bereinigt Formulareingaben. `raw` enthält die Werte als Text (Schalter als "on"/"1"/"true"). */
export function validateLegal(raw: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  const on = (k: string) => ["on", "1", "true"].includes(String(raw[k] ?? "").toLowerCase());
  const d: LegalData = {
    brandName: oneLine(raw.brandName, 80),
    companyName: oneLine(raw.companyName, 120),
    legalForm: oneOf(legalForms, String(raw.legalForm ?? ""), "einzelunternehmen"),
    ownerName: oneLine(raw.ownerName, 120),
    representative: oneLine(raw.representative, 200),
    street: oneLine(raw.street, 120),
    zip: oneLine(raw.zip, 12),
    city: oneLine(raw.city, 80),
    country: oneLine(raw.country, 60),
    email: oneLine(raw.email, 120),
    phone: oneLine(raw.phone, 40),
    showGroupContactPath: on("showGroupContactPath"),
    registerEnabled: on("registerEnabled"),
    registerType: oneOf(registerTypes, String(raw.registerType ?? ""), "handelsregister"),
    registerCourt: oneLine(raw.registerCourt, 120),
    registerNumber: oneLine(raw.registerNumber, 40),
    vatMode: oneOf(vatModes, String(raw.vatMode ?? ""), "unset"),
    vatId: oneLine(raw.vatId, 20).replace(/\s+/g, "").toUpperCase(),
    supervisoryAuthority: clean(raw.supervisoryAuthority, 400),
    contentResponsibleEnabled: on("contentResponsibleEnabled"),
    contentResponsibleName: oneLine(raw.contentResponsibleName, 120),
    contentResponsibleAddress: clean(raw.contentResponsibleAddress, 300),
    disputeMode: (["none", "not_willing", "willing"] as const).includes(String(raw.disputeMode) as never)
      ? (String(raw.disputeMode) as LegalData["disputeMode"])
      : "none",
    disputeNote: clean(raw.disputeNote, 600),
    logRetentionDays: oneLine(raw.logRetentionDays, 5),
    dpoName: oneLine(raw.dpoName, 120),
    dpoEmail: oneLine(raw.dpoEmail, 120),
    privacyAuthority: clean(raw.privacyAuthority, 400),
    extraImpressum: clean(raw.extraImpressum, 2000),
    extraPrivacy: clean(raw.extraPrivacy, 3000),
  };

  if (d.email && !EMAIL_RE.test(d.email)) errors.push("Die E-Mail-Adresse sieht nicht gültig aus.");
  if (d.dpoEmail && !EMAIL_RE.test(d.dpoEmail)) errors.push("Die E-Mail-Adresse des Datenschutzbeauftragten sieht nicht gültig aus.");
  if (d.phone && !PHONE_RE.test(d.phone)) errors.push("Die Telefonnummer enthält ungültige Zeichen (erlaubt: Ziffern, Leerzeichen, + ( ) / . -).");
  if (d.vatId && !VAT_RE.test(d.vatId)) errors.push("Die USt-IdNr. ist ungültig (Format z. B. DE123456789).");
  if (d.logRetentionDays && !/^\d{1,4}$/.test(d.logRetentionDays)) errors.push("Die Speicherdauer der Logfiles muss eine ganze Zahl in Tagen sein.");
  if (d.logRetentionDays && (Number(d.logRetentionDays) < 1 || Number(d.logRetentionDays) > 3650)) errors.push("Die Speicherdauer der Logfiles muss zwischen 1 und 3650 Tagen liegen.");
  if (d.vatMode !== "regular") d.vatId = ""; // USt-IdNr. nur bei Regelbesteuerung speichern
  return errors.length ? { ok: false, errors } : { ok: true, data: d };
}

/* ------------------------------------------------------- Vollständigkeitsprüfung */
export type Gap = { field: string; label: string; area: "impressum" | "datenschutz" };

/** Liefert die Pflichtangaben, die noch fehlen (Hinweis auf offensichtliche Lücken). */
export function legalGaps(d: LegalData): Gap[] {
  const g: Gap[] = [];
  const need = (ok: boolean, field: string, label: string, area: Gap["area"] = "impressum") => {
    if (!ok) g.push({ field, label, area });
  };
  need(!!d.ownerName, "ownerName", "Name des Anbieters / Inhabers");
  need(!!d.street && !!d.zip && !!d.city, "street", "Anschrift (Straße, PLZ, Ort)");
  need(!!d.email, "email", "E-Mail-Adresse (schnelle elektronische Kontaktaufnahme)");
  const form = legalForms.find((f) => f.value === d.legalForm);
  need(!form?.needsRepresentative || !!d.representative, "representative", "Vertretungsberechtigte Person(en)");
  need(!d.registerEnabled || (!!d.registerCourt && !!d.registerNumber), "registerCourt", "Registergericht und Registernummer");
  need(d.vatMode !== "unset", "vatMode", "Umsatzsteuer-Status (Kleinunternehmerregelung oder Regelbesteuerung)");
  need(!d.contentResponsibleEnabled || !!d.contentResponsibleName, "contentResponsibleName", "Name der inhaltlich verantwortlichen Person");
  need(!!d.logRetentionDays, "logRetentionDays", "Speicherdauer der Server-Logfiles", "datenschutz");
  return g;
}
