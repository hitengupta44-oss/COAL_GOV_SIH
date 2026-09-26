"""
Alerts, reminders and escalation.

Scans the platform for obligations that have slipped and raises an alert
addressed to whoever should act on it. Run it on a schedule -- daily is
right for statutory deadlines.

    python alerts_engine.py

What it looks at:
  - compliance items overdue, or falling due inside the reminder window
  - contractor documents lapsed or lapsing (an expired safety certificate
    means that contractor's people should not be underground)
  - contracts ending soon
  - grievances past their response deadline
  - high and critical inspection findings still open

Design notes
------------
Alerts are addressed to a ROLE at a mine rather than a named person
wherever the right recipient is "whoever holds this post". Staff change;
statutory obligations don't, and an alert addressed to someone who has
left is an alert nobody reads.

Re-running is safe. A partial unique index on (source_table, source_id)
covers open and acknowledged alerts, so an obligation that is still
overdue tomorrow does not produce a second alert -- it gets escalated
instead. Alerts whose underlying issue has been fixed are closed
automatically, so the list reflects reality rather than accumulating.
"""

import datetime as dt
import os
import smtplib
from collections import Counter, defaultdict
from email.message import EmailMessage

from supabase import create_client
from credentials import get_supabase_credentials

SUPABASE_URL, SERVICE_KEY = get_supabase_credentials()
supabase = create_client(SUPABASE_URL, SERVICE_KEY)

TODAY = dt.date.today()
REMINDER_WINDOW_DAYS = 14   # how far ahead to warn on a due date

raised = Counter()
closed = 0

# Alerts are collected in memory and written in batches.
#
# The first version checked for an existing alert with its own SELECT and
# inserted one row at a time. With a few thousand overdue compliance items
# that is a few thousand sequential round trips, and the run took long
# enough to look hung. Existing source ids are now fetched once per source
# table, and new alerts go up in batches of 500.
_pending = []
_existing_cache = {}


def existing_ids(source_table):
    """Source ids that already have an open or acknowledged alert."""
    if source_table in _existing_cache:
        return _existing_cache[source_table]
    ids, page = set(), 0
    while True:
        rows = supabase.table("alerts").select("source_id").eq(
            "source_table", source_table
        ).in_("status", ["Open", "Acknowledged"]).range(page * 1000, page * 1000 + 999).execute().data or []
        ids.update(r["source_id"] for r in rows)
        if len(rows) < 1000:
            break
        page += 1
    _existing_cache[source_table] = ids
    return ids


MINE_ROLES = {"mine_official", "inspector", "contractor_manager", "worker"}
skipped_no_mine = 0


def queue_alert(**a):
    """Hold an alert for the next batch write, skipping ones already raised.

    An alert for a mine-level role about a record with no mine cannot be
    acted on by anyone -- no official owns it -- so it is not raised; the
    count is reported so the data gap itself is visible.
    """
    global skipped_no_mine
    if a.get("recipient_role") in MINE_ROLES and not a.get("mine_id"):
        skipped_no_mine += 1
        return False
    known = existing_ids(a["source_table"])
    if a["source_id"] in known:
        return False
    known.add(a["source_id"])          # guards duplicates within this run too
    _pending.append(a)
    raised[a["category"]] += 1
    return True


def flush(batch=500):
    """Write queued alerts. A failed batch is retried row by row so one bad
    record doesn't discard the other 499."""
    global _pending
    for i in range(0, len(_pending), batch):
        chunk = _pending[i:i + batch]
        try:
            supabase.table("alerts").insert(chunk).execute()
        except Exception:
            for row in chunk:
                try:
                    supabase.table("alerts").insert(row).execute()
                except Exception as e:
                    if "duplicate" not in str(e).lower():
                        print(f"  ! skipped one alert: {e}")
        print(f"  wrote {min(i + batch, len(_pending))}/{len(_pending)}")
    _pending = []


def close_resolved(source_table, still_open_ids):
    """Close alerts whose underlying record is no longer a problem.

    Done as a single filtered update rather than one call per alert.
    """
    global closed
    rows = supabase.table("alerts").select("alert_id, source_id").eq(
        "source_table", source_table
    ).in_("status", ["Open", "Acknowledged"]).limit(5000).execute().data or []
    stale = [r["alert_id"] for r in rows if r["source_id"] not in still_open_ids]
    for i in range(0, len(stale), 200):
        chunk = stale[i:i + 200]
        supabase.table("alerts").update({"status": "Resolved"}).in_("alert_id", chunk).execute()
        closed += len(chunk)


# ------------------------------------------------------------
# 1. Statutory compliance
# ------------------------------------------------------------
# An alert per overdue row would mean thousands of them, which is not a
# system anyone acts on -- it is a list nobody opens. Only the most
# pressing items per mine are raised: the ones furthest past their date,
# plus anything falling due inside the reminder window. The dashboards
# still show the full count, so nothing is hidden; the alert list stays
# something a mine official can actually work through.
MAX_COMPLIANCE_ALERTS_PER_MINE = 5


def mine_names():
    """mine_id -> "Name, State", fetched once and reused."""
    if hasattr(mine_names, "_cache"):
        return mine_names._cache
    out, page = {}, 0
    while True:
        rows = supabase.table("mines").select("mine_id, mine_name, state").range(
            page*1000, page*1000+999).execute().data or []
        for r in rows:
            out[r["mine_id"]] = ", ".join(x for x in (r.get("mine_name"), r.get("state")) if x)
        if len(rows) < 1000:
            break
        page += 1
    mine_names._cache = out
    return out


def compliance_alerts():
    names = mine_names()
    rows = supabase.table("compliance_tracking").select(
        "tracking_id, mine_id, due_date, status, "
        "statutory_compliance_items(requirement_summary, category, regulation_source)"
    ).in_("status", ["Overdue", "Pending"]).limit(4000).execute().data or []

    # Worst first, so the cap keeps the most overdue rather than whichever
    # happened to be returned first.
    def overdue_by(r):
        d = r.get("due_date")
        return dt.date.fromisoformat(str(d)[:10]) if d else dt.date.max
    rows.sort(key=overdue_by)

    live, per_mine = set(), Counter()
    for r in rows:
        due = r.get("due_date")
        if not due:
            continue
        due_date = dt.date.fromisoformat(str(due)[:10])
        days = (due_date - TODAY).days
        item = r.get("statutory_compliance_items") or {}

        if r["status"] == "Overdue" or days < 0:
            sev = "Critical" if days < -30 else "High"
            title = (f"{names.get(r.get('mine_id'), 'Unknown mine')}: "
                     f"compliance overdue by {abs(days)} days")
            body = (f"{item.get('regulation_source', 'Statutory requirement')}: "
                    f"{item.get('requirement_summary', '')} Due {due}.")
        elif days <= REMINDER_WINDOW_DAYS:
            sev = "Medium"
            title = (f"{names.get(r.get('mine_id'), 'Unknown mine')}: "
                     f"compliance due in {days} days")
            body = (f"{item.get('regulation_source', 'Statutory requirement')}: "
                    f"{item.get('requirement_summary', '')} Due {due}.")
        else:
            continue

        mid = r.get("mine_id")
        if per_mine[mid] >= MAX_COMPLIANCE_ALERTS_PER_MINE:
            continue
        per_mine[mid] += 1

        sid = str(r["tracking_id"])
        live.add(sid)
        queue_alert(
            recipient_role="mine_official",
            mine_id=r.get("mine_id"),
            category="compliance",
            severity=sev,
            title=title,
            body=body,
            source_table="compliance_tracking",
            source_id=sid,
            due_date=due,
        )
    close_resolved("compliance_tracking", live)


# ------------------------------------------------------------
# 2. Contractor documents and contracts
# ------------------------------------------------------------
def contractor_alerts():
    try:
        docs = supabase.table("contractor_compliance_view").select(
            "record_id, contractor_name, document_type, computed_status, "
            "days_to_expiry, mine_id, valid_until"
        ).in_("computed_status", ["Expired", "Expiring", "Missing"]).limit(2000).execute().data or []
    except Exception as e:
        print(f"  ! contractor_compliance_view unavailable ({e}). Run migration_02 first.")
        docs = []

    live = set()
    for d in docs:
        st = d["computed_status"]
        sev = {"Expired": "Critical", "Missing": "High", "Expiring": "Medium"}[st]
        if st == "Expired":
            title = f"{d['contractor_name']}: {d['document_type']} has lapsed"
            body = ("This contractor should not have people on site until it is "
                    f"renewed. Expired {abs(d.get('days_to_expiry') or 0)} days ago.")
        elif st == "Missing":
            title = f"{d['contractor_name']}: {d['document_type']} not on record"
            body = "No validity date recorded. Obtain the document or mark it not applicable."
        else:
            title = f"{d['contractor_name']}: {d['document_type']} expires in {d.get('days_to_expiry')} days"
            body = f"Valid until {d.get('valid_until')}. Start the renewal now."

        sid = str(d["record_id"])
        live.add(sid)
        queue_alert(
            recipient_role="contractor_manager",
            mine_id=d.get("mine_id"),
            category="contractor",
            severity=sev,
            title=title,
            body=body,
            source_table="contractor_compliance",
            source_id=sid,
            due_date=d.get("valid_until"),
        )
    close_resolved("contractor_compliance", live)

    # Contracts ending soon
    try:
        cons = supabase.table("contractor_register_view").select(
            "contractor_id, contractor_name, contract_end, contract_state, mine_id"
        ).in_("contract_state", ["Expiring soon", "Contract expired"]).limit(500).execute().data or []
    except Exception:
        cons = []

    live_c = set()
    for c in cons:
        expired = c["contract_state"] == "Contract expired"
        sid = str(c["contractor_id"])
        live_c.add(sid)
        queue_alert(
            recipient_role="contractor_manager",
            mine_id=c.get("mine_id"),
            category="contractor",
            severity="High" if expired else "Medium",
            title=(f"{c['contractor_name']}: contract has expired"
                   if expired else f"{c['contractor_name']}: contract ends {c.get('contract_end')}"),
            body="Renew, retender or close out the engagement.",
            source_table="contractors",
            source_id=sid,
            due_date=c.get("contract_end"),
        )
    close_resolved("contractors", live_c)


# ------------------------------------------------------------
# 3. Grievances past their response deadline
# ------------------------------------------------------------
def grievance_alerts():
    names = mine_names()
    try:
        rows = supabase.table("grievance_status_view").select(
            "grievance_id, mine_id, category, description, due_by, days_remaining, priority"
        ).eq("is_overdue", True).limit(1000).execute().data or []
    except Exception as e:
        print(f"  ! grievance_status_view unavailable ({e}). Run migration_02 first.")
        rows = []

    live = set()
    for g in rows:
        over = abs(g.get("days_remaining") or 0)
        sid = str(g["grievance_id"])
        live.add(sid)
        queue_alert(
            recipient_role="mine_official",
            mine_id=g.get("mine_id"),
            category="grievance",
            severity="Critical" if over > 14 else "High",
            title=(f"{names.get(g.get('mine_id'), 'Unknown mine')}: "
                   f"grievance unanswered {over} days past deadline"),
            body=f"{g.get('category')}: {g.get('description') or ''}",
            source_table="grievances",
            source_id=sid,
            due_date=g.get("due_by"),
        )
    close_resolved("grievances", live)


# ------------------------------------------------------------
# 4. Serious inspection findings still open
# ------------------------------------------------------------
def inspection_alerts():
    """Open findings go to the mine official; findings with a recorded fix
    go to the inspectors at that mine, because until someone independent
    has checked it the fix is only a claim."""
    names = mine_names()
    rows = supabase.table("geo_inspections").select(
        "inspection_id, mine_id, observation_type, severity, notes, "
        "corrective_action_status, action_due_date, action_taken, timestamp"
    ).in_("severity", ["High", "Critical"]).in_(
        "corrective_action_status", ["Open", "In Progress", "Reopened", "Overdue", "Action Taken"]
    ).limit(5000).execute().data or []

    live = set()
    for i in rows:
        mine = names.get(i.get("mine_id"), "Unknown mine")
        if i["corrective_action_status"] == "Action Taken":
            sid = f"{i['inspection_id']}:verify"
            live.add(sid)
            queue_alert(
                recipient_role="inspector", mine_id=i.get("mine_id"), category="inspection",
                severity="Medium",
                title=f"{mine}: fix recorded, needs verifying — {i.get('observation_type')}",
                body=f"Action recorded: {i.get('action_taken') or '—'}. Check it on site and close or reopen.",
                source_table="geo_inspections", source_id=sid, due_date=None,
            )
            continue
        sid = str(i["inspection_id"])
        live.add(sid)
        late = i["corrective_action_status"] == "Overdue"
        queue_alert(
            recipient_role="mine_official",
            mine_id=i.get("mine_id"),
            category="inspection",
            severity="Critical" if late else i["severity"],
            title=(f"{mine}: {i['severity']} finding "
                   f"{'past its action deadline' if late else 'open'} — {i.get('observation_type')}"),
            body=(i.get("notes") or "No notes recorded.")
                 + f" Raised {str(i.get('timestamp'))[:10]}, action due {i.get('action_due_date')}.",
            source_table="geo_inspections",
            source_id=sid,
            due_date=i.get("action_due_date"),
        )
    close_resolved("geo_inspections", live)


# ------------------------------------------------------------
# 4b. Statutory accident notices not yet sent
#
# The database raises an alert the moment an incident is reported. This
# adds the escalation: once the notice deadline has passed without a DGMS
# notice on record, corporate management is told directly.
# ------------------------------------------------------------
def incident_notice_alerts():
    try:
        rows = supabase.table("incident_view").select(
            "incident_id, mine_id, mine_name, incident_type, occurred_at, dgms_notice_due_at"
        ).eq("notice_overdue", True).limit(1000).execute().data or []
    except Exception as e:
        print(f"  ! incident_view unavailable ({e}); run migration 07")
        return
    live = set()
    for r in rows:
        sid = str(r["incident_id"])
        live.add(sid)
        queue_alert(
            recipient_role="corporate_admin", mine_id=r["mine_id"], category="incident",
            severity="Critical",
            title=f"{r['mine_name']}: DGMS notice overdue for {r['incident_type']}",
            body=(f"Occurred {str(r['occurred_at'])[:16].replace('T', ' ')}; notice was due "
                  f"{str(r['dgms_notice_due_at'])[:16].replace('T', ' ')} and none is on record."),
            source_table="incident_notices", source_id=sid, due_date=None,
        )
    close_resolved("incident_notices", live)


# ------------------------------------------------------------
# 5. Escalation
#
# An alert nobody acknowledges climbs rather than sits. Critical after 3
# days, High after 7, Medium after 14 -- then it also becomes visible to
# corporate management rather than only the mine.
# ------------------------------------------------------------
def escalate():
    try:
        rows = supabase.table("alert_escalation_view").select(
            "alert_id, escalation_level, severity, age_days, title, mine_id"
        ).eq("escalation_state", "Escalate").limit(1000).execute().data or []
    except Exception as e:
        print(f"  ! alert_escalation_view unavailable ({e})")
        return 0

    # The view says an alert is past its first window; each further level
    # needs another full window. Without this an alert went from level 1 to
    # level 2 on the very next run, because its age never resets.
    window = {"Critical": 3, "High": 7, "Medium": 14}
    n = 0
    for a in rows:
        current = a.get("escalation_level") or 0
        level = current + 1
        if level > 2:
            continue
        if (a.get("age_days") or 0) < window.get(a.get("severity"), 14) * level:
            continue
        supabase.table("alerts").update({
            "escalation_level": level,
            # Above the first step the alert is no longer just the mine's
            # problem, so it is re-addressed upward.
            "recipient_role": "corporate_admin" if level >= 2 else "mine_official",
        }).eq("alert_id", a["alert_id"]).execute()
        n += 1
    return n


# ------------------------------------------------------------
# 6. Email notifications
#
# Field staff do not sit in front of a dashboard. High and Critical alerts
# are emailed once to everyone who holds the addressed role at that mine
# (or, for oversight roles, to everyone in the role). One digest per person
# per run, so a bad night produces one email, not forty.
#
# Configure with SMTP_HOST, SMTP_PORT (587 for STARTTLS, 465 for SSL),
# SMTP_USER, SMTP_PASSWORD and ALERT_EMAIL_FROM. With no SMTP_HOST set this
# step is skipped.
#
# ALERT_EMAIL_REDIRECT (optional): send every email to this one address
# instead, with the intended recipient named in the subject. For demos and
# testing -- the demo accounts' addresses (@coaldemo.in) are not real
# inboxes, and mail to them is never attempted.
# ------------------------------------------------------------
def email_notifications():
    host = os.environ.get("SMTP_HOST")
    if not host:
        print("  SMTP_HOST not set -- email notifications skipped")
        return 0
    try:
        pending = supabase.table("alerts").select(
            "alert_id, recipient_role, recipient_id, mine_id, severity, title, body, due_date"
        ).in_("severity", ["High", "Critical"]).eq("status", "Open").is_("notified_at", "null") \
         .limit(2000).execute().data or []
    except Exception as e:
        print(f"  ! alerts.notified_at missing ({e}); run migration 07")
        return 0
    if not pending:
        return 0

    people = supabase.table("user_profiles").select("profile_id, email, full_name, role, mine_id") \
        .not_.is_("email", "null").execute().data or []
    oversight = {"corporate_admin", "regulator", "admin"}
    inbox = defaultdict(list)
    for a in pending:
        for p in people:
            if a.get("recipient_id"):
                match = p["profile_id"] == a["recipient_id"]
            else:
                match = p["role"] == a.get("recipient_role") and (
                    p["role"] in oversight or a.get("mine_id") is None or p.get("mine_id") == a.get("mine_id"))
            if match:
                inbox[(p["email"], p.get("full_name") or "")].append(a)

    sender = os.environ.get("ALERT_EMAIL_FROM") or os.environ.get("SMTP_USER") or "alerts@localhost"
    redirect = (os.environ.get("ALERT_EMAIL_REDIRECT") or "").strip()
    demo_domain = "@" + os.environ.get("DEMO_EMAIL_DOMAIN", "coaldemo.in")
    port = int(os.environ.get("SMTP_PORT") or "587")
    sent_ids, sent, skipped = set(), 0, 0
    smtp_cls = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
    with smtp_cls(host, port, timeout=30) as smtp:
        if port != 465:
            smtp.ehlo()
            if smtp.has_extn("starttls"):
                smtp.starttls()
                smtp.ehlo()
        if os.environ.get("SMTP_USER"):
            smtp.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        for (email, name), items in inbox.items():
            if not redirect and email.lower().endswith(demo_domain):
                skipped += 1          # demo address: not a real inbox
                continue
            items.sort(key=lambda x: (x["severity"] != "Critical", x.get("due_date") or "9999"))
            msg = EmailMessage()
            msg["From"], msg["To"] = sender, (redirect or email)
            crit = sum(1 for x in items if x["severity"] == "Critical")
            msg["Subject"] = ((f"[for {name or email} <{email}>] " if redirect else "")
                              + (f"{len(items)} alerts need attention" if len(items) > 1 else "1 alert needs attention")
                              + (f" ({crit} critical)" if crit else ""))
            lines = [f"{name or 'Hello'},", "", "These need action on the Coal Mine Governance platform:", ""]
            # One readable email, not a wall: the most urgent 25, then a count.
            shown, rest = items[:25], len(items) - 25
            for x in shown:
                lines.append(f"[{x['severity']}] {x['title']}")
                if x.get("body"):
                    lines.append(f"    {x['body']}")
                if x.get("due_date"):
                    lines.append(f"    Due {x['due_date']}")
                lines.append("")
            if rest > 0:
                lines += [f"...and {rest} more.", ""]
            lines.append("Open the platform to acknowledge or act on them: "
                         + os.environ.get("APP_URL", "https://coal-gov-sih.vercel.app") + "/dashboard")
            msg.set_content("\n".join(lines))
            try:
                smtp.send_message(msg)
                sent += 1
                sent_ids.update(x["alert_id"] for x in items)
            except Exception as e:
                print(f"  ! could not email {email}: {e}")
    if skipped:
        print(f"  {skipped} demo addresses ({demo_domain}) not emailed; set ALERT_EMAIL_REDIRECT to receive them")

    ids = list(sent_ids)
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for i in range(0, len(ids), 200):
        supabase.table("alerts").update({"notified_at": now}).in_("alert_id", ids[i:i + 200]).execute()
    return sent


def roll_forward_obligations():
    """Marks obligations past their date Overdue and starts the next cycle
    of every obligation whose date has passed (migration 10)."""
    try:
        return supabase.rpc("roll_forward_obligations", {}).execute().data or {}
    except Exception as e:
        print(f"  ! roll_forward_obligations unavailable ({e}); run migration 10")
        return {}


def prepare_returns():
    """Prepares last month's statutory returns for every mine with an
    official (migration 10). Existing returns are left alone."""
    try:
        return supabase.rpc("auto_prepare_returns", {}).execute().data or 0
    except Exception as e:
        print(f"  ! auto_prepare_returns unavailable ({e}); run migration 10")
        return 0


# ------------------------------------------------------------
# Statutory returns not yet submitted
#
# A month's returns are due by the 7th of the following month. A draft (or
# one sent back) still unsubmitted after that is overdue; the escalation
# ladder then carries it to corporate if nobody acts.
# ------------------------------------------------------------
def return_alerts():
    try:
        rows = supabase.table("statutory_return_view").select(
            "return_id, mine_id, mine_name, return_type, period_start, status, submission_due"
        ).in_("status", ["Draft", "Returned"]).lt("submission_due", TODAY.isoformat()).limit(2000).execute().data or []
    except Exception as e:
        print(f"  ! statutory_return_view unavailable ({e})")
        return
    live = set()
    for r in rows:
        sid = str(r["return_id"])
        live.add(sid)
        days = (TODAY - dt.date.fromisoformat(r["submission_due"])).days
        queue_alert(
            recipient_role="mine_official", mine_id=r["mine_id"], category="approval",
            severity="High" if days < 7 else "Critical",
            title=f"{r['mine_name']}: {r['return_type']} for {r['period_start'][:7]} not submitted",
            body=(f"Was due by {r['submission_due']} ({days} days ago). "
                  f"{'It was sent back and needs correcting.' if r['status'] == 'Returned' else 'The draft is ready to review and submit.'}"),
            source_table="statutory_returns_due", source_id=sid, due_date=r["submission_due"],
        )
    close_resolved("statutory_returns_due", live)


def close_crew_alerts():
    """A crew alert about lapsed contractor documents closes once every
    required document of that contractor is back in date."""
    global closed
    try:
        open_alerts = supabase.table("alerts").select("alert_id, source_id").eq(
            "source_table", "contractor_crew_attendance").in_("status", ["Open", "Acknowledged"]).limit(2000).execute().data or []
        if not open_alerts:
            return
        recs = supabase.table("contractor_crew_attendance").select("record_id, contractor_id").in_(
            "record_id", [a["source_id"] for a in open_alerts]).execute().data or []
        by_record = {r["record_id"]: r["contractor_id"] for r in recs}
        gaps = supabase.table("contractor_register_view").select("contractor_id, document_gaps").in_(
            "contractor_id", list(set(by_record.values())) or ["00000000-0000-0000-0000-000000000000"]).execute().data or []
        still_lapsed = {g["contractor_id"] for g in gaps if g.get("document_gaps")}
        done = [a["alert_id"] for a in open_alerts if by_record.get(a["source_id"]) not in still_lapsed]
        for i in range(0, len(done), 200):
            supabase.table("alerts").update({"status": "Resolved"}).in_("alert_id", done[i:i + 200]).execute()
        closed += len(done)
    except Exception as e:
        print(f"  ! crew alert check skipped ({e})")


def refresh_overdue_actions():
    """Marks corrective actions past their deadline as Overdue (a database
    function, callable only with the service role)."""
    try:
        return supabase.rpc("refresh_overdue_actions", {}).execute().data or 0
    except Exception as e:
        print(f"  ! refresh_overdue_actions unavailable ({e}); run migration 07")
        return 0


def main():
    print(f"Scanning {SUPABASE_URL}\n")
    # Bring the records up to date first, so this pass alerts on them.
    rolled = roll_forward_obligations()
    if rolled:
        print(f"Obligations: {rolled.get('marked_overdue', 0)} marked overdue, "
              f"{rolled.get('occurrences_created', 0)} next occurrences scheduled")
    print(f"Prepared {prepare_returns()} statutory returns")
    print("Scanning compliance...");   compliance_alerts()
    print("Scanning contractors...");  contractor_alerts()
    print("Scanning grievances...");   grievance_alerts()
    print(f"Marked {refresh_overdue_actions()} corrective actions overdue")
    print("Scanning inspections..."); inspection_alerts()
    print("Scanning incidents...");   incident_notice_alerts()
    print("Scanning returns...");     return_alerts()
    close_crew_alerts()
    print("Writing alerts...");        flush()
    escalated = escalate()
    emailed = email_notifications()
    if emailed:
        print(f"Emailed {emailed} people")

    total = sum(raised.values())
    print(f"Raised {total} new alerts")
    for k, v in sorted(raised.items()):
        print(f"  {k:<12} {v}")
    print(f"Closed {closed} alerts whose issue was resolved")
    if skipped_no_mine:
        print(f"Skipped {skipped_no_mine} alerts about records with no mine recorded (fix the source data)")
    print(f"Escalated {escalated} unacknowledged alerts")

    try:
        open_now = supabase.table("alerts").select(
            "severity", count="exact"
        ).eq("status", "Open").execute().count or 0
        print(f"\n{open_now} alerts currently open")
    except Exception:
        pass


if __name__ == "__main__":
    main()
