import { useEffect, useState } from "react";
import { listQueue, syncQueue } from "../lib/offlineQueue";
import { useAuth } from "../lib/useAuth";
import { logFieldInspection } from "../lib/api";
import { supabase } from "../lib/supabase";

// A standing indicator of connection state and anything waiting to be
// sent.
//
// Shown only when it has something to say. A permanent "you are online"
// badge is noise; a person needs to know the moment they are NOT, and
// whether anything they recorded is still sitting on the device.
export default function OfflineBar() {
  const { profile, getAccessToken } = useAuth();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState(null);

  const refresh = async () => {
    try { setPending((await listQueue()).length); } catch { /* no IndexedDB */ }
  };

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const token = await getAccessToken();
      const { sent, failed } = await syncQueue({
        inspection: (p) => logFieldInspection(token, p),
        grievance: async (p) => {
          const { data, error } = await supabase.from("grievances").insert(p).select();
          if (error) return { error: error.message };
          if (!data?.length) return { error: "Rejected by the database." };
          return {};
        },
      });
      if (sent) setNote(`${sent} record${sent > 1 ? "s" : ""} sent.`);
      if (failed) setNote(`${failed} could not be sent. They are still saved on this device.`);
    } finally {
      setSyncing(false);
      refresh();
      setTimeout(() => setNote(null), 6000);
    }
  };

  useEffect(() => {
    refresh();
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);

    const up = () => { setOnline(true); runSync(); };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);

    // Also poll, because a device can be "online" by the browser's
    // reckoning while still having no usable route out of a pit.
    const t = setInterval(refresh, 15000);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      clearInterval(t);
    };
  }, [profile?.profile_id]);

  if (online && !pending && !note) return null;

  const bg = !online ? "var(--sev-medium-wash)" : pending ? "var(--primary-wash)" : "var(--sev-low-wash)";
  const edge = !online ? "var(--sev-medium)" : pending ? "var(--primary)" : "var(--sev-low)";

  return (
    <div style={{
      background: bg, borderLeft: `3px solid ${edge}`, padding: "10px 14px",
      borderRadius: 3, marginBottom: 16, fontSize: 14,
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    }}>
      <span>
        {!online && "No connection. Anything you record is saved on this device and sent when you get a signal."}
        {online && pending > 0 && `${pending} record${pending > 1 ? "s" : ""} waiting to be sent.`}
        {online && !pending && note}
      </span>
      {online && pending > 0 && (
        <button onClick={runSync} disabled={syncing}
          style={{ background: "none", border: "none", color: "var(--primary)",
                   cursor: "pointer", fontSize: 14, whiteSpace: "nowrap" }}>
          {syncing ? "Sending" : "Send now"}
        </button>
      )}
    </div>
  );
}
