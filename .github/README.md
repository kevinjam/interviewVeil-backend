# Backend GitHub Actions

- [`workflows/backend-deploy.yml`](workflows/backend-deploy.yml) — on every push to `main`: test, build, then SSH deploy to AWS (when secrets are configured).

Repository secrets and server setup: [deploy/native/README.md](../deploy/native/README.md#github-actions--aws).
