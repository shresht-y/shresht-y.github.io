# Portfolio

Personal portfolio served by GitHub Pages at `https://shresht-y.github.io`. Project pages
show **live progress** pulled from private repositories (NetKnight, PAIOS) without
publishing their source code.

## How it works

```
private project repos ──(read-only token)──► GitHub Action in this repo
                                               1. scripts/collect.mjs → site/data/generated/site.json
                                               2. upload site/ → GitHub Pages
```

The Action runs every 30 minutes, on manual dispatch, on pushes here and (optionally)
instantly when a project repository pings it.

**What leaves a private repository** — only this allowlist, enforced in `scripts/collect.mjs`:
task numbers, titles and statuses from `tasks/task-status.json` and task headings; phase names;
ADR titles and statuses; the `STATUS.md` capability table (NetKnight); commit dates, short SHAs
and subject lines; language byte totals; latest CI conclusion. No file contents, diffs or
commit bodies. Commit subjects matching `commitFilter.exclude` in `config/projects.json`
are hidden; emails and local paths are redacted. **Every visible commit subject is public**,
so write them accordingly.

## Layout

| Path | Purpose | Edit by hand? |
|---|---|---|
| `site/data/profile.json` | Your name, bio, links, skills | **Yes — fill in the TODOs** |
| `config/projects.json` | Projects, descriptions, highlights, repos/branches to read | Yes |
| `site/index.html`, `site/project.html` | Page shells | Yes (UI) |
| `site/assets/style.css` | All styling; colours are tokens at the top | Yes (UI) |
| `site/assets/app.js` | Renders pages from the JSON | Yes (UI) |
| `site/assets/diagrams/*.svg` | Per-project architecture diagrams | Yes |
| `site/data/generated/` | Collector output — git-ignored, built in CI | No |
| `templates/notify-portfolio.yml` | Optional instant-update ping for project repos | Copy |

## Local preview

Needs Node 20+ and the project repositories checked out as siblings of this folder
(paths are `localPath` in `config/projects.json`). No `npm install` is needed — there are no
dependencies.

```text
node scripts/collect.mjs --local
node scripts/serve.mjs
```

Open http://127.0.0.1:4173/.

## One-time GitHub setup

1. **Create the repository** `shresht-y/shresht-y.github.io` (public), push this folder to `main`.
2. **Create a read-only token**: GitHub → Settings → Developer settings → Fine-grained tokens.
   - Repository access: *Only select repositories* → NetKnight, PAIOS, PAIOS-Front-End.
   - Permissions: **Contents: Read-only**, **Actions: Read-only** (for CI status); Metadata is implied.
   - Set an expiry and a calendar reminder; when it expires the site stops updating (it keeps the last version).
3. **Store it**: this repo → Settings → Secrets and variables → Actions → New secret
   `PORTFOLIO_READ_TOKEN`.
4. **Enable Pages**: Settings → Pages → Source: **GitHub Actions**.
5. Actions tab → *Build and deploy portfolio* → **Run workflow**. The site appears at
   `https://shresht-y.github.io` within a minute or two.

### Optional: instant updates on push

For each project repository:

1. Create a second fine-grained token scoped to **only** `shresht-y.github.io` with
   **Contents: Read and write** (required to send `repository_dispatch`).
2. Add it to the project repo as secret `PORTFOLIO_DISPATCH_TOKEN`.
3. Copy `templates/notify-portfolio.yml` to `.github/workflows/notify-portfolio.yml` there.

Each push then costs a few seconds of that repository's Actions minutes.

## Adding a project

Add an entry to `config/projects.json`. `progress` is optional; without it a project still
gets commits, activity and languages. `taskPattern` must capture `(phase)` and `(task number)`.
Add the repository to the read token's repository list.

## Notes

- GitHub disables scheduled workflows in a repository with no activity for 60 days; a push
  here or a manual run re-enables them.
- Without a license file, the code in this repository is all rights reserved by default.
