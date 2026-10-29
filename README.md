# League Legal Resource Library | GitHub Pages + Cloudflare

**This repository contains the complete application. It does not include any League documents or real search index data.**

## Architecture

- **GitHub Pages**: static, publicly downloadable frontend (`site/`). Access code is **not** checked in the browser.
- **Cloudflare Worker**: validates a temporary code using an SHA-256 hash stored as an encrypted Worker secret, returns short-lived signed sessions, enforces access on every search and download.
- **Cloudflare D1**: full-text FTS5 index of resources and passages, with staged index builds and atomic activation.
- **Cloudflare R2**: private original documents (`league-legal-private`). No public R2 hostname.
- **GitHub Actions** in a **private repository**: reads files from R2, runs Python and Tesseract on GitHub-hosted Ubuntu, builds an SQLite master index, publishes D1 records, and stores master snapshots as **private GitHub Releases**.

## Important distinction about a GitHub Pages site

A GitHub Pages site is **public to anyone on the internet**, even when published from a private repository. The access code protects **search requests and original documents**, not the public landing page or public JavaScript. Never add full legal text, original files, database snapshots, or secrets to `site/`.

## Setup

Read **[docs/DEPLOY_STEP_BY_STEP.md](docs/DEPLOY_STEP_BY_STEP.md)**. The first launch does not require iMIS; the shared code is a limited testing mechanism and must be replaced with individual member authentication before broad member access.

## Folder map

- `site/` site files deployed by GitHub Pages.
- `worker/` Cloudflare API with real access control.
- `db/` Cloudflare D1 schema.
- `processor/` private Python/OCR/index publisher.
- `.github/workflows/pages.yml` deploys public frontend.
- `.github/workflows/deploy-worker.yml` deploys Worker (manual).
- `.github/workflows/index.yml` rebuilds index (manual; **private repository only**).

## Limitations in this pilot

The pilot intentionally does not include member-specific SSO, granular authorization, an administrative upload form, legal approval/supersession controls, or advanced citation parsing. OCR is best-effort: low-quality scans can remain unreadable. Index build does not delete old builds yet; D1 storage will grow with each build and should be cleaned after verification. Shared access codes are not suitable for broad or sensitive access.
