# Planet

Planet is Galaxy for one user, without a Galaxy server. Galaxy's own web client runs in the browser
from static files, a Service Worker answers its API requests from IndexedDB, tools run as Kubernetes
Jobs on a cluster you provide, and datasets are stored in your S3-compatible bucket. Galaxy's Python
code runs only in the job pods, in an image built from this repository, so the pods and the site come
from the same Galaxy commit. Planet lives in this fork of Galaxy under `planet/` and
`client/src/planet/`.

## How it works

- **Site**: static files (Galaxy's client, Planet's Service Worker, generated Galaxy data and the
  built-in toolbox), served by Cloudflare Workers Static Assets or any host that behaves the same way.
- **Service Worker**: emulates the Galaxy API from IndexedDB. Previews read bounded ranges of objects
  and downloads redirect to presigned URLs.
- **Leader tab**: one open Planet tab dispatches jobs, follows them and collects their results.
- **Gateway**: an nginx proxy in your cluster that answers CORS and forwards an allow-list of
  Kubernetes API requests with the browser's token.
- **Job pods**: the `planet-runtime` image stages inputs, renders the command with Galaxy's code,
  runs the tool's container and finishes outputs as Galaxy does.
- **Bucket**: Cloudflare R2, AWS S3, Garage in the cluster, or another S3-compatible service; it
  holds datasets, job files and encrypted backups of the browser's database.

```
 Browser                                       Kubernetes cluster
+------------------------------------+        +-------------------------------+
| Galaxy client                      |  token | planet-gateway (nginx)        |
|   | Galaxy API requests            |   +--->|   CORS, path allow-list       |
|   v                                |   |    |   v                           |
| Service Worker <--> IndexedDB      |   |    | Kubernetes API                |
| Leader tab: job manager -----------+---+    |   v                           |
+-----------------+------------------+        | Job pods: stage-in, tool,     |
                  |                           |           stage-out           |
                  | signed requests           +---------------+---------------+
                  v                                           | presigned URLs
+-------------------------------------------------------------v---------------+
| S3-compatible bucket: datasets, job files, uploads, tools, backups          |
+-----------------------------------------------------------------------------+
```

## Quick start: local kind cluster with Garage

Requirements: Node.js 22 and pnpm 10.26.1 (`client/.node_version`, `client/package.json`), Docker,
kubectl 1.30 or later, openssl, and [kind](https://kind.sigs.k8s.io/) 0.33.0. Run the commands from
the repository root.

```sh
# Client dependencies
(cd client && pnpm install --frozen-lockfile)

# Runtime image, and the Galaxy data and toolbox generated with it (downloads tools from GitHub)
docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
docker build -f planet/runtime/Dockerfile --target test -t planet-runtime:test .
planet/scripts/generate-data.sh

# Site, with the local image as the job runtime
PLANET_ALLOW_UNPINNED_RUNTIME=1 PLANET_RUNTIME_IMAGE=planet-runtime:dev node planet/scripts/build-site.mjs

# Cluster with the gateway and Garage
planet/scripts/dev-cluster.sh up
kind load docker-image planet-runtime:dev --name planet
planet/scripts/dev-cluster.sh port-forward      # keep running: gateway on 127.0.0.1:8001, S3 on 127.0.0.1:8002

# In another terminal: serve the site on http://127.0.0.1:8787
node planet/scripts/serve-dist.mjs
```

Open `http://127.0.0.1:8787`. The home page shows Planet's setup page:

1. **Kubernetes cluster**: gateway URL `http://127.0.0.1:8001`, namespace `planet`, and the token
   that `planet/scripts/dev-cluster.sh token` prints.
2. **Storage bucket**: provider **Local Garage**, with the access key ID and secret access key that
   `planet/scripts/dev-cluster.sh storage` prints.
3. Run **Test connection** for both, save, and upload a dataset from Galaxy's upload dialog.

`planet/scripts/dev-cluster.sh down` deletes the cluster and its data.

## Real cluster and Cloudflare R2

1. Build the runtime image for amd64 and arm64, push it to a registry your cluster can pull from,
   and note its digest:

   ```sh
   docker buildx build --platform linux/amd64,linux/arm64 -f planet/runtime/Dockerfile \
     -t <registry>/planet-runtime:<tag> --push .
   docker buildx imagetools inspect <registry>/planet-runtime:<tag>
   ```

2. Build the site with that image pinned by digest, and publish `planet/dist` on an HTTPS origin.
   `planet/site/wrangler.jsonc` deploys it to Cloudflare Workers Static Assets:

   ```sh
   PLANET_RUNTIME_IMAGE=<registry>/planet-runtime@sha256:<digest> node planet/scripts/build-site.mjs
   npx wrangler deploy --config planet/site/wrangler.jsonc
   ```

   Other hosts must apply the headers in `planet/site/_headers`, answer unmatched navigations with
   `index.html`, and answer other unmatched requests with the JSON errors of `planet/site/worker.js`.

3. Deploy the gateway and job namespace with your site's origin, and publish the gateway over HTTPS:
   [cluster setup](docs/cluster-setup.md).
4. Create an R2 bucket, an API token, a CORS rule for your site's origin and the lifecycle rules:
   [storage setup](docs/storage-setup.md#cloudflare-r2).
5. Enter the gateway URL, token, R2 account ID, bucket and keys on the setup page.

## Documentation

| Document | Contents |
| --- | --- |
| [Architecture](docs/architecture.md) | Invariants, where code runs, data flows, storage layout, build |
| [Security](docs/security.md) | What is stored where, isolation of tool code and datasets, credentials |
| [Limitations](docs/limitations.md) | Differences from a Galaxy server |
| [Development](docs/development.md) | Repository layout, builds, tests, conventions |
| [Cluster setup](docs/cluster-setup.md) | Gateway, RBAC, admission policy, network policies, quotas |
| [Storage setup](docs/storage-setup.md) | R2, AWS S3 and Garage buckets |
| [Job protocol](docs/job-protocol.md) | Manifest, `prepare.json` and `results.json` between browser and pods |
| [Tool bundles](docs/tool-bundle.md) | The JSON form of a Galaxy tool used by forms and pods |
| [planet-runtime](runtime/README.md) | The job pod image and `planet-stager` |
| [Browser tests](tests/e2e/README.md) | Playwright tests, with and without a cluster |

## License and attribution

Planet is distributed under the MIT License of this Galaxy repository,
[`LICENSE.txt`](../LICENSE.txt). Copies and derived works must keep Galaxy's copyright and
permission notice.

Planet deploys or uses these components, unmodified, under their own licenses:

| Component | Use | License |
| --- | --- | --- |
| [Python](https://www.python.org/), image `python:3.14.7-slim-trixie` | Base of the `planet-runtime` image, with Debian packages | PSF-2.0 (Python), each package's own license |
| [nginx](https://nginx.org/), image `nginxinc/nginx-unprivileged` | The gateway | BSD-2-Clause (nginx), Apache-2.0 (image) |
| [Garage](https://garagehq.deuxfleurs.fr/), image `dxflrs/garage` | Optional in-cluster S3 storage, run as a separate service | AGPL-3.0 |
| [cloudflared](https://github.com/cloudflare/cloudflared), image `cloudflare/cloudflared` | Optional Cloudflare Tunnel for the gateway | Apache-2.0 |
| [BioContainers](https://biocontainers.pro/) images on quay.io | Tool containers, pulled by your cluster when a job runs | The license of each packaged tool |
| [galaxyproject/tools-iuc](https://github.com/galaxyproject/tools-iuc) | Tool definitions of the built-in toolbox, included in the site | MIT |
| [EDAM](https://edamontology.org/) | Datatype terms in the generated datatype data | CC BY-SA 4.0 |
| [kind](https://kind.sigs.k8s.io/), image `kindest/node` | The local development cluster | Apache-2.0 |
| [Mercurial](https://www.mercurial-scm.org/) | In `planet-runtime`, to clone Tool Shed repositories | GPL-2.0-or-later |

The site's npm dependencies are listed in `client/pnpm-lock.yaml`, the runtime image's Python
dependencies in `planet/runtime/requirements/*.txt`, and the browser tests' dependencies in
`planet/tests/e2e/package-lock.json`, each under its own license.
