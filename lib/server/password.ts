import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Passwort-Hashing mit scrypt (Teil von Node.js, keine Fremdbibliothek).
 * Format: scrypt$<log2 N>$<r>$<p>$<Salz base64>$<Hash base64>
 */
const LOG_N = 16; // N = 65536 (~150 ms, 64 MiB Speicher je Prüfung)
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, 2 ** LOG_N, R, P);
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

let dummyHash: Promise<string> | null = null;

/**
 * Prüft ein Passwort. Ohne gespeicherten Hash (unbekannter Benutzer) wird gegen einen Dummy-Hash
 * gerechnet, damit die Antwortzeit nicht verrät, ob es den Benutzer gibt.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword(randomBytes(12).toString("hex"));
    await verifyPassword(password, await dummyHash);
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 14 || logN > 17 || !Number.isInteger(r) || !Number.isInteger(p) || r < 1 || r > 8 || p < 1 || p > 2) {
    return false;
  }
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length < 8 || expected.length !== KEYLEN) return false;
  const actual = await derive(password, salt, 2 ** logN, r, p);
  return timingSafeEqual(actual, expected);
}

const COMMON_PARTS = [
  "password", "passwort", "qwertz", "qwerty", "123456", "abcdef", "admin", "welcome", "willkommen", "changeme",
  "letmein", "vylaris", "cloudflare", "iloveyou", "master", "login", "geheim",
];

/** Liefert eine Fehlermeldung oder null, wenn das Passwort den Anforderungen genügt. */
export function validateNewPassword(password: string, username: string): string | null {
  if (password.length < 14) return "Das Passwort muss mindestens 14 Zeichen lang sein.";
  if (password.length > 128) return "Das Passwort darf höchstens 128 Zeichen lang sein.";
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) return "Das Passwort darf den Benutzernamen nicht enthalten.";
  if (COMMON_PARTS.some((c) => lower.includes(c)) || /^(.)\1+$/.test(password)) return "Dieses Passwort ist zu einfach. Bitte etwas Längeres und Ungewöhnliches wählen.";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length < 20 && classes < 3) return "Bitte Groß- und Kleinbuchstaben, Zahlen oder Sonderzeichen mischen – oder eine Passphrase mit mindestens 20 Zeichen verwenden.";
  return null;
}
