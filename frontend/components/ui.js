// Shared presentational components.
//
// The signature device here is the severity rail: a coloured left edge on
// cards and table rows. It exists because this is a risk platform -- a
// regulator scanning 3,000 overdue items needs to find the critical ones
// without reading them. Colour carries the same information the text does,
// never information the text lacks, so it stays readable for anyone who
// can't distinguish the hues.

export const SEVERITY = {
  Low: "low", Medium: "medium", High: "high", Critical: "critical",
  Completed: "low", Pending: "medium", Overdue: "critical",
  "Not Applicable": null, Resolved: "low", "In Progress": "medium",
  Escalated: "high", Open: "medium", Closed: "low", Active: "low",
  Expired: "high", "Under Review": "medium",
};

const sevColor = (k) => (k ? `var(--sev-${k})` : "var(--line-strong)");
const sevWash = (k) => (k ? `var(--sev-${k}-wash)` : "transparent");

export function Card({ title, action, severity, children, style }) {
  const key = SEVERITY[severity] ?? null;
  return (
    <section
      style={{
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderLeft: severity ? `3px solid ${sevColor(key)}` : "1px solid var(--line)",
        borderRadius: "var(--radius)",
        padding: "18px 20px",
        marginBottom: 20,
        ...style,
      }}
    >
      {(title || action) && (
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

// Figures sit in one continuous strip rather than three identical floating
// cards -- they're one reading, not three unrelated facts.
export function StatStrip({ items }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length}, minmax(0,1fr))`,
        background: "var(--surface)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius)",
        marginBottom: 24,
      }}
    >
      {items.map((it, i) => (
        <div
          key={it.label}
          style={{
            padding: "16px 20px",
            borderLeft: i === 0 ? "none" : "1px solid var(--line)",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{it.label}</div>
          <div
            className="figure"
            style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.15, color: it.tone ? sevColor(it.tone) : "var(--ink)" }}
          >
            {it.value}
          </div>
          {it.note && <div style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>{it.note}</div>}
        </div>
      ))}
    </div>
  );
}

export function Badge({ children }) {
  const key = SEVERITY[children] ?? null;
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 12.5,
        fontWeight: 500,
        padding: "2px 8px",
        borderRadius: 3,
        color: key ? sevColor(key) : "var(--ink-soft)",
        background: key ? sevWash(key) : "var(--page)",
        border: `1px solid ${key ? sevColor(key) : "var(--line)"}22`,
      }}
    >
      {children}
    </span>
  );
}

export function Table({ columns, rows, severityOf, empty = "Nothing to show yet." }) {
  if (!rows || rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  textAlign: c.align || "left",
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--line-strong)",
                  color: "var(--ink-soft)",
                  fontWeight: 500,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const key = severityOf ? SEVERITY[severityOf(r)] ?? null : null;
            return (
              <tr key={i}>
                {columns.map((c, ci) => (
                  <td
                    key={c.key}
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--line)",
                      textAlign: c.align || "left",
                      verticalAlign: "top",
                      borderLeft: ci === 0 && key ? `3px solid ${sevColor(key)}` : undefined,
                      width: c.width,
                      // Dates and short codes shouldn't break across lines --
                      // a wrapped "2026-07-18" reads as two separate values.
                      whiteSpace: c.nowrap ? "nowrap" : undefined,
                    }}
                  >
                    {c.render ? c.render(r) : r[c.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// An empty state points at the next action rather than just reporting
// absence, so a blank screen still tells someone what to do.
export function Empty({ children }) {
  return (
    <p style={{ color: "var(--ink-faint)", fontSize: 14, margin: "6px 0" }}>{children}</p>
  );
}

export function Button({ children, variant = "primary", ...rest }) {
  const base = {
    padding: "8px 14px",
    borderRadius: "var(--radius)",
    cursor: rest.disabled ? "not-allowed" : "pointer",
    opacity: rest.disabled ? 0.55 : 1,
    fontWeight: 500,
  };
  const styles = {
    primary: { ...base, background: "var(--primary)", color: "#fff", border: "1px solid var(--primary)" },
    secondary: { ...base, background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line-strong)" },
    quiet: { ...base, background: "none", color: "var(--primary)", border: "none", padding: "4px 0" },
  };
  return <button style={styles[variant]} {...rest}>{children}</button>;
}

export function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ display: "block", fontSize: 13, color: "var(--ink-soft)", marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

export function Notice({ tone = "info", children }) {
  const map = {
    info: ["var(--primary)", "var(--primary-wash)"],
    error: ["var(--sev-critical)", "var(--sev-critical-wash)"],
    success: ["var(--sev-low)", "var(--sev-low-wash)"],
  };
  const [fg, bg] = map[tone] || map.info;
  return (
    <div style={{ background: bg, borderLeft: `3px solid ${fg}`, padding: "10px 14px", borderRadius: 3, fontSize: 14, marginBottom: 12 }}>
      {children}
    </div>
  );
}
