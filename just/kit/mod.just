# The v3 sbx workload in sbx/: a device sandbox, built as an image and consumed by reference.
# This is a different lineage from kits/ in the pi repo (a spec.yaml plus a files/ tree); see
# sbx/README.md for why it lives in this repo instead.
#
# Publishing goes through `buildx --push`, never through `docker push`. The kit descriptor is a
# manifest annotation, and annotations only exist on OCI manifests; a Docker schema2 manifest
# has nowhere to put them. Building into the daemon and pushing from there (or any classic
# image store on the way) converts the artifact to schema2 and drops the descriptor, which sbx
# then reports as a layer size error rather than a shape error. `just kit verify` exists to
# catch that in one second.

set shell := ["bash", "-uc"]
set positional-arguments
set working-directory := "../.."

tag := env("DPI_KIT_TAG", "k7o/sbx-kit-durable:dev")
platforms := env("DPI_PLATFORMS", "linux/amd64,linux/arm64")
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
    @rsync -a {{exclude}} apps/dpi-demo-backend/ sbx/build/apps/dpi-demo-backend/
    @rsync -a {{exclude}} apps/dpi-news-backend/ sbx/build/apps/dpi-news-backend/
    @rsync -a {{exclude}} apps/dpi-tui/ sbx/build/apps/dpi-tui/
    @echo "staged dpi-sdk, dpi-backend, dpi-demo-backend, dpi-news-backend, dpi-tui into sbx/build/apps"

# Build into the local image store, for iterating with docker run. The result is not
# publishable: `docker push` from the image store serializes it as Docker schema2, which has no
# annotations and therefore no kit descriptor. Use `just kit push` to publish.
build: stage
    docker buildx build --file sbx/durable.yaml --tag {{tag}} sbx/

# Validate the descriptor and its recipe without creating a sandbox
check:
    sbx kit validate ./sbx

# The provider matrix `durable start` resolves, without a sandbox, an image or a key
[no-cd]
test:
    bash sbx/scripts/durable.test.sh

# Create a device sandbox on this checkout. The local-directory form makes sbx build the kit
# itself, which avoids the question of whether a locally built image is in the runtime's image
# store; `just kit push` is the path to an image an environment file can reference.
run name="durable-dev":
    just kit stage
    sbx run ./sbx --name {{name}}

# Publish the workload so `kits: [<ref>]` in an environment file resolves, then prove the
# artifact is a kit and not an image. The default ref is the local HTTPS registry from
# sbx/local-registry-v3-kits.md; pass a Docker Hub ref to publish there instead.
#
# For a loopback registry the builder has to be the docker driver, where the push goes through
# dockerd and its certs.d trust applies. On a containerd image store that driver also handles
# both platforms and lands an OCI index, so the whole publish is:
#
#   docker buildx use default && just kit push
#
# A container-driver buildkit cannot push to a loopback registry at all: inside it, localhost is
# the buildkit container, and BuildKit treats loopback registries as plain HTTP whatever CA it
# is given. Keep that builder for Docker Hub, not for localhost.
push ref="localhost:5002/k7o/sbx-kit-durable:0.1.0":
    just kit stage
    docker buildx build --file sbx/durable.yaml \
        --platform {{platforms}} \
        --output type=image,oci-mediatypes=true,push=true \
        --tag {{ref}} sbx/
    just kit verify {{ref}}

# Fail unless REF is a v3 kit artifact: an OCI manifest carrying the kit descriptor annotation.
# TLS is not verified here on purpose, since this checks shape, not trust, and dockerd usually
# trusts the registry through certs.d long before the OS store does.
verify ref="localhost:5002/k7o/sbx-kit-durable:0.1.0":
    #!/usr/bin/env bash
    set -euo pipefail

    ref="{{ref}}"
    host=docker.io
    rest="$ref"
    case "$rest" in
      */*)
        first="${rest%%/*}"
        case "$first" in
          localhost | *.* | *:*) host="$first" ; rest="${rest#*/}" ;;
        esac
        ;;
    esac
    case "$rest" in
      *:*) repo="${rest%:*}" ; tag="${rest##*:}" ;;
      *) echo "verify: $ref has no tag, and a mutable 'latest' proves nothing" >&2 ; exit 2 ;;
    esac

    accept='application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json'
    accept="$accept,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.v1+json"
    base="https://$host/v2/$repo/manifests"
    body="$(curl -fsSk -H "Accept: $accept" "$base/$tag" | tr -d ' \n')" || {
      echo "verify: cannot read $base/$tag" >&2 ; exit 1
    }

    case "$body" in
      *'"schemaVersion":1'* | *'"fsLayers"'*)
        echo "verify: $ref is a schema1 manifest. The registry converted it, which means the" >&2
        echo "        stored artifact has no OCI annotations. Rebuild with 'just kit push'." >&2
        exit 1
        ;;
      *'"mediaType":"application/vnd.docker.distribution.manifest.v2+json"'*)
        echo "verify: $ref is a Docker schema2 manifest." >&2
        echo "        The kit descriptor is a manifest annotation, and schema2 has no annotation" >&2
        echo "        field, so sbx will not see a kit. Rebuild with 'just kit push', which goes" >&2
        echo "        through buildx --push and keeps OCI mediatypes." >&2
        exit 1
        ;;
      *'"mediaType":"application/vnd.docker.distribution.manifest.list.v2+json"'*)
        echo "verify: $ref is a Docker manifest list; its children are schema2 too." >&2
        echo "        Rebuild with 'just kit push' to get an OCI index." >&2
        exit 1
        ;;
    esac

    if printf '%s' "$body" | grep -q 'vnd\.docker\.sandbox\.kit\.descriptor'; then
      echo "verify: $ref is a v3 kit (OCI manifest with the descriptor annotation)"
      exit 0
    fi

    # An index carries no annotations itself; the descriptor sits on each platform manifest.
    # No `head` here: it closes the pipe and pipefail turns that SIGPIPE into an exit.
    digests="$(printf '%s' "$body" | grep -o '"digest":"sha256:[0-9a-f]*"' | cut -d'"' -f4)"
    tried=0
    for digest in $digests; do
      [ "$tried" -lt 6 ] || break
      tried=$((tried + 1))
      child="$(curl -fsSk -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
        "$base/$digest" | tr -d ' \n')" || continue
      if printf '%s' "$child" | grep -q 'vnd\.docker\.sandbox\.kit\.descriptor'; then
        echo "verify: $ref is a v3 kit (OCI index, descriptor on $digest)"
        exit 0
      fi
    done

    echo "verify: $ref resolves but no manifest carries vnd.docker.sandbox.kit.descriptor." >&2
    echo "        The build did not produce a kit; check that -f names the kit descriptor and" >&2
    echo "        that it starts with '# syntax=docker/sandbox-kit:3'." >&2
    exit 1

# Copy a running device's token into this machine's hub registry (declare it as kind: url first)
enroll id sandbox:
    ./sbx/enroll.sh "{{id}}" "{{sandbox}}"
