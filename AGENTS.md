# Factory Relay — Agent Notes

## Layout and skills

Factory Relay provides shared Mac desktop QA and replay evidence. Start with
[README.md](README.md) for setup, workflows, and supported capabilities.
Use the [setup skill](.factory/skills/factory-relay-setup/SKILL.md) for installation
or troubleshooting and the [QA skill](.factory/skills/factory-relay/SKILL.md)
for live checks and replay. Do not expose credentials or private recordings,
bypass native permissions, or take over another user's active QA session.

## Organization repositories

Use these canonical slugs in links, clone commands, and `gh --repo` arguments:

- `Software-FactoryAN/Annular`
- `Software-FactoryAN/droid-mobile`
- `Software-FactoryAN/factory-relay` (this repository)
- `Software-FactoryAN/relay-exploration`

Lion's personal GitHub identity (`mxdsl`, including `users/mxdsl` API paths)
is not a repository owner slug.

## Verify and submit changes

Run `npm run check` and `npm run qa:check` for syntax checks and `npm test`
for the test suite. GitHub Actions runs the suite on Ubuntu.

Follow the [merge queue guide](docs/merge-queue.md) for PRs into `main`.
Do not merge directly, rebase just to bring a branch up to date, or treat
green PR checks as proof the PR has merged.
