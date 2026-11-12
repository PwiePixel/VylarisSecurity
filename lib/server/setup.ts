/**
 * Freischaltung der Erst-Einrichtung. Der Schlüssel kommt aus ADMIN_SETUP_TOKEN (von ./install.sh admin erzeugt)
 * und gilt nur bis ADMIN_SETUP_EXPIRES (Unix-Sekunden). Ist bereits ein Admin vorhanden, ist die Einrichtung
 * immer gesperrt.
 */
export type SetupState = "ok" | "disabled" | "expired";

export function setupState(now = Date.now()): SetupState {
  const token = process.env.ADMIN_SETUP_TOKEN ?? "";
  if (token.length < 16) return "disabled";
  const exp = Number(process.env.ADMIN_SETUP_EXPIRES ?? "");
  if (Number.isFinite(exp) && exp > 0 && now / 1000 > exp) return "expired";
  return "ok";
}

export const setupToken = () => process.env.ADMIN_SETUP_TOKEN ?? "";
