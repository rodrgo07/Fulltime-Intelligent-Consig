-- Papéis, RLS, privilégios e validações centrais.

-- ---------------------------------------------------------------- identidade do chamador
create function private.current_app_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create function private.is_aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
$$;

-- admin e backoffice exigem MFA (aal2); operador não.
create function private.has_role(p_role public.app_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_app_role() = p_role
     and (p_role = 'operator' or private.is_aal2())
$$;

create function private.is_staff() returns boolean
language sql stable set search_path = '' as $$
  select private.has_role('admin') or private.has_role('backoffice')
$$;

create function private.require_role(p_role public.app_role) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHENTICATED';
  end if;
  if private.current_app_role() is distinct from p_role then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_role <> 'operator' and not private.is_aal2() then
    raise exception using errcode = 'P0001', message = 'MFA_REQUIRED';
  end if;
  return auth.uid();
end $$;

-- ---------------------------------------------------------------- auditoria (interna)
create function private.audit(p_action text, p_request_id uuid, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (actor_id, actor_role, action, request_id, details)
  values (auth.uid(), coalesce(private.current_app_role()::text, auth.role()), p_action, p_request_id,
          coalesce(p_details, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------- máquina de estados da solicitação
create function private.request_transition_allowed(p_from public.request_status, p_to public.request_status)
returns boolean language sql immutable set search_path = '' as $$
  select (p_from, p_to) in (
    ('received', 'queued'), ('received', 'cancelled'), ('received', 'failed'),
    ('queued', 'preparing'), ('queued', 'cancelled'), ('queued', 'failed'),
    ('preparing', 'running'), ('preparing', 'queued'), ('preparing', 'failed'),
    ('preparing', 'awaiting_confirmation'), ('preparing', 'cancelled'),
    ('running', 'completed'), ('running', 'failed'), ('running', 'queued'),
    ('running', 'awaiting_confirmation'),
    ('awaiting_confirmation', 'completed'), ('awaiting_confirmation', 'queued'),
    ('awaiting_confirmation', 'failed'), ('awaiting_confirmation', 'cancelled'),
    ('failed', 'queued')
  )
$$;

create function private.guard_request_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and not private.request_transition_allowed(old.status, new.status) then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION',
      detail = format('%s -> %s', old.status, new.status);
  end if;
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;

create trigger proposal_requests_guard before update of status on public.proposal_requests
  for each row execute function private.guard_request_status();

-- ---------------------------------------------------------------- validação do formulário
create function private.is_valid_cpf(v text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  d integer[];
  s integer;
  r integer;
begin
  if v is null or v !~ '^[0-9]{11}$' or v ~ '^(.)\1{10}$' then
    return false;
  end if;
  d := array(select substr(v, i, 1)::integer from generate_series(1, 11) as i);
  s := 0;
  for i in 1..9 loop s := s + d[i] * (11 - i); end loop;
  r := (s * 10) % 11; if r = 10 then r := 0; end if;
  if r <> d[10] then return false; end if;
  s := 0;
  for i in 1..10 loop s := s + d[i] * (12 - i); end loop;
  r := (s * 10) % 11; if r = 10 then r := 0; end if;
  return r = d[11];
end $$;

create function private.is_valid_iso_date(v text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  return v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and to_char(v::date, 'YYYY-MM-DD') = v;
exception when others then
  return false;
end $$;

-- Valida a definição de campos (estrutura genérica; nenhum campo bancário é pré-definido).
create function private.form_fields_errors(p_fields jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  f jsonb;
  errs text[] := '{}';
  seen text[] := '{}';
  k text;
begin
  if jsonb_typeof(p_fields) <> 'array' then return array['fields must be an array']; end if;
  for f in select * from jsonb_array_elements(p_fields) loop
    k := f ->> 'key';
    if k is null or k !~ '^[a-z][a-z0-9_]{0,62}$' then errs := errs || format('invalid key %s', k); end if;
    if k = any(seen) then errs := errs || format('duplicate key %s', k); end if;
    seen := seen || k;
    if coalesce(f ->> 'label', '') = '' then errs := errs || format('%s: label required', k); end if;
    if coalesce(f ->> 'type', '') not in ('text', 'integer', 'decimal', 'date', 'select', 'cpf', 'email', 'phone') then
      errs := errs || format('%s: unsupported type %s', k, f ->> 'type');
    end if;
    if f ->> 'type' = 'select' and jsonb_typeof(f -> 'options') is distinct from 'array' then
      errs := errs || format('%s: select requires options', k);
    end if;
  end loop;
  return errs;
end $$;

create function private.guard_form_definition() returns trigger
language plpgsql set search_path = '' as $$
declare errs text[];
begin
  errs := private.form_fields_errors(new.fields);
  if cardinality(errs) > 0 then
    raise exception using errcode = 'P0001', message = 'FORM_DEFINITION_INVALID', detail = array_to_string(errs, '; ');
  end if;
  return new;
end $$;

create trigger form_definitions_guard before insert or update on public.form_definitions
  for each row execute function private.guard_form_definition();

-- Retorna [{field, code}] — vazio quando válido. Fonte única das regras de validação do payload.
create function private.validate_payload(p_fields jsonb, p_payload jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  f jsonb;
  k text;
  t text;
  v jsonb;
  s text;
  n numeric;
  errs jsonb := '[]'::jsonb;
  known text[] := '{}';
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    return jsonb_build_array(jsonb_build_object('field', null, 'code', 'NOT_AN_OBJECT'));
  end if;

  for f in select * from jsonb_array_elements(p_fields) loop
    k := f ->> 'key';
    t := f ->> 'type';
    known := known || k;
    v := p_payload -> k;

    if v is null or v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') then
      if coalesce((f ->> 'required')::boolean, false) then
        errs := errs || jsonb_build_object('field', k, 'code', 'REQUIRED');
      end if;
      continue;
    end if;

    if t in ('integer', 'decimal') then
      if jsonb_typeof(v) <> 'number' then
        errs := errs || jsonb_build_object('field', k, 'code', 'NOT_A_NUMBER'); continue;
      end if;
      n := (v #>> '{}')::numeric;
      if t = 'integer' and n <> trunc(n) then
        errs := errs || jsonb_build_object('field', k, 'code', 'NOT_AN_INTEGER'); continue;
      end if;
      if f ? 'min' and n < (f ->> 'min')::numeric then
        errs := errs || jsonb_build_object('field', k, 'code', 'BELOW_MIN'); continue;
      end if;
      if f ? 'max' and n > (f ->> 'max')::numeric then
        errs := errs || jsonb_build_object('field', k, 'code', 'ABOVE_MAX'); continue;
      end if;
      continue;
    end if;

    if jsonb_typeof(v) <> 'string' then
      errs := errs || jsonb_build_object('field', k, 'code', 'NOT_A_STRING'); continue;
    end if;
    s := v #>> '{}';

    if char_length(s) > coalesce((f ->> 'max_length')::integer, 500) then
      errs := errs || jsonb_build_object('field', k, 'code', 'TOO_LONG'); continue;
    end if;
    if f ? 'min_length' and char_length(s) < (f ->> 'min_length')::integer then
      errs := errs || jsonb_build_object('field', k, 'code', 'TOO_SHORT'); continue;
    end if;
    if f ? 'pattern' and s !~ (f ->> 'pattern') then
      errs := errs || jsonb_build_object('field', k, 'code', 'PATTERN_MISMATCH'); continue;
    end if;

    case t
      when 'cpf' then
        if not private.is_valid_cpf(s) then errs := errs || jsonb_build_object('field', k, 'code', 'INVALID_CPF'); end if;
      when 'email' then
        if s !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then errs := errs || jsonb_build_object('field', k, 'code', 'INVALID_EMAIL'); end if;
      when 'phone' then
        if s !~ '^[0-9]{10,11}$' then errs := errs || jsonb_build_object('field', k, 'code', 'INVALID_PHONE'); end if;
      when 'date' then
        if not private.is_valid_iso_date(s) then
          errs := errs || jsonb_build_object('field', k, 'code', 'INVALID_DATE');
        elsif (f ? 'min' and s < f ->> 'min') or (f ? 'max' and s > f ->> 'max') then
          errs := errs || jsonb_build_object('field', k, 'code', 'DATE_OUT_OF_RANGE');
        end if;
      when 'select' then
        if not exists (select 1 from jsonb_array_elements(f -> 'options') o where o ->> 'value' = s) then
          errs := errs || jsonb_build_object('field', k, 'code', 'INVALID_OPTION');
        end if;
      else null;
    end case;
  end loop;

  for k in select jsonb_object_keys(p_payload) loop
    if not k = any(known) then
      errs := errs || jsonb_build_object('field', k, 'code', 'UNKNOWN_FIELD');
    end if;
  end loop;

  return errs;
end $$;

-- ---------------------------------------------------------------- privilégios
-- Nada de escrita direta pela API: toda alteração passa por funções que aplicam as regras.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
-- O EXECUTE padrão para PUBLIC só é removível no nível global (sem "in schema").
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

grant usage on schema private to authenticated;
grant execute on function private.current_app_role(), private.is_aal2(),
  private.has_role(public.app_role), private.is_staff() to authenticated;

grant select on public.profiles, public.operators, public.form_definitions, public.proposal_requests,
  public.automation_jobs, public.proposal_results, public.notification_queue, public.audit_logs,
  public.app_versions, public.app_settings to authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.app_settings       enable row level security;
alter table public.profiles           enable row level security;
alter table public.operators          enable row level security;
alter table public.form_definitions   enable row level security;
alter table public.proposal_requests  enable row level security;
alter table public.clients_temp       enable row level security;  -- sem políticas: negado a todos via API
alter table public.automation_jobs    enable row level security;
alter table public.proposal_results   enable row level security;
alter table public.notification_queue enable row level security;
alter table public.audit_logs         enable row level security;
alter table public.app_versions       enable row level security;

create policy profiles_self on public.profiles for select to authenticated
  using (id = auth.uid() or private.is_staff());

create policy operators_self on public.operators for select to authenticated
  using (id = auth.uid() or private.is_staff());

create policy form_definitions_active on public.form_definitions for select to authenticated
  using (active or private.has_role('admin'));

create policy requests_participants on public.proposal_requests for select to authenticated
  using (submitted_by = auth.uid() or owner_operator_id = auth.uid() or private.is_staff());

create policy results_participants on public.proposal_results for select to authenticated
  using (
    private.is_staff() or exists (
      select 1 from public.proposal_requests r
      where r.id = request_id and (r.submitted_by = auth.uid() or r.owner_operator_id = auth.uid())
    )
  );

create policy jobs_staff on public.automation_jobs for select to authenticated using (private.is_staff());
create policy notifications_staff on public.notification_queue for select to authenticated using (private.is_staff());
create policy audit_staff on public.audit_logs for select to authenticated using (private.is_staff());
create policy versions_staff on public.app_versions for select to authenticated using (private.is_staff());
create policy settings_staff on public.app_settings for select to authenticated using (private.is_staff());
