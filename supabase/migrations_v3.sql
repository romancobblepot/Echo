-- Run in Supabase SQL editor

alter table user_settings
  add column if not exists gmail_access_token text,
  add column if not exists gmail_refresh_token text,
  add column if not exists gmail_token_expiry timestamptz;
