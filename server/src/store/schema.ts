export const SCHEMA_SQL = `
pragma journal_mode = WAL;
pragma foreign_keys = ON;

create table if not exists users (
  id          text primary key,
  nickname    text not null,
  device_id   text unique,
  created_at  text not null,
  updated_at  text not null,
  revision    integer not null default 1
);

create table if not exists ledgers (
  id          text primary key,
  name        text not null,
  currency    text not null default 'CNY',
  owner_id    text not null references users(id),
  invite_code text not null unique,
  created_at  text not null,
  updated_at  text not null,
  deleted_at  text,
  revision    integer not null default 1
);

-- The per-ledger monotonic counter that drives incremental sync.
create table if not exists ledger_revisions (
  ledger_id text primary key references ledgers(id),
  revision  integer not null default 0
);

create table if not exists ledger_members (
  id         text primary key,
  ledger_id  text not null references ledgers(id),
  user_id    text not null references users(id),
  role       text not null check (role in ('owner', 'member')),
  joined_at  text not null,
  removed_at text,
  revision   integer not null default 1,
  unique (ledger_id, user_id)
);
create index if not exists ledger_members_user on ledger_members(user_id);

create table if not exists categories (
  id          text primary key,
  ledger_id   text not null references ledgers(id),
  key         text not null,
  name        text not null,
  icon        text not null,
  kind        text not null check (kind in ('expense', 'income', 'both')),
  sort_order  integer not null default 100,
  is_archived integer not null default 0,
  revision    integer not null default 1,
  unique (ledger_id, key)
);

create table if not exists expenses (
  id                 text primary key,
  ledger_id          text not null references ledgers(id),
  type               text not null check (type in ('expense', 'income')),
  -- Money is integer minor units, always positive; \`type\` carries the sign.
  amount_cents       integer not null check (amount_cents > 0),
  currency           text not null,
  category_id        text not null,
  date               text not null,
  note               text not null default '',
  -- Who actually handed over the money (first-class).
  paid_by            text not null,
  -- How the shares were derived; kept for editing/diagnostics.
  share_mode         text not null default 'amounts',
  source             text not null default 'manual',
  raw_utterance      text,
  created_by         text not null,
  created_at         text not null,
  updated_at         text not null,
  deleted_at         text,
  revision           integer not null default 1,
  client_mutation_id text
);
create index if not exists expenses_ledger_date on expenses(ledger_id, date);
create index if not exists expenses_ledger_revision on expenses(ledger_id, revision);
create unique index if not exists expenses_idempotency
  on expenses(ledger_id, client_mutation_id) where client_mutation_id is not null;

-- Who ultimately bears the cost (first-class). Sum must equal expenses.amount_cents.
create table if not exists expense_shares (
  id           text primary key,
  expense_id   text not null references expenses(id) on delete cascade,
  ledger_id    text not null,
  user_id      text not null,
  amount_cents integer not null check (amount_cents >= 0),
  unique (expense_id, user_id)
);
create index if not exists expense_shares_expense on expense_shares(expense_id);
create index if not exists expense_shares_user on expense_shares(ledger_id, user_id);
`;
