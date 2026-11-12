import assert from 'node:assert/strict';
import { test } from 'node:test';

const L = new URL('../lib/server/', import.meta.url).href;
const { validateLegal, legalGaps, defaultLegal } = await import(L + 'legal-shared.ts');

const full = {
  brandName: 'VylarisData', companyName: 'CircleUpWilms', legalForm: 'einzelunternehmen', ownerName: 'Lucas Wilms',
  street: 'Musterstraße 1', zip: '12345', city: 'Musterstadt', country: 'Deutschland', email: 'info@example.org',
  vatMode: 'small', logRetentionDays: '7',
};

test('gültige Angaben werden übernommen und bereinigt', () => {
  const r = validateLegal({ ...full, ownerName: '  Lucas   Wilms \u0007 ', street: 'Musterstraße 1\nZeile 2' });
  assert.equal(r.ok, true);
  assert.equal(r.data.ownerName, 'Lucas   Wilms', 'Steuerzeichen entfernt, getrimmt');
  assert.equal(r.data.street, 'Musterstraße 1 Zeile 2', 'einzeilige Felder: Umbrüche werden zu Leerzeichen');
});

test('ungültige E-Mail, Telefon, USt-IdNr. und Logfile-Dauer werden abgelehnt', () => {
  assert.equal(validateLegal({ ...full, email: 'keine-mail' }).ok, false);
  assert.equal(validateLegal({ ...full, email: 'a@b<script>.de' }).ok, false);
  assert.equal(validateLegal({ ...full, phone: 'abc' }).ok, false);
  assert.equal(validateLegal({ ...full, phone: '+49 (0)30 123456' }).ok, true);
  assert.equal(validateLegal({ ...full, vatMode: 'regular', vatId: 'DE12' }).ok, true);
  assert.equal(validateLegal({ ...full, vatMode: 'regular', vatId: 'ungültig!' }).ok, false);
  assert.equal(validateLegal({ ...full, logRetentionDays: 'sieben' }).ok, false);
  assert.equal(validateLegal({ ...full, logRetentionDays: '0' }).ok, false);
  assert.equal(validateLegal({ ...full, logRetentionDays: '4000' }).ok, false);
  const many = validateLegal({ ...full, email: 'x', phone: 'y', logRetentionDays: 'z' });
  assert.equal(many.ok, false); assert.equal(many.errors.length, 3, 'alle Fehler werden gemeldet');
});

test('USt-IdNr. wird nur bei Regelbesteuerung gespeichert; Kleinunternehmer löscht sie', () => {
  assert.equal(validateLegal({ ...full, vatMode: 'regular', vatId: 'de 123 456 789' }).data.vatId, 'DE123456789');
  assert.equal(validateLegal({ ...full, vatMode: 'small', vatId: 'DE123456789' }).data.vatId, '');
});

test('Schalter und Auswahlfelder: unbekannte Werte fallen auf sichere Standardwerte zurück', () => {
  const r = validateLegal({ ...full, legalForm: 'gibtesnicht', registerType: 'x', vatMode: 'x', disputeMode: 'x', registerEnabled: 'on', contentResponsibleEnabled: 'on' });
  assert.equal(r.data.legalForm, 'einzelunternehmen'); assert.equal(r.data.registerType, 'handelsregister');
  assert.equal(r.data.vatMode, 'unset'); assert.equal(r.data.disputeMode, 'none');
  assert.equal(r.data.registerEnabled, true); assert.equal(r.data.contentResponsibleEnabled, true);
  assert.equal(validateLegal({ ...full }).data.registerEnabled, false, 'nicht angehakt = aus');
});

test('Längen werden begrenzt (kein Überlauf durch riesige Eingaben)', () => {
  const r = validateLegal({ ...full, ownerName: 'a'.repeat(5000), extraImpressum: 'b'.repeat(99999), extraPrivacy: 'c'.repeat(99999) });
  assert.equal(r.data.ownerName.length, 120); assert.equal(r.data.extraImpressum.length, 2000); assert.equal(r.data.extraPrivacy.length, 3000);
});

test('HTML in Eingaben bleibt Text (wird erst beim Rendern von React escaped, nichts wird entfernt oder ausgeführt)', () => {
  const r = validateLegal({ ...full, extraImpressum: '<script>alert(1)</script>\n\n<b>fett</b>' });
  assert.equal(r.ok, true); assert.ok(r.data.extraImpressum.includes('<script>'));
});

test('Vollständigkeitsprüfung: Standardwerte haben Lücken, vollständige Angaben keine', () => {
  const keys = (d) => legalGaps(d).map(g => g.field);
  assert.deepEqual(keys(defaultLegal).sort(), ['email', 'logRetentionDays', 'street', 'vatMode'].sort());
  assert.deepEqual(keys(validateLegal(full).data), []);
});

test('Vollständigkeitsprüfung: Rechtsform und Register verlangen weitere Angaben', () => {
  const base = validateLegal(full).data;
  assert.ok(legalGaps({ ...base, legalForm: 'gmbh' }).some(g => g.field === 'representative'));
  assert.ok(!legalGaps({ ...base, legalForm: 'gmbh', representative: 'Max Muster' }).some(g => g.field === 'representative'));
  assert.ok(legalGaps({ ...base, registerEnabled: true }).some(g => g.field === 'registerCourt'));
  assert.ok(!legalGaps({ ...base, registerEnabled: true, registerCourt: 'AG Musterstadt', registerNumber: 'HRB 1' }).some(g => g.field === 'registerCourt'));
  assert.ok(!legalGaps({ ...base, registerEnabled: false }).some(g => g.field === 'registerCourt'), 'Register aus = keine Pflicht');
  assert.ok(legalGaps({ ...base, contentResponsibleEnabled: true }).some(g => g.field === 'contentResponsibleName'));
  assert.ok(legalGaps({ ...base, vatMode: 'unset' }).some(g => g.field === 'vatMode'));
});
