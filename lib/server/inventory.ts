import { defaultInventory, sanitizeInventory, type Inventory } from "@/lib/core/inventory-model";
import { FILES } from "@/lib/core/runtime-model";
import { readJson, withLock, writeJson } from "./store";

/** Server und IP-Verwaltung (inventory.json). Defekte Dateien führen nie zu Fehlern beim Lesen. */
export async function getInventory(): Promise<Inventory> {
  try {
    return sanitizeInventory(await readJson<unknown>(FILES.inventory, defaultInventory()));
  } catch {
    return defaultInventory();
  }
}

/**
 * Ändert das Inventar atomar und seriell. Die Funktion bekommt eine Kopie und gibt entweder das neue Inventar
 * oder { error } zurück; bei Fehler wird nichts gespeichert.
 */
export function mutateInventory(fn: (inv: Inventory) => Promise<Inventory | { error: string }> | Inventory | { error: string }): Promise<{ error: string } | { ok: true; inventory: Inventory }> {
  return withLock(async () => {
    const current = await getInventory();
    const next = await fn(structuredClone(current));
    if ("error" in next) return { error: next.error };
    const clean = sanitizeInventory(next); // nie etwas Ungültiges speichern
    clean.updatedAt = new Date().toISOString();
    await writeJson(FILES.inventory, clean);
    return { ok: true as const, inventory: clean };
  });
}
