# Backend GitHub Actions

Workflow: [`workflows/backend-deploy.yml`](workflows/backend-deploy.yml) — runs on every push to **`main`** and via **Actions → Deploy backend → Run workflow**.

## Where this file must live on GitHub

GitHub **only** loads workflows from **the repository root**:

```text
interviewVeil-backend/          ← GitHub repo root (not a monorepo `backend/` folder)
  .github/workflows/backend-deploy.yml
  package.json
  src/
```

If the remote repo is structured as `your-monorepo/backend/package.json`, GitHub will **ignore** `backend/.github/workflows/` — move the workflow to the monorepo root `.github/workflows/` instead.

This project’s git root **is** the API package (`kevinjam/interviewVeil-backend`), so `.github/workflows/` here is correct **when you push from this directory**:

```bash
cd /path/to/interviewVeil-backend   # must contain package.json + .github/
git push origin main
```

## Actions not running?

1. **Repo** — Open **github.com/kevinjam/interviewVeil-backend** (not a parent Silentide repo).
2. **Settings → Actions → General** — allow actions (read/write for deploy may need “Read and write” if you add releases later; test job only needs default).
3. **Branch** — workflow triggers on **`main`** only; confirm default branch is `main`.
4. **File on GitHub** — browse to `.github/workflows/backend-deploy.yml` on `main`; it must exist.
5. **Manual run** — **Actions** tab → **Deploy backend** → **Run workflow**. If the workflow does not appear, the YAML path or branch is wrong.
6. **Deploy job skipped** — expected until `SSH_HOST` (and other SSH secrets) are set; the **test** job should still run.

Server setup: [deploy/native/README.md](../deploy/native/README.md#github-actions--aws).
