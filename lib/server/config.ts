import path from "node:path";

/** Ordner für veränderliche Daten (Admin-Zugang, Sitzungen, Status, Protokoll). Im Container: Volume /data. */
export const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? path.join(process.cwd(), ".data"));

/** In Produktion nur über HTTPS gesetzte Cookies. Für lokale Tests per ADMIN_INSECURE_COOKIES=1 abschaltbar. */
export const SECURE_COOKIES = process.env.NODE_ENV === "production" && process.env.ADMIN_INSECURE_COOKIES !== "1";
