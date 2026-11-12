/**
 * DNS-Wire-Format (RFC 1035, RFC 6891 EDNS0): Nachrichten lesen und schreiben.
 * Nur node:-Bordmittel. Beim Lesen werden Kompressionszeiger aufgelöst (nur rückwärts, mit Obergrenze),
 * beim Schreiben wird optional Namenskompression genutzt (nur dort, wo RFC 3597 sie erlaubt).
 * Namen sind intern klein geschrieben und ohne Punkt am Ende; die Wurzel ist "".
 */
import type { RData } from "../../lib/core/dns-model.ts";
import { parseIPv4, parseIPv6 } from "../../lib/core/net.ts";

export const QTYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, HINFO: 13, MX: 15, TXT: 16, AAAA: 28, SRV: 33, OPT: 41, IXFR: 251, AXFR: 252, ANY: 255, CAA: 257 } as const;
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;

const NAME_BY_CODE = new Map<number, string>(Object.entries(QTYPE).map(([k, v]) => [v, k]));
export const typeName = (code: number): string => NAME_BY_CODE.get(code) ?? `TYPE${code}`;
export const typeCode = (name: string): number | undefined => (QTYPE as Record<string, number>)[name];

export class DnsParseError extends Error {}

/** Daten eines Eintrags: die Modelltypen plus HINFO (für ANY-Antworten) und unbekannte Typen (roh). */
export type WireData = RData | { type: "HINFO"; cpu: string; os: string } | { type: "RAW"; code: number; data: Uint8Array };

export type Question = { name: string; /** Schreibweise wie angefragt (0x20-Verschlüsselung muss zurückgegeben werden) */ rawName: string; type: number; cls: number };
export type WireRR = { name: string; cls: number; ttl: number; data: WireData };
export type Edns = { udpSize: number; extRcode: number; version: number; flags: number; options?: Uint8Array };

export type Message = {
  id: number;
  qr: boolean;
  opcode: number;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  ad: boolean;
  cd: boolean;
  rcode: number;
  questions: Question[];
  answers: WireRR[];
  authority: WireRR[];
  additional: WireRR[];
  edns?: Edns;
};

export const emptyMessage = (id = 0): Message => ({
  id, qr: false, opcode: 0, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: 0,
  questions: [], answers: [], authority: [], additional: [],
});

/* ================================================================== Lesen */
class Reader {
  pos = 0;
  readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  need(n: number): void {
    if (this.pos + n > this.buf.length) throw new DnsParseError("Nachricht zu kurz");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Liest einen Namen ab `offset`. Rückgabe: Name (klein), Original-Schreibweise und Position hinter dem Namen. */
export function readName(buf: Buffer, offset: number): { name: string; raw: string; next: number } {
  let pos = offset;
  let next = -1;
  let hops = 0;
  let total = 0;
  const labels: string[] = [];
  for (;;) {
    if (pos >= buf.length) throw new DnsParseError("Name läuft über das Ende hinaus");
    const len = buf[pos]!;
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new DnsParseError("Kompressionszeiger abgeschnitten");
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (next < 0) next = pos + 2;
      if (++hops > 64 || ptr >= pos) throw new DnsParseError("Ungültiger Kompressionszeiger");
      pos = ptr;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new DnsParseError("Unbekannter Label-Typ");
    if (pos + 1 + len > buf.length) throw new DnsParseError("Label läuft über das Ende hinaus");
    total += len + 1;
    if (total > 254) throw new DnsParseError("Name zu lang");
    const label = buf.toString("latin1", pos + 1, pos + 1 + len);
    if (label.includes(".")) throw new DnsParseError("Punkt im Label nicht unterstützt");
    labels.push(label);
    pos += 1 + len;
  }
  const raw = labels.join(".");
  return { name: lowerAscii(raw), raw, next };
}

function readRData(r: Reader, type: number, rdlen: number): WireData {
  const end = r.pos + rdlen;
  r.need(rdlen);
  const nameAt = (): string => {
    const n = readName(r.buf, r.pos);
    r.pos = n.next;
    return n.name;
  };
  let data: WireData;
  switch (type) {
    case QTYPE.A: {
      if (rdlen !== 4) throw new DnsParseError("A-Daten haben falsche Länge");
      data = { type: "A", address: [...r.bytes(4)].join(".") };
      break;
    }
    case QTYPE.AAAA: {
      if (rdlen !== 16) throw new DnsParseError("AAAA-Daten haben falsche Länge");
      const b = r.bytes(16);
      let g = "";
      for (let i = 0; i < 16; i += 2) g += (i ? ":" : "") + b.readUInt16BE(i).toString(16);
      data = { type: "AAAA", address: g };
      break;
    }
    case QTYPE.NS:
      data = { type: "NS", target: nameAt() };
      break;
    case QTYPE.CNAME:
      data = { type: "CNAME", target: nameAt() };
      break;
    case QTYPE.PTR:
      data = { type: "PTR", target: nameAt() };
      break;
    case QTYPE.MX: {
      const preference = r.u16();
      data = { type: "MX", preference, exchange: nameAt() };
      break;
    }
    case QTYPE.SRV: {
      const priority = r.u16();
      const weight = r.u16();
      const port = r.u16();
      data = { type: "SRV", priority, weight, port, target: nameAt() };
      break;
    }
    case QTYPE.SOA: {
      const mname = nameAt();
      const rname = nameAt();
      data = { type: "SOA", mname, rname, serial: r.u32(), refresh: r.u32(), retry: r.u32(), expire: r.u32(), minimum: r.u32() };
      break;
    }
    case QTYPE.TXT: {
      const parts: Buffer[] = [];
      while (r.pos < end) {
        const l = r.u8();
        if (r.pos + l > end) throw new DnsParseError("TXT-Teil zu lang");
        parts.push(r.bytes(l));
      }
      data = { type: "TXT", text: Buffer.concat(parts).toString("utf8") };
      break;
    }
    case QTYPE.CAA: {
      const flags = r.u8();
      const tl = r.u8();
      if (r.pos + tl > end) throw new DnsParseError("CAA-Tag zu lang");
      const tag = r.bytes(tl).toString("latin1");
      data = { type: "CAA", flags, tag, value: r.bytes(end - r.pos).toString("utf8") };
      break;
    }
    case QTYPE.HINFO: {
      const c = r.bytes(r.u8()).toString("latin1");
      const o = r.bytes(r.u8()).toString("latin1");
      data = { type: "HINFO", cpu: c, os: o };
      break;
    }
    default:
      data = { type: "RAW", code: type, data: Uint8Array.from(r.bytes(rdlen)) };
  }
  if (r.pos !== end) throw new DnsParseError("Eintragsdaten haben falsche Länge");
  return data;
}

/** Liest eine komplette Nachricht. Wirft DnsParseError bei Unsinn. */
export function decodeMessage(buf: Buffer): Message {
  if (buf.length < 12) throw new DnsParseError("Kopf zu kurz");
  const r = new Reader(buf);
  const id = r.u16();
  const flags = r.u16();
  const qd = r.u16();
  const an = r.u16();
  const ns = r.u16();
  const ar = r.u16();
  if (qd > 16 || an > 1000 || ns > 1000 || ar > 1000) throw new DnsParseError("Unplausible Anzahl");
  const msg: Message = {
    id,
    qr: !!(flags & 0x8000),
    opcode: (flags >> 11) & 0xf,
    aa: !!(flags & 0x400),
    tc: !!(flags & 0x200),
    rd: !!(flags & 0x100),
    ra: !!(flags & 0x80),
    ad: !!(flags & 0x20),
    cd: !!(flags & 0x10),
    rcode: flags & 0xf,
    questions: [],
    answers: [],
    authority: [],
    additional: [],
  };
  for (let i = 0; i < qd; i++) {
    const n = readName(buf, r.pos);
    r.pos = n.next;
    msg.questions.push({ name: n.name, rawName: n.raw, type: r.u16(), cls: r.u16() });
  }
  const readRR = (into: WireRR[], isAdditional: boolean): void => {
    const n = readName(buf, r.pos);
    r.pos = n.next;
    const type = r.u16();
    const cls = r.u16();
    const ttl = r.u32();
    const rdlen = r.u16();
    if (type === QTYPE.OPT && isAdditional) {
      if (msg.edns) throw new DnsParseError("Mehrere OPT-Einträge");
      msg.edns = { udpSize: cls, extRcode: (ttl >>> 24) & 0xff, version: (ttl >>> 16) & 0xff, flags: ttl & 0xffff, options: Uint8Array.from(r.bytes(rdlen)) };
      return;
    }
    into.push({ name: n.name, cls, ttl, data: readRData(r, type, rdlen) });
  };
  for (let i = 0; i < an; i++) readRR(msg.answers, false);
  for (let i = 0; i < ns; i++) readRR(msg.authority, false);
  for (let i = 0; i < ar; i++) readRR(msg.additional, true);
  return msg;
}

/* =============================================================== Schreiben */
class Writer {
  buf = Buffer.allocUnsafe(1024);
  len = 0;
  readonly names = new Map<string, number>();
  readonly compress: boolean;
  constructor(compress: boolean) {
    this.compress = compress;
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v: number): void {
    this.ensure(2);
    this.buf.writeUInt16BE(v & 0xffff, this.len);
    this.len += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.buf.writeUInt32BE(v >>> 0, this.len);
    this.len += 4;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  /** Schreibt einen Namen; `allowCompress=false` für Daten, in denen Kompression verboten ist. */
  name(name: string, allowCompress = true): void {
    const n = name.replace(/\.$/, "");
    const labels = n === "" ? [] : n.split(".");
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join(".").toLowerCase();
      if (this.compress && allowCompress) {
        const off = this.names.get(suffix);
        if (off !== undefined) {
          this.u16(0xc000 | off);
          return;
        }
        if (this.len < 0x3fff) this.names.set(suffix, this.len);
      }
      const l = Buffer.from(labels[i]!, "latin1");
      if (l.length === 0 || l.length > 63) throw new Error(`Ungültiges Label in „${name}“`);
      this.u8(l.length);
      this.bytes(l);
    }
    this.u8(0);
  }
  result(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

function writeRData(w: Writer, d: WireData): number {
  switch (d.type) {
    case "A": {
      const v = parseIPv4(d.address);
      if (v === null) throw new Error(`Ungültige IPv4-Adresse ${d.address}`);
      w.u32(Number(v));
      return QTYPE.A;
    }
    case "AAAA": {
      const v = parseIPv6(d.address);
      if (v === null) throw new Error(`Ungültige IPv6-Adresse ${d.address}`);
      for (let i = 7; i >= 0; i--) w.u16(Number((v >> BigInt(i * 16)) & 0xffffn));
      return QTYPE.AAAA;
    }
    case "NS":
      w.name(d.target);
      return QTYPE.NS;
    case "CNAME":
      w.name(d.target);
      return QTYPE.CNAME;
    case "PTR":
      w.name(d.target);
      return QTYPE.PTR;
    case "MX":
      w.u16(d.preference);
      w.name(d.exchange);
      return QTYPE.MX;
    case "SRV":
      w.u16(d.priority);
      w.u16(d.weight);
      w.u16(d.port);
      w.name(d.target, false);
      return QTYPE.SRV;
    case "SOA":
      w.name(d.mname);
      w.name(d.rname);
      w.u32(d.serial);
      w.u32(d.refresh);
      w.u32(d.retry);
      w.u32(d.expire);
      w.u32(d.minimum);
      return QTYPE.SOA;
    case "TXT": {
      const b = Buffer.from(d.text, "utf8");
      if (b.length === 0) w.u8(0);
      for (let i = 0; i < b.length; i += 255) {
        const part = b.subarray(i, i + 255);
        w.u8(part.length);
        w.bytes(part);
      }
      return QTYPE.TXT;
    }
    case "CAA": {
      const tag = Buffer.from(d.tag, "latin1");
      w.u8(d.flags);
      w.u8(tag.length);
      w.bytes(tag);
      w.bytes(Buffer.from(d.value, "utf8"));
      return QTYPE.CAA;
    }
    case "HINFO": {
      const c = Buffer.from(d.cpu, "latin1").subarray(0, 255);
      const o = Buffer.from(d.os, "latin1").subarray(0, 255);
      w.u8(c.length);
      w.bytes(c);
      w.u8(o.length);
      w.bytes(o);
      return QTYPE.HINFO;
    }
    case "RAW":
      w.bytes(d.data);
      return d.code;
    case "ALIAS":
      throw new Error("ALIAS-Einträge werden nie direkt kodiert");
  }
}

function writeRR(w: Writer, rr: WireRR): void {
  w.name(rr.name);
  const typePos = w.len;
  w.u16(0); // Typ wird nach den Daten gesetzt
  w.u16(rr.cls);
  w.u32(rr.ttl);
  const lenPos = w.len;
  w.u16(0);
  const start = w.len;
  const type = writeRData(w, rr.data);
  w.buf.writeUInt16BE(type, typePos);
  w.buf.writeUInt16BE(w.len - start, lenPos);
}

/** Schreibt eine Nachricht. Standardmäßig mit Namenskompression. */
export function encodeMessage(msg: Message, opts: { compress?: boolean } = {}): Buffer {
  const w = new Writer(opts.compress !== false);
  w.u16(msg.id);
  const flags =
    (msg.qr ? 0x8000 : 0) | ((msg.opcode & 0xf) << 11) | (msg.aa ? 0x400 : 0) | (msg.tc ? 0x200 : 0) | (msg.rd ? 0x100 : 0) |
    (msg.ra ? 0x80 : 0) | (msg.ad ? 0x20 : 0) | (msg.cd ? 0x10 : 0) | (msg.rcode & 0xf);
  w.u16(flags);
  w.u16(msg.questions.length);
  w.u16(msg.answers.length);
  w.u16(msg.authority.length);
  w.u16(msg.additional.length + (msg.edns ? 1 : 0));
  for (const q of msg.questions) {
    w.name(q.rawName);
    w.u16(q.type);
    w.u16(q.cls);
  }
  for (const rr of msg.answers) writeRR(w, rr);
  for (const rr of msg.authority) writeRR(w, rr);
  for (const rr of msg.additional) writeRR(w, rr);
  if (msg.edns) {
    const e = msg.edns;
    w.u8(0);
    w.u16(QTYPE.OPT);
    w.u16(e.udpSize);
    w.u32(((e.extRcode & 0xff) << 24) | ((e.version & 0xff) << 16) | (e.flags & 0xffff));
    const opts2 = e.options ?? new Uint8Array(0);
    w.u16(opts2.length);
    w.bytes(opts2);
  }
  return w.result();
}
