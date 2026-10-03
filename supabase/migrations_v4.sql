-- Run in Supabase SQL editor

alter table user_settings
  add column if not exists openai_key_encrypted text,
  add column if not exists gemini_key_encrypted text,
  add column if not exists writing_rules text[],
  add column if not exists ask_rules_every_time boolean default false,
  add column if not exists onboarding_complete boolean default false;
