create table if not exists public.campanhas (
  token text primary key,
  titulo text default '',
  empresa text default '',
  dev_id text default '',
  nota text default '',
  num_avaliacoes text default '',
  classificacao text default '',
  downloads text default '',
  descricao text default '',
  descricao_curta text default '',
  atualizado_em text default '',
  disponivel_em text default '',
  icone_url text default '',
  screenshots jsonb default '[]'::jsonb,
  criado_em timestamptz default now()
);

alter table public.campanhas enable row level security;

insert into storage.buckets (id, name, public) values ('midia', 'midia', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('pages', 'pages', true) on conflict (id) do nothing;
