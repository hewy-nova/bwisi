-- Before We Invite Someone In: database setup
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.
-- Running it again is safe.
--
-- How the security works
-- ----------------------
-- Every answer set is encrypted on the phone (PBKDF2 + AES-GCM) before it is sent.
-- The database only ever holds ciphertext ("blob"), so nobody who can query it,
-- including the project owner, can read an answer without that person's password.
--
-- Each row is addressed by `key` = sha256(name + ":" + stage + ":" + password),
-- computed on the phone. Knowing the key is the proof that you know the password,
-- so the key must never be readable by the public anon role:
--
--   * The anon role gets SELECT on every column EXCEPT `key` (column-level grant).
--     Rows can be listed for the home screen status, but nobody can read, list,
--     or filter by the keys. The blob is readable, but it is only ciphertext.
--
--   * The anon role gets NO direct INSERT, UPDATE or DELETE on the table.
--     Postgres requires SELECT privilege on any column used in a WHERE clause or
--     ON CONFLICT target, so "update where key = ..." or a REST upsert on `key`
--     would need `key` to be readable, which would defeat the point. Instead,
--     every write goes through one of the small functions below. They run with
--     the table owner's rights and only touch rows whose key the caller supplied,
--     which is the "only where the request's key matches" rule, enforced in one place.
--
--   * `decision` and `read_at` are stored in plain text on purpose so the other
--     person's phone can show whether Stage 2 is open without any password.

create table if not exists public.entries (
  key        text primary key check (key ~ '^[0-9a-f]{64}$'),
  name       text not null check (name in ('matt', 'louise')),
  stage      int  not null check (stage in (1, 2)),
  blob       text not null check (length(blob) <= 500000),
  decision   text check (decision in ('yes', 'unsure', 'no')),
  read_at    timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists entries_name_stage_idx on public.entries (name, stage, updated_at desc);

alter table public.entries enable row level security;

-- Supabase grants everything on new tables to anon and authenticated by default. Take it back.
revoke all on table public.entries from anon, authenticated;

-- Readable columns: everything except `key`.
grant select (name, stage, blob, decision, read_at, updated_at) on public.entries to anon, authenticated;

drop policy if exists "anyone can read non-key columns" on public.entries;
create policy "anyone can read non-key columns" on public.entries
  for select to anon, authenticated using (true);
-- No insert, update or delete policies: direct writes are refused. Writes use the functions below.


-- Save (upsert by key). A new key for the same person and stage makes a new version;
-- the page treats the newest updated_at as current. A new version carries over
-- decision and read_at from the previous current version.
create or replace function public.bwisi_save(p_key text, p_name text, p_stage int, p_blob text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_dec  text;
  v_read timestamptz;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then raise exception 'bad key'; end if;
  update entries set blob = p_blob, updated_at = v_now
    where key = p_key and name = p_name and stage = p_stage;
  if not found then
    select decision, read_at into v_dec, v_read from entries
      where name = p_name and stage = p_stage order by updated_at desc limit 1;
    insert into entries (key, name, stage, blob, decision, read_at, updated_at)
      values (p_key, p_name, p_stage, p_blob, v_dec, v_read, v_now);
  end if;
  return v_now;
end $$;

-- Record a Stage 1 decision on the row this key opens. Returns false if no such row.
create or replace function public.bwisi_set_decision(p_key text, p_decision text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_decision not in ('yes', 'unsure', 'no') then raise exception 'bad decision'; end if;
  update entries set decision = p_decision where key = p_key and stage = 1;
  return found;
end $$;

-- Mark a stage as read together. Needs both keys, so both passwords. Keeps the first date.
create or replace function public.bwisi_mark_read(p_key_matt text, p_key_louise text, p_stage int)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if not exists (select 1 from entries where key = p_key_matt and name = 'matt' and stage = p_stage)
     or not exists (select 1 from entries where key = p_key_louise and name = 'louise' and stage = p_stage) then
    raise exception 'unknown keys';
  end if;
  select min(read_at) into v_at from entries where key in (p_key_matt, p_key_louise);
  v_at := coalesce(v_at, now());
  update entries set read_at = v_at where key in (p_key_matt, p_key_louise);
  return v_at;
end $$;

-- Delete versions older than the one this key opens (same person, same stage).
create or replace function public.bwisi_delete_older(p_key text)
returns int
language plpgsql security definer set search_path = public as $$
declare r entries%rowtype; n int;
begin
  select * into r from entries where key = p_key;
  if not found then return 0; end if;
  delete from entries where name = r.name and stage = r.stage and key <> r.key and updated_at < r.updated_at;
  get diagnostics n = row_count;
  return n;
end $$;

-- Clear a stage for both people (all versions). Needs both keys. Clearing Stage 1 also clears Stage 2.
create or replace function public.bwisi_reset(p_key_matt text, p_key_louise text, p_stage int)
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not exists (select 1 from entries where key = p_key_matt and name = 'matt' and stage = p_stage)
     or not exists (select 1 from entries where key = p_key_louise and name = 'louise' and stage = p_stage) then
    raise exception 'unknown keys';
  end if;
  delete from entries where stage = p_stage or (p_stage = 1 and stage = 2);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.bwisi_save(text, text, int, text) from public;
revoke all on function public.bwisi_set_decision(text, text) from public;
revoke all on function public.bwisi_mark_read(text, text, int) from public;
revoke all on function public.bwisi_delete_older(text) from public;
revoke all on function public.bwisi_reset(text, text, int) from public;
grant execute on function public.bwisi_save(text, text, int, text) to anon, authenticated;
grant execute on function public.bwisi_set_decision(text, text) to anon, authenticated;
grant execute on function public.bwisi_mark_read(text, text, int) to anon, authenticated;
grant execute on function public.bwisi_delete_older(text) to anon, authenticated;
grant execute on function public.bwisi_reset(text, text, int) to anon, authenticated;

-- Ask the REST API to pick up the new table and functions right away.
notify pgrst, 'reload schema';
