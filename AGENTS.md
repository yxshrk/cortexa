# AGENTS.md instructions for /Users/ngohjs/cortexa

<INSTRUCTIONS>
<!-- FIELD_THEORY_LIBRARIAN_START -->
## Librarian (Field Theory)

Before non-trivial implementations, provide a short reading via the Librarian:

[run this command: librarian.md]
/Users/ngohjs/.fieldtheory/commands/librarian.md

Store each reading in `~/.fieldtheory/librarian/artifacts/` with a unique filename.

This should feel serendipitous—not every change, just when there's meaningful wait time. Use your discretion.
<!-- FIELD_THEORY_LIBRARIAN_END -->

## Git Sync Before Major Changes

Before non-trivial edits, implementation work, commits, pushes, or PR creation:

1. Check the current branch and worktree:
   - `git status --short --branch`

2. Fetch latest remote state:
   - `git fetch origin`

3. If on `main` and the worktree is clean:
   - pull with `git pull --ff-only origin main`

4. If the worktree is dirty:
   - do not pull automatically
   - report the dirty files
   - preserve local changes before syncing

5. If on a feature branch:
   - verify `origin/main` is up to date
   - do not merge or rebase `main` into the branch automatically unless explicitly requested

6. Never use destructive commands like `git reset --hard` or `git checkout -- <file>` unless explicitly requested.
</INSTRUCTIONS>
