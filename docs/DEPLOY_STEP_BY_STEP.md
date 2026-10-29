# Deployment guide: GitHub Pages search with Cloudflare-protected documents

This is a web-first implementation. There is no local Python service, no Windows OCR installer, and no Cloudflare Container.

## A. GitHub repository and GitHub Pages

1. In GitHub, create **LeagueWI/league-legal-resource-library**. **Choose PRIVATE** if your plan permits private-repository GitHub Pages. Upload the project contents with folders intact (not the ZIP as a single file). If your plan does not allow Pages from a private repository, see **Section G** to split frontend and indexing safely.
2. Go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. GitHub Actions runs `Publish GitHub Pages`, deploying the contents of `site/`.
4. The expected Pages address, once enabled, is `https://leaguewi.github.io/league-legal-resource-library/`. **Do not assume it is live before GitHub reports a successful deployment.**
5. The page initially reports that its API isn't configured. This is correct until you finish Cloudflare.

## B. Cloudflare: create storage and database

1. Cloudflare → **R2 Object Storage → Create bucket**: `league-legal-private`.
2. Leave **Public Development URL** disabled and **Custom Domains** disabled. Do not enable public buckets.
3. Cloudflare → **Workers & Pages → D1 SQL Database → Create**: `league-legal-search`.
4. Copy the D1 **database ID** into `worker/wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
5. Cloudflare → R2 → **Manage R2 API Tokens** (navigation wording can vary). Create **Object Read** credentials scoped to only `league-legal-private` for GitHub Actions. If you want browser dashboard uploads, no GitHub write permissions are required. Save the **S3-compatible account endpoint** `https://<account_id>.r2.cloudflarestorage.com`.

## C. Set the temporary access code securely

The separately supplied file `PRIVATE_ACCESS_CODE_SETUP.txt` contains the generated **temporary code**, its SHA-256 hash, and a random signing secret. **Never upload or commit that file.**

1. Create the Worker with the same name specified in `worker/wrangler.toml`, either through your Cloudflare dashboard or by first triggering the deployment workflow after adding repository secrets (see D).
2. Cloudflare → Workers & Pages → `league-legal-library-api` → **Settings → Variables and Secrets**.
3. Add two values as **Secret**, not plaintext variables:
   - `ACCESS_CODE_HASH`: paste the SHA-256 hash from the private setup file, **not the actual code**.
   - `SESSION_SECRET`: paste the random signing secret from the private setup file.
4. Save and deploy the secret changes. Never put either value in `site/config.js`, `wrangler.toml`, GitHub commits, or GitHub Actions logs.
5. Use the actual access code from the separate private file at the GitHub Pages sign-in screen. This shared code is meant for controlled testing only.

## D. Link Cloudflare to GitHub Actions

Under **GitHub repository → Settings → Secrets and variables → Actions → New repository secret**, set:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token scoped to Workers/D1 operations; use least required access |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | Read-only R2 API key ID for the bucket |
| `R2_SECRET_ACCESS_KEY` | Matching R2 secret access key |

`R2_BUCKET` is already set to `league-legal-private` within the indexing workflow.

Your Cloudflare Worker `ALLOWED_ORIGIN` is `https://leaguewi.github.io`, not the full page URL. If you use a **custom GitHub Pages domain**, update `ALLOWED_ORIGIN` in `worker/wrangler.toml` to that exact origin (scheme plus host, no trailing slash).

## E. Deploy and configure the API

1. In GitHub Actions, manually run **Deploy Cloudflare search API**. The repository must have the Worker deployment secrets and actual D1 database ID set first.
2. If the Worker has not been created, add its secrets afterward in the Cloudflare dashboard and redeploy.
3. Copy your actual `workers.dev` Worker URL from the successful deployment.
4. Edit `site/config.js` to set `apiBase` to that exact `https://...workers.dev` URL. Commit. GitHub Pages will redeploy.
5. Once configured, trying to search without logging in must return HTTP 401 from the API. A wrong code must return HTTP 401.

## F. Upload and index legal documents

1. Cloudflare → R2 → `league-legal-private` → **Upload**. Add a small test batch of PDF, DOCX, or RTF files. You can upload additional batches in the dashboard. The browser uploads do not send the documents to this conversation.
2. In the **private** GitHub repository → **Actions → Build private legal search index → Run workflow**.
3. This workflow uses GitHub's Linux runner to install Tesseract and LibreOffice, securely downloads objects from R2, performs OCR as necessary, tests extraction, builds a master SQLite index, and stages D1 SQL in batches.
4. The final stage activates the new D1 index **only after all batches succeed**. The previous index remains active if extraction fails.
5. Successful runs save `search_master.sqlite3` and `manifest.json` to a **private GitHub Release**, not to Pages or public repository files.
6. Open GitHub Pages, enter the shared code, and test search results and original PDF/Word opening.
7. Repeat for the rest of your library. The indexing workflow currently performs full rebuilds; no manual OCR installation is needed.

### Quality checks for the first batch

- Search a phrase known to occur halfway through a PDF. Verify the excerpt includes the relevant sentence and the PDF opens to its page.
- Include one scanned PDF and verify `ocr_pages` is nonzero in the private index manifest.
- Include both PDF and DOCX versions of the same text. Verify confirmed duplicates are grouped, without automatically treating revised texts as identical.
- Confirm a query for an absent term returns no results.
- Verify unauthenticated `/api/search` and `/api/document/<id>` requests return 401.

## G. If GitHub Pages requires a PUBLIC repository

**Do not switch your indexing repository to public.** Instead use TWO repositories:

- `LeagueWI/league-legal-resource-library` (**PRIVATE**): worker code, `processor/`, D1 schema, index action, private Releases. You may remove or disable the Pages workflow here.
- `LeagueWI/league-legal-resource-library-pages` (**PUBLIC**): only the `site/` directory and `.github/workflows/pages.yml`; nothing else. The public site can share the same Cloudflare API. Its Pages URL is `https://leaguewi.github.io/league-legal-resource-library-pages/`.

GitHub Pages public files can be downloaded by everyone. The backend still denies all protected API requests without a valid access code, regardless of whether the site repository is public.

## H. Maintenance and safe access

- Rotate the pilot code by generating a new random code, calculating its SHA-256, and updating `ACCESS_CODE_HASH`. Old signed sessions remain valid for up to eight hours unless you also rotate `SESSION_SECRET`.
- To revoke **all** sessions immediately, rotate `SESSION_SECRET`.
- Keep GitHub repository processing logs free of document text. Use the supplied private report/release metadata to diagnose failures.
- Only run indexing against a private repository. The workflow includes a visibility check and refuses to run in public repositories.
- Cloudflare can add WAF rate limiting before general release. The Worker currently limits failed code attempts by IP in D1.
- Later replace the shared code with iMIS SSO and an active-member eligibility check. Do not mistake a shared passcode for individual member authentication.

## Troubleshooting

- **Website says API not configured:** edit `site/config.js` with the actual Worker HTTPS URL and wait for GitHub Pages to redeploy.
- **Wrong origin:** ensure `ALLOWED_ORIGIN` is the exact site origin, e.g. `https://leaguewi.github.io`, with no repository path.
- **Worker says configuration incomplete:** set both secret values, D1 and R2 bindings, and deploy.
- **0 resources after logging in:** upload files to R2 and run the private indexing workflow; check `manifest.json` in the private GitHub Release.
- **R2 AccessDenied:** check bucket-scoped API token permissions and `R2_ENDPOINT`.
- **PDF scans still title only:** check the workflow's OCR installation and private manifest; poorly scanned images may need review.
- **Deploy errors in Wrangler:** verify D1 ID, Worker name, GitHub secrets, and Cloudflare token permissions.

## Notes

This project is a functional pilot, not legal approval of resource currency. Search ranking favors exact phrases, titles, and term coverage. No AI-generated legal answers are produced. D1 keeps prior index builds; delete older builds only after validating a replacement.
