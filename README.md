# Clean up Railway preview environments

A GitHub Action that deletes the GitHub environments Railway creates for a pull request's preview environment. Run it when the pull request closes.

## Why it exists

Railway's GitHub app posts a GitHub deployment for every PR environment, and GitHub turns each deployment into a repository environment. Railway tears down its own PR environment when the pull request closes, but it does nothing on the GitHub side. These repository environments pile up. I had over 800 environments on a single repo at one point.

These environments give you nothing in return. They have no protection rules, secrets, or approvals. They hold a deployment record and a link, and Railway's pull request comment already carries that link.

## Which environments it deletes

Railway names the environments in one of two formats:

- `<railway project> / <name>-pr-<number>`, for example `my-project / web-pr-42`
- `<railway project> / pr-<hash>-<number>`, for example `my-project / pr-189c05-42`

The action deletes the environments in those formats that end in the pull request's number. It never touches anything else: `production`, `staging`, and environments from other providers stay. The number must match whole, so pull request 7 never matches `pr-17`.

## Token

Deleting an environment needs Repository › Administration: write. `GITHUB_TOKEN` cannot get that permission.

Use a dedicated GitHub App with only that permission. Install it on the repositories it cleans, and store its credentials as secrets of an environment restricted to the default branch. Administration write can rewrite branch protection and rulesets, so pull request branches must not be able to reach it.

A fine-grained personal access token also works, but it is tied to a person.

## Usage

```yaml
name: Clean up Railway preview environments

on:
  pull_request_target:
    types: [closed]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: true

permissions: {}

jobs:
  cleanup:
    runs-on: ubuntu-latest
    environment: railway-cleanup
    steps:
      - id: app
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: ${{ secrets.CLEANUP_APP_CLIENT_ID }}
          private-key: ${{ secrets.CLEANUP_APP_PRIVATE_KEY }}
          permission-administration: write
      - uses: lachieh/gha-cleanup-railway-preview-environment@v1
        with:
          token: ${{ steps.app.outputs.token }}
          pr-number: ${{ github.event.pull_request.number || inputs.pr_number }}
```

`pull_request_target` runs from the default branch and has access to secrets. That is safe here because the job runs no pull request code.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | yes | | Token with Administration write on the repository. |
| `pr-number` | no | `${{ github.event.pull_request.number }}` | Pull request whose environments to delete. |
| `repository` | no | `${{ github.repository }}` | Owner and repository name. |
| `railway-project` | no | empty | When set, only delete environments whose name starts with exactly `<railway-project> / `. Compared as literal text, not a pattern. |
| `dry-run` | no | `false` | Set to `true` to list the environments that would be deleted without deleting them. |

## Outputs

| Output | Description |
| --- | --- |
| `deleted` | Newline-separated names of the deleted environments. In a dry run, the names that would be deleted. |

## Clear an existing backlog

To remove environments left by pull requests that closed before you installed the action, loop over the repository's environments with the same pattern. Run the list first and read it before you delete anything. This loop matches any pull request number.

```bash
repo=OWNER/REPO
pattern='^[^/]+ / ([a-z0-9-]+-pr|pr-[0-9a-f]+)-[1-9][0-9]*$'

gh api "repos/$repo/environments" --paginate -q '.environments[].name' | grep -E "$pattern"
```

When the list looks right, delete them:

```bash
gh api "repos/$repo/environments" --paginate -q '.environments[].name' \
  | grep -E "$pattern" \
  | while IFS= read -r name; do
      gh api -X DELETE "repos/$repo/environments/$(jq -rn --arg n "$name" '$n|@uri')"
    done
```

This loop also deletes environments for pull requests that are still open. Railway posts a new deployment on the next push, which recreates them.

## Caveat

If Railway posts a deployment after the workflow ran, for example on a push right before the pull request closes, that environment comes back. Run the workflow again from `workflow_dispatch` with the pull request number.

## License

MIT. See [LICENSE](LICENSE).
