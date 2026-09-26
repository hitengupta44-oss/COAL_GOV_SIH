"""
Verifies the audit hash chain and anchors its head outside the database.

The hash chain (migration 08) makes any edit to past audit entries
detectable -- unless someone with full database access rewrites the WHOLE
chain from the edited entry onwards. Anchoring the head hash somewhere the
database cannot reach closes that gap: a rewritten chain ends in a
different hash from the one already on public record.

Two anchors, both outside the database:

  1. GitHub. Every run writes the head hash to the workflow's job summary,
     kept by GitHub and not editable from the database.
  2. The Bitcoin blockchain (migration 14). Once a day the head hash is
     stamped with OpenTimestamps -- an open, free standard: the hash is sent
     to public calendar servers, which commit it to a Bitcoin transaction
     within a few hours. Later runs "upgrade" each stamp until the proof
     reaches a Bitcoin block, then mark it Confirmed. Nobody can later make
     a proof for a hash that did not exist at that time, and anyone can
     check one at https://opentimestamps.org without trusting this platform.

The job FAILS (and GitHub emails the repo owners) if verification fails.
If the calendar servers are unreachable the anchor is simply retried on the
next run; that never fails the job.

    python publish_audit_anchor.py
"""

import base64
import datetime as dt
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

from supabase import create_client

from credentials import get_supabase_credentials

ANCHOR_EVERY_HOURS = 20       # at most one new Bitcoin anchor per day


# ------------------------------------------------------------------
# OpenTimestamps helpers
# ------------------------------------------------------------------
def ots_available():
    return shutil.which("ots") is not None


def proof_details(ots_bytes):
    """(bitcoin_block or None, pending calendar URLs, digest the proof covers)."""
    from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
    from opentimestamps.core.serialize import BytesDeserializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile

    d = DetachedTimestampFile.deserialize(BytesDeserializationContext(ots_bytes))
    heights, calendars = [], []
    for _, att in d.timestamp.all_attestations():
        if isinstance(att, BitcoinBlockHeaderAttestation):
            heights.append(att.height)
        elif isinstance(att, PendingAttestation):
            calendars.append(att.uri)
    return (min(heights) if heights else None), sorted(set(calendars)), d.file_digest.hex()


def run_ots(args, cwd):
    return subprocess.run(["ots", "--no-cache", *args], cwd=cwd, capture_output=True, text=True, timeout=120)


def stamp(text):
    """Stamp `text`; returns the .ots proof bytes, or None if it could not."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "audit-anchor.txt")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        r = run_ots(["stamp", "audit-anchor.txt"], d)
        proof = path + ".ots"
        if r.returncode != 0 or not os.path.exists(proof):
            print(f"  ! OpenTimestamps stamp failed: {(r.stderr or r.stdout).strip()[:300]}")
            return None
        with open(proof, "rb") as f:
            return f.read()


def upgrade(ots_bytes):
    """Try to complete a pending proof; returns the (possibly unchanged) bytes."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "audit-anchor.txt.ots")
        with open(path, "wb") as f:
            f.write(ots_bytes)
        run_ots(["upgrade", "audit-anchor.txt.ots"], d)   # non-zero simply means "not yet"
        with open(path, "rb") as f:
            return f.read()


def anchor_text(head_seq, head_hash, when):
    return (
        "Coal Mine Governance Platform - audit trail anchor\n"
        f"Audit chain entries: {head_seq}\n"
        f"Head hash (SHA-256 of entry {head_seq}): {head_hash}\n"
        f"Verified intact at: {when}\n"
    )


def blockchain_anchor(sb, result, summary_lines):
    if not ots_available():
        print("  OpenTimestamps client not installed -- Bitcoin anchoring skipped")
        return
    try:
        pending = sb.table("audit_anchors").select("anchor_id, ots_proof").eq("status", "Pending") \
            .order("anchored_at").limit(50).execute().data or []
    except Exception as e:
        print(f"  ! audit_anchors table missing ({e}); run migration 14")
        return

    # 1. Upgrade earlier stamps whose Bitcoin transaction has since confirmed.
    for a in pending:
        old = base64.b64decode(a["ots_proof"])
        new = upgrade(old)
        block, calendars, _ = proof_details(new)
        patch = {}
        if new != old:
            patch["ots_proof"] = base64.b64encode(new).decode()
        if block:
            patch.update({"status": "Confirmed", "bitcoin_block": block,
                          "confirmed_at": dt.datetime.now(dt.timezone.utc).isoformat()})
            summary_lines.append(f"| Bitcoin anchor confirmed | block {block} | anchor {a['anchor_id'][:8]} |")
            print(f"  Anchor {a['anchor_id'][:8]} confirmed in Bitcoin block {block}")
        if patch:
            sb.table("audit_anchors").update(patch).eq("anchor_id", a["anchor_id"]).execute()

    # 2. A new stamp, at most once a day and only when the chain has moved on.
    last = sb.table("audit_anchors").select("anchored_at, head_hash").order(
        "anchored_at", desc=True).limit(1).execute().data or []
    if last:
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last[0]["anchored_at"].replace("Z", "+00:00"))
        if age < dt.timedelta(hours=ANCHOR_EVERY_HOURS) or last[0]["head_hash"] == result.get("head_hash"):
            print(f"  Last Bitcoin anchor {age.total_seconds() / 3600:.1f} h ago; next one due later")
            return

    head_seq, head_hash = result.get("head_seq") or result.get("checked"), result.get("head_hash")
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    text = anchor_text(head_seq, head_hash, now)
    proof = stamp(text)
    if not proof:
        return
    block, calendars, digest = proof_details(proof)
    if digest != hashlib.sha256(text.encode("utf-8")).hexdigest():
        print("  ! OpenTimestamps proof does not cover the stamped text; not stored")
        return
    sb.table("audit_anchors").insert({
        "head_seq": head_seq, "head_hash": head_hash, "stamped_text": text,
        "ots_proof": base64.b64encode(proof).decode(), "calendars": calendars,
        "status": "Confirmed" if block else "Pending", "bitcoin_block": block,
    }).execute()
    summary_lines.append(f"| Bitcoin anchor submitted | entry {head_seq} | {len(calendars)} calendars, confirms in a few hours |")
    print(f"  Head hash stamped with OpenTimestamps ({len(calendars)} calendars); Bitcoin confirmation follows")


def main():
    url, key = get_supabase_credentials()
    sb = create_client(url, key)
    result = sb.rpc("verify_audit_chain", {}).execute().data or {}
    stamp_time = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if result.get("ok"):
        line = (f"| {stamp_time} | intact | {result.get('checked')} | "
                f"`{result.get('head_hash')}` |")
        print(f"Audit chain intact: {result.get('checked')} entries, head {result.get('head_hash')}")
    else:
        line = f"| {stamp_time} | **BROKEN at entry {result.get('broken_at')}** | {result.get('checked')} | {result.get('reason')} |"
        print(f"AUDIT CHAIN BROKEN: {result}")

    anchors = []
    if result.get("ok"):
        try:
            blockchain_anchor(sb, result, anchors)
        except Exception as e:  # anchoring must never hide the verification result
            print(f"  ! Bitcoin anchoring skipped this run: {e}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("### Audit trail anchor\n\n| Checked at | Chain | Entries | Head hash |\n|---|---|---|---|\n")
            f.write(line + "\n")
            if anchors:
                f.write("\n| Bitcoin (OpenTimestamps) | | |\n|---|---|---|\n" + "\n".join(anchors) + "\n")

    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
