drop table if exists pairing_sessions;
create table pairing_sessions (
  code_hash bytea primary key,
  device_id uuid not null,
  name text not null,
  platform text not null,
  target_pub_key bytea not null constraint pairing_pub_key_len check (octet_length(target_pub_key) = 32),
  schema_version int not null,
  poll_secret_hash bytea not null,
  user_id uuid references users (id) on delete cascade,
  wrapped_key text,
  token_issued_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz
);
create index pairing_sessions_expiry_idx on pairing_sessions (expires_at);
create unique index devices_user_pubkey_unique on devices (user_id, pub_key) where revoked_at is null;
