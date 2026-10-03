-- Run this in your Supabase SQL editor (safe to run on existing schema)

-- Enable pgvector (idempotent)
create extension if not exists vector;

-- Drop old policies before recreating
drop policy if exists "Users manage own settings" on user_settings;
drop policy if exists "Users manage own files" on uploaded_files;
drop policy if exists "Users manage own chunks" on doc_chunks;
drop policy if exists "Users manage own replies" on email_replies;
drop policy if exists "Owner upload" on storage.objects;
drop policy if exists "Owner read" on storage.objects;
drop policy if exists "Owner delete" on storage.objects;

-- Drop old ivfflat index if it exists
drop index if exists doc_chunks_embedding_idx;

-- Add chunk_tsv column if it doesn't exist yet
alter table doc_chunks
  add column if not exists chunk_tsv tsvector
    generated always as (to_tsvector('english', chunk_text)) stored;

-- HNSW index for cosine similarity
create index if not exists doc_chunks_embedding_hnsw_idx
  on doc_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- GIN index for full-text keyword search
create index if not exists doc_chunks_tsv_idx
  on doc_chunks using gin (chunk_tsv);

-- Recreate RLS policies
create policy "Users manage own settings"
  on user_settings for all using (auth.uid() = user_id);

create policy "Users manage own files"
  on uploaded_files for all using (auth.uid() = user_id);

create policy "Users manage own chunks"
  on doc_chunks for all using (auth.uid() = user_id);

create policy "Users manage own replies"
  on email_replies for all using (auth.uid() = user_id);

-- Storage policies
create policy "Owner upload"
  on storage.objects for insert
  with check (bucket_id = 'knowledge-base' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Owner read"
  on storage.objects for select
  using (bucket_id = 'knowledge-base' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Owner delete"
  on storage.objects for delete
  using (bucket_id = 'knowledge-base' and auth.uid()::text = (storage.foldername(name))[1]);

-- Hybrid search function (create or replace — safe to rerun)
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
