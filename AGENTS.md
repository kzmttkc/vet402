<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Documentation and code

When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code.

## Working copies
Create a working copy only with `bash ~/vouch/scripts/wt/new.sh <name>` and remove it with `bash ~/vouch/scripts/wt/done.sh <name>` right after its branch is in origin/main. new.sh clones node_modules from ~/vouch (APFS copy, no symlink) so a copy costs about 270MB instead of 1 to 3GB.
