import { useEffect, useState } from "react";
import RoleGuard from "../../components/RoleGuard";
import Layout from "../../components/Layout";
import { Card, StatStrip, Table, Button, Notice } from "../../components/ui";
import { GeoBadge } from "../../components/Evidence";
import { useAuth } from "../../lib/useAuth";
import { useT } from "../../lib/i18n";
import { supabase } from "../../lib/supabase";
import { getPosition, isOnline } from "../../lib/geo";
import { enqueue } from "../../lib/offlineQueue";

// Personal, geo-fenced attendance.
//
// Each person checks themselves in and out; the device supplies the
// position, and the database -- not this page -- decides the identity,
// the mine, the shift and whether the position is inside the mine's
// geo-fence (migration 07). A headcount built from these events can be
// traced back to people and places, which a typed-in shift total cannot.

const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

function MyAttendance() {
  const { profile } = useAuth();
  const { t } = useT();
  const [open, setOpen] = useState(undefined);   // undefined = loading, null = none
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data } = await supabase
      .from("attendance_checkins")
      .select("checkin_id, shift, check_in_at, check_out_at, check_in_within_geofence, check_in_distance_m, "
            + "check_out_within_geofence, check_out_distance_m")
      .eq("profile_id", profile.profile_id)
      .order("check_in_at", { ascending: false })
      .limit(30);
    const rows = data || [];
    setOpen(rows.find((r) => !r.check_out_at) || null);
    setHistory(rows);
  };

  useEffect(() => { if (profile?.profile_id) load(); }, [profile?.profile_id]);

  const act = async (kind) => {
    if (!profile?.mine_id) return setStatus({ tone: "error", text: t("noMine") });
    setBusy(true);
    setStatus({ tone: "info", text: t("location.getting") });
    let pos;
    try {
      pos = await getPosition();
    } catch (e) {
      setBusy(false);
      return setStatus({ tone: "error", text: e.code === "refused" ? t("location.refused") : t("location.none") });
    }
    const at = new Date().toISOString();

    // No signal: the event, its device time and its position are kept and
    // sent later. The server accepts device times up to 72 hours old.
    const queue = async () => {
      await enqueue(kind, { at, ...pos, checkinId: open?.checkin_id || null }, profile?.profile_id);
      setStatus({ tone: "info", text: t("savedOffline") });
      if (kind === "checkin") setOpen({ checkin_id: null, check_in_at: at, shift: "—", pending: true });
      else setOpen(null);
    };

    try {
      if (!isOnline()) return await queue();
      let res;
      if (kind === "checkin") {
        res = await supabase.from("attendance_checkins").insert({
          profile_id: profile.profile_id, mine_id: profile.mine_id,
          check_in_lat: pos.latitude, check_in_lon: pos.longitude,
        }).select("check_in_within_geofence").single();
      } else {
        res = await supabase.from("attendance_checkins").update({
          check_out_at: at, check_out_lat: pos.latitude, check_out_lon: pos.longitude,
        }).eq("checkin_id", open.checkin_id).select("check_out_within_geofence").single();
      }
      if (res.error) {
        if (/fetch|network/i.test(res.error.message)) return await queue();
        return setStatus({ tone: "error", text: res.error.message });
      }
      const inside = kind === "checkin" ? res.data.check_in_within_geofence : res.data.check_out_within_geofence;
      setStatus(inside === false
        ? { tone: "error", text: `${t(kind === "checkin" ? "att.done.in" : "att.done.out")} ${t("att.outside")}` }
        : { tone: "success", text: t(kind === "checkin" ? "att.done.in" : "att.done.out") });
      load();
    } catch (e) {
      try { await queue(); } catch { setStatus({ tone: "error", text: String(e.message || e) }); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={t("att.title")} style={{ maxWidth: 560 }}
            severity={open ? "Completed" : undefined}>
        {status && <Notice tone={status.tone}>{status.text}</Notice>}
        {open === undefined ? null : open ? (
          <>
            <p style={{ fontSize: 16, margin: "0 0 14px" }}>
              <strong>{t("att.onSite")}</strong> {t("att.since")} {fmt(open.check_in_at)}
              {open.shift && open.shift !== "—" && <> · {t("att.shift")} {open.shift}</>}
            </p>
            <Button onClick={() => act("checkout")} disabled={busy} style={{ minWidth: 160, padding: "12px 18px" }}>
              {t("att.checkOut")}
            </Button>
          </>
        ) : (
          <>
            <p style={{ fontSize: 16, margin: "0 0 14px", color: "var(--ink-soft)" }}>{t("att.notIn")}</p>
            <Button onClick={() => act("checkin")} disabled={busy} style={{ minWidth: 160, padding: "12px 18px" }}>
              {t("att.checkIn")}
            </Button>
          </>
        )}
        <p style={{ fontSize: 13, color: "var(--ink-faint)", margin: "14px 0 0" }}>{t("att.hint")}</p>
      </Card>

      <Card title={t("att.history")}>
        <Table
          columns={[
            { key: "in", label: t("att.in"), nowrap: true, render: (r) => fmt(r.check_in_at) },
            { key: "out", label: t("att.out"), nowrap: true, render: (r) => fmt(r.check_out_at) },
            { key: "shift", label: t("att.shift"), width: 70 },
            { key: "place", label: t("att.place"),
              render: (r) => <GeoBadge within={r.check_in_within_geofence === false || r.check_out_within_geofence === false
                                          ? false : r.check_in_within_geofence}
                                        distance={r.check_in_distance_m} /> },
          ]}
          rows={history}
          countLabel="shifts"
          severityOf={(r) => (r.check_in_within_geofence === false || r.check_out_within_geofence === false) ? "High" : null}
          empty={t("att.none")}
        />
      </Card>
    </>
  );
}

// The mine official's view: who is on site now, and which records need a
// second look because they were made away from the mine.
function MineRoster() {
  const { profile } = useAuth();
  const [rows, setRows] = useState(null);
  const [daily, setDaily] = useState([]);

  useEffect(() => {
    if (!profile?.mine_id) return;
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    supabase.from("attendance_checkin_view")
      .select("checkin_id, full_name, role, shift, check_in_at, check_out_at, hours_on_site, "
            + "check_in_within_geofence, check_in_distance_m, check_out_within_geofence, check_out_distance_m, geofence_exception")
      .eq("mine_id", profile.mine_id).gte("check_in_at", since)
      .order("check_in_at", { ascending: false }).limit(1000)
      .then(({ data }) => setRows(data || []));
    supabase.from("attendance_daily_view").select("*").eq("mine_id", profile.mine_id)
      .order("attendance_date", { ascending: false }).limit(60)
      .then(({ data }) => setDaily(data || []));
  }, [profile?.mine_id]);

  const list = rows || [];
  const onSite = list.filter((r) => !r.check_out_at);
  const exceptions = list.filter((r) => r.geofence_exception);
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = daily.filter((d) => d.attendance_date === today).reduce((s, d) => s + d.present, 0);

  return (
    <>
      <StatStrip items={[
        { label: "On site now", value: onSite.length },
        { label: "Checked in today", value: todayCount },
        { label: "Location exceptions, 14 days", value: exceptions.length, tone: exceptions.length ? "high" : null,
          note: "Recorded outside the mine boundary" },
      ]} />

      <Card title="On site now">
        <Table
          columns={[
            { key: "full_name", label: "Person", render: (r) => <strong>{r.full_name || "—"}</strong> },
            { key: "role", label: "Role", width: 150, render: (r) => (r.role || "").replace("_", " ") },
            { key: "shift", label: "Shift", width: 70 },
            { key: "check_in_at", label: "Since", nowrap: true, render: (r) => fmt(r.check_in_at) },
            { key: "geo", label: "Checked in", render: (r) => <GeoBadge within={r.check_in_within_geofence} distance={r.check_in_distance_m} /> },
          ]}
          rows={onSite}
          countLabel="people"
          empty="Nobody is checked in right now."
        />
      </Card>

      <Card title="Records made outside the mine boundary" severity={exceptions.length ? "High" : undefined}>
        <p style={{ color: "var(--ink-soft)", fontSize: 14, marginTop: -4 }}>
          Either the record was not made at the mine, or the mine&apos;s recorded location needs correcting.
          Both are worth a conversation.
        </p>
        <Table
          columns={[
            { key: "full_name", label: "Person", render: (r) => <strong>{r.full_name || "—"}</strong> },
            { key: "check_in_at", label: "Shift started", nowrap: true, render: (r) => fmt(r.check_in_at) },
            { key: "in", label: "Check-in", render: (r) => <GeoBadge within={r.check_in_within_geofence} distance={r.check_in_distance_m} /> },
            { key: "out", label: "Check-out", render: (r) => r.check_out_at
                ? <GeoBadge within={r.check_out_within_geofence} distance={r.check_out_distance_m} /> : "On site" },
          ]}
          rows={exceptions}
          countLabel="records"
          severityOf={() => "High"}
          empty="Every check-in and check-out in the last 14 days was at the mine."
        />
      </Card>

      <Card title="Daily headcount">
        <Table
          columns={[
            { key: "attendance_date", label: "Date", width: 120, nowrap: true },
            { key: "shift", label: "Shift", width: 70 },
            { key: "present", label: "Present", align: "right", width: 90 },
            { key: "geofence_exceptions", label: "Location exceptions", align: "right", width: 160 },
            { key: "still_on_site", label: "Not checked out", align: "right", width: 140 },
          ]}
          rows={daily}
          countLabel="shifts"
          severityOf={(d) => (d.geofence_exceptions ? "Medium" : null)}
          empty="No check-ins recorded yet."
        />
      </Card>
    </>
  );
}

function AttendanceContent() {
  const { profile } = useAuth();
  const { t } = useT();
  return (
    <Layout title={t("att.title")} subtitle="">
      <MyAttendance />
      {profile?.role === "mine_official" && <MineRoster />}
    </Layout>
  );
}

export default function AttendancePage() {
  return (
    <RoleGuard allowedRoles={["worker", "inspector", "contractor_manager", "mine_official"]}>
      <AttendanceContent />
    </RoleGuard>
  );
}
