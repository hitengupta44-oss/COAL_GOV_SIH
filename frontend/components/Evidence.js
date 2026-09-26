import { useEffect, useRef, useState } from "react";
import { evidenceUrl } from "../lib/evidence";
import { useT } from "../lib/i18n";

// Camera-first photo picker. On a phone `capture="environment"` opens the
// rear camera directly, which is what someone at the face actually wants.
// The chosen file stays in memory (and in the offline queue if there is no
// signal) until the record it belongs to is sent.
export function PhotoInput({ value, onChange, label, accept = "image/*", capture = true }) {
  const { t } = useT();
  const input = useRef(null);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (!value || !value.type?.startsWith("image/")) return setPreview(null);
    const url = URL.createObjectURL(value);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  return (
    <div style={{ marginBottom: 12 }}>
      <span style={{ display: "block", fontSize: 13, color: "var(--ink-soft)", marginBottom: 4 }}>
        {label || t("photo")}
      </span>
      <input
        ref={input}
        type="file"
        accept={accept}
        {...(capture ? { capture: "environment" } : {})}
        style={{ display: "none" }}
        onChange={(e) => onChange(e.target.files?.[0] || null)}
      />
      {value ? (
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {preview ? (
            <img src={preview} alt="" style={{ width: 88, height: 88, objectFit: "cover",
                                               borderRadius: "var(--radius)", border: "1px solid var(--line)" }} />
          ) : (
            <span style={{ fontSize: 14 }}>{value.name}</span>
          )}
          <button type="button" className="linkish" onClick={() => input.current?.click()}>{t("changePhoto")}</button>
          <button type="button" className="linkish" onClick={() => { onChange(null); if (input.current) input.current.value = ""; }}>
            {t("removePhoto")}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => input.current?.click()}
          style={{ padding: "10px 14px", border: "1px dashed var(--line-strong)", background: "var(--page)",
                   borderRadius: "var(--radius)", cursor: "pointer", width: "100%", textAlign: "left",
                   color: "var(--ink-soft)" }}>
          {t("addPhoto")}
        </button>
      )}
    </div>
  );
}

// Evidence is in a private bucket, so a link is minted on demand and
// expires. Nothing sensitive sits in the page as a permanent URL.
export function EvidenceLink({ path, children = "View" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!path) return <span style={{ color: "var(--ink-faint)" }}>—</span>;
  return (
    <>
      <button type="button" className="linkish" disabled={busy}
        onClick={async () => {
          setBusy(true); setErr(null);
          try {
            const url = await evidenceUrl(path);
            if (url) window.open(url, "_blank", "noopener");
          } catch (e) {
            setErr("Not available");
          } finally { setBusy(false); }
        }}>
        {busy ? "Opening" : children}
      </button>
      {err && <span style={{ color: "var(--sev-critical)", fontSize: 12.5, marginLeft: 6 }}>{err}</span>}
    </>
  );
}

// Geo-fence verdict, shown wherever a geo-tagged record is listed. The
// wording is factual rather than accusing: "outside" can mean the mine's
// coordinates are wrong as easily as the record.
export function GeoBadge({ within, distance }) {
  if (within == null) return <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>No location</span>;
  const km = distance == null ? "" : distance < 1000 ? ` · ${Math.round(distance)} m` : ` · ${(distance / 1000).toFixed(1)} km`;
  return (
    <span style={{ fontSize: 13, color: within ? "var(--sev-low)" : "var(--sev-high)", whiteSpace: "nowrap" }}>
      {within ? "At the mine" : "Outside boundary"}{km}
    </span>
  );
}
