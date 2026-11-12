import { bps } from "@/lib/format";

type Pt = { t: number; a: number; b?: number };

/** Flächen-Diagramm aus zwei Reihen (z. B. Empfangen/Gesendet). Reines SVG, ohne Bibliothek. */
export function AreaChart({ points, fmt = bps, labels = ["Empfangen", "Gesendet"] }: { points: Pt[]; fmt?: (n: number) => string; labels?: [string, string] }) {
  const W = 600;
  const H = 100;
  if (points.length < 2) return <p className="muted small">Noch zu wenige Messpunkte.</p>;
  const max = Math.max(1, ...points.flatMap((p) => [p.a, p.b ?? 0]));
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - (v / max) * (H - 4) - 2;
  const area = (pick: (p: Pt) => number) => `M0,${H} ${points.map((p) => `L${x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ")} L${W},${H} Z`;
  const line = (pick: (p: Pt) => number) => points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");
  const hasB = points.some((p) => p.b !== undefined);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Verlauf, Spitze ${fmt(max)}`}>
        <path d={area((p) => p.a)} className="rx" strokeWidth="0" />
        <path d={line((p) => p.a)} className="rx" fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {hasB && <path d={area((p) => p.b ?? 0)} className="tx" strokeWidth="0" />}
        {hasB && <path d={line((p) => p.b ?? 0)} className="tx" fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="legend">
        <span className="k-rx">{labels[0]}</span>
        {hasB && <span className="k-tx">{labels[1]}</span>}
        <span>Spitze {fmt(max)}</span>
      </div>
    </>
  );
}

/** Balken: Anteile frei/zugewiesen/reserviert/gesperrt eines Netzes. */
export function UsageBar({ free, assigned, reserved, blocked }: { free: number; assigned: number; reserved: number; blocked: number }) {
  const total = Math.max(1, free + assigned + reserved + blocked);
  const w = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  return (
    <div className="bar" role="img" aria-label={`${assigned} zugewiesen, ${reserved} reserviert, ${blocked} gesperrt, ${free} frei`}>
      <i className="a" style={{ width: w(assigned) }} />
      <i className="r" style={{ width: w(reserved) }} />
      <i className="b" style={{ width: w(blocked) }} />
      <i className="f" style={{ width: w(free) }} />
    </div>
  );
}
