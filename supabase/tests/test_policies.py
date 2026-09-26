"""
Database policy and workflow tests.

Runs every migration against a throwaway Postgres, then acts as each role
(by setting the same JWT claims Supabase sets) and checks that what should
succeed succeeds and what should be refused is refused.

    PGHOST=localhost PGUSER=postgres PGPASSWORD=... PGDATABASE=coal_test \
      python tests/test_policies.py

The database must already have the Supabase stubs (tests/supabase_stub.sql)
and schema.sql + migrations 02..09 applied. See tests/run_tests.sh.
"""

import os
import sys
import uuid
import traceback

import psycopg2
import psycopg2.extras

psycopg2.extras.register_uuid()

conn = psycopg2.connect(
    host=os.environ.get("PGHOST", "localhost"),
    user=os.environ.get("PGUSER", "postgres"),
    password=os.environ.get("PGPASSWORD", ""),
    dbname=os.environ.get("PGDATABASE", "coal_test"),
)
conn.autocommit = False

PASSED, FAILED = [], []


# ------------------------------------------------------------------ helpers
def admin(sql, args=None, fetch=False):
    """Run as the database owner (like the service role / SQL editor)."""
    with conn.cursor() as cur:
        cur.execute(sql, args)
        out = cur.fetchall() if fetch else None
    conn.commit()
    return out


def as_user(uid, sql, args=None, fetch=True):
    """Run one statement as a signed-in user. Rolled back afterwards unless
    the caller commits via as_user_commit."""
    with conn.cursor() as cur:
        cur.execute("set local role authenticated" if uid else "set local role anon")
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(uid) if uid else "",))
        cur.execute("select set_config('request.jwt.claim.role', %s, true)", ("authenticated" if uid else "anon",))
        cur.execute(sql, args)
        return cur.fetchall() if fetch and cur.description else None


def run(uid, sql, args=None, fetch=True):
    """As a user, committed. Returns rows."""
    try:
        out = as_user(uid, sql, args, fetch)
        conn.commit()
        return out
    except Exception:
        conn.rollback()
        raise


def refused(uid, sql, args=None, contains=None):
    """True if the statement errors (or silently affects zero rows)."""
    try:
        out = as_user(uid, sql, args, fetch=True)
        conn.rollback()
        # An RLS-filtered UPDATE/INSERT ... RETURNING returns no rows.
        return out is not None and len(out) == 0
    except Exception as e:
        conn.rollback()
        return contains is None or contains.lower() in str(e).lower()


def check(name, cond):
    (PASSED if cond else FAILED).append(name)
    print(("  ok   " if cond else "  FAIL ") + name)


# ------------------------------------------------------------------ fixtures
def setup():
    admin("insert into subsidiaries (subsidiary_code, subsidiary_name) values ('TST','Test Coal') "
          "on conflict do nothing")
    sub = admin("select subsidiary_id from subsidiaries where subsidiary_code='TST'", fetch=True)[0][0]
    A, B = uuid.uuid4(), uuid.uuid4()
    admin("insert into mines (mine_id, mine_name, state, subsidiary_id, latitude, longitude, geo_accuracy, mine_type) "
          "values (%s,'Alpha OC','Jharkhand',%s,23.80,86.40,'Exact','OC'), "
          "       (%s,'Bravo UG','Odisha',%s,21.90,84.00,'Approximate','UG')", (A, sub, B, sub))
    admin("insert into statutory_compliance_items (regulation_source, category, requirement_summary, frequency) "
          "values ('CMR 2017 test','Safety','Test requirement','Monthly')")
    item = admin("select max(item_id) from statutory_compliance_items", fetch=True)[0][0]

    people = {}
    for key, role, mine in [
        ("worker_a", "worker", A), ("worker_a2", "worker", A), ("worker_b", "worker", B),
        ("official_a", "mine_official", A), ("official_b", "mine_official", B),
        ("inspector_a", "inspector", A), ("inspector_a2", "inspector", A),
        ("contractor_a", "contractor_manager", A),
        ("corporate", "corporate_admin", None), ("corporate2", "corporate_admin", None),
        ("regulator", "regulator", None), ("admin", "admin", None),
    ]:
        uid, pid = uuid.uuid4(), uuid.uuid4()
        admin("insert into auth.users (id, email) values (%s, %s)", (uid, f"{key}@t.in"))
        admin("insert into user_profiles (profile_id, auth_uid, full_name, email, role, mine_id, subsidiary_id) "
              "values (%s,%s,%s,%s,%s,%s,%s)", (pid, uid, key.replace("_", " ").title(), f"{key}@t.in", role, mine, sub))
        people[key] = (uid, pid)
    return A, B, sub, item, people


# ------------------------------------------------------------------ tests
def main():
    A, B, sub, item, P = setup()
    u = {k: v[0] for k, v in P.items()}
    p = {k: v[1] for k, v in P.items()}

    print("\nRow level security coverage")
    off = admin("select relname from pg_class where relnamespace='public'::regnamespace "
                "and relkind='r' and not relrowsecurity and relname <> 'spatial_ref_sys'", fetch=True)
    check("every public table has RLS enabled", off == [])

    print("\nAnonymous access")
    check("anon cannot read grievances",
          refused(None, "select * from grievances") or run(None, "select * from grievances") == [])
    check("anon cannot read audit_log", run(None, "select * from audit_log") == [])
    check("anon cannot insert a grievance",
          refused(None, "insert into grievances (mine_id, date_filed, category, description) "
                        "values (%s, current_date, 'x', 'x') returning 1", (A,)))

    print("\nGrievances")
    g = run(u["worker_a"], "insert into grievances (mine_id, filed_by, date_filed, category, description) "
                           "values (%s,%s,current_date,'Safety Equipment Shortage','No helmets') returning grievance_id",
            (A, p["worker_a"]))
    check("worker files at own mine", bool(g))
    gid = g[0][0]
    check("worker cannot file at another mine",
          refused(u["worker_a"], "insert into grievances (mine_id, filed_by, date_filed, category, description) "
                                 "values (%s,%s,current_date,'x','x') returning 1", (B, p["worker_a"])))
    check("worker cannot file in someone else's name",
          refused(u["worker_a"], "insert into grievances (mine_id, filed_by, date_filed, category, description) "
                                 "values (%s,%s,current_date,'x','x') returning 1", (A, p["worker_a2"])))
    check("another worker at the same mine cannot read it",
          run(u["worker_a2"], "select * from grievances where grievance_id=%s", (gid,)) == [])
    check("mine official reads it", len(run(u["official_a"], "select * from grievances where grievance_id=%s", (gid,))) == 1)
    check("other mine's official cannot read it",
          run(u["official_b"], "select * from grievances where grievance_id=%s", (gid,)) == [])
    check("worker cannot mark own grievance resolved",
          refused(u["worker_a"], "update grievances set status='Resolved' where grievance_id=%s returning 1", (gid,)))
    check("grievance view respects RLS",
          run(u["worker_a2"], "select * from grievance_status_view where grievance_id=%s", (gid,)) == [])
    run(u["official_a"], "update grievances set status='Resolved', resolution_note='Issued 40 helmets' "
                         "where grievance_id=%s returning 1", (gid,))
    aud = admin("select details from audit_log where table_affected='grievances' and record_id=%s "
                "order by chain_seq desc limit 1", (str(gid),), fetch=True)
    check("grievance text is redacted in the audit trail",
          aud and aud[0][0].get("resolution_note") == "[redacted]")

    admin("insert into alerts (recipient_role, category, severity, title, source_table, source_id) "
          "values ('mine_official', 'inspection', 'High', 'orphan', 'test', 'orphan-1')")
    check("an alert with no mine does not reach every mine official",
          run(u["official_a"], "select 1 from alerts where source_id='orphan-1'") == [])
    check("oversight still sees it", len(run(u["corporate"], "select 1 from alerts where source_id='orphan-1'")) == 1)

    print("\nAudit log is append-only")
    check("regulator can read the audit log", len(run(u["regulator"], "select 1 from audit_log")) > 0)
    check("worker cannot read the audit log", run(u["worker_a"], "select 1 from audit_log") == [])
    for label, sql in [("update", "update audit_log set action='x'"),
                       ("delete", "delete from audit_log"),
                       ("truncate", "truncate audit_log")]:
        try:
            admin(sql)
            ok = False
        except Exception:
            conn.rollback()
            ok = True
        check(f"even the owner cannot {label} audit_log", ok)

    print("\nInspections: geo-fence")
    near = admin("insert into geo_inspections (mine_id, inspector_id, \"timestamp\", latitude, longitude, "
                 "observation_type, severity, notes) values (%s,%s,now(),23.81,86.41,'Slope Stability','High','Cracks') "
                 "returning inspection_id, within_geofence, action_due_date - current_date", (A, p["inspector_a"]), fetch=True)[0]
    far = admin("insert into geo_inspections (mine_id, inspector_id, \"timestamp\", latitude, longitude, "
                "observation_type, severity, notes) values (%s,%s,now(),28.60,77.20,'PPE Compliance','Critical','x') "
                "returning inspection_id, within_geofence", (A, p["inspector_a"]), fetch=True)[0]
    check("inspection at the mine is inside the geo-fence", near[1] is True)
    check("inspection 1,000 km away is flagged outside", far[1] is False)
    check("High finding gets a 7-day action deadline", near[2] == 7)
    fid, cid = near[0], far[0]

    print("\nCorrective action workflow")
    upd = "update geo_inspections set {} where inspection_id=%s returning corrective_action_status"
    check("inspector cannot record the fix",
          refused(u["inspector_a"], upd.format("corrective_action_status='Action Taken', action_taken='x'"), (fid,)))
    check("nobody can rewrite the observation",
          refused(u["official_a"], upd.format("notes='nothing wrong'"), (fid,)))
    check("other mine's official cannot touch it",
          refused(u["official_b"], upd.format("corrective_action_status='In Progress'"), (fid,)))
    check("official starts work", run(u["official_a"], upd.format("corrective_action_status='In Progress'"), (fid,)) == [("In Progress",)])
    check("action needs a description",
          refused(u["official_a"], upd.format("corrective_action_status='Action Taken'"), (fid,), "describe"))
    check("official records the fix",
          run(u["official_a"], upd.format("corrective_action_status='Action Taken', action_taken='Benches re-cut, drain dug'"),
              (fid,)) == [("Action Taken",)])
    check("official cannot verify their own fix",
          refused(u["official_a"], upd.format("corrective_action_status='Closed'"), (fid,)))
    check("reopening requires a reason",
          refused(u["inspector_a"], upd.format("corrective_action_status='Reopened'"), (fid,), "why"))
    check("inspector reopens with a reason",
          run(u["inspector_a"], upd.format("corrective_action_status='Reopened', verification_note='Drain still blocked'"),
              (fid,)) == [("Reopened",)])
    run(u["official_a"], upd.format("corrective_action_status='Action Taken', action_taken='Drain cleared too'"), (fid,))
    check("inspector verifies and closes",
          run(u["inspector_a2"], upd.format("corrective_action_status='Closed'"), (fid,)) == [("Closed",)])
    row = admin("select reopened_count, verified_by is not null from geo_inspections where inspection_id=%s", (fid,), fetch=True)[0]
    check("reopen count and verifier recorded", row == (1, True))
    check("a closed finding is final",
          refused(u["official_a"], upd.format("corrective_action_status='In Progress'"), (fid,)))
    check("Critical finding needs a photo of the fix",
          refused(u["official_a"], upd.format("corrective_action_status='Action Taken', action_taken='done'"), (cid,), "photo"))
    run(u["corporate"], upd.format("corrective_action_status='Action Taken', action_taken='Done', action_photo_url='x.jpg'"), (cid,))
    check("corporate who recorded the fix cannot verify it",
          refused(u["corporate"], upd.format("corrective_action_status='Closed'"), (cid,), "someone else"))
    check("a second corporate user can",
          run(u["corporate2"], upd.format("corrective_action_status='Closed'"), (cid,)) == [("Closed",)])
    check("regulator cannot act on findings",
          refused(u["regulator"], upd.format("corrective_action_status='In Progress'"), (fid,)))
    late = admin("insert into geo_inspections (mine_id, inspector_id, \"timestamp\", latitude, longitude, severity, "
                 "observation_type) values (%s,%s,now() - interval '40 days',23.8,86.4,'Low','Housekeeping') "
                 "returning inspection_id", (A, p["inspector_a"]), fetch=True)[0][0]
    n = admin("select refresh_overdue_actions()", fetch=True)[0][0]
    st = admin("select corrective_action_status from geo_inspections where inspection_id=%s", (late,), fetch=True)[0][0]
    check("scheduler marks missed deadlines Overdue", n >= 1 and st == "Overdue")
    check("users cannot call the scheduler function",
          refused(u["official_a"], "select refresh_overdue_actions()"))
    names = run(u["official_a"], "select inspector_name from corrective_action_view where inspection_id=%s", (fid,))
    check("mine official sees colleague names in the action view", names and names[0][0] == "Inspector A")

    print("\nIncidents")
    inc = run(u["worker_a"], "insert into incidents (mine_id, occurred_at, incident_type, description, persons_injured, reported_by) "
                             "values (%s, now() - interval '1 hour', 'Serious Injury', 'Dumper hit a worker', 1, %s) "
                             "returning incident_id, severity, notifiable, reported_by", (A, p["official_b"]))[0]
    iid = inc[0]
    check("worker reports; severity and notifiability derived", inc[1] == "High" and inc[2] is True)
    check("reporter identity comes from the session", inc[3] == p["worker_a"])
    alerts = admin("select recipient_role from alerts where source_table='incidents' and source_id like %s",
                   (f"{iid}%",), fetch=True)
    check("alerts raised instantly to mine, corporate and regulator",
          sorted(r[0] for r in alerts) == ["corporate_admin", "mine_official", "regulator"])
    check("other mine's worker cannot see it", run(u["worker_b"], "select 1 from incidents where incident_id=%s", (iid,)) == [])
    check("future-dated incident refused",
          refused(u["worker_a"], "insert into incidents (mine_id, occurred_at, incident_type, description) "
                                 "values (%s, now() + interval '2 days', 'Near Miss', 'x') returning 1", (A,)))
    iu = "update incidents set {} where incident_id=%s returning status"
    check("worker cannot investigate", refused(u["worker_a"], iu.format("status='Under Investigation'"), (iid,)))
    check("report text cannot be edited", refused(u["official_a"], iu.format("description='minor'"), (iid,)))
    run(u["official_a"], iu.format("status='Under Investigation'"), (iid,))
    check("cannot close before DGMS is notified",
          refused(u["official_a"], iu.format("status='Closed', investigation_findings='a', root_cause='b'"), (iid,), "dgms"))
    check("DGMS notice needs a reference",
          refused(u["official_a"], iu.format("dgms_notified=true"), (iid,), "reference"))
    run(u["official_a"], iu.format("dgms_notified=true, dgms_notice_ref='DGMS/DHN/2026/114'"), (iid,))
    open_alerts = admin("select count(*) from alerts where source_table='incidents' and source_id like %s and status='Open'",
                        (f"{iid}%",), fetch=True)[0][0]
    check("notifying DGMS resolves the incident alerts", open_alerts == 0)
    check("closing needs findings and root cause",
          refused(u["official_a"], iu.format("status='Closed'"), (iid,), "root cause"))
    check("official closes with findings",
          run(u["official_a"], iu.format("status='Closed', investigation_findings='Reversing alarm faulty', "
                                         "root_cause='Maintenance lapse'"), (iid,)) == [("Closed",)])

    print("\nAttendance")
    ci = run(u["worker_a"], "insert into attendance_checkins (profile_id, mine_id, check_in_lat, check_in_lon) "
                            "values (%s, %s, 23.801, 86.401) returning checkin_id, profile_id, mine_id, check_in_within_geofence",
             (p["worker_b"], B))[0]
    check("check-in identity and mine come from the session, not the request",
          ci[1] == p["worker_a"] and ci[2] == A)
    check("check-in at the mine is inside the geo-fence", ci[3] is True)
    check("cannot be checked in twice",
          refused(u["worker_a"], "insert into attendance_checkins (profile_id, mine_id) values (%s,%s) returning 1",
                  (p["worker_a"], A)))
    check("offline time outside 72h is refused",
          refused(u["worker_a2"], "insert into attendance_checkins (profile_id, mine_id, check_in_at, captured_offline) "
                                  "values (%s,%s, now() - interval '5 days', true) returning 1", (p["worker_a2"], A), "72-hour"))
    co = run(u["worker_a"], "update attendance_checkins set check_out_at=now(), check_out_lat=28.6, check_out_lon=77.2 "
                            "where checkin_id=%s returning check_out_within_geofence", (ci[0],))
    check("check-out far away is flagged", co == [(False,)])
    check("cannot check out twice",
          refused(u["worker_a"], "update attendance_checkins set check_out_at=now() where checkin_id=%s returning 1", (ci[0],)))
    check("another worker cannot see it",
          run(u["worker_a2"], "select 1 from attendance_checkins where checkin_id=%s", (ci[0],)) == [])
    check("mine official sees it with the exception flagged",
          run(u["official_a"], "select geofence_exception from attendance_checkin_view where checkin_id=%s", (ci[0],)) == [(True,)])

    print("\nProduction")
    check("official reports today's production",
          bool(run(u["official_a"], "insert into mine_production_daily (mine_id, production_date, shift, coal_produced_t, target_t) "
                                    "values (%s, current_date, 'A', 4200, 4000) returning 1", (A,))))
    check("backdating past 7 days refused",
          refused(u["official_a"], "insert into mine_production_daily (mine_id, production_date, shift, coal_produced_t) "
                                   "values (%s, current_date - 20, 'A', 1) returning 1", (A,), "7 days"))
    check("worker cannot report production",
          refused(u["worker_a"], "insert into mine_production_daily (mine_id, production_date, shift, coal_produced_t) "
                                 "values (%s, current_date, 'B', 1) returning 1", (A,)))
    for d in range(1, 21):
        admin("insert into mine_production_daily (mine_id, production_date, shift, coal_produced_t, target_t) "
              "values (%s, current_date - %s, 'A', %s, 4000)", (A, d, 4000 + (d % 5) * 50))
    admin("update mine_production_daily set coal_produced_t = 300 where mine_id=%s and production_date = current_date", (A,))
    an = admin("select is_anomaly from production_anomaly_view where mine_id=%s and production_date=current_date", (A,), fetch=True)
    check("a collapse in output is flagged as an anomaly", an == [(True,)])

    print("\nEnvironment")
    r = run(u["official_a"], "insert into env_readings (mine_id, reading_date, parameter, value, station_label) "
                             "values (%s, current_date, 'PM10', 188, 'Haul road') returning reading_id, exceeds_limit", (A,))[0]
    check("PM10 of 188 exceeds the 100 µg/m³ limit", r[1] is True)
    check("an exceedance raises an alert",
          admin("select count(*) from alerts where source_table='env_readings' and source_id=%s", (str(r[0]),), fetch=True)[0][0] == 1)
    ph = run(u["official_a"], "insert into env_readings (mine_id, reading_date, parameter, value) "
                              "values (%s, current_date, 'Discharge pH', 4.8) returning exceeds_limit", (A,))
    check("pH below the 5.5 minimum is a breach", ph == [(True,)])
    check("readings cannot be edited away",
          refused(u["official_a"], "update env_readings set value=50 where reading_id=%s returning 1", (r[0],)))
    check("worker cannot enter readings",
          refused(u["worker_a"], "insert into env_readings (mine_id, reading_date, parameter, value) "
                                 "values (%s, current_date, 'PM10', 10) returning 1", (A,)))

    print("\nStatutory returns and approval")
    admin("insert into compliance_tracking (mine_id, item_id, due_date, status) values "
          "(%s,%s,current_date - 3,'Overdue'), (%s,%s,current_date - 5,'Completed')", (A, item, A, item))
    ret = run(u["official_a"], "insert into statutory_returns (mine_id, return_type, period_start, period_end, snapshot) "
                               "values (%s,'Monthly Safety & Compliance Return', date_trunc('month', current_date)::date - 60, "
                               "current_date, '{\"fake\": true}') returning return_id, status, snapshot", (A,))[0]
    rid = ret[0]
    check("draft created with figures generated by the database",
          ret[1] == "Draft" and "fake" not in ret[2] and ret[2]["compliance"]["overdue"] >= 1)
    check("other mine's official cannot see the draft",
          run(u["official_b"], "select 1 from statutory_returns where return_id=%s", (rid,)) == [])
    check("regulator cannot see a draft",
          run(u["regulator"], "select 1 from statutory_returns where return_id=%s", (rid,)) == [])
    ru = "update statutory_returns set {} where return_id=%s returning status, snapshot_hash"
    sub_ = run(u["official_a"], ru.format("status='Submitted', remarks='For review'"), (rid,))[0]
    check("submission fingerprints the figures (SHA-256)", sub_[0] == "Submitted" and len(sub_[1] or "") == 64)
    check("submitter cannot approve", refused(u["official_a"], ru.format("status='Approved'"), (rid,)))
    check("reviewer cannot alter the figures",
          refused(u["corporate"], ru.format("status='Approved', snapshot='{}'"), (rid,), "content"))
    check("sending back requires a reason",
          refused(u["corporate"], ru.format("status='Returned'"), (rid,), "change"))
    run(u["corporate"], ru.format("status='Returned', review_note='Add the incident count'"), (rid,))
    run(u["official_a"], ru.format("status='Submitted'"), (rid,))
    check("corporate approves the revision",
          run(u["corporate"], ru.format("status='Approved'"), (rid,))[0][0] == "Approved")
    rev = admin("select revision from statutory_returns where return_id=%s", (rid,), fetch=True)[0][0]
    check("resubmission increments the revision", rev == 1)
    check("regulator sees the approved return",
          len(run(u["regulator"], "select 1 from statutory_returns where return_id=%s", (rid,))) == 1)
    check("an approved return is final",
          refused(u["corporate"], ru.format("remarks='changed'"), (rid,), "final"))
    check("regulator cannot approve anything",
          refused(u["regulator"], "insert into statutory_returns (mine_id, return_type, period_start, period_end) "
                                  "values (%s,'Monthly Production Return', current_date, current_date) returning 1", (A,)))

    print("\nContractors")
    check("contractor manager adds a contractor at own mine",
          bool(run(u["contractor_a"], "insert into contractors (contractor_name, mine_id) values ('Acme Haulage', %s) "
                                      "returning contractor_id", (A,))))
    check("but not at another mine",
          refused(u["contractor_a"], "insert into contractors (contractor_name, mine_id) values ('X', %s) returning 1", (B,)))
    admin("insert into contractors (contractor_name, mine_id) values ('Bravo Blasting', %s)", (B,))
    bid = admin("select contractor_id from contractors where contractor_name='Bravo Blasting'", fetch=True)[0][0]
    check("cannot blacklist a contractor at another mine",
          refused(u["contractor_a"], "update contractors set blacklisted=true where contractor_id=%s returning 1", (bid,)))
    check("cannot add documents for another mine's contractor",
          refused(u["contractor_a"], "insert into contractor_compliance (contractor_id, document_type) values (%s,'Insurance') "
                                     "returning 1", (bid,)))

    print("\nRecurring obligations")
    admin("insert into statutory_compliance_items (regulation_source, category, requirement_summary, frequency) "
          "values ('CMR 2017 weekly test','Safety','Weekly gas test','Weekly')")
    wk = admin("select max(item_id) from statutory_compliance_items", fetch=True)[0][0]
    t1 = admin("insert into compliance_tracking (mine_id, item_id, due_date, status) "
               "values (%s,%s,current_date + 2,'Pending') returning tracking_id", (A, wk), fetch=True)[0][0]
    run(u["official_a"], "update compliance_tracking set status='Completed', completed_date=current_date "
                         "where tracking_id=%s returning 1", (t1,))
    nxt = admin("select due_date - current_date, status from compliance_tracking "
                "where mine_id=%s and item_id=%s and due_date > current_date + 2", (A, wk), fetch=True)
    check("completing an occurrence schedules the next one", nxt == [(9, "Pending")])
    n_before = admin("select count(*) from compliance_tracking where mine_id=%s and item_id=%s", (A, wk), fetch=True)[0][0]
    old = admin("insert into compliance_tracking (mine_id, item_id, due_date, status) "
                "values (%s,%s,current_date - 20,'Overdue') returning tracking_id", (A, wk), fetch=True)[0][0]
    run(u["official_a"], "update compliance_tracking set status='Completed', completed_date=current_date "
                         "where tracking_id=%s returning 1", (old,))
    n_after = admin("select count(*) from compliance_tracking where mine_id=%s and item_id=%s", (A, wk), fetch=True)[0][0]
    check("completing an old occurrence does not push the schedule ahead", n_after == n_before + 1)
    admin("insert into compliance_tracking (mine_id, item_id, due_date, status) values (%s,%s,current_date - 3,'Pending')", (B, wk))
    res = admin("select roll_forward_obligations()", fetch=True)[0][0]
    st = admin("select status from compliance_tracking where mine_id=%s and item_id=%s and due_date=current_date - 3", (B, wk), fetch=True)
    check("scheduler marks past-due Pending items Overdue", st == [("Overdue",)] and res["marked_overdue"] >= 1)
    nb = admin("select count(*) from compliance_tracking where mine_id=%s and item_id=%s and due_date >= current_date", (B, wk), fetch=True)[0][0]
    check("scheduler starts the next cycle once a date has passed", nb == 1)
    again = admin("select roll_forward_obligations()", fetch=True)[0][0]
    check("re-running the scheduler creates nothing twice", again["occurrences_created"] == 0)
    check("users cannot run the scheduler", refused(u["official_a"], "select roll_forward_obligations()"))
    rec = run(u["official_a"], "select periods, missed from obligation_track_record_view where mine_id=%s and item_id=%s", (A, wk))
    check("track record counts a late completion as missed", rec == [(1, 1)])
    check("other mines' track records are hidden", run(u["official_a"],
          "select 1 from obligation_track_record_view where mine_id=%s", (B,)) == [])

    print("\nContractor onboarding approval")
    c1 = run(u["contractor_a"], "insert into contractors (contractor_name, mine_id, status) "
                                "values ('Delta Drilling', %s, 'Active') returning contractor_id, status, created_by", (A,))[0]
    check("a new contractor starts Under Review whatever the request says", c1[1] == "Under Review" and c1[2] == p["contractor_a"])
    cid1 = c1[0]
    check("the mine official is alerted to approve it", admin(
        "select count(*) from alerts where source_table='contractor_approvals' and source_id=%s",
        (f"{cid1}:review",), fetch=True)[0][0] == 1)
    cu = "update contractors set {} where contractor_id=%s returning status"
    check("the contractor manager cannot approve", refused(u["contractor_a"], cu.format("status='Active'"), (cid1,)))
    check("approval needs the four core documents", refused(u["official_a"], cu.format("status='Active'"), (cid1,), "missing"))
    check("rejection needs a reason", refused(u["official_a"], cu.format("status='Rejected'"), (cid1,), "why"))
    for d in ["Safety training certificate", "Workmen compensation insurance", "Contract labour licence", "PF registration"]:
        run(u["contractor_a"], "insert into contractor_compliance (contractor_id, document_type, valid_until) "
                               "values (%s, %s, current_date + 200) returning 1", (cid1, d))
    check("the mine official approves once documents are valid",
          run(u["official_a"], cu.format("status='Active'"), (cid1,)) == [("Active",)])
    open_ap = admin("select count(*) from alerts where source_table='contractor_approvals' "
                    "and split_part(source_id, ':', 1)=%s and status='Open'", (str(cid1),), fetch=True)[0][0]
    check("approving closes the approval alert", open_ap == 0)
    c2 = run(u["official_a"], "insert into contractors (contractor_name, mine_id) values ('Echo Explosives', %s) "
                              "returning contractor_id", (A,))[0][0]
    check("whoever added a contractor cannot approve it",
          refused(u["official_a"], cu.format("status='Rejected', review_note='x'"), (c2,), "someone else"))
    run(u["corporate"], cu.format("status='Rejected', review_note='No blasting licence'"), (c2,))
    check("a rejection goes back to the contractor manager", admin(
        "select count(*) from alerts where source_table='contractor_approvals' and source_id=%s and recipient_role='contractor_manager'",
        (f"{c2}:rejected",), fetch=True)[0][0] == 1)
    check("a rejected contractor can be resubmitted",
          run(u["contractor_a"], cu.format("status='Under Review'"), (c2,)) == [("Under Review",)])

    print("\nCrew attendance")
    ci = "insert into contractor_crew_attendance (contractor_id, shift, headcount, latitude, longitude) values (%s,%s,%s,%s,%s) " \
         "returning within_geofence, documents_lapsed, mine_id"
    r1 = run(u["contractor_a"], ci, (cid1, "A", 24, 23.805, 86.405))
    check("crew recorded for an approved contractor, geo-fence checked", r1 == [(True, False, A)])
    check("a contractor under review cannot be recorded on site",
          refused(u["contractor_a"], ci, (c2, "A", 5, 23.8, 86.4), "not approved"))
    check("a future date is refused", refused(u["contractor_a"],
          "insert into contractor_crew_attendance (contractor_id, attendance_date, shift, headcount) "
          "values (%s, current_date + 3, 'B', 5) returning 1", (cid1,), "future"))
    admin("update contractor_compliance set valid_until = current_date - 1 "
          "where contractor_id=%s and document_type='Safety training certificate'", (cid1,))
    r2 = run(u["contractor_a"], ci, (cid1, "B", 18, 23.805, 86.405))
    check("a crew under a lapsed document is flagged", r2 and r2[0][1] is True)
    check("and the mine official is alerted at once", admin(
        "select count(*) from alerts where source_table='contractor_crew_attendance'", fetch=True)[0][0] >= 1)
    run(u["official_a"], cu.format("blacklisted=true"), (cid1,))
    check("a blacklisted contractor cannot be recorded on site",
          refused(u["contractor_a"], ci, (cid1, "C", 5, 23.8, 86.4), "blacklisted"))
    check("workers cannot read crew records", run(u["worker_a"], "select 1 from contractor_crew_attendance") == [])
    check("another mine cannot read them", run(u["official_b"], "select 1 from contractor_crew_attendance") == [])

    print("\nAutomatic returns")
    n = admin("select auto_prepare_returns()", fetch=True)[0][0]
    check("last month's returns prepared for every mine with an official", n >= 4)
    check("running it again prepares nothing twice", admin("select auto_prepare_returns()", fetch=True)[0][0] == 0)
    ar = run(u["official_a"], "select return_id, status, auto_prepared, snapshot ? 'contract_labour' from statutory_return_view "
                              "where auto_prepared and mine_id=%s and return_type='Monthly Safety & Compliance Return'", (A,))
    check("the official sees the auto-prepared draft with contract labour figures", ar and ar[0][1:] == ("Draft", True, True))
    check("the official can submit it", run(u["official_a"], "update statutory_returns set status='Submitted' "
          "where return_id=%s returning status", (ar[0][0],)) == [("Submitted",)])
    check("users cannot trigger preparation", refused(u["official_a"], "select auto_prepare_returns()"))

    print("\nRate limiting")
    hits = [admin("select hit_rate_limit('test-key', 2, 60)", fetch=True)[0][0] for _ in range(3)]
    check("the third call inside the window is limited", hits == [False, False, True])
    check("users cannot call the rate limiter", refused(u["worker_a"], "select hit_rate_limit('x', 1, 60)"))

    print("\nReal data (migration 11)")
    admin("insert into air_quality_records (report_year, state, city_town, pm10_annual_avg, pm25_annual_avg, latitude, longitude) "
          "values (2023,'Jharkhand','Testpur',148,68,23.79,86.43), (2023,'Kerala','Farcity',40,20,10.0,76.3)")
    near = run(u["worker_a"], "select city_town, distance_km, pm10_exceeds from mine_air_quality_view where mine_id = %s", (A,))
    check("a mine is linked to its nearest CPCB city", bool(near) and near[0][0] == "Testpur" and near[0][2] is True)
    check("no city within 60 km means no link",
          not run(u["worker_b"], "select 1 from mine_air_quality_view where mine_id = %s", (B,)))
    belt = run(u["regulator"], "select mines_nearby from coalfield_air_quality_view where city_town = 'Testpur'")
    check("coal-belt view counts the mines each city covers", bool(belt) and belt[0][0] >= 1)
    admin("update mines set production_2019_20_mt = 3.65 where mine_id = %s", (A,))
    admin("insert into mine_production_daily (mine_id, production_date, shift, coal_produced_t, target_t, is_synthetic) "
          "values (%s, current_date - 40, 'A', 900, 1000, true)", (A,))
    admin("select apply_real_data_links()")
    tgt = admin("select target_t, coal_produced_t from mine_production_daily where mine_id = %s "
                "and production_date = current_date - 40 and is_synthetic", (A,), fetch=True)[0]
    check("demo production is rescaled to the mine's real output", float(tgt[0]) == 10000.0 and float(tgt[1]) == 9000.0)
    admin("select apply_real_data_links()")
    tgt2 = admin("select target_t from mine_production_daily where mine_id = %s "
                 "and production_date = current_date - 40 and is_synthetic", (A,), fetch=True)[0]
    check("rescaling a second time changes nothing", float(tgt2[0]) == 10000.0)
    check("users cannot run the relinking function", refused(u["corporate"], "select apply_real_data_links()"))

    print("\nMonitoring data and lease boundaries (migration 12)")
    admin("insert into water_quality_records (report_year, station_code, monitoring_location, river, "
          "dissolved_oxygen_min, ph_min, ph_max, bod_max, fecal_coliform_max, latitude, longitude) values "
          "(2024,'T1','RIVER TEST AT ALPHA','Test',4.2,6.9,8.1,2.0,900,23.82,86.41), "
          "(2024,'T2','RIVER FAR AWAY','Far',7,7,8,1,10,10.0,76.3)")
    w = run(u["worker_a"], "select station_code, do_fails, criteria_failed from mine_water_quality_view where mine_id = %s", (A,))
    check("a mine is linked to river stations within 25 km", [r[0] for r in w] == ["T1"])
    check("a station failing CPCB's DO criterion is marked", bool(w) and w[0][1] is True and w[0][2] == 1)
    admin("insert into env_readings (mine_id, reading_date, parameter, value, source_document) "
          "values (%s, current_date - 400, 'PM10', 150, 'Test EC report')", (A,))
    hist = admin("select count(*) from alerts where source_table = 'env_readings' and body like '%%150%%'", fetch=True)[0][0]
    check("a breach copied from a published report is stored but raises no live alert", hist == 0)
    check("users cannot pass a reading off as from a published report",
          run(u["official_a"], "insert into env_readings (mine_id, reading_date, parameter, value, source_document) "
              "values (%s, current_date, 'PM10', 50, 'Forged report') returning source_document", (A,))[0][0] is None)
    admin("insert into mine_boundaries (mine_id, boundary, boundary_type, source) values "
          "(%s, '[[23.79,86.39],[23.79,86.41],[23.81,86.41],[23.81,86.39],[23.79,86.39]]', 'Surveyed lease polygon', 'test')", (A,))
    g_in = admin("select distance_m, within from geofence_check(%s, 23.80, 86.40)", (A,), fetch=True)[0]
    g_edge = admin("select within from geofence_check(%s, 23.8115, 86.40)", (A,), fetch=True)[0][0]
    g_out = admin("select distance_m, within from geofence_check(%s, 23.83, 86.40)", (A,), fetch=True)[0]
    check("inside the lease polygon is at the mine", g_in[0] == 0 and g_in[1] is True)
    check("just outside the boundary (under 250 m) is allowed for GPS error", g_edge is True)
    check("2 km outside the lease is flagged, with distance to the boundary",
          g_out[1] is False and 2000 < float(g_out[0]) < 2400)
    check("only corporate can set a lease boundary",
          refused(u["official_a"], "update mine_boundaries set source = 'x' where mine_id = %s returning 1", (A,))
          or not run(u["official_a"], "update mine_boundaries set source = 'x' where mine_id = %s returning 1", (A,)))

    print("\nRoof falls need a DGMS notice (migration 13)")
    rf = run(u["official_a"], "insert into incidents (mine_id, occurred_at, incident_type, description, persons_injured) "
             "values (%s, now() - interval '1 hour', 'Roof/Side Fall', 'Roof fall at face', 1) "
             "returning incident_id, notifiable, severity", (A,))[0]
    check("a roof/side fall is notifiable and High severity", rf[1] is True and rf[2] == "High")
    check("a roof fall cannot be closed without the DGMS notice",
          refused(u["official_a"], "update incidents set status = 'Closed', investigation_findings = 'x', root_cause = 'y' "
                  "where incident_id = %s returning 1", (rf[0],), contains="DGMS notice"))

    print("\nBlockchain anchors (migration 14)")
    good = admin("select chain_seq, row_hash from audit_log order by chain_seq desc limit 1", fetch=True)[0]
    admin("insert into audit_anchors (head_seq, head_hash, stamped_text, ots_proof) values "
          "(%s, %s, 'anchor text', 'cHJvb2Y='), (1, 'rewritten-since', 'old anchor', 'cHJvb2Y=')", (good[0], good[1]))
    st = dict(admin("select head_hash, still_matches from audit_anchor_status", fetch=True))
    check("an anchor matching today's chain says so", st.get(good[1]) is True)
    check("an anchor whose entry no longer carries the anchored hash is flagged", st.get("rewritten-since") is False)
    check("regulators can read the anchors", len(run(u["regulator"], "select 1 from audit_anchor_status")) >= 2)
    check("workers cannot read the anchors", not run(u["worker_a"], "select 1 from audit_anchor_status"))
    def owner_refused(sql, msg):
        # Even the database owner (service role, SQL editor) is stopped.
        try:
            admin(sql)
            return False
        except Exception as e:
            conn.rollback()
            return msg in str(e)
    check("even the database owner cannot edit an anchor's claim",
          owner_refused("update audit_anchors set head_hash = 'x'", "cannot be changed"))
    check("even the database owner cannot delete an anchor",
          owner_refused("delete from audit_anchors", "cannot be deleted"))
    check("a pending anchor can be confirmed",
          bool(admin("update audit_anchors set status = 'Confirmed', bitcoin_block = 900000 "
                     "where head_hash = %s returning 1", (good[1],), fetch=True)))

    print("\nDispatch grade verification (migration 15)")
    check("GCV bands follow the Coal Controller's table",
          admin("select gcv_to_grade(7200), gcv_to_grade(4300), gcv_to_grade(4301), gcv_to_grade(2200)", fetch=True)[0]
          == ("G1", "G11", "G10", "Ungraded"))
    dsp = run(u["official_a"], "insert into coal_dispatches (mine_id, dispatch_date, mode, vehicle_ref, consignee, quantity_t, declared_grade) "
              "values (%s, current_date, 'Rail', 'RK-T-1', 'Test TPP', 3800, 'G11') returning dispatch_id", (A,))[0][0]
    check("the mine official records a dispatch", bool(dsp))
    check("an inspector cannot record a dispatch",
          refused(u["inspector_a"], "insert into coal_dispatches (mine_id, dispatch_date, mode, vehicle_ref, consignee, quantity_t, declared_grade) "
                  "values (%s, current_date, 'Road', 'X', 'Y', 20, 'G10') returning 1", (A,)))
    check("the declared grade cannot be changed afterwards",
          refused(u["official_a"], "update coal_dispatches set declared_grade = 'G9' where dispatch_id = %s returning 1", (dsp,),
                  contains="cannot be changed"))
    check("a grade check needs a photo",
          refused(u["inspector_a"], "insert into grade_checks (dispatch_id, test_method, gcv_kcal_kg) values (%s, 'Field test', 3600) returning 1",
                  (dsp,), contains="photo"))
    gc = run(u["inspector_a"], "insert into grade_checks (dispatch_id, photo_paths, test_method, gcv_kcal_kg, ai_assessment) "
             "values (%s, %s, 'Laboratory (third party)', 3600, '{\"summary\": \"forged\"}') "
             "returning check_id, assessed_grade, grade_gap, verdict, ai_assessment", (dsp, [f"{A}/grade-checks/p.jpg"]))[0]
    check("GCV 3600 on a G11 dispatch is G13: two grades of slippage", gc[1:4] == ("G13", 2, "Grade slippage"))
    check("the inspector cannot supply the AI screening", gc[4] is None)
    al = admin("select recipient_role from alerts where source_table = 'grade_checks' and source_id like %s", (f"{gc[0]}%",), fetch=True)
    check("two grades of slippage alerts the mine, corporate and the regulator",
          sorted(r[0] for r in al) == ["corporate_admin", "mine_official", "regulator"])
    other = admin("insert into coal_dispatches (mine_id, dispatch_date, mode, vehicle_ref, consignee, quantity_t, declared_grade) "
                  "values (%s, current_date, 'Road', 'OD01X1', 'Other TPP', 25, 'G12') returning dispatch_id", (B,), fetch=True)[0][0]
    check("an inspector cannot check another mine's dispatch",
          refused(u["inspector_a"], "insert into grade_checks (dispatch_id, photo_paths) values (%s, %s) returning 1",
                  (other, [f"{B}/grade-checks/x.jpg"]), contains="own mine"))
    check("workers do not see dispatch grade checks", not run(u["worker_a"], "select 1 from grade_checks"))
    check("the inspector cannot edit the recorded test",
          refused(u["inspector_a"], "update grade_checks set gcv_kcal_kg = 4200 where check_id = %s returning 1", (gc[0],)))
    check("the mine must give a reason to dispute",
          refused(u["official_a"], "update grade_checks set status = 'Disputed by mine' where check_id = %s returning 1", (gc[0],),
                  contains="response"))
    run(u["official_a"], "update grade_checks set status = 'Disputed by mine', mine_response = 'Referee sample sent' "
        "where check_id = %s returning 1", (gc[0],))
    check("the mine cannot answer twice",
          refused(u["official_a"], "update grade_checks set status = 'Accepted by mine', mine_response = 'ok' where check_id = %s returning 1",
                  (gc[0],), contains="already answered"))
    check("only corporate closes a check",
          refused(u["official_a"], "update grade_checks set status = 'Closed' where check_id = %s returning 1", (gc[0],)))
    run(u["corporate"], "update grade_checks set status = 'Closed' where check_id = %s returning 1", (gc[0],))
    closed = admin("select status, mine_answer, mine_response from grade_checks where check_id = %s", (gc[0],), fetch=True)[0]
    check("closing keeps the mine's answer", closed == ("Closed", "Disputed", "Referee sample sent"))
    v = run(u["inspector_a"], "insert into grade_checks (dispatch_id, photo_paths) values (%s, %s) returning check_id, verdict",
            (dsp, [f"{A}/grade-checks/q.jpg"]))[0]
    check("photos alone give 'Visual check only'", v[1] == "Visual check only")
    admin("update grade_checks set ai_assessment = '{\"consistent_with_declared\": \"no\"}', ai_model = 'test', ai_at = now() "
          "where check_id = %s", (v[0],))
    check("a screening that finds the load inconsistent asks for a lab test, not a verdict",
          admin("select verdict from grade_checks where check_id = %s", (v[0],), fetch=True)[0][0] == "Lab test needed")

    print("\nOfficial annual grade declarations (migration 15)")
    check("a mine official cannot load a grade declaration",
          refused(u["official_a"], "insert into declared_grades (subsidiary, fy, area, dispatch_point, point_type, grade, mine_ids, source) "
                  "values ('TST', '2025-26', 'Alpha', 'ALPHA', 'Mine', 'G9', %s, 'forged') returning 1", ([A],)))
    admin("insert into declared_grades (subsidiary, fy, area, dispatch_point, point_type, grade, mine_ids, source) values "
          "('TST', '2024-25', 'Alpha', 'ALPHA', 'Mine', 'G10', %s, 'Test order 1'), "
          "('TST', '2025-26', 'Alpha', 'SIDING 1', 'Siding', 'G13', %s, 'Test order 2'), "
          "('TST', '2025-26', 'Alpha', 'ALPHA', 'Mine', 'G12', %s, 'Test order 2')", ([A], [A], [A]))
    check("everyone signed in can read the declarations",
          len(run(u["worker_a"], "select 1 from declared_grades where subsidiary = 'TST'")) == 3)
    og = run(u["official_a"], "select grade, fy from official_grade_of(%s)", (A,))
    check("the official grade is the latest year's mine-level row", og == [("G12", "2025-26")])
    check("a mine with no declaration has no official grade", run(u["official_b"], "select * from official_grade_of(%s)", (B,)) == [])
    hi = run(u["official_a"], "insert into coal_dispatches (mine_id, dispatch_date, mode, vehicle_ref, consignee, quantity_t, declared_grade, dispatch_point) "
             "values (%s, current_date, 'Rail', 'RK-T-2', 'Test TPP', 3700, 'G10', 'SIDING 1') returning dispatch_id", (A,))[0][0]
    ok = run(u["official_a"], "insert into coal_dispatches (mine_id, dispatch_date, mode, vehicle_ref, consignee, quantity_t, declared_grade) "
             "values (%s, current_date, 'Rail', 'RK-T-3', 'Test TPP', 3700, 'G12') returning dispatch_id", (A,))[0][0]
    al = admin("select recipient_role, severity from alerts where source_table = 'coal_dispatches' and source_id = %s", (str(hi),), fetch=True)
    check("a dispatch declared above the official grade alerts corporate", al == [("corporate_admin", "High")])
    check("a dispatch at the official grade raises nothing",
          not admin("select 1 from alerts where source_table = 'coal_dispatches' and source_id = %s", (str(ok),), fetch=True))
    dv = dict((r[0], r[1:]) for r in run(u["corporate"], "select dispatch_id, official_grade, declared_above_official "
                                                          "from dispatch_view where dispatch_id in (%s, %s)", (hi, ok)))
    check("the dispatch list shows the official grade and flags the one above it",
          dv.get(hi) == ("G12", True) and dv.get(ok) == ("G12", False))
    check("the dispatch point is kept", run(u["corporate"], "select dispatch_point from coal_dispatches where dispatch_id = %s", (hi,)) == [("SIDING 1",)])

    print("\nEvidence storage")
    check("upload into own mine's folder",
          bool(run(u["inspector_a"], "insert into storage.objects (bucket_id, name) values ('evidence', %s) returning 1",
                   (f"{A}/inspections/a.jpg",))))
    check("upload into another mine's folder refused",
          refused(u["inspector_a"], "insert into storage.objects (bucket_id, name) values ('evidence', %s) returning 1",
                  (f"{B}/inspections/b.jpg",)))
    check("other mine cannot read the evidence",
          run(u["worker_b"], "select 1 from storage.objects where name like %s", (f"{A}/%",)) == [])

    print("\nAudit chain")
    v = run(u["regulator"], "select verify_audit_chain()")[0][0]
    check(f"chain verifies intact ({v.get('checked')} entries)", v.get("ok") is True and v.get("checked", 0) > 10)
    check("workers cannot run verification", refused(u["worker_a"], "select verify_audit_chain()", contains="oversight"))
    # Simulate an attacker with direct database access editing history.
    admin("alter table audit_log disable trigger trg_audit_log_no_update")
    admin("update audit_log set action='nothing to see' where chain_seq = 3")
    admin("alter table audit_log enable trigger trg_audit_log_no_update")
    v2 = run(u["regulator"], "select verify_audit_chain()")[0][0]
    check("tampering with entry 3 is detected at entry 3", v2.get("ok") is False and v2.get("broken_at") == 3)

    print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
    if FAILED:
        print("Failed:\n  " + "\n  ".join(FAILED))
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(2)
