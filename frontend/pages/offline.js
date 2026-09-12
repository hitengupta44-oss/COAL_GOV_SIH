// Shown when a page is opened with no connection and nothing cached.
// It states what still works rather than only reporting the failure --
// someone underground needs to know they can still record a finding.
export default function Offline() {
  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <div style={{
        maxWidth: 440, background: "var(--surface)", border: "1px solid var(--line)",
        borderLeft: "3px solid var(--sev-medium)", borderRadius: "var(--radius)", padding: "28px 30px",
      }}>
        <h1 style={{ fontSize: 20 }}>No connection</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 14.5, marginTop: 10 }}>
          This page hasn&apos;t been opened on this device before, so there&apos;s
          nothing stored to show you.
        </p>
        <p style={{ color: "var(--ink-soft)", fontSize: 14.5 }}>
          Pages you have already visited still work, and anything you record is
          saved here and sent automatically once you have a signal.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 14px", background: "var(--primary)", color: "#fff",
            border: "1px solid var(--primary)", borderRadius: "var(--radius)", cursor: "pointer",
          }}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
