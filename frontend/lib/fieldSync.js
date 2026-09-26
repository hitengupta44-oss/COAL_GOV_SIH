// How each kind of record saved offline is sent once there is a signal.
// Used by OfflineBar for automatic and manual sync.
//
// Photos travel inside the queued record as a Blob (IndexedDB stores them
// natively) and are uploaded first, so the record that references them is
// only written once its evidence is safely stored.
import { supabase } from "./supabase";
import { logFieldInspection } from "./api";
import { uploadEvidence } from "./evidence";

export function syncHandlers({ getAccessToken, profile }) {
  const insert = async (table, row) => {
    const { data, error } = await supabase.from(table).insert(row).select();
    if (error) return { error: error.message };
    if (!data?.length) return { error: "Rejected by the database." };
    return {};
  };

  return {
    inspection: async (p) => {
      const token = await getAccessToken();
      const { photoBlob, ...rest } = p;
      const photoPath = photoBlob ? await uploadEvidence(rest.mineId, "inspections", photoBlob) : rest.photoPath;
      const res = await logFieldInspection(token, { ...rest, photoPath });
      return res?.error ? { error: res.error } : {};
    },

    grievance: (row) => insert("grievances", row),

    // Crew attendance recorded offline: same row, sent as an upsert so a
    // re-sent record for the same shift replaces rather than duplicates.
    crew: async (row) => {
      const { data, error } = await supabase.from("contractor_crew_attendance")
        .upsert(row, { onConflict: "contractor_id,attendance_date,shift" }).select();
      if (error) return { error: error.message };
      return data?.length ? {} : { error: "Rejected by the database." };
    },

    incident: async (p) => {
      const { photoBlob, ...row } = p;
      if (photoBlob) row.photo_url = await uploadEvidence(row.mine_id, "incidents", photoBlob);
      return insert("incidents", row);
    },

    // The server accepts a device time within 72 hours when the record is
    // marked captured_offline; the geo-fence check happens on arrival.
    checkin: (p) => insert("attendance_checkins", {
      profile_id: profile?.profile_id, mine_id: profile?.mine_id,
      check_in_at: p.at, check_in_lat: p.latitude, check_in_lon: p.longitude, captured_offline: true,
    }),

    checkout: async (p) => {
      // If the check-in was itself queued offline it had no id when this
      // was saved; queue order guarantees it has been sent by now.
      let id = p.checkinId;
      if (!id) {
        const { data } = await supabase.from("attendance_checkins").select("checkin_id")
          .eq("profile_id", profile?.profile_id).is("check_out_at", null).limit(1);
        id = data?.[0]?.checkin_id;
      }
      if (!id) return { error: "No open check-in to close." };
      const { data, error } = await supabase.from("attendance_checkins").update({
        check_out_at: p.at, check_out_lat: p.latitude, check_out_lon: p.longitude, captured_offline: true,
      }).eq("checkin_id", id).select();
      if (error) return { error: error.message };
      return data?.length ? {} : { error: "Check-out was not saved." };
    },
  };
}
