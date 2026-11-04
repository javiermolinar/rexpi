# pi-rex

Pi extension package for Rex. Keep terminal-specific operations in `lib/rex.ts`; conversation identity, launch guards and lifecycle logic live separately.

- Read the installed Pi extension documentation and Rex's installed skill before changing their integrations.
- Never infer permission from saved metadata, role labels, parent links or live bindings.
- Separate confirmed creation, observed Pi binding, task readiness and task completion.
- Do not retry uncertain native creation or automatically kill/clean up unknown children.
- Reuse native Activity reporting rather than emitting duplicate status.
- Keep history handoffs, worktrees, messaging, remote launches and custom panels out of this initial slice unless explicitly requested.
- Keep `rex_open_terminal` independent from the `pi-rex.commands` user catalog. Catalog entries never authorize agent execution; forwarded arguments must stay literal.
- Update README and CHANGELOG for user-visible behavior changes.
- Validate with `npm test`, `npm run typecheck`, and `npm run pack:check`.
- `npm run smoke` is an explicit native test: it creates a hidden disposable Rex session, starts real Pi processes without model prompts, and cleans up only its known test session. It never installs the package or edits global settings.
