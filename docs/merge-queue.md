# GitHub merge queue

The GitHub merge queue flow for PRs into `main` is the same in [factory-relay],
[droid-mobile], and [Annular]: the required check is `ci-gate`, and PR branches
do not need to be up to date with `main` once the queue is enabled.

Annular's strict up-to-date checks still apply until its queue is enabled
after [PR #895](https://github.com/Software-FactoryAN/Annular/pull/895) merges.

Use **Merge when ready** on the GitHub pull request, or request it with:

```sh
gh pr merge --auto <pr-number>
```

GitHub enables auto-merge if required checks are still pending and adds the
PR to the queue when it's eligible. Do not merge directly or rebase or merge
`main` into a PR branch just to bring it up to date. Resolve actual merge
conflicts if GitHub reports them. The queue tests the PR with the latest
`main` and any PRs ahead of it before merging.

In factory-relay, the [test workflow](../.github/workflows/test.yml) runs on
`pull_request` and `merge_group` so `ci-gate` reports for both the PR and the
queued merge group.

[factory-relay]: https://github.com/Software-FactoryAN/factory-relay
[Annular]: https://github.com/Software-FactoryAN/Annular
[droid-mobile]: https://github.com/Software-FactoryAN/droid-mobile
