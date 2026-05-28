# GitHub PR Compare

Local side-by-side GitHub PR diff viewer powered by Mergely.

Paste a PR URL, choose a base branch, and review changed files in a two-column diff. This is useful when GitHub makes a small refactor look much larger, especially when an `else` block is changed to an early return and the remaining code only shifts indentation.

Example problem:

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

For small refactors, GitHub's diff is usually good enough. The problem becomes painful when many lines are refactored but most changes are only leading whitespace. GitHub can create a lot of noise by showing related lines far apart.

This tool is useful for that case because Mergely connects related lines even when indentation changes, making the actual behavior change easier to review.

## Requirements

- Node.js 20+
- npm
- git
- GitHub CLI (`gh`)
- `gh auth login` completed with access to the target repo
- Internet access when loading PR data from GitHub

## Run

```bash
npm start
```

Open:

```text
http://localhost:4173
```

Optional custom port:

```bash
PORT=5000 npm start
```

## Use

1. Paste a GitHub PR URL.
2. Enter the base branch, default is `master`.
3. Click `Compare`.
4. Select a changed file from the sidebar.
5. Review base code on the left and PR code on the right.

The browser talks only to the local server. GitHub auth stays server-side through `gh` and `git`, so tokens are not exposed to the browser.

## Diff Behavior

For open PRs:

```text
merge-base(base branch, PR head) -> PR head
```

For already merged PRs where that diff is empty:

```text
merge commit first parent -> merge commit
```

## Notes

- This is read-only. It does not comment, approve, label, or update GitHub.
- Private repos work if the local `gh` account has access.
- Binary or very large files are listed but not rendered in Mergely.
- Runtime cache is stored in `.cache/pr-compare/`.
- Mergely assets are vendored in `cloned-sites/editor.mergely.com/`, cloned from https://editor.mergely.com/.
