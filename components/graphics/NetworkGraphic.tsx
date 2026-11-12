import { Logo } from "@/components/layout/Logo";

type Node = { x: number; y: number; label: string };

const nodes: readonly Node[] = [
  { x: 70, y: 150, label: "Server" },
  { x: 130, y: 70, label: "Proxy" },
  { x: 250, y: 40, label: "Cloudflare" },
  { x: 370, y: 70, label: "Schutz" },
  { x: 430, y: 150, label: "DNS" },
  { x: 90, y: 215, label: "IP-Netz" },
  { x: 410, y: 215, label: "Traffic" },
];

/** Animiertes Netzwerk-Motiv für den Startseiten-Hero. */
export function NetworkGraphic() {
  return (
    <div className="net" aria-hidden="true">
      <svg viewBox="0 0 500 262" fill="none" focusable="false">
        <defs>
          <radialGradient id="vd-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0" style={{ stopColor: "var(--brand)" }} stopOpacity=".45" />
            <stop offset=".55" style={{ stopColor: "var(--brand)" }} stopOpacity=".12" />
            <stop offset="1" style={{ stopColor: "var(--brand)" }} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle className="glow" cx="250" cy="150" r="150" />
        {nodes.map((n) => (
          <line key={n.label} className="link" x1="250" y1="150" x2={n.x} y2={n.y} />
        ))}
        <g className="spin">
          <circle className="ring" cx="250" cy="150" r="118" strokeOpacity=".3" strokeDasharray="3 7" />
        </g>
        <g className="spin-rev">
          <circle className="ring" cx="250" cy="150" r="170" strokeOpacity=".2" strokeDasharray="3 9" />
        </g>
        {nodes.map((n, i) => (
          <g key={n.label}>
            <circle className="node-halo" cx={n.x} cy={n.y} r="16" style={{ animationDelay: `${(i * 0.45).toFixed(2)}s` }} />
            <circle className="node-ring" cx={n.x} cy={n.y} r="9" />
            <circle className="node-dot" cx={n.x} cy={n.y} r="3.5" />
            <text x={n.x} y={n.y + 27} textAnchor="middle">
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      <Logo />
    </div>
  );
}
