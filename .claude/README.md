# `.claude/`

`skills/` symlinks the project's two skills into the location Claude Code
discovers, so `/heal-agent` is invocable from a session in this repo. The skills
themselves live in `skills/` at the root, because they are project artifacts
rather than editor configuration — `cli gen` copies `spec-to-agent` into its
sandbox from there, not from here.

Symlinks rather than copies: two divergent versions of a skill, one of which
silently wins, is a debugging session nobody needs.
