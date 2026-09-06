import { useState } from "react";
import { Card, Button, Notice } from "./ui";
import { useAuth } from "../lib/useAuth";
import { supabase } from "./../lib/supabase";

// Reports are built in the browser rather than on the server.
//
// The data is already fetched under the caller's own credentials, so a
// server-side generator would have to re-implement the access rules to
// avoid handing someone a PDF of a mine they cannot otherwise see.
// Building it here means a report can only ever contain rows the person
// was already allowed to read -- RLS does the work, not a second copy of
// the policy. It also means no file storage and nothing to clean up.
const JSPDF = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const found = document.querySelector(`script[src="${src}"]`);
    if (found) {
      if (found.dataset.loaded) return resolve();
      found.addEventListener("load", () => resolve());
      found.addEventListener("error", () => reject(new Error(`Could not load ${src}`)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadPdfLibs() {
  await loadScript(JSPDF);
  await loadScript(AUTOTABLE);
  return window.jspdf.jsPDF;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Quoting every field and doubling internal quotes: statutory requirement
// text contains commas and quotation marks, and an unescaped one silently
// shifts every following column.
function toCsv(headers, rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
}

const today = () => new Date().toISOString().slice(0, 10);

export default function ReportPanel() {
  const { profile } = useAuth();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const wide = ["corporate_admin", "regulator", "admin"].includes(profile?.role);

  // ---------------------------------------------------------------
  // Data gathering. Each report pulls only what it prints.
  // ---------------------------------------------------------------
  const mineComplianceRows = async () => {
    let q = supabase
      .from("compliance_tracking")
      .select("mine_id, status, due_date, completed_date, remarks, "
            + "statutory_compliance_items(regulation_source, category, requirement_summary)")
      .order("due_date");
    if (profile?.mine_id && !wide) q = q.eq("mine_id", profile.mine_id);
    const { data, error: err } = await q.limit(2000);
    if (err) throw err;

    const ids = [...new Set((data || []).map((r) => r.mine_id).filter(Boolean))];
    const names = {};
    if (ids.length) {
      const { data: mines } = await supabase
        .from("mines").select("mine_id, mine_name, state").in("mine_id", ids);
      (mines || []).forEach((m) => { names[m.mine_id] = m; });
    }
    return (data || []).map((r) => {
      const item = r.statutory_compliance_items || {};
      const m = names[r.mine_id] || {};
      return {
        mine: m.mine_name || "—",
        state: m.state || "—",
        source: item.regulation_source || "—",
        category: item.category || "—",
        requirement: item.requirement_summary || "—",
        due: r.due_date || "—",
        status: r.status || "—",
        completed: r.completed_date || "",
      };
    });
  };

  const summaryRows = async () => {
    const { data: mines } = await supabase
      .from("mines").select("mine_id, mine_name, state").limit(1000);
    const { data: comp } = await supabase
      .from("compliance_tracking").select("mine_id, status").limit(20000);
    const { data: flags } = await supabase
      .from("ai_risk_flags").select("mine_id, risk_score").limit(3000);

    const byMine = {};
    (comp || []).forEach((c) => {
      const b = (byMine[c.mine_id] ||= { overdue: 0, pending: 0, done: 0 });
      if (c.status === "Overdue") b.overdue++;
      else if (c.status === "Pending") b.pending++;
      else if (c.status === "Completed") b.done++;
    });
    const worst = {};
    (flags || []).forEach((f) => {
      if (!worst[f.mine_id] || f.risk_score > worst[f.mine_id]) worst[f.mine_id] = f.risk_score;
    });

    // Only mines with something to report. A summary listing 400 sites
    // with nothing outstanding is a document nobody reads.
    return (mines || [])
      .map((m) => ({
        mine: m.mine_name,
        state: m.state || "—",
        overdue: byMine[m.mine_id]?.overdue || 0,
        pending: byMine[m.mine_id]?.pending || 0,
        completed: byMine[m.mine_id]?.done || 0,
        risk: worst[m.mine_id] ?? "",
      }))
      .filter((r) => r.overdue || r.pending || r.risk !== "")
      .sort((a, b) => b.overdue - a.overdue || (b.risk || 0) - (a.risk || 0));
  };

  // ---------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------
  const header = (doc, title, subtitle) => {
    doc.setFontSize(15);
    doc.text(title, 40, 45);
    doc.setFontSize(9.5);
    doc.setTextColor(90);
    doc.text(subtitle, 40, 62);
    doc.text(
      `Generated ${today()} by ${profile?.full_name || profile?.email || "the platform"}`,
      40, 76
    );
    doc.setTextColor(0);
  };

  // A statement of provenance rather than decoration: a printed report
  // detached from the system needs to say where its figures came from and
  // that it reflects only what this user is permitted to see.
  const footNote = (doc) => {
    const p = doc.internal.pageSize;
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(
      "Generated from live records in the Coal Mine Governance platform. "
      + "Contents reflect the data this user is authorised to view.",
      40, p.getHeight() - 24
    );
  };

  const run = async (key, fn) => {
    setBusy(key); setError(null);
    try { await fn(); }
    catch (e) { setError(`Could not build the report: ${e.message || e}`); }
    finally { setBusy(null); }
  };

  const compliancePdf = () => run("cpdf", async () => {
    const rows = await mineComplianceRows();
    if (!rows.length) throw new Error("There are no compliance records to report.");
    const jsPDF = await loadPdfLibs();
    const doc = new jsPDF({ orientation: "landscape", unit: "pt" });
    header(doc, "Statutory compliance status",
      wide ? "All mines" : rows[0].mine + ", " + rows[0].state);
    doc.autoTable({
      startY: 92,
      head: [["Mine", "Regulation", "Area", "Requirement", "Due", "Status"]],
      body: rows.map((r) => [r.mine, r.source, r.category, r.requirement, r.due, r.status]),
      styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [22, 33, 43] },
      columnStyles: { 3: { cellWidth: 300 } },
      // Overdue rows are tinted so the reader finds them without reading
      // the status column, matching the severity rail in the interface.
      didParseCell: (d) => {
        if (d.section === "body" && d.row.raw[5] === "Overdue") {
          d.cell.styles.textColor = [165, 35, 28];
        }
      },
      didDrawPage: () => footNote(doc),
    });
    doc.save(`compliance-status-${today()}.pdf`);
  });

  const complianceCsv = () => run("ccsv", async () => {
    const rows = await mineComplianceRows();
    if (!rows.length) throw new Error("There are no compliance records to report.");
    const csv = toCsv(
      ["Mine", "State", "Regulation", "Area", "Requirement", "Due", "Status", "Completed"],
      rows.map((r) => [r.mine, r.state, r.source, r.category, r.requirement, r.due, r.status, r.completed])
    );
    download(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `compliance-status-${today()}.csv`);
  });

  const summaryPdf = () => run("spdf", async () => {
    const rows = await summaryRows();
    if (!rows.length) throw new Error("There is nothing outstanding to report.");
    const jsPDF = await loadPdfLibs();
    const doc = new jsPDF({ unit: "pt" });
    const totalOverdue = rows.reduce((a, r) => a + r.overdue, 0);
    header(doc, "Compliance summary by mine",
      `${rows.length} mines with outstanding obligations · ${totalOverdue} items overdue`);
    doc.autoTable({
      startY: 92,
      head: [["Mine", "State", "Overdue", "Pending", "Completed", "Risk"]],
      body: rows.map((r) => [r.mine, r.state, r.overdue, r.pending, r.completed,
                             r.risk === "" ? "—" : r.risk]),
      styles: { fontSize: 8.5, cellPadding: 4 },
      headStyles: { fillColor: [22, 33, 43] },
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" },
                      4: { halign: "right" }, 5: { halign: "right" } },
      didParseCell: (d) => {
        if (d.section === "body" && d.column.index === 2 && Number(d.cell.raw) > 0) {
          d.cell.styles.textColor = [165, 35, 28];
        }
      },
      didDrawPage: () => footNote(doc),
    });
    doc.save(`compliance-summary-${today()}.pdf`);
  });

  const summaryCsv = () => run("scsv", async () => {
    const rows = await summaryRows();
    if (!rows.length) throw new Error("There is nothing outstanding to report.");
    const csv = toCsv(
      ["Mine", "State", "Overdue", "Pending", "Completed", "Highest risk score"],
      rows.map((r) => [r.mine, r.state, r.overdue, r.pending, r.completed, r.risk])
    );
    download(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `compliance-summary-${today()}.csv`);
  });

  return (
    <Card title="Reports">
      {error && <Notice tone="error">{error}</Notice>}
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
        Built from live records at the moment you download them, so a report never
        disagrees with the dashboard it came from.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
        <Button onClick={compliancePdf} disabled={!!busy}>
          {busy === "cpdf" ? "Building" : "Compliance status (PDF)"}
        </Button>
        <Button variant="secondary" onClick={complianceCsv} disabled={!!busy}>
          {busy === "ccsv" ? "Building" : "Compliance status (CSV)"}
        </Button>
        {wide && (
          <>
            <Button onClick={summaryPdf} disabled={!!busy}>
              {busy === "spdf" ? "Building" : "Summary by mine (PDF)"}
            </Button>
            <Button variant="secondary" onClick={summaryCsv} disabled={!!busy}>
              {busy === "scsv" ? "Building" : "Summary by mine (CSV)"}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
