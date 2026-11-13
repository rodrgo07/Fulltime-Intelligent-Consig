-- Fulltime Intelligent Consig — estrutura base.
-- Regra geral: dados pessoais do cliente existem SOMENTE em public.clients_temp.
-- Todas as demais tabelas guardam identificadores técnicos.

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------- tipos
create type public.app_role as enum ('operator', 'admin', 'backoffice');

create type public.request_status as enum (
  'received',              -- solicitação recebida (gravada, backoffice ainda não confirmou recebimento)
  'queued',                -- aguardando processamento
  'preparing',             -- em preparação (job reservado pelo backoffice)
  'running',               -- em execução no motor RPA
  'awaiting_confirmation', -- aguardando confirmação humana
  'completed',             -- concluída
  'failed',                -- falha
  'cancelled'              -- cancelada
);

create type public.job_status as enum (
  'leased', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'released', 'cancelled'
);

create type public.notification_status as enum ('pending', 'sending', 'sent', 'failed');

-- ---------------------------------------------------------------- utilidades
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- configurações
create table public.app_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  value jsonb not null,
  description text not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value, description) values
  ('rate_limit_per_minute',     '10',        'Máximo de solicitações por operador por minuto'),
  ('rate_limit_per_day',        '300',       'Máximo de solicitações por operador por dia'),
  ('payload_max_bytes',         '16384',     'Tamanho máximo do payload do formulário'),
  ('pii_ttl_hours',             '72',        'Prazo máximo dos dados pessoais de solicitações não concluídas'),
  ('history_retention_days',    '90',        'Retenção de solicitações finalizadas, resultados e auditoria (PENDENTE VALIDAÇÃO JURÍDICA)'),
  ('job_lease_seconds',         '300',       'Duração da reserva de um job; renovada por heartbeat'),
  ('job_max_attempts',          '3',         'Tentativas automáticas antes de marcar falha'),
  ('notification_max_attempts', '8',         'Tentativas de envio de e-mail antes de marcar falha'),
  ('storage_limit_bytes',       '524288000', 'Limite de armazenamento do plano (500 MB no plano gratuito)');

create function private.setting_int(p_key text) returns integer
language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::integer from public.app_settings where key = p_key
$$;

-- ---------------------------------------------------------------- pessoas
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

create sequence public.operator_code_seq;

create table public.operators (
  id uuid primary key references public.profiles (id) on delete cascade,
  operator_code text not null unique
    default 'OP-' || lpad(nextval('public.operator_code_seq')::text, 4, '0')
    check (operator_code ~ '^OP-[0-9]{4,}$'),
  notification_email text not null
    check (char_length(notification_email) <= 254 and notification_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- formulário versionado
-- Os campos reais serão definidos quando o processo do Consig for mapeado.
-- Nenhuma versão é criada aqui: sem formulário ativo, o envio é recusado (FORM_NOT_CONFIGURED).
create table public.form_definitions (
  version integer primary key check (version > 0),
  title text not null check (char_length(title) between 1 and 120),
  fields jsonb not null check (jsonb_typeof(fields) = 'array'),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index form_definitions_one_active on public.form_definitions ((true)) where active;

-- ---------------------------------------------------------------- solicitações
create function private.new_public_ref() returns text
language sql volatile set search_path = '' as $$
  select 'FIC-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYMMDD') || '-'
         || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
$$;

create table public.proposal_requests (
  id uuid primary key default gen_random_uuid(),
  public_ref text not null unique default private.new_public_ref(),
  submitted_by uuid not null references public.operators (id),
  owner_operator_id uuid not null references public.operators (id),
  idempotency_key uuid not null,
  payload_fingerprint text,                -- sha256 do payload; apagado junto com os dados pessoais
  form_version integer not null references public.form_definitions (version),
  status public.request_status not null default 'received',
  status_reason text check (char_length(status_reason) <= 500),
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  pii_expires_at timestamptz not null,
  pii_purged_at timestamptz,
  unique (submitted_by, idempotency_key)
);
create trigger proposal_requests_touch before update on public.proposal_requests
  for each row execute function private.touch_updated_at();
create index proposal_requests_status_idx on public.proposal_requests (status, received_at);
create index proposal_requests_submitter_idx on public.proposal_requests (submitted_by, received_at desc);
create index proposal_requests_owner_idx on public.proposal_requests (owner_operator_id, received_at desc);
-- Uma única proposta pode ocupar a sessão do Consig por vez (garantia no banco).
create unique index proposal_requests_single_active on public.proposal_requests ((true))
  where status in ('preparing', 'running', 'awaiting_confirmation');

-- Dados pessoais temporários. Sem políticas RLS: acesso somente por funções controladas.
create table public.clients_temp (
  request_id uuid primary key references public.proposal_requests (id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------- execução
create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.proposal_requests (id) on delete cascade,
  attempt integer not null check (attempt >= 1),
  status public.job_status not null default 'leased',
  worker_id text not null check (char_length(worker_id) between 1 and 100),
  leased_by uuid not null references public.profiles (id),
  app_version text check (char_length(app_version) <= 40),
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  current_step text check (char_length(current_step) <= 100),
  side_effect_started_at timestamptz,      -- após este ponto nunca há nova tentativa automática
  error_code text check (char_length(error_code) <= 64),
  error_message text check (char_length(error_message) <= 1000),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (request_id, attempt)
);
create unique index automation_jobs_one_open on public.automation_jobs ((true))
  where status in ('leased', 'running', 'awaiting_confirmation');
create index automation_jobs_request_idx on public.automation_jobs (request_id);

create table public.proposal_results (
  request_id uuid primary key references public.proposal_requests (id) on delete cascade,
  job_id uuid references public.automation_jobs (id) on delete set null,
  adhesion_number text not null check (char_length(adhesion_number) between 1 and 64),
  external_operation_id text check (char_length(external_operation_id) <= 128),
  result_status text not null check (char_length(result_status) between 1 and 64),
  completed_at timestamptz not null,
  source text not null check (source in ('rpa', 'manual')),
  confirmed_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- notificações
create table public.notification_queue (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.proposal_requests (id) on delete cascade,
  kind text not null check (kind in ('proposal_completed')),
  recipient_operator_id uuid not null references public.operators (id),
  status public.notification_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (char_length(last_error) <= 500),
  provider_message_id text check (char_length(provider_message_id) <= 128),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (request_id, kind)               -- impede notificação duplicada
);
create index notification_queue_due_idx on public.notification_queue (status, next_attempt_at);

-- ---------------------------------------------------------------- auditoria e versões
create table public.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,                           -- sem FK: o registro sobrevive à remoção do usuário
  actor_role text,
  action text not null check (action ~ '^[a-z][a-z0-9_.]{2,63}$'),
  request_id uuid,
  details jsonb not null default '{}'::jsonb
);
create index audit_logs_time_idx on public.audit_logs (occurred_at);
create index audit_logs_request_idx on public.audit_logs (request_id);

create table public.app_versions (
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),
  channel text not null check (channel in ('development', 'staging', 'production')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_reported_by uuid references public.profiles (id) on delete set null,
  primary key (version, channel)
);
