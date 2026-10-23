# Local HTTPS registry for v3 kit images

**Status:** operational note. Written against sbx 0.45+ with a `registry:2` container
serving TLS on `https://localhost:5002`. Certificates come from one script,
`sbx/scripts/registry-tls.sh`. The rest of this note is about making Windows and Linux
accept what that script mints.

Why a registry at all: a kit image is only reachable by `sbx` once it sits in a registry,
and `sbx` fetches the manifest on the host, with the host's trust store. So the registry
has to speak TLS and the host has to trust the CA behind it. `sbx` has no insecure mode
and no CA setting; trust is the only lever.

The v3 kit registry listens on 5002. Whatever already answers on 5001 keeps 5001.

## What sbx does with a reference

| Reference shape | Resolver | Builds locally |
| --- | --- | --- |
| `./my-kit`, `../my-kit`, `my-kit.zip` | kit loader, local source | yes |
| `git+https://host/repo.git#ref=<sha>&dir=my-kit` | kit loader, git clone | yes |
| `localhost:5002/ns/my-kit:1.0.0`, `docker.io/ns/my-kit:1.0.0` | kit loader, registry pull | no |

Two consequences. A bare reference is a registry reference, so `kits/sbx-kit-durable` is a
repository path and `./kits/sbx-kit-durable` is a directory. And kits are read at creation
time, so changing one needs `sbx env rm` before `sbx env create`.

Point the kit loader at 5002 with a direct reference, and widen the allowlist, which permits
Docker Hub only by default:

```bash
sbx settings set kit.allowedSources '["docker.io/","localhost:5002/"]'
```

That key replaces the whole list, so keep every prefix you still want. Prefixes match at
path-segment boundaries, which is why the trailing slash is there.

If the host runs an upstream proxy, the daemon cannot resolve a loopback name. Exempt it
for the daemon only:

```bash
sbx settings set no_proxy.daemon "localhost:5002"
sbx daemon restart
```

## Make the certificate

```bash
./sbx/scripts/registry-tls.sh --port 5002
```

`--port` only changes the commands the script prints; the default is 5001. The files it writes
are the same either way.

It writes `ca.crt`, `ca.key`, `ca.srl`, `registry.crt`, `registry.key` and `registry.ext`
to `~/registry/certs`, then prints the `docker run`, trust and verification commands with
the port already filled in. Run it again and it reuses the leaf and CA; `--force` mints a
new leaf under the same CA, `--new-ca` replaces the CA (every host then has to import the
new `ca.crt`).

The certificate does not contain a port. TLS subjectAltNames are names, never ports, so one
leaf on `localhost` serves 5001, 5002 and anything else you publish. Only the CA has to be
trusted, and only once per store.

On Windows, run the script from Git Bash or WSL. Both have the bash and openssl it needs, and
Git Bash takes a Windows path directly: `-d C:/registry/certs`. WSL should write under
`/mnt/c/...`, or `Import-Certificate` will not see the file.

Serve it. The container port stays 5000, only the published port is 5002, and the name is
`registry-5002` so it cannot replace a container called `registry`:

```bash
docker rm -f registry-5002
docker run -d --name registry-5002 -p 5002:5000 \
  -v ~/registry/certs:/certs:ro \
  -e REGISTRY_HTTP_ADDR=0.0.0.0:5000 \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/registry.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/registry.key \
  registry:2
```

## Which stores have to trust it

The stores that matter, and which client reads each one. Getting one right and leaving
another out is the usual reason a pull works and a push does not.

| Client | Store it reads |
| --- | --- |
| `sbx` daemon (Go) | OS store: `/etc/ssl/certs` on Linux, `ROOT` cert stores on Windows |
| `curl` on Linux | OS store (OpenSSL) |
| `curl.exe` on Windows | Windows store (Schannel) |
| `docker push` | `/etc/docker/certs.d/<host:port>`, not the OS store |
| Docker Desktop | the VM's copy of `certs.d`, at `~/.docker/certs.d` |

## Linux

```bash
# Debian, Ubuntu
sudo cp ~/registry/certs/ca.crt /usr/local/share/ca-certificates/sbx-local-ca.crt
sudo update-ca-certificates

# Fedora, RHEL
sudo cp ~/registry/certs/ca.crt /etc/pki/ca-trust/source/anchors/sbx-local-ca.crt
sudo update-ca-trust

# Arch
sudo cp ~/registry/certs/ca.crt /etc/ca-certificates/trust-source/anchors/sbx-local-ca.crt
sudo trust extract-compat
```

On Debian and Ubuntu the file name has to end in `.crt`, because `update-ca-certificates` globs
for `*.crt`. `update-ca-trust` on Fedora reads whatever sits in the anchors directory. The
first copies the CA into `/etc/ssl/certs` and rebuilds `ca-certificates.crt`; the second
rebuilds `/etc/pki/tls/certs/ca-bundle.crt`. The daemon is a Go program and reads one of those
bundles.

Then restart it. Go loads the system roots once per process, so a daemon that started before
the import keeps the roots it started with:

```bash
sbx daemon restart
```

WSL is a separate trust domain. A daemon inside WSL reads the distro's `/etc/ssl/certs` and
sees nothing you imported in Windows; a Windows daemon sees nothing you ran
`update-ca-certificates` for. Run the commands in whichever of the two runs the daemon.

## Windows

```powershell
# current user, no elevation
Import-Certificate -FilePath "C:\registry\certs\ca.crt" -CertStoreLocation Cert:\CurrentUser\Root

# machine-wide, elevated
certutil -addstore -f Root "C:\registry\certs\ca.crt"
```

Go's Windows backend opens the ROOT store for the user it runs as, so a daemon you start
yourself is covered by `CurrentUser\Root`. A daemon installed as a service, under SYSTEM or
another account, needs `LocalMachine\Root`.

Restart the daemon after importing, same as on Linux. `sbx daemon restart`.

Check what is already there before adding a second root. An mkcert or Docker root that
covers `localhost` can sign this leaf for you, and then nothing needs importing:

```powershell
Get-ChildItem Cert:\CurrentUser\Root, Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -match 'mkcert|localhost|registry|Docker' } |
  Select-Object Subject, NotAfter
```

If one of those is the issuer you want to use, point the script at its key rather than
minting a new CA. From Git Bash:

```bash
./sbx/scripts/registry-tls.sh --port 5002 \
  --ca-crt /c/registry/rootCA.pem --ca-key /c/registry/rootCA-key.pem
```

Importing a root does not make a plaintext registry work, and a leaf certificate cannot be
imported in place of a CA. The script refuses a signer that lacks `CA:TRUE` for that reason.

## Docker push, both platforms

Docker's trust is keyed by host and port, unlike the OS store:

```bash
# Linux
sudo mkdir -p /etc/docker/certs.d/localhost:5002
sudo cp ~/registry/certs/ca.crt /etc/docker/certs.d/localhost:5002/ca.crt
sudo systemctl restart docker
```

```powershell
# Windows and macOS, Docker Desktop
New-Item -ItemType Directory -Force "$HOME\.docker\certs.d\localhost:5002"
Copy-Item "C:\registry\certs\ca.crt" "$HOME\.docker\certs.d\localhost:5002\ca.crt"
# then restart Docker Desktop; there is no reload for this
```

The file must be PEM and must be named `ca.crt`. A DER `.cer` copy is skipped and the push
fails with the same unknown-authority error you were trying to fix.

## Prove it before blaming sbx

Three checks, in increasing order of how much they prove. None of them passes a CA file on
the command line, because that would test the file and not the store.

```bash
# 1. the listener actually does TLS, from the OS store
curl -s https://localhost:5002/v2/ -o /dev/null -w '%{http_code}\n'    # 200, or 401 with auth

# 2. the chain the daemon will build, and who issued it
openssl s_client -connect localhost:5002 -servername localhost </dev/null 2>/dev/null \
  | grep -E 'Verify return code|issuer='

# 3. the client that actually matters
sbx env plan
```

`Verify return code: 0` plus `issuer=CN=sbx local registry CA` means the store accepted the
leaf. The curl code distinguishes TLS from auth: `200` on an anonymous registry, `401` when
a token is wanted, either way TLS is fine.

On Windows, use `curl.exe` from PowerShell or CMD, which speaks Schannel and therefore the
Windows store. Pass `--ssl-no-revoke`, because Schannel checks revocation and a local CA
publishes no CRL for it to fetch:

```powershell
curl.exe --ssl-no-revoke -s -o NUL -w "%{http_code}`n" https://localhost:5002/v2/
```

Without the flag you get `schannel: next InitializeSecurityContext failed:
CRYPT_E_NO_REVOCATION_CHECK (0x80092012)`. That is the revocation check failing, not trust: an
untrusted root reports `SEC_E_UNTRUSTED_ROOT (0x80090325)` instead. Unchecking "Check for server
certificate revocation" in Internet Options fixes it for every Schannel client at once, which is
usually more than you wanted. The sbx daemon is a Go program and does no revocation checking at
all, so this never blocks a pull. It only blocks `curl.exe` used as a diagnostic.

Do not run that check from Git Bash. Its `curl` is built against OpenSSL with Git's own CA
bundle, so it reads neither the Windows store nor `certs.d`, and it reports the CA as unknown
however well the import went. From Git Bash, call `/c/Windows/System32/curl.exe` explicitly.

## Push a kit, then consume it

```bash
docker buildx build ./kits/sbx-kit-durable \
  -f ./kits/sbx-kit-durable/sbx-kit-durable.yaml \
  --platform linux/amd64,linux/arm64 \
  --output type=image,oci-mediatypes=true,push=true \
  -t localhost:5002/k7o/sbx-kit-durable:0.1.0
```

Use `--push` rather than `-t` plus `docker push`. With the container driver, `-t` alone
leaves the result in the build cache and `docker push` has nothing to send. Build both Linux
platforms if the kit is used on Apple Silicon and x86 machines.

The mediatype is not cosmetic. A v3 kit is recognized by its descriptor annotation, and
annotations exist only on OCI manifests. A push through the classic Docker image store emits a
Docker schema2 manifest with the annotations dropped, and sbx then fails to recognize the kit.
The error to expect is a size bound on a layer, which says nothing about size:

```text
resolve kits: kit "...": copy from registry: failed to perform "FindSuccessors" on source:
sha256:7072... declares 39948891 bytes, outside the 0..4194304 byte range
```

Check the shape before blaming sbx. A correct artifact answers with an index whose child
manifest carries the annotation:

```bash
curl -sk -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://localhost:5002/v2/k7o/sbx-kit-durable/manifests/0.1.0 \
  | jq -r '.mediaType, (.manifests[0].digest)'
# application/vnd.oci.image.index.v1+json
# sha256:d4c8cf...

curl -sk -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
  https://localhost:5002/v2/k7o/sbx-kit-durable/manifests/sha256:d4c8cf... \
  | jq -r '.mediaType, .annotations["vnd.docker.sandbox.kit.descriptor"]'
# application/vnd.oci.image.manifest.v1+json
# {"schemaVersion":"3",...}
```

If you get `application/vnd.docker.distribution.manifest.v2+json` and a null annotation, the
build never produced a kit. Turn on the containerd image store in Docker Desktop, then build with
the default docker driver, which pushes through dockerd and keeps OCI manifests:

```bash
docker buildx use default
```

Switching stores hides everything in the other one. Nothing is deleted: Docker Desktop keeps both
on disk, and the hidden set comes back when you switch the checkbox the other way. The registry
container is part of that set, along with the blobs it stored, so after switching you either
recreate it or switch back and start the old one. If you would rather not switch at all, the
fallback is a container-driver builder pointed at a non-loopback name plus a buildkitd registry
config, which is what the following paragraphs cover.

That driver also builds both platforms once the containerd store is on, so `--platform
linux/amd64,linux/arm64` works and lands an OCI index. It needs emulation for the foreign
architecture, which Docker Desktop ships.

Do not reach for a container-driver builder on the default path. That buildkit cannot push to a
loopback registry at all: inside it `localhost` is the buildkit container, and BuildKit treats
loopback registries as plain HTTP whatever CA you hand it, so the push dies on a 400 from the TLS
listener. It works against any other name, which is the escape hatch when the classic store has to
stay. Address the registry the way a container sees it, hand buildkitd the CA, and put that name
in the certificate:

```toml
# buildkitd.toml, passed to `docker buildx create --buildkitd-config`. The path is read on the
# host and copied into the buildkit container, so it does not have to exist inside it.
[registry."host.docker.internal:5002"]
  ca = ["/home/you/registry/certs/ca.crt"]
```

```bash
./sbx/scripts/registry-tls.sh --port 5002 host.docker.internal   # SAN the push will use
```

Then push to `host.docker.internal:5002/...` while kit references stay on `localhost:5002/...`.
Both names reach the same registry, so the repository is the same one either way. Keep the
container-driver builder for Docker Hub, where it is the better choice anyway.

Kits are read at creation, so the order is:

```bash
sbx env plan        # kits resolve here, before anything exists
sbx env rm          # kits, template and sandboxOptions need a recreate
sbx env create
```

Rebuilding and running `sbx env run` against an existing sandbox attaches to the old sandbox
with its recorded kit configuration. Tags are mutable, so pin `@sha256:<digest>` once the
reference leaves your machine.

## Failure signatures

| Message | What it means |
| --- | --- |
| curl `SSL certificate problem: unable to get local issuer certificate`, sbx `x509: certificate signed by unknown authority` | Server TLS is fine, the store the client reads is missing the CA |
| curl `wrong version number`, sbx `http: server gave HTTP response to HTTPS client` | The listener is plaintext. Fix the server, not the trust store |
| `connection refused`, or EOF | Nothing listening, or nothing TLS-capable on that port |
| `schannel: ... CRYPT_E_NO_REVOCATION_CHECK (0x80092012)` | Schannel built the chain and then wanted a CRL that a local CA does not publish. Add `--ssl-no-revoke` to `curl.exe` |
| `copy from registry: failed to perform "FindSuccessors" ... outside the 0..4194304 byte range` | The pushed artifact is a Docker schema2 image, not a v3 kit, so the layer is read as metadata. Push OCI mediatypes, see [Push a kit](#push-a-kit-then-consume-it) |
| `dial tcp [::1]:5002: i/o timeout` | Go tried IPv6 loopback first and something black-holed it. Either the registry container is not running (it lives in whichever image store created it, so a store switch stops it), or only IPv4 is published. Check with `docker ps -a --filter name=registry`, then push to `127.0.0.1:5002`, which every certificate from `registry-tls.sh` already covers |
| `401` with a `www-authenticate` header | Neither of the above. It is auth, or the repository does not exist |
| sbx `fetch manifest: ... 401: unauthorized` with `Action: pull` | Repository missing or private. Docker Hub answers 401 for both, so this never says which |
| `pull access denied for <repo>, repository does not exist` | Same class as the 401, reported by the Docker engine instead |

## Notes

The registry is the wrong tool while authoring a kit. `source: ./kits/sbx-kit-durable` builds
in place, and `sbx` reuses that build while the source files and kit arguments are unchanged.
Reach for the registry when the kit is shared, or when a tag or digest has to mean something.

A pull that cannot reach the registry never shows up in `sbx policy log`. Kit and template
pulls are daemon requests, not sandbox egress, so a host with no route to the port fails
quietly from the policy log's point of view.

An anonymous registry needs no credential. With htpasswd basic auth, store the password once:
`sbx secret set --registry localhost:5002 --password-stdin`.

## References

- [Use kits](https://docs.docker.com/ai/sandboxes/customize/use-kits/): source types, local
  builds, `kit.allowedSources`
- [Build and distribute kits](https://docs.docker.com/ai/sandboxes/customize/author/distribute/):
  `docker buildx ... --push`
- [Sandbox environment files](https://docs.docker.com/ai/sandboxes/configuration/environment-files/):
  `kits[].source`, creation-time semantics
- [Settings reference](https://docs.docker.com/ai/sandboxes/configuration/settings/):
  `kit.allowedSources`, `no_proxy.daemon`, `tls.allowNegativeSerial`
