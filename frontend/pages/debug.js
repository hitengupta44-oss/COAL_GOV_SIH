// TEMPORARY DIAGNOSTIC PAGE -- visit /debug on your deployed site.
//
// This page deliberately avoids useAuth, RoleGuard and every other part of
// the app, so it renders even when the rest of the site is throwing the
// generic "Application error: a client-side exception has occurred" screen
// (which is Next.js's production error page -- it hides the real error on
// purpose). Everything it finds is printed on screen, so no DevTools
// needed. Delete this file before your final submission.

import { useEffect, useState } from "react";

export default function Debug() {
  const [log, setLog] = useState([]);
  const [testing, setTesting] = useState(false);

  const add = (label, value, ok = null) =>
    setLog((l) => [...l, { label, value: String(value), ok }]);

  useEffect(() => {
    // Catch any error the app throws while this page is open.
    const onErr = (e) =>
      add("window.onerror", `${e.message} @ ${e.filename}:${e.lineno}`, false);
    const onRej = (e) => add("unhandledrejection", e.reason, false);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);

    const backend = process.env.NEXT_PUBLIC_BACKEND_URL;
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supaKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    add("NEXT_PUBLIC_BACKEND_URL", backend ?? "(undefined -- fallback used)", !!backend);
    add("NEXT_PUBLIC_SUPABASE_URL", supaUrl ?? "(undefined!)", !!supaUrl);
    add(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      supaKey ? `set, length ${supaKey.length}` : "(undefined!)",
      !!supaKey
    );

    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  const testBackend = async () => {
    setTesting(true);
    const base = (
      process.env.NEXT_PUBLIC_BACKEND_URL || "https://beastzzz-coal-gov.hf.space"
    ).replace(/\/+$/, "");
    const url = `${base}/api/get_dashboard_summary`;
    add("calling", url);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: ["not-a-real-token", "All"] }),
      });
      add("HTTP status", res.status, res.ok);
      const text = await res.text();
      add("response body", text.slice(0, 400), res.ok);
      if (res.ok) {
        add(
          "verdict",
          "Backend reachable. An 'Invalid or expired access_token' message here is the CORRECT result.",
          true
        );
      } else if (res.status === 404) {
        add(
          "verdict",
          url.includes("hf.space")
            ? "404 from the Space itself -- app.py is missing its api_name registrations."
            : "404 from Vercel -- the request never reached the Space.",
          false
        );
      }
    } catch (e) {
      add("fetch threw", e.message, false);
      add(
        "verdict",
        "Network/CORS failure -- the browser blocked or could not reach the Space.",
        false
      );
    }
    setTesting(false);
  };

  const testSupabase = async () => {
    setTesting(true);
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const sb = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );
      const { data, error } = await sb.from("mines").select("mine_id").limit(1);
      if (error) add("supabase query error", error.message, false);
      else add("supabase query", `ok, ${data.length} row(s) returned`, true);
    } catch (e) {
      add("supabase threw", e.message, false);
    }
    setTesting(false);
  };

  return (
    <div style={{ fontFamily: "monospace", padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ fontFamily: "sans-serif" }}>Deployment diagnostics</h1>
      <p style={{ fontFamily: "sans-serif", color: "#666" }}>
        Temporary page. Delete <code>pages/debug.js</code> before submitting.
      </p>

      <div style={{ margin: "16px 0" }}>
        <button onClick={testBackend} disabled={testing} style={btn}>
          Test backend
        </button>
        <button onClick={testSupabase} disabled={testing} style={btn}>
          Test Supabase
        </button>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <tbody>
          {log.map((r, i) => (
            <tr key={i}>
              <td style={{ ...cell, width: 220, fontWeight: 700 }}>{r.label}</td>
              <td
                style={{
                  ...cell,
                  color: r.ok === false ? "#b00" : r.ok === true ? "#070" : "#222",
                  wordBreak: "break-all",
                }}
              >
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const btn = {
  padding: "8px 16px",
  marginRight: 8,
  cursor: "pointer",
  fontFamily: "sans-serif",
};
const cell = { borderBottom: "1px solid #eee", padding: 8, verticalAlign: "top" };
