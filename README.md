# GitHub PR Compare

Local side-by-side PR diff viewer powered by Mergely.

The app lets you paste a GitHub pull request URL, choose a base branch, and review changed files in a two-column diff view. It is designed for private repositories too: GitHub access stays on the local machine through `gh` and `git`.

## Problem This Solves

GitHub's PR diff can become hard to review when a refactor changes control flow or indentation without changing most of the underlying logic.

One common example is replacing an `else` block with an early return:

```php
if (!empty($currentBatch)) {
    $this->logging('Batch is running');
} else {
    $this->initServices();
    foreach ($listCsv as $fileCsv) {
        $logCompareResultInfo = $gajoenCompareResultInfo;
        // existing logic continues here
    }
}
```

becomes:

```php
if (!empty($currentBatch)) {
    $this->logging('Batch is running');

    return self::SUCCESS;
}

$this->initServices();
foreach ($listCsv as $fileCsv) {
    $logCompareResultInfo = $gajoenCompareResultInfo;
    // existing logic continues here
}
```

The real behavioral change is small: return early when a batch is already running. But because the old `else` block is removed, the rest of the method is shifted left by one indentation level. GitHub may then render a long delete block on the left and a long add block on the right, placing logically identical code far apart.

That makes it difficult to see that later code such as:

```php
foreach ($listCsv as $fileCsv) {
    $logCompareResultInfo = $gajoenCompareResultInfo;
```

is effectively the same logic with only leading whitespace changed.

This tool uses Mergely's side-by-side diff behavior to align those related lines more closely. The goal is to make review easier for refactors where most code is unchanged but GitHub's default diff makes the change look much larger than it is.

## Requirements

- Node.js 20 or newer
- npm
- git
- GitHub CLI (`gh`)
- Internet access for loading PR data from GitHub
- A GitHub CLI login with access to the target repository

Check the basics:

```bash
node --version
npm --version
git --version
gh --version
gh auth status
```

If `gh auth status` is not logged in, run:

```bash
gh auth login
```

For private repositories, the authenticated GitHub account must have permission to read the repo.

## Run

```bash
npm start
```

Open:

```text
http://localhost:4173
```

The default port is `4173`. To use another port:

```bash
PORT=5000 npm start
```

## Use

1. Paste a GitHub PR URL, for example:
   ```text
   https://github.com/giftee-tech-vietnam/ecplatform-gw/pull/367
   ```
2. Enter the base branch. Default is `master`.
3. Click `Compare`.
4. Select a changed file from the left file tree.
5. Review base content on the left and PR content on the right.

The file tree supports filtering. The `Viewed` checkbox is local UI state only; it does not update GitHub.

## How Diff Is Calculated

For open PRs, the app compares:

```text
merge-base(base branch, PR head) -> PR head
```

This matches the normal GitHub PR "Files changed" behavior better than comparing the full base branch tip against the PR branch tip.

For already-merged PRs where the PR head is now part of the base branch and the merge-base diff is empty, the app falls back to:

```text
merge commit first parent -> merge commit
```

This makes merged PRs reviewable after they have landed.

## Network Access

The browser frontend talks to the local server only:

```text
http://localhost:4173
```

The backend connects to GitHub when a PR is submitted:

- `gh pr view <url>` for PR metadata
- `gh auth token` to reuse local GitHub auth
- `git fetch https://github.com/<owner>/<repo>.git` for base/PR refs

The GitHub token is not sent to the browser. It is used server-side for local `git fetch` authentication.

## Project Layout

- `server.mjs` - local Node backend and static file server
- `public/` - frontend UI
  - `index.html`
  - `app.js`
  - `styles.css`
- `cloned-sites/editor.mergely.com/` - vendored Mergely bundle/assets
- `.cache/pr-compare/` - runtime git cache for compare sessions
- `.playwright-cli/` - local browser test artifacts

Only `server.mjs`, `package.json`, `public/`, `cloned-sites/editor.mergely.com/`, `.gitignore`, and this README are needed as source/runtime assets.

## Troubleshooting

### `gh` is not authenticated

Run:

```bash
gh auth login
gh auth status
```

### Private repo fails to load

Confirm the logged-in GitHub account can access the repo:

```bash
gh pr view https://github.com/OWNER/REPO/pull/NUMBER
```

### Base branch error

Make sure the branch exists in the target repo and use its exact name, for example `master`, `main`, or `develop`.

### PR shows zero files

If the PR is already merged, the app attempts a merge-commit fallback. If it still shows zero files, the PR may be a no-op, squashed/rebased in a way that has no merge commit available through the PR metadata, or the selected base branch may not match the PR's target branch.

### Cache is stale or large

Compare sessions are stored under:

```text
.cache/pr-compare/
```

It is safe to delete this folder while the server is stopped:

```bash
rm -rf .cache/pr-compare
```

## Notes

- This is a local review tool. It does not write comments, approvals, labels, or any other changes back to GitHub.
- Binary or very large files are listed but not rendered in the text diff viewer.
- Mergely is used from the vendored bundle in `cloned-sites/editor.mergely.com/`.
