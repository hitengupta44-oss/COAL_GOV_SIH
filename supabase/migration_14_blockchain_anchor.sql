-- ============================================================
-- Migration 14 — anchoring the audit trail in the Bitcoin blockchain
--
-- The audit log is a hash chain (migration 08): altering any past entry
-- breaks every hash after it. The one attack that leaves a chain looking
-- intact is rewriting ALL of it from the altered entry onwards, which
-- someone with full database access could do. Until now the defence was
-- publishing the chain's latest hash in GitHub's job log.
--
-- This adds a public, independent record. Once a day the scheduled job
-- stamps the chain's latest hash with OpenTimestamps, an open standard
-- that commits it to the Bitcoin blockchain within a few hours. Nobody,
-- including us, can later produce a proof for a hash that did not exist
-- at that time. Anyone can check a proof at opentimestamps.org with the
-- two files the Audit page offers for download, without trusting this
-- platform or its database.
--
-- audit_anchor_status then compares every anchor with today's chain: if
-- the entry that was anchored no longer carries the anchored hash, the
-- chain has been rewritten since, whatever verify_audit_chain says.
--
-- Run after migration_13_incident_notice.sql. Safe to re-run.
-- ============================================================

create table if not exists audit_anchors (
    anchor_id      uuid primary key default uuid_generate_v4(),
    anchored_at    timestamptz not null default now(),
    head_seq       bigint not null,
    head_hash      text   not null,
    -- The exact text that was stamped (it names the hash), and the
    -- OpenTimestamps proof for it, base64-encoded.
    stamped_text   text   not null,
    ots_proof      text   not null,
    method         text   not null default 'OpenTimestamps (Bitcoin)',
    status         text   not null default 'Pending' check (status in ('Pending', 'Confirmed')),
    bitcoin_block  int,
    confirmed_at   timestamptz,
    calendars      text[]
);
create index if not exists idx_audit_anchors_time on audit_anchors(anchored_at desc);

alter table audit_anchors enable row level security;
-- Oversight roles read; only the scheduled job (service role) writes.
drop policy if exists "Oversight reads anchors" on audit_anchors;
create policy "Oversight reads anchors" on audit_anchors
  for select using (is_oversight());

-- Anchors are evidence: once written they are only ever upgraded from
-- Pending to Confirmed, never edited in what they claim, never deleted.
create or replace function audit_anchors_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Audit anchors cannot be deleted.';
  end if;
  if (new.anchored_at, new.head_seq, new.head_hash, new.stamped_text)
     is distinct from (old.anchored_at, old.head_seq, old.head_hash, old.stamped_text) then
    raise exception 'An audit anchor cannot be changed, only confirmed.';
  end if;
  if old.status = 'Confirmed' and new.status <> 'Confirmed' then
    raise exception 'A confirmed anchor cannot be un-confirmed.';
  end if;
  return new;
end $$;

drop trigger if exists trg_audit_anchors_guard on audit_anchors;
create trigger trg_audit_anchors_guard
  before update or delete on audit_anchors
  for each row execute function audit_anchors_guard();

-- Each anchor against today's chain.
create or replace view audit_anchor_status as
select a.anchor_id, a.anchored_at, a.head_seq, a.head_hash, a.method, a.status,
       a.bitcoin_block, a.confirmed_at, a.stamped_text, a.ots_proof,
       l.row_hash as current_hash,
       (l.row_hash is not distinct from a.head_hash) as still_matches
  from audit_anchors a
  left join audit_log l on l.chain_seq = a.head_seq;
alter view audit_anchor_status set (security_invoker = true);
grant select on audit_anchor_status to authenticated;
