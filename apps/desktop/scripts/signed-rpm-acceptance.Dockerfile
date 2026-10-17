FROM node:22-bookworm-slim AS node
FROM opensuse/leap:16.0
# Copy only the fixture's runtime and npm; Node's /usr/local/man symlink
# conflicts with the directory provided by the Leap base image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN zypper --non-interactive install --no-recommends \
    rpm cpio gpg2 dbus-1 dbus-1-daemon gnome-keyring libsecret-1-0 xorg-x11-server-Xvfb \
    xauth xdg-utils liberation-fonts gtk3 libgtk-3-0 libnotify4 at-spi2-core \
    libdrm2 libxcb1 libgbm1 mozilla-nss libasound2 \
    libXss1 libXtst6 tar gzip shadow util-linux tesseract-ocr tesseract-ocr-traineddata-eng && zypper clean --all
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /acceptance
COPY package.json package-lock.json tsconfig.json ./
# npm ci installs braces from this reviewed lockfile-pinned tarball.
COPY vendor/braces-3.0.4-depthguard.1.tgz vendor/braces-3.0.4-depthguard.1.tgz
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/local-setup/package.json packages/local-setup/package.json
COPY packages/shared/ packages/shared/
COPY apps/desktop/scripts/ apps/desktop/scripts/
COPY propr-ui/package.json propr-ui/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund && npm run build -w @propr/shared \
    && npx playwright install chromium \
    && node --test apps/desktop/scripts/packaged-browser-approval.playwright.mjs
RUN useradd --create-home --uid 1000 acceptance
ENTRYPOINT ["bash", "/acceptance/apps/desktop/scripts/test-signed-installed-rpm.sh"]
