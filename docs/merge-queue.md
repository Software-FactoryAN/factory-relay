# GitHub merge queue

Pull requests into `main` in [factory-relay], [Annular], and [droid-mobile]
go through GitHub's merge queue. The required status check is `ci-gate`.
Annular and droid-mobile do not require PR branches to be up to date with `main`.

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
