# GitHub merge queue

GitHub Merge Queue squash-merges PRs into `main` in [factory-relay],
[droid-mobile], [Annular], and [relay-exploration]. All four require
`ci-gate` and leave "Require branches to be up to date" off. The organization
standard is to automatically delete head branches after merge.

Use **Merge when ready** on the GitHub pull request, or request it with:

```sh
gh pr merge --squash --auto <pr-number>
```

GitHub enables auto-merge if required checks are still pending and adds the
PR to the queue when it's eligible. Do not merge directly or rebase or merge
`main` into a PR branch just to bring it up to date. Resolve actual merge
conflicts if GitHub reports them. The queue tests the PR with the latest
`main` and any PRs ahead of it before merging.

The PR babysitter follows the PR until GitHub reports it merged. If GitHub
removes it from the queue or its `merge_group` run fails, hand it back to the
babysitter to inspect the queue status and CI logs, fix the cause, verify the
updated PR, and re-enqueue it. Do not bypass the queue or retry blindly.

In factory-relay, the [test workflow](../.github/workflows/test.yml) runs on
`pull_request` and `merge_group` so `ci-gate` reports for both the PR and the
queued merge group.

[factory-relay]: https://github.com/Software-FactoryAN/factory-relay
[Annular]: https://github.com/Software-FactoryAN/Annular
[droid-mobile]: https://github.com/Software-FactoryAN/droid-mobile
[relay-exploration]: https://github.com/Software-FactoryAN/relay-exploration
