-- Run this in your Supabase SQL editor (full reset — drop and recreate)

-- Enable pgvector extension
create extension if not exists vector;

-- User settings (Groq API key stored encrypted)
create table if not exists user_settings (
  user_id uuid primary key references auth.users on delete cascade,
  groq_api_key_encrypted text,
  updated_at timestamptz default now()
);

-- Uploaded file registry
create table if not exists uploaded_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade,
  file_name text not null,
  file_path text not null,
  file_type text not null,
  file_size bigint,
  parent_folder text,
  uploaded_at timestamptz default now()
);

-- Vector knowledge base (768 dims for all-mpnet-base-v2)
create table if not exists doc_chunks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid references uploaded_files on delete cascade,
  user_id uuid references auth.users on delete cascade,
  chunk_text text not null,
  embedding vector(768),
  chunk_index integer,
  -- Full-text search column (auto-populated via trigger)
  chunk_tsv tsvector generated always as (to_tsvector('english', chunk_text)) stored,
  metadata jsonb
);

-- Email reply log
create table if not exists email_replies (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  user_id uuid references auth.users on delete cascade,
  original_email_id text,
  original_email_snippet text,
  ai_draft text,
  sent_reply text,
  model_used text,
  retrieved_context jsonb,
  star_rating smallint check (star_rating between 1 and 5),
  textual_feedback text
);

-- RLS
alter table user_settings enable row level security;
alter table uploaded_files enable row level security;
alter table doc_chunks enable row level security;
alter table email_replies enable row level security;

create policy "Users manage own settings"
  on user_settings for all using (auth.uid() = user_id);

create policy "Users manage own files"
  on uploaded_files for all using (auth.uid() = user_id);

create policy "Users manage own chunks"
  on doc_chunks for all using (auth.uid() = user_id);

create policy "Users manage own replies"
  on email_replies for all using (auth.uid() = user_id);

-- HNSW index for fast cosine similarity search (better than ivfflat for small-medium data)
create index if not exists doc_chunks_embedding_hnsw_idx
  on doc_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- GIN index for full-text keyword search
create index if not exists doc_chunks_tsv_idx
  on doc_chunks using gin (chunk_tsv);

-- Hybrid search function: semantic + keyword, returns merged candidates
-- Called server-side; reranking happens in application code
create or replace function hybrid_search(
  query_embedding vector(768),
  query_text text,
  match_user_id uuid,
  top_k int default 5
)
returns table (
  id uuid,
  file_id uuid,
  chunk_text text,
  metadata jsonb,
  semantic_score float,
  keyword_rank float
)
language sql
as $$
  with semantic as (
    select
      dc.id,
      dc.file_id,
      dc.chunk_text,
      dc.metadata,
      1 - (dc.embedding <=> query_embedding) as score
    from doc_chunks dc
    where dc.user_id = match_user_id
    order by dc.embedding <=> query_embedding
    limit top_k
  ),
  keyword as (
    select
      dc.id,
      dc.file_id,
      dc.chunk_text,
      dc.metadata,
      ts_rank_cd(dc.chunk_tsv, plainto_tsquery('english', query_text)) as score
    from doc_chunks dc
    where dc.user_id = match_user_id
      and dc.chunk_tsv @@ plainto_tsquery('english', query_text)
    order by score desc
    limit top_k
  )
  select
    coalesce(s.id, k.id) as id,
    coalesce(s.file_id, k.file_id) as file_id,
    coalesce(s.chunk_text, k.chunk_text) as chunk_text,
    coalesce(s.metadata, k.metadata) as metadata,
    coalesce(s.score, 0) as semantic_score,
    coalesce(k.score, 0) as keyword_rank
  from semantic s
  full outer join keyword k on s.id = k.id;
$$;

-- Supabase Storage bucket
insert into storage.buckets (id, name, public)
  values ('knowledge-base', 'knowledge-base', false)
  on conflict do nothing;

create policy "Owner upload"
  on storage.objects for insert
  with check (bucket_id = 'knowledge-base' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Owner read"
  on storage.objects for select
  using (bucket_id = 'knowledge-base' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Owner delete"
  on storage.objects for delete
  using (bucket_id = 'knowledge-base' and auth.uid()::text = (storage.foldername(name))[1]);
