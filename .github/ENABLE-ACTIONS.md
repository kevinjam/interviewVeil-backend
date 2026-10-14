# GitHub Actions not running?

This repo is **only** the backend (`interviewVeil-backend`). The workflow file must be at:

```text
.github/workflows/backend-deploy.yml   ← repo root (same folder as package.json)
```

## 1. Confirm the remote repo

```bash
git remote -v
# should be: git@github.com:kevinjam/interviewVeil-backend.git (or your fork)
```

Open **that exact repo** on GitHub → **Actions** tab (not a parent monorepo).

## 2. Enable Actions (private repos)

**Settings → Actions → General**

- **Actions permissions:** *Allow all actions and reusable workflows* (or allow listed).
- **Workflow permissions:** *Read repository contents* is enough for CI; deploy uses SSH only.

Save. Without this, pushes do not run workflows.

## 3. Confirm workflow on `main`

**Code** → branch **main** → open `.github/workflows/backend-deploy.yml`.

If the file is missing on GitHub, you pushed the wrong repo or branch:

```bash
git checkout main
git add .github/workflows/backend-deploy.yml
git commit -m "ci: add backend deploy workflow"
git push origin main
```

## 4. Trigger a run

- Push any commit to `main`, or
- **Actions** → **Backend CI/CD** → **Run workflow** → branch `main`.

You should see **Test and build**, then **Deploy to AWS (SSH)**.

## 5. Deploy secrets (required for deploy job)

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `SSH_HOST` | EC2 public IP or hostname |
| `SSH_USER` | `deploy` or `ubuntu` |
| `SSH_PRIVATE_KEY` | Private key that matches `authorized_keys` on the server |

If deploy fails with “Missing SSH_HOST”, add secrets and re-run.

## 6. Still empty Actions tab?

- Default branch must be **main** (**Settings → General → Default branch**).
- You need **write access** to the repo to see Actions on private repos.
- Check **Settings → Actions → General** for org-level policies blocking Actions.
