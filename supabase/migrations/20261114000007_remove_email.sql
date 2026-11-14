-- Sistema sem e-mail (decisão do usuário, plano 499cd858): sem convite, sem recuperação de senha por e-mail e
-- sem Edge Functions. O admin cadastra membros pelo painel do Supabase + SQL Editor (ver
-- docs/DATABASE_SCHEMA.md#cadastro-de-membros-sem-e-mail); quem recebe senha provisória troca no primeiro login.
-- Idempotente. Não edita 0001–0006.

-- ---------------------------------------------------------------- troca de senha obrigatória
-- Perfis que já existem NÃO ficam travados: a coluna nasce com default false (linhas atuais = false) e só
-- depois o default passa a true (cadastros novos nascem obrigados a trocar a senha). Sem UPDATE por e-mail.
alter table public.profiles add column if not exists must_change_password boolean not null default false;
alter table public.profiles alter column must_change_password set default true;

-- Trava NO BANCO (decisão do Frank): a senha provisória é conhecida pelo admin, então até ser trocada ela não
-- pode valer na API. Toda RPC protegida passa por require_role; mark_password_changed fica fora dele.
-- Resto idêntico à 0002. Leituras pelo RLS (inclusive do próprio perfil, para o portal ver a flag) seguem livres.
create or replace function private.require_role(p_role public.app_role) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHENTICATED';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid() and must_change_password) then
    raise exception using errcode = 'P0001', message = 'PASSWORD_CHANGE_REQUIRED';
  end if;
  if private.current_app_role() is distinct from p_role then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  if p_role <> 'operator' and not private.is_aal2() then
    raise exception using errcode = 'P0001', message = 'MFA_REQUIRED';
  end if;
  return auth.uid();
end $$;

-- O próprio usuário, depois de trocar a senha no Auth, baixa a flag. Só mexe no próprio perfil.
create or replace function public.mark_password_changed() returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'UNAUTHENTICATED';
  end if;
  update public.profiles set must_change_password = false where id = auth.uid() and must_change_password;
  if found then
    perform private.audit('member.password_changed', null, jsonb_build_object('profile_id', auth.uid()));
  end if;
end $$;
revoke execute on function public.mark_password_changed() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;

-- ---------------------------------------------------------------- cadastro de membro (3 argumentos)
-- O login do membro é o e-mail do auth.users; o operador não tem mais e-mail próprio.
drop function if exists public.svc_register_member(uuid, public.app_role, text, text, uuid);

create or replace function public.svc_register_member(p_user_id uuid, p_role public.app_role, p_display_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_code text;
begin
  insert into public.profiles (id, role, display_name) values (p_user_id, p_role, btrim(p_display_name))
  on conflict (id) do update set role = excluded.role, display_name = excluded.display_name, active = true;
  if p_role = 'operator' then
    insert into public.operators (id) values (p_user_id) on conflict (id) do nothing;
    select operator_code into v_code from public.operators where id = p_user_id;
  end if;
  -- Chamado do SQL Editor (sem JWT): ator nulo. Pela chave de servidor: papel service_role.
  perform private.audit('member.registered', null, jsonb_build_object('profile_id', p_user_id, 'role', p_role));
  return jsonb_build_object('profile_id', p_user_id, 'operator_code', v_code);
end $$;
revoke execute on function public.svc_register_member(uuid, public.app_role, text) from public, anon, authenticated;
grant execute on function public.svc_register_member(uuid, public.app_role, text) to service_role;

-- ---------------------------------------------------------------- e-mail próprio do operador
alter table public.operators drop column if exists notification_email;

-- ---------------------------------------------------------------- helper do convite
-- Só existia para a Edge Function admin-invite validar o JWT do admin.
drop function if exists public.assert_admin();
