# Backend GitHub Actions

Workflow definitions live here:

- [`workflows/backend-deploy.yml`](workflows/backend-deploy.yml) — test, build, and SSH deploy.

GitHub only runs workflows from the repository root `.github/workflows/` directory. The repo keeps **symlinks** there pointing at this file so Actions still picks up the workflow while the source of truth stays under `backend/`.
