-- OTP codes table
create table if not exists otp_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts int not null default 0,
  ip_address text
);

create index if not exists idx_otp_email_created on otp_codes (email, created_at desc);
create index if not exists idx_otp_hash on otp_codes (code_hash) where used_at is null;

-- Rate limiting table
create table if not exists auth_rate_limits (
  id bigserial primary key,
  email text,
  ip_address text,
  action text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rl_email_action on auth_rate_limits (email, action, created_at desc);
create index if not exists idx_rl_ip_action on auth_rate_limits (ip_address, action, created_at desc);

-- RLS on profili_salvati: deny ALL to anon/authenticated
alter table profili_salvati enable row level security;

drop policy if exists "no_direct_access" on profili_salvati;
create policy "no_direct_access" on profili_salvati
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- RLS on otp_codes: deny all to anon/authenticated
alter table otp_codes enable row level security;

drop policy if exists "no_anon_otp" on otp_codes;
create policy "no_anon_otp" on otp_codes
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- RLS on auth_rate_limits: deny all to anon/authenticated
alter table auth_rate_limits enable row level security;

drop policy if exists "no_anon_rl" on auth_rate_limits;
create policy "no_anon_rl" on auth_rate_limits
  for all
  to anon, authenticated
  using (false)
  with check (false);
