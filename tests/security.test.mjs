import assert from 'node:assert/strict';
import { test } from 'node:test';
const L = new URL('../lib/server/', import.meta.url).href;
const rl = await import(L + 'ratelimit.ts');
const pw = await import(L + 'password.ts');
const totp = await import(L + 'totp.ts');

test('TOTP: RFC-6238-Testvektoren (SHA-1, Schlüssel "12345678901234567890", 8 Stellen -> letzte 6)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  // Zeitpunkt 59 s => Zähler 1 => Code 94287082 (8 Stellen) => 6 Stellen: 287082
  assert.equal(totp.hotp(secret, Math.floor(59 / 30)), '287082');
  // Zeitpunkt 1111111109 => 07081804 => 081804
  assert.equal(totp.hotp(secret, Math.floor(1111111109 / 30)), '081804');
  // Zeitpunkt 20000000000 => 65353130 => 353130
  assert.equal(totp.hotp(secret, Math.floor(20000000000 / 30)), '353130');
});

test('TOTP: Base32 Hin- und Rückweg, Replay-Schutz und Zeitfenster', () => {
  const s = totp.generateTotpSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Encode(totp.base32Decode(s)), s);
  const now = Date.UTC(2026, 10, 5, 12, 0, 10);
  const step = totp.currentStep(now);
  const code = totp.hotp(s, step);
  assert.equal(totp.verifyTotp(s, code, -1, now), step);
  assert.equal(totp.verifyTotp(s, code, step, now), null, 'derselbe Zeitschritt darf nicht erneut gelten');
  assert.equal(totp.verifyTotp(s, totp.hotp(s, step - 1), -1, now), step - 1, '±1 Fenster');
  assert.equal(totp.verifyTotp(s, totp.hotp(s, step + 2), -1, now), null, 'außerhalb des Fensters');
  assert.equal(totp.verifyTotp(s, '12345', -1, now), null);
  assert.equal(totp.verifyTotp(s, 'abcdef', -1, now), null);
});

test('Passwort: Hash, Prüfung, falsches Passwort, unbekannter Benutzer', async () => {
  const h = await pw.hashPassword('Kupfer-Ziegel-Lampe-2026!');
  assert.match(h, /^scrypt\$16\$8\$1\$/);
  assert.equal(await pw.verifyPassword('Kupfer-Ziegel-Lampe-2026!', h), true);
  assert.equal(await pw.verifyPassword('Kupfer-Ziegel-Lampe-2026', h), false);
  assert.equal(await pw.verifyPassword('irgendwas', null), false);
  assert.equal(await pw.verifyPassword('x', 'scrypt$20$16$4$AAAA$BBBB'), false, 'überzogene Parameter werden abgelehnt');
  assert.equal(await pw.verifyPassword('x', 'kaputt'), false);
});

test('Passwort-Regeln', () => {
  const v = (p, u = 'lucas') => pw.validateNewPassword(p, u);
  assert.match(v('kurz'), /14 Zeichen/);
  assert.match(v('Passwort1234!abc'), /zu einfach/);
  assert.match(v('Vylaris-Data-2026!!!'), /zu einfach/);
  assert.match(v('lucas-ist-ein-langer-name'), /Benutzernamen/);
  assert.match(v('nurkleinbuchstabenhier'.slice(0, 18)), /mischen/);
  assert.equal(v('Kupfer-Ziegel-Lampe-2026!'), null);
  assert.equal(v('ein sehr langer satz ohne zahlen'), null, 'Passphrase ab 20 Zeichen ist erlaubt');
  assert.match(v('a'.repeat(129)), /höchstens/);
});

test('Ratenbegrenzung: Versuche werden vor der Prüfung reserviert', () => {
  const key = 'test:' + Math.random();
  let ok = 0, blocked = 0;
  for (let i = 0; i < 25; i++) (rl.attempt(key, 8).ok ? ok++ : blocked++); // gleichzeitig = ohne await dazwischen
  assert.equal(ok, 8); assert.equal(blocked, 17);
  const r = rl.attempt(key, 8); assert.equal(r.ok, false); assert.ok(r.retryAfter > 800 && r.retryAfter <= 900);
  rl.release(key); assert.equal(rl.attempt(key, 8).ok, true);
  assert.equal(rl.used(key), 1);
});

test('Ratenbegrenzung: Fenster läuft ab', () => {
  const key = 'fenster:' + Math.random(); const t0 = Date.now();
  for (let i = 0; i < 8; i++) rl.attempt(key, 8, t0);
  assert.equal(rl.attempt(key, 8, t0 + 1000).ok, false);
  assert.equal(rl.attempt(key, 8, t0 + rl.WINDOW_MS + 1).ok, true);
});

test('Backoff wächst und ist begrenzt', () => {
  assert.equal(rl.backoffMs(0, 0), 0); assert.equal(rl.backoffMs(1, 1), 0);
  assert.equal(rl.backoffMs(2, 1), 250); assert.equal(rl.backoffMs(3, 1), 500);
  assert.equal(rl.backoffMs(100, 0), 8000);
});

test('IPv6 wird auf /64 zusammengefasst, IPv4 bleibt', () => {
  assert.equal(rl.ipBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(rl.ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
  const a = rl.ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), b = rl.ipBucket('2001:db8:1:2::1'), c = rl.ipBucket('2001:db8:1:3::1');
  assert.equal(a, b); assert.notEqual(a, c); assert.equal(a, '2001:db8:1:2::/64');
  assert.equal(rl.ipBucket('2001:0db8:0001:0002:0:0:0:1'), '2001:db8:1:2::/64');
});

test('scrypt-Parallelität: höchstens 2 gleichzeitig, Warteschlange begrenzt, danach "busy"', async () => {
  let running = 0, peak = 0;
  const job = () => rl.limited(async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 40)); running--; return 1; });
  const results = await Promise.allSettled(Array.from({ length: 20 }, job));
  const okN = results.filter(r => r.status === 'fulfilled').length;
  const busy = results.filter(r => r.status === 'rejected' && r.reason instanceof rl.BusyError).length;
  assert.equal(peak, 2, 'nie mehr als 2 parallel');
  assert.equal(okN, 8, '2 laufen + 6 in der Schlange');
  assert.equal(busy, 12, 'der Rest wird sofort abgewiesen');
  assert.equal(await job(), 1, 'danach geht es wieder');
});

test('Protokoll-Drosselung: gleiche Ereignisse nur einmal je Zeitraum', () => {
  const k = 'x' + Math.random(); const t = Date.now();
  assert.equal(rl.shouldLogOnce(k, 1000, t), true); assert.equal(rl.shouldLogOnce(k, 1000, t + 10), false); assert.equal(rl.shouldLogOnce(k, 1000, t + 1500), true);
});
