-- ============================================================================
-- Add `meetings` to supabase_realtime so the Meeting Notes panel reflects
-- /meetings/start + /meetings/{id}/end (and any other status changes) across
-- tabs without a manual refresh.
--
-- Idempotent: ALTER PUBLICATION raises "table already in publication" if
-- run twice, so we wrap it in a DO block that swallows that specific error.
-- ============================================================================

do $$
begin
  execute 'alter publication supabase_realtime add table meetings';
exception
  when duplicate_object then null;
  when others then
    -- Older PG versions report the duplicate-add as 42710 / "is already member of"
    if sqlerrm ilike '%already%' then null; else raise; end if;
end $$;
