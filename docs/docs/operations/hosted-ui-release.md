---
sidebar_label: "Hosted UI Release Deploy"
title: "Deploy the hosted UI (app.propr.dev) on release"
description: "How the release workflow deploys app.propr.dev, the scoped Cloudflare API token it needs, how to re-deploy a published release, and how to deploy by hand."
---
# Hosted UI Release Deploy

`https://app.propr.dev` is the Cloudflare Worker `propr-hosted-ui`, configured in `wrangler.hosted-ui.toml`. It serves the static `propr-ui` build (`./propr-ui/dist`) on the `app.propr.dev` custom domain with single-page-application not-found handling. It has no server code and no bindings.

## Automatic deploy on release

The **Docker Images** workflow (`.github/workflows/docker-images.yml`) deploys the hosted UI in its `deploy-hosted-ui` job. That job calls the reusable **Hosted UI Deploy** workflow (`.github/workflows/hosted-ui-deploy.yml`), the same workflow you dispatch to re-deploy a release, so the two paths cannot drift. The deploy:

1. Runs only after `publish-github-release` succeeds, for a `v*.*.*` tag push and for the manual `workflow_dispatch` release path. If an earlier release job fails or is skipped, the deploy is skipped too.
2. Runs in the `hosted-ui-production` GitHub environment, which holds the only copy of the Cloudflare credentials. Only one deploy to that environment runs at a time.
3. Checks out the release tag: the pushed tag, or `v<expected_version>` for a manual release. It confirms that `package.json` has the tag's version, then runs `npm ci`, `npm run build -w @propr/shared` and `npm run build -w propr-ui`. The UI imports `@propr/shared` through its built `dist/` entry, which a clean install does not contain; the v0.9.1 release deploy failed for that reason.
4. Runs `wrangler deploy --config wrangler.hosted-ui.toml`, with wrangler pinned to an exact version in the workflow.
5. Verifies the deploy. It fetches `https://app.propr.dev/`, finds the `/assets/index-*.js` entry module that `index.html` loads, and checks that the bundle contains the released version string, for example `"0.9.1"`. The check makes up to six attempts, 20 seconds apart, to allow for edge propagation. The script is `scripts/verify-hosted-ui-release.mjs`. To check a deployment yourself, run `RELEASE_VERSION=0.9.1 node scripts/verify-hosted-ui-release.mjs`.

If the environment or either secret is missing, the job prints a **Hosted UI deploy skipped** notice and finishes successfully. The images, the npm package and the GitHub release are already published at this point, so a missing deploy credential does not mark the release as failed. A failed deploy or a failed verification does fail the job. The job summary then explains how to recover: [re-deploy the release](#re-deploy-a-published-release) from `main`, or deploy by hand. Deploying the same build again is idempotent.

## Create the Cloudflare API token

Create a custom token in the Cloudflare dashboard under **My Profile > API Tokens > Create Token > Create Custom Token**. Do not start from the "Edit Cloudflare Workers" template: it also grants KV, R2, tail and membership access, which this deploy does not use. Grant only:

| Scope | Permission | Why |
| --- | --- | --- |
| Account > (the ProPR account) | **Workers Scripts: Edit** | Upload the Worker version and its static assets, and deploy it. The newer role-based name is Workers **Editor** at the Workers product scope. Custom Domains do not support per-Worker roles, so grant it at the Workers product scope. |
| Zone > `propr.dev` only | **Workers Routes: Edit** | Attach the `app.propr.dev` custom domain (`custom_domain = true`). Under **Zone Resources**, choose **Include > Specific zone > propr.dev**, not all zones. |

Leave out everything else. The token does not need zone-wide DNS edit or Zone Settings access. The Worker's custom domain manages its own DNS record and certificate. It also does not need **User Details** or **Memberships**, because the workflow passes `CLOUDFLARE_ACCOUNT_ID` and wrangler never has to look up the account.

Also set:

- **Account Resources**: include only the ProPR account.
- **Client IP Address Filtering**: leave it empty, because GitHub-hosted runner addresses change.
- **TTL**: an expiry date, with a reminder to rotate the token before it expires.

These two permissions are enough to update the existing `propr-hosted-ui` Worker. They are not enough in two cases:

- **The Worker does not exist yet**, for example after it was deleted. Cloudflare requires Workers admin rights to create a new Worker. Run the first deploy by hand with an account member's login (`npx wrangler login`), not by widening the CI token.
- **`app.propr.dev` has a conflicting DNS record**, such as a manually created `CNAME`. Cloudflare cannot attach the custom domain until that record is removed. Remove it in the dashboard rather than giving the CI token DNS edit access.

If wrangler reports an authentication error that names a permission, add only that permission and update this page.

The account ID is shown on the account's **Workers & Pages** overview, and in the dashboard URL after `dash.cloudflare.com/`.

## Add the token to the GitHub environment

`scripts/setup-hosted-ui-environment.sh` sets up the environment in one step. It is the script that provisioned `hosted-ui-production` on `integry/propr`. It needs an authenticated `gh` with admin rights on the repository:

```bash
scripts/setup-hosted-ui-environment.sh               # integry/propr, hosted-ui-production
scripts/setup-hosted-ui-environment.sh --reviewer    # also require your approval for each deploy
scripts/setup-hosted-ui-environment.sh --repo owner/name --env name
```

The script creates or updates the environment and limits it to the tag rule `v*` and the branch `main`. It then stores `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as environment secrets. It reads each value from a hidden prompt, or from the variable of the same name if it is already exported, and never echoes the value or passes it on a command line. You can re-run it: deployment rules that already exist are kept, and the secrets are overwritten. It finishes by printing the environment's rules, allowed refs and secret names.

To do the same by hand:

1. In the repository, open **Settings > Environments > New environment** and name it `hosted-ui-production`. If a release has already referenced it, it may exist already, with no protection.
2. Under **Deployment branches and tags**, choose **Selected branches and tags**. Add the tag rule `v*` and the branch `main`. Tag pushes deploy from the release tag. Manual releases also check out `v<expected_version>`, but the environment matches the ref the workflow was dispatched from, which is usually `main`. Without the `main` rule, a manual release fails on the environment rule instead of deploying.
3. Optional: under **Required reviewers**, add release maintainers so that each deploy waits for approval.
4. Under **Environment secrets**, add:
   - `CLOUDFLARE_API_TOKEN`: the token created above.
   - `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

Store these only as **environment** secrets. Do not add them as repository or organization secrets, because every job could then read them, including PR and build jobs. The workflow contract test (`test/hostedUiReleaseDeploy.test.mjs`) fails if any other job in the release workflow refers to the Cloudflare credentials.

To deploy a release whose deploy was skipped, add the secrets (for example with `scripts/setup-hosted-ui-environment.sh`) and then [re-deploy the release](#re-deploy-a-published-release).

## Re-deploy a published release

Run the **Hosted UI Deploy** workflow from `main`:

```bash
gh workflow run hosted-ui-deploy.yml --repo integry/propr --ref main -f release_tag=v0.9.1
```

Or open **Actions > Hosted UI Deploy > Run workflow**, keep **Use workflow from** on `main`, and enter the tag. The workflow:

1. Refuses to run from any ref other than `main`, and refuses a `release_tag` that is not `v<semver>` (for example `v0.9.1`) or that does not exist in the repository.
2. Runs in `hosted-ui-production`, the same environment and secrets as the release job. If the secrets are missing it skips with the same notice.
3. Checks out the tag, not `main`, and confirms that the root `package.json` version equals the tag version.
4. Runs `npm ci`, builds `@propr/shared` and then the UI, deploys with the pinned wrangler version, and verifies that `app.propr.dev` serves the release.

Do not re-run the failed job of the release's own workflow run. A re-run uses the workflow file from the release tag, so it repeats whatever was wrong with that tag's deploy steps. The dispatch uses `main`'s copy of the steps against the tag's code.

## Manual deploy

`npm run deploy:hosted-ui` still works for local and emergency deploys. It runs `npm run build -w @propr/shared && npm run build -w propr-ui && npx wrangler deploy --config wrangler.hosted-ui.toml` with whatever wrangler login or `CLOUDFLARE_API_TOKEN` you have locally. Run it from a clean checkout of the release tag (`git checkout v<version> && npm ci`), so the deployed bundle matches the release. Tags up to and including `v0.9.1` have the older script that skips the shared build; for those, run `npm run build -w @propr/shared` first. Then verify the deploy with `RELEASE_VERSION=<version> node scripts/verify-hosted-ui-release.mjs`.
