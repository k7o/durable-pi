# The v3 sbx workload in sbx/: a device sandbox, built as an image and consumed by reference.
# This is a different lineage from kits/ in the pi repo (a spec.yaml plus a files/ tree); see
# sbx/README.md for why it lives in this repo instead.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../.."

tag := env("DPI_KIT_TAG", "k7o/sbx-kit-durable:dev")
exclude := "--exclude node_modules --exclude .data --exclude workspace --exclude dist"

# List kit commands
[default]
default:
    @just --list kit

# Copy the apps the image needs into sbx/build. The build context is the descriptor's own
# directory, so the recipe cannot reach into apps/ by itself.
stage:
    @rm -rf sbx/build
    @mkdir -p sbx/build/apps
    @rsync -a {{exclude}} apps/dpi-sdk/ sbx/build/apps/dpi-sdk/
    @rsync -a {{exclude}} apps/dpi-backend/ sbx/build/apps/dpi-backend/
    @rsync -a {{exclude}} apps/dpi-tui/ sbx/build/apps/dpi-tui/
    @echo "staged dpi-sdk, dpi-backend, dpi-tui into sbx/build/apps"

# Build the workload image (needs docker buildx on this machine)
build: stage
    docker buildx build --file sbx/durable.yaml --tag {{tag}} sbx/

# Validate the descriptor and its recipe without creating a sandbox
check:
    sbx kit validate ./sbx

# Create a device sandbox on this checkout. The local-directory form makes sbx build the kit
# itself, which avoids the question of whether a locally built image is in the runtime's image
# store; `just kit push` is the path to an image an environment file can reference.
run name="durable-dev":
    just kit stage
    sbx run ./sbx --name {{name}}

# Publish the image so `kits: [<ref>]` in an environment file resolves
push ref="k7o/sbx-kit-durable:0.1.0":
    DPI_KIT_TAG={{ref}} just kit build
    docker push {{ref}}

# Copy a running device's token into this machine's hub registry (declare it as kind: url first)
enroll id sandbox:
    ./sbx/enroll.sh "{{id}}" "{{sandbox}}"
