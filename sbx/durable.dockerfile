# syntax=docker/dockerfile:1
#
# Content recipe for sbx/durable.yaml (companion pair; the descriptor's directory is the build
# context root). The apps are not fetched here: `just kit stage` copies them from this checkout
# into ./build first, so the image is built from the branch you are standing on and there is no
# ref to keep in sync.
#
# shell-docker rather than plain shell: durable agents run bash inside the sandbox, and a task
# that builds or runs a container should not discover the engine is missing. It costs a bigger
# image and privileged mode; drop to `shell` if that trade is wrong for you.
FROM docker.io/docker/sandbox-templates:shell-docker

USER root

# dpi-backend pins engines >= 22.19 and uses node:sqlite. Assert the template's node once, at
# build time, so a template bump fails here instead of at the first request.
RUN node --version \
 && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); \
      if (major < 22 || (major === 22 && minor < 19)) { \
        console.error("node " + process.versions.node + " is too old: dpi-backend needs >= 22.19"); \
        process.exit(1); \
      }'

# apps/dpi-backend and apps/dpi-tui import apps/dpi-sdk by relative path (../../dpi-sdk/src/...),
# so the three have to keep this layout. The lockfiles are committed; --omit=dev drops the type
# packages, which nothing needs at runtime because tsx transpiles without type checking.
COPY build/apps/dpi-sdk     /opt/durable-pi/apps/dpi-sdk
COPY build/apps/dpi-backend /opt/durable-pi/apps/dpi-backend
COPY build/apps/dpi-tui     /opt/durable-pi/apps/dpi-tui
RUN cd /opt/durable-pi/apps/dpi-sdk     && npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && cd /opt/durable-pi/apps/dpi-backend && npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && cd /opt/durable-pi/apps/dpi-tui     && npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && rm -rf /root/.npm

COPY --chmod=0755 scripts/durable.sh /usr/local/bin/durable

# The workspace mounts at the image's working directory, so this is where a durable session's
# relative ". " resolves and where the agent's file tools see the user's tree.
WORKDIR /home/agent/workspace
USER agent

# Read by the host as the launch command (sbx@1: the entrypoint is not PID 1). `attach` starts
# the device, then hands the terminal to dpi-tui on a session in the workspace.
ENTRYPOINT ["/usr/local/bin/durable", "attach"]
