-- hibe lab 홈페이지 관리자 기능용 Supabase 설정
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 Run 한 번이면 됩니다.

-- 1) 관리자 명단: 여기에 있는 이메일로 로그인한 사람만 홈페이지 내용을 고칠 수 있습니다.
create table if not exists public.admins (
  email      text primary key check (email = lower(email)),
  added_at   timestamptz not null default now(),
  added_by   text
);

-- 2) 홈페이지 내용: 구역(members, projects, pubs, posts, awards ...)마다 한 줄, 내용은 JSON
create table if not exists public.site_content (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- 3) 고치기 전 내용을 자동 보관 (실수했을 때 되돌리기용)
create table if not exists public.site_content_history (
  id         bigint generated always as identity primary key,
  key        text not null,
  data       jsonb not null,
  saved_at   timestamptz not null default now(),
  saved_by   text
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public.keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.site_content_history (key, data, saved_by) values (old.key, old.data, old.updated_by);
  new.updated_at := now();
  new.updated_by := lower(auth.jwt() ->> 'email');
  return new;
end $$;
drop trigger if exists site_content_history_trg on public.site_content;
create trigger site_content_history_trg before update on public.site_content
  for each row execute function public.keep_history();

create or replace function public.stamp_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin new.updated_by := lower(auth.jwt() ->> 'email'); return new; end $$;
drop trigger if exists site_content_insert_trg on public.site_content;
create trigger site_content_insert_trg before insert on public.site_content
  for each row execute function public.stamp_insert();

alter table public.admins               enable row level security;
alter table public.site_content         enable row level security;
alter table public.site_content_history enable row level security;

drop policy if exists "anyone reads content" on public.site_content;
create policy "anyone reads content" on public.site_content for select using (true);
drop policy if exists "admins write content" on public.site_content;
create policy "admins write content" on public.site_content for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins read history" on public.site_content_history;
create policy "admins read history" on public.site_content_history for select to authenticated using (public.is_admin());

drop policy if exists "admins see admins" on public.admins;
create policy "admins see admins" on public.admins for select to authenticated using (public.is_admin());
drop policy if exists "admins add admins" on public.admins;
create policy "admins add admins" on public.admins for insert to authenticated with check (public.is_admin());
drop policy if exists "admins remove others" on public.admins;
create policy "admins remove others" on public.admins for delete to authenticated
  using (public.is_admin() and email <> lower(auth.jwt() ->> 'email'));

-- 4) 사진 저장소 (누구나 보기, 관리자만 올리기·지우기)
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict (id) do nothing;
drop policy if exists "anyone reads media" on storage.objects;
create policy "anyone reads media" on storage.objects for select using (bucket_id = 'media');
drop policy if exists "admins upload media" on storage.objects;
create policy "admins upload media" on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.is_admin());
drop policy if exists "admins change media" on storage.objects;
create policy "admins change media" on storage.objects for update to authenticated using (bucket_id = 'media' and public.is_admin());
drop policy if exists "admins delete media" on storage.objects;
create policy "admins delete media" on storage.objects for delete to authenticated using (bucket_id = 'media' and public.is_admin());

-- 5) 첫 관리자 (P.I.)
insert into public.admins (email, added_by) values ('myk127@cau.ac.kr', 'setup') on conflict do nothing;
