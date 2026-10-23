#!/usr/bin/env bash
# registry-tls — mint a TLS leaf for a registry:2 container, plus the local CA that signs it.
#
#   ./sbx/scripts/registry-tls.sh                          # ~/registry/certs, localhost + loopback
#   ./sbx/scripts/registry-tls.sh --port 5002               # second registry, for v3 kits
#   ./sbx/scripts/registry-tls.sh -d ./certs registry.local 192.168.1.10
#   ./sbx/scripts/registry-tls.sh --ca-crt ~/mkcert/rootCA.pem --ca-key ~/mkcert/rootCA-key.pem
#
# The port is not part of the certificate -- TLS subjectAltNames carry names, never ports --
# so one leaf on localhost serves registries on 5001, 5002 and anything else. --port only
# rewrites the commands that have to name it: -p, the certs.d directory, allowlist, curl.
#
# Why a CA at all: sbx pulls kit manifests on the host, with the host's trust store, and it has
# no insecure mode. A self-signed leaf can be served but never trusted, because a leaf with
# CA:FALSE cannot issue for a new name and installing it as a root trusts exactly one certificate.
# So this script always signs a leaf from a CA (ours or yours) and leaves you one file to import.
#
# registry:2 wants registry.crt + registry.key, mounted read-only, via
# REGISTRY_HTTP_TLS_CERTIFICATE / REGISTRY_HTTP_TLS_KEY. Everything else in this directory
# (ca.crt, ca.key, ca.srl) stays on the host, and ca.key must never leave it.
#
# On Windows run this under Git Bash or WSL. Git Bash ships openssl; WSL writes to /mnt/c/...
# so the files are visible to Import-Certificate. The Windows trust line printed at the end
# is rewritten to C:/-style when the script notices it is running under MSYS.
set -euo pipefail

umask 077

PROG=registry-tls

log() { printf '[%s] %s\n' "$PROG" "$*" >&2; }
die() {
  printf '[%s] error: %s\n' "$PROG" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: registry-tls.sh [-d DIR] [-n CN] [-p PORT] [-c NAME] [-D DAYS] [-f|--new-ca]
                       [--ca-crt FILE --ca-key FILE] [SAN ...]

  -d, --out DIR       output directory (default: $REGISTRY_CERTS_DIR or ~/registry/certs)
  -n, --cn NAME       subject common name (default: localhost)
  -p, --port PORT     host port the registry publishes (default: 5001)
  -c, --container N   container name (default: registry-PORT, so it cannot clobber 'registry')
  -D, --days N        leaf lifetime in days (default: 825, the macOS ceiling)
  -f, --force         re-mint the leaf even if a valid certificate is already present
      --new-ca        mint a fresh CA too (the host must then trust the new ca.crt)
      --ca-crt FILE   sign with an existing CA certificate instead of generating one
      --ca-key FILE   its private key (required with --ca-crt)
  -h, --help          this text

Positional arguments are extra subjectAltNames. Anything with a colon, or only digits and
dots, is treated as an IP; everything else as a DNS name. localhost, 127.0.0.1 and ::1 are
always included: a reference like localhost:5001 is checked against the SAN list by Go, and
the Common Name is ignored.

Output: ca.crt ca.key ca.srl registry.crt registry.key registry.ext
EOF
}

abs() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    [A-Za-z]:[\\/]*) printf '%s' "$1" ;; # Git Bash accepts C:/... and understands it natively
    *) printf '%s/%s' "${PWD%/}" "$1" ;;
  esac
}

# Printed paths go straight into Windows commands, which do not read /c/registry/...
win_path() {
  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      case "$1" in
        /[A-Za-z]/*) printf '%s:/%s' "$(printf '%s' "${1:1:1}" | tr 'a-z' 'A-Z')" "${1:3}" ;;
        *) printf '%s' "$1" ;;
      esac
      ;;
    *) printf '%s' "$1" ;;
  esac
}

OUT="${REGISTRY_CERTS_DIR:-$HOME/registry/certs}"
CN=localhost
DAYS=825
FORCE=0
NEW_CA=0
PORT=5001
CONTAINER=""
CA_CRT=""
CA_KEY=""
EXTRA_SANS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -d | --out)
      [ $# -ge 2 ] || die "$1 needs a value"
      OUT="$2"
      shift 2
      ;;
    -n | --cn)
      [ $# -ge 2 ] || die "$1 needs a value"
      CN="$2"
      shift 2
      ;;
    -D | --days)
      [ $# -ge 2 ] || die "$1 needs a value"
      DAYS="$2"
      shift 2
      ;;
    -p | --port)
      [ $# -ge 2 ] || die "$1 needs a value"
      PORT="$2"
      shift 2
      ;;
    -c | --container)
      [ $# -ge 2 ] || die "$1 needs a value"
      CONTAINER="$2"
      shift 2
      ;;
    -f | --force)
      FORCE=1
      shift
      ;;
    --new-ca)
      NEW_CA=1
      shift
      ;;
    --ca-crt)
      [ $# -ge 2 ] || die "$1 needs a value"
      CA_CRT="$2"
      shift 2
      ;;
    --ca-key)
      [ $# -ge 2 ] || die "$1 needs a value"
      CA_KEY="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option $1 (try --help)"
      ;;
    *)
      EXTRA_SANS+=("$1")
      shift
      ;;
  esac
done
while [ $# -gt 0 ]; do
  EXTRA_SANS+=("$1")
  shift
done

case "$DAYS" in
  '' | *[!0-9]*) die "--days wants a whole number of days, got '$DAYS'" ;;
esac
case "$PORT" in
  '' | *[!0-9]*) die "--port wants a number, got '$PORT'" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port out of range: $PORT"
CONTAINER="${CONTAINER:-registry-$PORT}"
# Pushed blobs live here, not in the container layer, so recreating the container (a Docker
# Desktop image store switch does exactly that) keeps the registry's contents.
DATA_DIR="${REGISTRY_DATA_DIR:-$(dirname "$OUT")/data}"
mkdir -p "$DATA_DIR"
command -v openssl >/dev/null 2>&1 || die "openssl is not on PATH"
OUT="$(abs "$OUT")"

if [ -n "$CA_CRT" ] || [ -n "$CA_KEY" ]; then
  [ -n "$CA_CRT" ] && [ -n "$CA_KEY" ] || die "--ca-crt and --ca-key go together"
  CA_CRT="$(abs "$CA_CRT")"
  CA_KEY="$(abs "$CA_KEY")"
  [ -f "$CA_CRT" ] || die "no CA certificate at $CA_CRT"
  [ -f "$CA_KEY" ] || die "no CA key at $CA_KEY"

  # The one mistake worth blocking outright: an end-entity certificate used as a signer. It
  # either cannot issue (missing keyCertSign) or cannot be trusted as a root by any client.
  openssl x509 -in "$CA_CRT" -noout -text 2>/dev/null | grep -q 'CA:TRUE' ||
    die "$CA_CRT is not a CA certificate (no CA:TRUE in basicConstraints)"
  [ "$(openssl x509 -in "$CA_CRT" -noout -pubkey 2>/dev/null)" = \
    "$(openssl pkey -in "$CA_KEY" -pubout 2>/dev/null)" ] ||
    die "$CA_KEY does not match $CA_CRT"

  # A CA without its key still signs nothing: this catches the mkcert rootCA.pem-without-key case.
  log "signing with existing CA: $(openssl x509 -in "$CA_CRT" -noout -subject | sed 's/^subject=//')"
fi

mkdir -p "$OUT"
# The private keys live here; keep the whole directory out of any repository that contains it.
[ -f "$OUT/.gitignore" ] || printf '*\n' >"$OUT/.gitignore"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

leaf_is_fresh() {
  [ -f "$OUT/registry.crt" ] && [ -f "$OUT/registry.key" ] &&
    openssl x509 -in "$OUT/registry.crt" -noout -checkend 604800 >/dev/null 2>&1
}

build_san_list() {
  local host kind dns_n=0 ip_n=0 alt="" entry
  for host in localhost 127.0.0.1 ::1 "${EXTRA_SANS[@]+"${EXTRA_SANS[@]}"}"; do
    [ -n "$host" ] || continue
    case "$host" in
      *:*) kind=IP ;;
      *[!0-9.]*) kind=DNS ;;
      *) kind=IP ;;
    esac
    entry="$kind:$host"
    # Bash 3.2 (macOS /bin/bash) has no associative arrays, so dedupe through the text itself.
    if printf '%s\n' "$alt" | grep -qxF -- "$entry"; then continue; fi
    alt="${alt}${entry}
"
  done
  printf '%s' "$alt"
}

SAN_ENTRIES="$(build_san_list)"
[ -n "$SAN_ENTRIES" ] || die "no subjectAltName could be built"

write_ext() {
  local alt="" line kind value dns_n=0 ip_n=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    kind="${line%%:*}"
    value="${line#*:}"
    if [ "$kind" = DNS ]; then
      dns_n=$((dns_n + 1))
      alt="${alt}DNS.${dns_n}=${value}
"
    else
      ip_n=$((ip_n + 1))
      alt="${alt}IP.${ip_n}=${value}
"
    fi
  done <<EOF
$SAN_ENTRIES
EOF
  # subjectAltName has to be declared before the [alt] header, or it is read as a key inside
  # the alt section and silently dropped.
  {
    printf 'basicConstraints=critical,CA:FALSE\n'
    printf 'keyUsage=critical,digitalSignature,keyEncipherment\n'
    printf 'extendedKeyUsage=serverAuth\n'
    printf 'subjectAltName=@alt\n\n[alt]\n%s' "$alt"
  } >"$TMP/registry.ext"
}

mint_ca() {
  log "generating a local CA in $OUT/ca.crt"
  cat >"$TMP/ca.cnf" <<'EOF'
[req]
distinguished_name=dn
prompt=no
x509_extensions=ca_ext
[dn]
CN=sbx local registry CA
[ca_ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
EOF
  openssl req -x509 -new -newkey rsa:4096 -nodes -sha256 -days 3650 \
    -config "$TMP/ca.cnf" -keyout "$OUT/ca.key" -out "$OUT/ca.crt" 2>/dev/null
  chmod 600 "$OUT/ca.key"
  chmod 644 "$OUT/ca.crt"
  CA_CRT="$OUT/ca.crt"
  CA_KEY="$OUT/ca.key"
}

mint_leaf() {
  log "minting leaf for CN=$CN ($DAYS days)"
  write_ext
  openssl req -new -newkey rsa:2048 -nodes -sha256 \
    -keyout "$TMP/registry.key" -out "$TMP/registry.csr" -subj "/CN=$CN" 2>/dev/null
  openssl x509 -req -in "$TMP/registry.csr" -sha256 -days "$DAYS" \
    -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial -CAserial "$OUT/ca.srl" \
    -extfile "$TMP/registry.ext" -out "$TMP/registry.crt" 2>/dev/null
  # cp + chmod rather than install: Git Bash on Windows and busybox images lack install.
  cp "$TMP/registry.key" "$OUT/registry.key"
  cp "$TMP/registry.crt" "$OUT/registry.crt"
  chmod 600 "$OUT/registry.key"
  chmod 644 "$OUT/registry.crt"
  cp "$TMP/registry.ext" "$OUT/registry.ext"
}

if [ "$FORCE" -eq 0 ] && [ "$NEW_CA" -eq 0 ] && leaf_is_fresh; then
  [ -n "$CA_CRT" ] || CA_CRT="$OUT/ca.crt"
  log "reusing the certificate in $OUT (valid past the next 7 days; --force to re-mint)"
else
  if [ -z "$CA_CRT" ]; then
    # --force re-mints the leaf, not the CA: throwing the CA away would silently untrust the
    # registry on every host that already imported the old ca.crt.
    if [ "$NEW_CA" -eq 0 ] && [ -f "$OUT/ca.crt" ] && [ -f "$OUT/ca.key" ]; then
      CA_CRT="$OUT/ca.crt"
      CA_KEY="$OUT/ca.key"
      log "reusing the CA in $OUT/ca.crt (--new-ca to replace it)"
    else
      mint_ca
    fi
  fi
  mint_leaf
  openssl verify -CAfile "$CA_CRT" "$OUT/registry.crt" >/dev/null ||
    die "the new leaf does not verify against $CA_CRT"
  log "verified against $CA_CRT"
fi

# Show what was actually minted. If any of this is wrong, the client error will not say so.
printf '\n'
openssl x509 -in "$OUT/registry.crt" -noout -subject -issuer -dates \
  -ext subjectAltName,extendedKeyUsage,basicConstraints | sed 's/^/  /'
printf '\n'

WIN_CA="$(win_path "$CA_CRT")"

cat <<EOF
Registry certificate: $OUT/registry.crt
Registry key:         $OUT/registry.key
CA to trust:          $CA_CRT
Reference to use:     localhost:$PORT/<repo>:<tag>

Serve it (the container port stays 5000, only the host port is published):
  docker rm -f $CONTAINER
  docker run -d --name $CONTAINER -p $PORT:5000 \\
    -v "$DATA_DIR":/var/lib/registry \\
    -v "$OUT":/certs:ro \\
    -e REGISTRY_HTTP_ADDR=0.0.0.0:5000 \\
    -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/registry.crt \\
    -e REGISTRY_HTTP_TLS_KEY=/certs/registry.key \\
    registry:2

A second registry on another port shares this certificate: TLS has no port in its identity, so
point the new container's -v at "$OUT" and publish -p <port>:5000. Only the CA has to be trusted.

Trust the CA in every store that has to read it. The host OS store covers sbx's daemon and
curl; Docker Desktop's VM is a separate store and only matters for docker push:
  Debian   sudo cp "$CA_CRT" /usr/local/share/ca-certificates/sbx-local-ca.crt && sudo update-ca-certificates
  Fedora   sudo cp "$CA_CRT" /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust
  macOS    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CA_CRT"
  Windows  Import-Certificate -FilePath "$WIN_CA" -CertStoreLocation Cert:\\CurrentUser\\Root

Then restart the daemon: Go loads the system roots once per process, so it keeps the old set
until it starts again.
  sbx daemon restart

Docker's push trust is per host:port, unlike the OS store:
  Linux    sudo mkdir -p /etc/docker/certs.d/localhost:$PORT
           sudo cp "$CA_CRT" /etc/docker/certs.d/localhost:$PORT/ca.crt && sudo systemctl restart docker
  Desktop  mkdir -p ~/.docker/certs.d/localhost:$PORT && cp "$CA_CRT" ~/.docker/certs.d/localhost:$PORT/
           # then restart Docker Desktop

Then prove the listener before blaming sbx:
  curl -s https://localhost:$PORT/v2/ -o /dev/null -w '%{http_code}\\n'     # 200 or 401 is success
  openssl s_client -connect localhost:$PORT -servername localhost </dev/null 2>/dev/null \\
    | openssl x509 -noout -issuer -subject -ext subjectAltName
  # Windows: curl.exe --ssl-no-revoke ... (Schannel demands a CRL that a local CA lacks;
  # CRYPT_E_NO_REVOCATION_CHECK means the chain built, not that the CA is missing)

For a kit on $PORT, sbx needs the port in the allowlist, and out of the daemon's proxy scope:
  sbx settings set kit.allowedSources '["docker.io/","localhost:$PORT/"]'
  sbx settings set no_proxy.daemon "localhost:$PORT" && sbx daemon restart

Push to it directly (the port belongs in the tag, and does not move with the image):
  docker buildx build ./kits/sbx-kit-durable \\
    -f ./kits/sbx-kit-durable/sbx-kit-durable.yaml \\
    --platform linux/amd64,linux/arm64 \\
    -t localhost:$PORT/k7o/sbx-kit-durable:0.1.0 --push
EOF

if [ "$FORCE" -eq 0 ] && [ -f "$OUT/ca.key" ]; then
  cat <<EOF

ca.key stays here ($OUT/ca.key). It signs anything named whatever you pass this script, so do
not copy it to a machine that only needs to pull: those get "$CA_CRT" and nothing else.
EOF
fi
