create unique index if not exists generation_runs_one_active_uniq
  on generation_runs (project_id, week_start)
  where status in ('queued', 'running');

revoke all on meeting_notes, meeting_transcript_chunks, project_context,
              knowledge_documents, plan_items, generated_actions,
              generation_runs, projects, meetings from anon, authenticated;

grant select on meeting_notes              to anon;
grant select on meeting_transcript_chunks  to anon;
grant select on project_context            to anon;
grant select on knowledge_documents        to anon;
grant select on plan_items                 to anon;
grant select on generated_actions          to anon;
grant select on generation_runs            to anon;
grant select on projects                   to anon;
grant select on meetings                   to anon;

grant insert on meeting_notes              to anon;
grant insert on meeting_transcript_chunks  to anon;

grant select on meeting_notes, meeting_transcript_chunks, project_context,
                knowledge_documents, plan_items, generated_actions,
                generation_runs, projects, meetings to authenticated;
grant insert on meeting_notes, meeting_transcript_chunks to authenticated;
