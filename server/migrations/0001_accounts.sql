create table users (
    id uuid primary key,
    email text not null unique,
    auth_verifier text not null,
    auth_salt bytea not null,
    account_salt bytea not null,
    key_envelope bytea,
    created_at timestamptz not null default now()
);

create table sessions (
    token_hash bytea primary key,
    user_id uuid not null references users (id) on delete cascade,
    device_id uuid,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);

create table devices (
    id uuid primary key,
    user_id uuid not null references users (id) on delete cascade,
    name text not null,
    platform text not null,
    pub_key bytea not null constraint devices_pub_key_len check (octet_length(pub_key) = 32),
    schema_version int not null,
    last_seen_at timestamptz not null default now(),
    revoked_at timestamptz
);

create index sessions_user_id_idx on sessions (user_id);
create index devices_user_id_idx on devices (user_id);
