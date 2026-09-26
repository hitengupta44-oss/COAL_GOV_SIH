"""
Verifies the audit hash chain and publishes its head outside the database.

The hash chain (migration 08) makes any edit to past audit entries
detectable -- unless someone with full database access rewrites the WHOLE
chain from the edited entry onwards. Publishing the head hash somewhere the
database cannot reach closes that gap: a rewritten chain ends in a different
hash from the one already on public record.

Run by the scheduled GitHub Action after every job run. Each run's head hash
lands in the workflow's job summary, which is kept by GitHub and not
editable from the database. The job FAILS (and GitHub emails the repo
owners) if verification ever fails.

    python publish_audit_anchor.py
"""

import datetime as dt
import os
import sys

from supabase import create_client

from credentials import get_supabase_credentials


def main():
    url, key = get_supabase_credentials()
    sb = create_client(url, key)
    result = sb.rpc("verify_audit_chain", {}).execute().data or {}
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if result.get("ok"):
        line = (f"| {stamp} | intact | {result.get('checked')} | "
                f"`{result.get('head_hash')}` |")
        print(f"Audit chain intact: {result.get('checked')} entries, head {result.get('head_hash')}")
    else:
        line = f"| {stamp} | **BROKEN at entry {result.get('broken_at')}** | {result.get('checked')} | {result.get('reason')} |"
        print(f"AUDIT CHAIN BROKEN: {result}")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("### Audit trail anchor\n\n| Checked at | Chain | Entries | Head hash |\n|---|---|---|---|\n")
            f.write(line + "\n")

    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
