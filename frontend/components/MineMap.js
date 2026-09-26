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
const HEAT_JS = "https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js";

// The heatmap plugin is optional: if it cannot load (offline, blocked),
// the map still draws every other layer.
function loadHeat(L) {
  return new Promise((resolve) => {
    if (L.heatLayer) return resolve(true);
    const s = document.createElement("script");
    s.src = HEAT_JS;
    s.onload = () => resolve(Boolean(L.heatLayer));
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// Same radii the database uses to decide whether a record was made at the
// mine (migration 07, geofence_radius_m).
const geofenceRadius = (accuracy) => (String(accuracy || "").toLowerCase() === "exact" ? 5000 : 25000);

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEV_COLOR = { Critical: "#A5231C", High: "#C2410C", Medium: "#B47600", Low: "#2E7D4F" };

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
          .select("mine_id, mine_name, state, district, latitude, longitude, geo_accuracy")
          .not("latitude", "is", null)
          .not("longitude", "is", null)
          .limit(1000);
        if (error) throw error;

        const { data: flags } = await supabase
          .from("ai_risk_flags")
          .select("mine_id, risk_score, flag_type")
          .limit(2000);

        // Operational layers. RLS already limits each to what this person
        // may see, so a mine official gets their mine and a regulator gets
        // the country. A layer whose source is unavailable is just left out.
        const since = new Date(Date.now() - 90 * 864e5).toISOString();
        const safe = async (q) => { try { const { data } = await q; return data || []; } catch { return []; } };
        const [findings, incidents, offsite] = await Promise.all([
          safe(supabase.from("corrective_action_view")
            .select("inspection_id, mine_name, observation_type, severity, notes, latitude, longitude, corrective_action_status, action_due_date, is_late, within_geofence")
            .neq("corrective_action_status", "Closed").not("latitude", "is", null).limit(1500)),
          safe(supabase.from("incident_view")
            .select("incident_id, mine_name, incident_type, severity, occurred_at, status, latitude, longitude, persons_killed, persons_injured")
            .gte("occurred_at", since).not("latitude", "is", null).limit(1000)),
          safe(supabase.from("attendance_checkin_view")
            .select("checkin_id, full_name, check_in_at, check_in_lat, check_in_lon, check_in_distance_m, mine_id")
            .eq("check_in_within_geofence", false).gte("check_in_at", since).limit(500)),
        ]);

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
        const minesLayer = L.layerGroup();
        const heatPoints = [];

        scoped.forEach((m) => {
          const flag = worst[m.mine_id];
          const band = flag ? bandFor(flag.risk_score) : BANDS[BANDS.length - 1];
          tally[band.label] += 1;
          const lat = Number(m.latitude);
          const lng = Number(m.longitude);
          points.push([lat, lng]);
          if (flag) heatPoints.push([lat, lng, Math.max(0.15, Number(flag.risk_score) || 0)]);

          L.circleMarker([lat, lng], {
            radius: flag ? 7 : 4,
            color: band.color,
            weight: flag ? 2 : 1,
            fillColor: band.color,
            fillOpacity: flag ? 0.75 : 0.4,
          })
            .addTo(minesLayer)
            .bindPopup(
              `<strong>${esc(m.mine_name)}</strong><br>` +
                `${esc([m.district, m.state].filter(Boolean).join(", "))}<br>` +
                (flag
                  ? `<span style="color:${band.color}">${band.label} — ${esc(flag.flag_type)}</span>` +
                    ` (${esc(flag.risk_score)})`
                  : "No risk flag recorded")
            );
        });
        minesLayer.addTo(map);

        // Open inspection findings: square-ish markers so they read as a
        // different kind of thing from the mines. Late ones are outlined.
        const findingsLayer = L.layerGroup();
        findings.forEach((f) => {
          const c = SEV_COLOR[f.severity] || SEV_COLOR.Medium;
          L.circleMarker([Number(f.latitude), Number(f.longitude)], {
            radius: 5, color: f.is_late ? "#16212B" : c, weight: f.is_late ? 2 : 1,
            fillColor: c, fillOpacity: 0.9, dashArray: f.within_geofence === false ? "2 2" : null,
          }).addTo(findingsLayer).bindPopup(
            `<strong>${esc(f.observation_type)}</strong> · ${esc(f.severity)}<br>${esc(f.mine_name)}<br>` +
            `Status: ${esc(f.corrective_action_status)}${f.is_late ? " — <b>past its deadline</b>" : ""}<br>` +
            `Action due ${esc(f.action_due_date)}` +
            (f.within_geofence === false ? "<br><i>Recorded outside the mine boundary</i>" : "") +
            (f.notes ? `<br><span style="color:#46586B">${esc(f.notes).slice(0, 160)}</span>` : ""));
        });

        // Incidents: a ring whose size follows severity.
        const incidentsLayer = L.layerGroup();
        incidents.forEach((i) => {
          const c = SEV_COLOR[i.severity] || SEV_COLOR.High;
          L.circleMarker([Number(i.latitude), Number(i.longitude)], {
            radius: i.severity === "Critical" ? 11 : i.severity === "High" ? 9 : 6,
            color: c, weight: 3, fillOpacity: 0,
          }).addTo(incidentsLayer).bindPopup(
            `<strong>${esc(i.incident_type)}</strong><br>${esc(i.mine_name)}<br>` +
            `${new Date(i.occurred_at).toLocaleString()}<br>` +
            `${Number(i.persons_killed) ? `${i.persons_killed} killed, ` : ""}${esc(i.persons_injured || 0)} injured · ${esc(i.status)}`);
        });

        // Check-ins made away from the mine, joined to the mine they claim.
        const offsiteLayer = L.layerGroup();
        const mineById = Object.fromEntries((mines || []).map((m) => [m.mine_id, m]));
        offsite.forEach((a) => {
          const at = [Number(a.check_in_lat), Number(a.check_in_lon)];
          const m = mineById[a.mine_id];
          if (m) {
            L.polyline([at, [Number(m.latitude), Number(m.longitude)]],
              { color: "#C2410C", weight: 1.5, dashArray: "4 4", opacity: 0.8 }).addTo(offsiteLayer);
          }
          L.circleMarker(at, { radius: 5, color: "#C2410C", fillColor: "#fff", fillOpacity: 1, weight: 2 })
            .addTo(offsiteLayer)
            .bindPopup(`<strong>Check-in outside the boundary</strong><br>${esc(a.full_name || "")}<br>` +
              `${new Date(a.check_in_at).toLocaleString()}<br>` +
              `${a.check_in_distance_m != null ? (Number(a.check_in_distance_m) / 1000).toFixed(1) + " km from " : ""}${esc(m?.mine_name || "the mine")}`);
        });

        // A mine-level user sees their own geo-fence, the line the platform
        // uses to accept or flag every geo-tagged record at their mine.
        const fenceLayer = L.layerGroup();
        const singleMine = Boolean(profile?.mine_id) && scoped.length === 1;
        let fenceBounds = null;
        if (singleMine) {
          const m = scoped[0];
          fenceBounds = L.latLng(Number(m.latitude), Number(m.longitude)).toBounds(2 * geofenceRadius(m.geo_accuracy));
          L.circle([Number(m.latitude), Number(m.longitude)], {
            radius: geofenceRadius(m.geo_accuracy), color: "#1A5490", weight: 1.5, dashArray: "6 4", fillOpacity: 0.04,
          }).addTo(fenceLayer).bindPopup(
            `Geo-fence: ${geofenceRadius(m.geo_accuracy) / 1000} km around the recorded location` +
            ` (${String(m.geo_accuracy || "approximate").toLowerCase()} coordinates)`);
          fenceLayer.addTo(map);
        }

        const overlays = {
          [`Mines by risk (${scoped.length})`]: minesLayer,
          [`Open findings (${findings.length})`]: findingsLayer,
          [`Incidents, 90 days (${incidents.length})`]: incidentsLayer,
          [`Check-ins outside boundary (${offsite.length})`]: offsiteLayer,
        };
        if (singleMine) overlays["Geo-fence"] = fenceLayer;
        // Findings and incidents start switched on where there are few
        // enough to read; across the whole country they start off.
        if (findings.length && findings.length <= 300) findingsLayer.addTo(map);
        if (incidents.length) incidentsLayer.addTo(map);
        if (offsite.length) offsiteLayer.addTo(map);

        if (heatPoints.length > 1 && await loadHeat(L) && !cancelled) {
          overlays["Risk heatmap"] = L.heatLayer(heatPoints, {
            radius: 28, blur: 22, maxZoom: 9, minOpacity: 0.25,
            gradient: { 0.3: "#2E7D4F", 0.55: "#B47600", 0.75: "#C2410C", 1.0: "#A5231C" },
          });
        }
        L.control.layers(null, overlays, { collapsed: false, position: "topright" }).addTo(map);

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
          // One mine: frame its geo-fence and everything recorded around it,
          // so an off-site record is visible rather than cropped out.
          if (singleMine) {
            let bounds = L.latLngBounds(points);
            // Computed from centre and radius: a circle cannot measure itself
            // until the map has a view, which is what this call sets.
            if (fenceBounds) bounds = bounds.extend(fenceBounds);
            [...findings.map((f) => [f.latitude, f.longitude]), ...incidents.map((i) => [i.latitude, i.longitude]),
             ...offsite.map((a) => [a.check_in_lat, a.check_in_lon])]
              .forEach(([la, lo]) => { if (la != null && lo != null) bounds = bounds.extend([Number(la), Number(lo)]); });
            map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
          } else {
            map.fitBounds(points, { padding: [30, 30], maxZoom: 8 });
          }
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
            Larger markers carry an active risk flag. Use the layer list on the map to show
            findings (small dots; dark outline = past deadline, dashed = recorded off-site),
            incidents (rings, sized by severity), off-site check-ins and the risk heatmap.
          </span>
        </div>
      )}
    </Card>
  );
}
