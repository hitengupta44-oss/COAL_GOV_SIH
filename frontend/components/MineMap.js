import { useEffect, useRef, useState } from "react";
import { Card, Badge } from "./ui";
import { useAuth } from "../lib/useAuth";
import { supabase } from "../lib/supabase";

// Leaflet is loaded from a CDN at runtime rather than bundled.
//
// react-leaflet needs dynamic imports and SSR guards in Next.js, and
// pulling the whole library into the bundle to draw circles on a tile
// layer is a poor trade. Loading it on demand also means the map costs
// nothing on the dashboards where nobody opens it.
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.L) return resolve(window.L);

    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${LEAFLET_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.L));
      existing.addEventListener("error", () => reject(new Error("Leaflet failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error("Leaflet failed to load"));
    document.head.appendChild(s);
  });
}

// Bands rather than a continuous gradient: a reader can hold four
// categories in their head and match them to the badges elsewhere in the
// platform, which a smooth colour ramp doesn't allow.
const BANDS = [
  { min: 0.9, label: "Critical", color: "#A5231C" },
  { min: 0.7, label: "High", color: "#C2410C" },
  { min: 0.4, label: "Medium", color: "#B47600" },
  { min: 0, label: "Low", color: "#2E7D4F" },
];
const bandFor = (score) =>
  BANDS.find((b) => (score ?? 0) >= b.min) || BANDS[BANDS.length - 1];

export default function MineMap({ height = 460 }) {
  const { profile } = useAuth();
  const holder = useRef(null);
  const mapRef = useRef(null);
  const observerRef = useRef(null);
  const [status, setStatus] = useState("Loading map");
  const [counts, setCounts] = useState(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Mines carry the coordinates; risk scores live separately, so the
        // highest score per mine is folded in here rather than in the
        // query -- PostgREST has no clean "max per group" for this shape.
        const { data: mines, error } = await supabase
          .from("mines")
          .select("mine_id, mine_name, state, district, latitude, longitude")
          .not("latitude", "is", null)
          .not("longitude", "is", null)
          .limit(1000);
        if (error) throw error;

        const { data: flags } = await supabase
          .from("ai_risk_flags")
          .select("mine_id, risk_score, flag_type")
          .limit(2000);

        const worst = {};
        (flags || []).forEach((f) => {
          const cur = worst[f.mine_id];
          if (!cur || (f.risk_score ?? 0) > (cur.risk_score ?? 0)) worst[f.mine_id] = f;
        });

        // Mine-scoped roles see only their own site, matching the RLS
        // rules everywhere else. A worker shouldn't get a national map.
        const scoped = (mines || []).filter(
          (m) =>
            ["corporate_admin", "regulator", "admin"].includes(profile?.role) ||
            !profile?.mine_id ||
            m.mine_id === profile.mine_id
        );

        if (cancelled) return;
        if (!scoped.length) {
          setStatus("No mines with recorded coordinates.");
          return;
        }

        const L = await loadLeaflet();
        if (cancelled || !holder.current) return;

        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }

        const map = L.map(holder.current, { scrollWheelZoom: false });
        mapRef.current = map;

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors",
          maxZoom: 18,
        }).addTo(map);

        const tally = { Critical: 0, High: 0, Medium: 0, Low: 0 };
        const points = [];

        scoped.forEach((m) => {
          const flag = worst[m.mine_id];
          const band = flag ? bandFor(flag.risk_score) : BANDS[BANDS.length - 1];
          tally[band.label] += 1;
          const lat = Number(m.latitude);
          const lng = Number(m.longitude);
          points.push([lat, lng]);

          L.circleMarker([lat, lng], {
            radius: flag ? 7 : 4,
            color: band.color,
            weight: flag ? 2 : 1,
            fillColor: band.color,
            fillOpacity: flag ? 0.75 : 0.4,
          })
            .addTo(map)
            .bindPopup(
              `<strong>${m.mine_name}</strong><br>` +
                `${[m.district, m.state].filter(Boolean).join(", ")}<br>` +
                (flag
                  ? `<span style="color:${band.color}">${band.label} — ${flag.flag_type}</span>` +
                    ` (${flag.risk_score})`
                  : "No risk flag recorded")
            );
        });

        setCounts(tally);
        setStatus(null);

        // Leaflet measures its container once, at construction. This card
        // is still being laid out at that moment -- and it was hidden
        // (display:none) while `status` was set -- so the map computed a
        // near-zero size and only ever requested the handful of tiles that
        // fitted it. That is the grey area with a sliver of map in the
        // corner.
        //
        // invalidateSize() forces a re-measure. It runs after the browser
        // has painted, then the bounds are applied so the fit is against
        // the real dimensions rather than the stale ones.
        requestAnimationFrame(() => {
          if (cancelled || !mapRef.current) return;
          map.invalidateSize(false);
          map.fitBounds(points, { padding: [30, 30], maxZoom: 8 });
        });

        // Anything that changes the card's width later -- the window
        // resizing, the sidebar reflowing at a breakpoint, a panel above
        // expanding -- leaves the same stale measurement behind, so keep
        // watching rather than measuring once.
        if (typeof ResizeObserver !== "undefined") {
          const ro = new ResizeObserver(() => {
            if (mapRef.current) mapRef.current.invalidateSize(false);
          });
          ro.observe(holder.current);
          observerRef.current = ro;
        }
      } catch (e) {
        if (!cancelled) setStatus(`Could not draw the map: ${e.message || e}`);
      }
    })();

    return () => {
      cancelled = true;
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [profile?.role, profile?.mine_id]);

  return (
    <Card
      title="Where the risk sits"
      action={
        counts ? (
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            {Object.values(counts).reduce((a, b) => a + b, 0)} mines plotted
          </span>
        ) : null
      }
    >
      {status && (
        <p style={{ color: "var(--ink-faint)", fontSize: 14 }}>{status}</p>
      )}

      <div
        ref={holder}
        style={{
          height,
          width: "100%",
          borderRadius: "var(--radius)",
          border: "1px solid var(--line)",
          // Kept in the layout rather than display:none while loading:
          // Leaflet cannot measure a hidden element, and a map built
          // against a zero-size container never recovers on its own.
          visibility: status ? "hidden" : "visible",
        }}
      />

      {counts && (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, fontSize: 13 }}>
          {BANDS.map((b) => (
            <span key={b.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 10, height: 10, borderRadius: "50%",
                  background: b.color, display: "inline-block",
                }}
              />
              {b.label}
              <span style={{ color: "var(--ink-faint)" }}>{counts[b.label]}</span>
            </span>
          ))}
          <span style={{ color: "var(--ink-faint)" }}>
            Larger markers carry an active risk flag.
          </span>
        </div>
      )}
    </Card>
  );
}
