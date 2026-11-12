import { auditLabels, type AuditEntry } from "@/lib/server/audit";

const time = (iso: string) => new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Berlin" });

export function AuditTable({ events }: { events: readonly AuditEntry[] }) {
  if (events.length === 0) return <p className="muted">Noch keine Ereignisse.</p>;
  return (
    <div className="table-wrap" style={{ marginTop: 0 }}>
      <table className="spec">
        <thead>
          <tr>
            <th scope="col">Zeit</th>
            <th scope="col">Ereignis</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.t}-${i}`}>
              <td className="nowrap">{time(e.t)}</td>
              <td>{auditLabels[e.event] ?? e.event}</td>
              <td>{[e.user, e.ip, e.detail].filter(Boolean).join(" · ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
