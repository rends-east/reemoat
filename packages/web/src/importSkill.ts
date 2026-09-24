/** Pasted into whatever agent the customer runs, so it names no agent or path; its exclusions and size cap are what the daemon enforces. */
export const IMPORT_SKILL = `Run this in the project you want to export. If your agent keeps skills, save it as one first.

---
name: reemoat-export
description: Package this project's source and context into one archive, for import into Reemoat.
---

Package this project so a coding agent somewhere else can pick it up and work on it.

1. Work out what this project is: its name, its language, and how it is built,
   tested and run. Take the name from the directory or from package.json,
   Cargo.toml, pyproject.toml, go.mod or equivalent.

2. Stage a copy under a temp directory, inside **one** folder named after the
   project.

   Include the source, README and docs, config and manifests, lockfiles, schema
   and migrations, .env.example, CI config, and any agent or editor instruction
   files the project carries — AGENTS.md, CLAUDE.md, .cursorrules and the like.

   Exclude .git — an archive containing one is refused, not trimmed — and
   node_modules, vendor, target, dist, build, .next, .venv, __pycache__, caches,
   logs and coverage output.

   Exclude real secrets: .env and .env.*, *.pem, *.key, id_rsa, service-account
   JSON, anything holding a live token. If a file might be one and you are not
   sure, leave it out and say which.

3. Write CONTEXT.md at the top of that folder: what this project is, how the tree
   is laid out, how to install, build, test and run it, and anything else a fresh
   agent would otherwise have to guess. Keep it to a page.

4. Archive the folder, from its parent, so the archive holds that one folder:

       tar --format=ustar -czf <project>.tar.gz <project>

5. Keep it under 50 MB. If it is over, drop the largest files that are not source,
   say which you dropped, and archive again.

6. Print the absolute path of the archive, and nothing else on that line.
---`;
