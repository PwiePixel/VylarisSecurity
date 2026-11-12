import { readJson, withLock, writeJson } from "./store";
import { defaultLegal, validateLegal, type LegalData } from "./legal-shared";

export * from "./legal-shared";

const FILE = "legal.json";

/** Gespeicherte Angaben, ergänzt um Standardwerte (neue Felder bleiben so immer vorhanden). */
export async function getLegal(): Promise<LegalData> {
  try {
    const stored = await readJson<Partial<LegalData>>(FILE, {});
    return { ...defaultLegal, ...stored };
  } catch {
    return { ...defaultLegal }; // defekte Datei: Standardwerte statt Fehlerseite
  }
}

/** Speichert geprüfte Angaben. Rückgabe: Namen der geänderten Felder (für das Protokoll). */
export async function saveLegal(data: LegalData): Promise<string[]> {
  return withLock(async () => {
    const before = await getLegal();
    const next: LegalData = { ...data, updatedAt: new Date().toISOString() };
    const changed = (Object.keys(defaultLegal) as (keyof LegalData)[]).filter((k) => k !== "updatedAt" && before[k] !== next[k]);
    await writeJson(FILE, next);
    return changed as string[];
  });
}

export { validateLegal };
