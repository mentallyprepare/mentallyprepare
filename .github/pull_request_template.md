# What & why

<!-- One paragraph — what changed and why. Link the launch-ladder item or issue if there is one. -->

## Checklist

- [ ] `npm test` green locally
- [ ] `npm run check:syntax` clean
- [ ] `scripts/api-smoke.js` still passes (if the change touches HTTP or auth)
- [ ] No new dependency without a note on why the alternative was inadequate
- [ ] Secret scanner clean — no keys, tokens, or passwords in the diff
- [ ] Migrations in this diff are new files (0002+, not edits to existing ones)

## Reviewer heads-up

<!--
Anything about this PR that a fresh pair of eyes should know before reviewing:
- new env var
- new dependency
- prod rollout order sensitivity
- Railway deploy that needs a variable set first
- schema change with implications for other services
Leave blank if there is nothing.
-->

## Rollback plan

<!--
One sentence. Ideally: "revert this PR; nothing else needed." If not, name what else needs to happen — e.g. re-enable a feature flag, keep an env var around during the revert window, run a specific script.
-->
