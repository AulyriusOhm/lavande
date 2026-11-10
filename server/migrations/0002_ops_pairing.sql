create table pairing_sessions (
    code_hash bytea primary key,
    user_id uuid not null references users (id) on delete cascade,
    from_device_id uuid not null,
    target_pub_key bytea,
    schema_version int,
    wrapped_key bytea,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    claimed_at timestamptz,
    completed_at timestamptz
);

create table ops (
    seq bigserial primary key,
    user_id uuid not null references users (id) on delete cascade,
    op_id text not null,
    device_id uuid not null,
    entity_ref text not null,
    kind text not null constraint ops_kind_valid check (kind in ('task', 'suggestion')),
    hlc text not null,
    schema_version int not null,
    nonce bytea not null constraint ops_nonce_len check (octet_length(nonce) = 24),
    ciphertext bytea not null constraint ops_ciphertext_len check (
        octet_length(ciphertext) between 1 and 65536
    ),
    created_at timestamptz not null default now(),
    constraint ops_user_op_id_unique unique (user_id, op_id)
);

create index ops_user_seq on ops (user_id, seq);
create index ops_user_entity on ops (user_id, entity_ref);
