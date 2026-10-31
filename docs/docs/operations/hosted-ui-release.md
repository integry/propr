---
sidebar_label: "Hosted UI Release Deploy"
title: "Deploy the hosted UI (app.propr.dev) on release"
description: "How the release workflow deploys app.propr.dev, the scoped Cloudflare API token it needs, and how to deploy by hand."
---
# Hosted UI Release Deploy

`https://app.propr.dev` is the Cloudflare Worker `propr-hosted-ui`, configured in `wrangler.hosted-ui.toml`. It serves the static `propr-ui` build (`./propr-ui/dist`) on the `app.propr.dev` custom domain with single-page-application not-found handling. It has no server code and no bindings.

## Automatic deploy on release

The **Docker Images** workflow (`.github/workflows/docker-images.yml`) deploys the hosted UI in its `deploy-hosted-ui` job. The job:

1. Runs only after `publish-github-release` succeeds, for a `v*.*.*` tag push and for the manual `workflow_dispatch` release path. If an earlier release job fails or is skipped, the deploy is skipped too.
2. Runs in the `hosted-ui-production` GitHub environment, which holds the only copy of the Cloudflare credentials.
3. Checks out the exact release ref: the pushed tag, or `v<expected_version>` for a manual run. It confirms that `package.json` has the released version, then runs `npm ci` and `npm run build -w propr-ui`.
4. Runs `wrangler deploy --config wrangler.hosted-ui.toml`, with wrangler pinned to an exact version in the workflow.
5. Verifies the deploy. It fetches `https://app.propr.dev/`, finds the `/assets/index-*.js` entry module that `index.html` loads, and checks that the bundle contains the released version string, for example `"0.9.0"`. The check makes up to six attempts, 20 seconds apart, to allow for edge propagation. The script is `scripts/verify-hosted-ui-release.mjs`. To check a deployment yourself, run `RELEASE_VERSION=0.9.0 node scripts/verify-hosted-ui-release.mjs`.

If the environment or either secret is missing, the job prints a **Hosted UI deploy skipped** notice and finishes successfully. The images, the npm package and the GitHub release are already published at this point, so a missing deploy credential does not mark the release as failed. A failed deploy or a failed verification does fail the job. The job summary then explains how to recover: re-run the job, or deploy by hand. Deploying the same build again is idempotent.

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

1. In the repository, open **Settings > Environments > New environment** and name it `hosted-ui-production`. If a release has already referenced it, it may exist already, with no protection.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*.*.*`. Every deploy then runs from a release tag. Manual releases also check out `v<expected_version>`, but the environment matches the ref the workflow was dispatched from. If you dispatch manual releases from `main`, add `main` too.
3. Optional: under **Required reviewers**, add release maintainers so that each deploy waits for approval.
4. Under **Environment secrets**, add:
   - `CLOUDFLARE_API_TOKEN`: the token created above.
   - `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

Store these only as **environment** secrets. Do not add them as repository or organization secrets, because every job could then read them, including PR and build jobs. The workflow contract test (`test/hostedUiReleaseDeploy.test.mjs`) fails if any other job in the release workflow refers to the Cloudflare credentials.

To deploy a release whose deploy was skipped, add the secrets and then re-run the **Deploy hosted UI (app.propr.dev)** job from that release's workflow run.

## Manual deploy

`npm run deploy:hosted-ui` still works for local and emergency deploys. It runs `npm run build -w propr-ui && npx wrangler deploy --config wrangler.hosted-ui.toml` with whatever wrangler login or `CLOUDFLARE_API_TOKEN` you have locally. Run it from a clean checkout of the release tag (`git checkout v<version> && npm ci`), so the deployed bundle matches the release. Then verify the deploy with `RELEASE_VERSION=<version> node scripts/verify-hosted-ui-release.mjs`.
