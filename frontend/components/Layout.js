import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/useAuth";
import { supabase } from "../lib/supabase";
import OfflineBar from "./OfflineBar";

// Nav is built per role rather than shown-and-disabled, because a
// regulator has no use for knowing a contractor screen exists. Every
// entry here is a page that role can actually open; RoleGuard enforces
// the same rules server of the router, so the nav can't be used to reach
// anything the guard would reject.
const NAV = {
  admin: [["/dashboard/admin", "User access"]],
  corporate_admin: [["/dashboard/corporate", "Overview"]],
  regulator: [["/dashboard/regulator", "Oversight"]],
  mine_official: [["/dashboard/manager", "Mine operations"]],
  inspector: [["/dashboard/inspector", "Inspections"]],
  contractor_manager: [["/dashboard/contractor-manager", "Contractors"]],
  worker: [["/dashboard/worker", "My mine"]],
};

const ROLE_LABEL = {
  admin: "Administrator",
  corporate_admin: "Corporate management",
  regulator: "Regulator",
  mine_official: "Mine official",
  inspector: "Field inspector",
  contractor_manager: "Contractor manager",
  worker: "Worker",
};

export default function Layout({ title, subtitle, children }) {
  const { profile, logout } = useAuth();
  const router = useRouter();
  const [mine, setMine] = useState(null);

  // Mine-scoped roles get their site named in the header. Without it the
  // same screen looks identical whichever mine you're assigned to, and
  // "overdue at my mine" is meaningless if you can't see which mine.
  useEffect(() => {
    // `cancelled` guards against setting state after logout has unmounted
    // this component: the query is in flight when the session is torn down,
    // and resolving into a dead component is a classic source of the blank
    // "client-side exception" screen. The catch matters too -- once the
    // session is gone the request can reject rather than resolve.
    let cancelled = false;
    if (!profile?.mine_id) {
      setMine(null);
      return;
    }
    supabase
      .from("mines")
      .select("mine_name, state")
      .eq("mine_id", profile.mine_id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setMine(data || null);
      })
      .catch(() => {
        if (!cancelled) setMine(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.mine_id]);

  const links = NAV[profile?.role] || [];

  return (
    <div className="app">
      <nav className="sidebar">
        <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid rgba(255,255,255,.10)" }}>
          <div style={{ color: "#fff", fontWeight: 600, fontSize: 15, lineHeight: 1.3 }}>
            Coal Mine Governance
          </div>
          <div style={{ fontSize: 12.5, color: "#8FA2B4", marginTop: 2 }}>
            Compliance &amp; safety oversight
          </div>
        </div>

        <div style={{ padding: "14px 0", flex: 1 }}>
          {links.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="navlink"
              aria-current={router.pathname === href ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </div>

        <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,.10)" }}>
          <div style={{ color: "#fff", fontSize: 14 }}>{profile?.full_name || profile?.email}</div>
          <div style={{ fontSize: 12.5, color: "#8FA2B4", marginBottom: 10 }}>
            {ROLE_LABEL[profile?.role] || profile?.role}
          </div>
          <button
            onClick={() => {
              // Errors here are swallowed on purpose: whatever happens to
              // the network call, the user asked to leave, and useAuth
              // clears local state either way.
              Promise.resolve(logout()).catch(() => {});
            }}
            style={{
              background: "none",
              border: "1px solid rgba(255,255,255,.28)",
              color: "#C9D4DE",
              padding: "6px 12px",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            Log out
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="content">
          <header style={{ marginBottom: 24 }}>
            <h1>{title}</h1>
            <p style={{ color: "var(--ink-soft)", margin: "4px 0 0", fontSize: 14 }}>
              {subtitle}
              {mine && (subtitle ? " · " : "") + `${mine.mine_name}, ${mine.state}`}
            </p>
          </header>
          <OfflineBar />
          {children}
        </div>
      </main>
    </div>
  );
}
