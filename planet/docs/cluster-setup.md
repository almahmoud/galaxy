# Cluster setup

Planet runs tools as Kubernetes Jobs in a cluster you control. The browser calls the Kubernetes
API through the Planet gateway, an nginx proxy in the cluster that handles CORS and forwards
only the requests Planet makes. The manifests are kustomize directories under `planet/deploy`.

## Requirements

- Kubernetes 1.30 or later.
- kubectl 1.30 or later, which includes kustomize.
- Permission to create namespaces, a PriorityClass and a ValidatingAdmissionPolicy
  (cluster-admin).
- A network plugin that enforces NetworkPolicy, such as Calico, Cilium, or kindnet in kind 0.24
  and later. Other plugins accept the policies without enforcing them.
- amd64 nodes for most tools: BioContainers images are published for amd64 only.

## Contents

| Path | Contents |
| --- | --- |
| `base` | Namespace `planet`, ServiceAccounts, RBAC, token Secret, admission policy, NetworkPolicies, ResourceQuota, LimitRange, PriorityClass `planet-service`, gateway Deployment and Service (port 8080). |
| `components/garage` | Garage S3 server in namespace `planet-storage`, and an S3 listener on gateway port 8081. See [Storage setup](storage-setup.md#garage-local-clusters). |
| `components/cloudflare-tunnel` | cloudflared in namespace `planet-edge`, publishing the gateway over HTTPS. |
| `overlays/local` | kind cluster: origins `http://localhost:8787` and `http://127.0.0.1:8787`, Garage, small quotas. |
| `overlays/example` | Starting point for other clusters: one HTTPS origin, base quotas. |
| `kind/cluster.yaml` | Single-node kind cluster, Kubernetes 1.37. |
| `tests/gateway-test.sh` | Runs the gateway configuration in Docker and checks its behaviour. |

## Install

1. Copy `overlays/example` to a new directory beside it, for example `overlays/mylab`.
2. List each origin that serves Planet in `allowed-origins.map`:

   ```nginx
   "https://planet.mylab.org" 1;
   ```

   Origins match exactly: scheme, host and port, without a path or trailing slash.
3. Apply the overlay and wait for the gateway:

   ```sh
   kubectl apply -k planet/deploy/overlays/mylab
   kubectl -n planet rollout status deployment/planet-gateway
   ```

To use a namespace other than `planet`, set kustomize's `namespace` field in an overlay without
components (components keep their own namespaces). The gateway reads its namespace from its pod,
and the admission policy and NetworkPolicies select namespaces by label.

### Local cluster with kind

`planet/scripts/dev-cluster.sh` manages a kind cluster named `planet` with `overlays/local`. It
needs Docker, kubectl, openssl and kind 0.33.0; without kind it prints install instructions.

```sh
planet/scripts/dev-cluster.sh up            # create the cluster and apply overlays/local
planet/scripts/dev-cluster.sh port-forward  # gateway on 127.0.0.1:8001, S3 on 127.0.0.1:8002
planet/scripts/dev-cluster.sh token         # print the planet-client token
planet/scripts/dev-cluster.sh storage       # print the Garage S3 settings
planet/scripts/dev-cluster.sh status
planet/scripts/dev-cluster.sh down          # delete the cluster and its data
```

`up` makes `kind-planet` the current kubectl context. `PLANET_GATEWAY_PORT` and
`PLANET_S3_PORT` change the local ports.

## Expose the gateway

### Port-forward (Chrome, Firefox)

```sh
kubectl -n planet port-forward --address 127.0.0.1 service/planet-gateway 8001:8080
```

The gateway URL is then `http://127.0.0.1:8001`. Chrome and Firefox let an HTTPS page call
loopback addresses once the user accepts the browser's local network access prompt. The forward
ends when the gateway pod restarts; `dev-cluster.sh port-forward` reconnects. Safari blocks
`http://` loopback addresses from HTTPS pages: use HTTPS.

### HTTPS (Safari, remote access)

Publish the Service `planet-gateway`, port 8080, on an HTTPS hostname with a publicly trusted
certificate. Disable response buffering in that layer so that watches and logs stream. Do not
put an authentication proxy such as Cloudflare Access in front of the gateway: browsers send
CORS preflight requests without credentials, and the proxy would refuse them.

The NetworkPolicy `planet-gateway-ingress` admits pods from every namespace except Job pods. A
proxy that runs on the host network needs its own rule in an overlay.

**Cloudflare Tunnel**

1. In Cloudflare Zero Trust, create a tunnel, add a public hostname such as `k8s.mylab.org`
   with the service `http://planet-gateway.planet.svc:8080`, and copy the tunnel token.
2. Add `../../components/cloudflare-tunnel` to `components` in your overlay and apply it.
3. Store the token; the cloudflared pods start once the Secret exists:

   ```sh
   kubectl -n planet-edge create secret generic cloudflared-token --from-literal=token='<tunnel token>'
   ```

cloudflared buffers responses whose content type is not `text/event-stream`, so watch events and
followed logs arrive when each request ends. Cloudflare fails a request with error 524 when the
gateway sends no response for 125 seconds.

**Gateway API**

With an implementation that has a Gateway and an HTTPS listener accepting routes from the
`planet` namespace:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: planet-gateway
  namespace: planet
spec:
  parentRefs:
    - name: public            # your Gateway
      namespace: gateway-system
  hostnames: ["k8s.mylab.org"]
  rules:
    - backendRefs:
        - name: planet-gateway
          port: 8080
      timeouts:
        request: 1h           # watches and log streams are long requests
```

## Token

The overlay creates a long-lived token for the ServiceAccount `planet-client`:

```sh
kubectl -n planet get secret planet-client-token -o jsonpath='{.data.token}' | base64 --decode
```

The token does not expire. Deleting the Secret revokes it; applying the overlay again issues a
new one.

## Planet settings

| Setting | Value |
| --- | --- |
| Gateway URL | `http://127.0.0.1:8001`, or the HTTPS URL of the gateway |
| Namespace | `planet` |
| Token | the `planet-client` token |
| Job service account | `planet-job` |

## Security

**Token.** It can create, read, list, watch and delete Jobs, read pods and their logs, and list
events in the namespace, nothing else. Whoever holds it can run containers in the namespace
within the quota.

**Gateway.** The gateway holds no credential: it forwards the browser's bearer token. It accepts
only the origins in `allowed-origins.map` and answers CORS preflights itself. It matches the
decoded and normalized path against this list and forwards that normalized path:

| Method | Path |
| --- | --- |
| `GET` | `/version` |
| `POST` | `/apis/authorization.k8s.io/v1/selfsubjectrulesreviews` |
| `GET`, `POST` | `/apis/batch/v1/namespaces/<namespace>/jobs` |
| `GET`, `DELETE` | `/apis/batch/v1/namespaces/<namespace>/jobs/<name>` |
| `GET` | `/api/v1/namespaces/<namespace>/pods`, `.../pods/<name>`, `.../pods/<name>/log` |
| `GET` | `/api/v1/namespaces/<namespace>/events` |

Other requests get a Kubernetes `Status` with code 403. A `DELETE` is forwarded with
`propagationPolicy=Background` so that the Job's pods are deleted with it; a `GET` or `DELETE`
with a body gets 400. The gateway removes `Impersonate-User`, `Impersonate-Group`,
`Impersonate-Uid` and `Cookie` headers, refuses `insecureSkipTLSVerifyBackend`, verifies the
API server with the cluster CA, and allows 20 requests per second per client (bursts of 40) and
64 concurrent connections. It runs as a non-root user with a read-only root filesystem.

**Admission policy.** `planet-job-template` rejects a Job in the namespace unless:

- its pods use the ServiceAccount `planet-job` with `automountServiceAccountToken: false`;
- no volume is a Secret or hostPath, and no projected volume includes a Secret or a
  ServiceAccount token;
- no container reads a Secret through `env` or `envFrom`;
- `activeDeadlineSeconds` is set and at most 604800 (7 days), and `ttlSecondsAfterFinished` is
  set;
- `manualSelector` is not true;
- the pods do not use the `planet-service` or `system-*` priority classes.

**Pod Security.** The namespace enforces the `restricted` Pod Security Standard. The `warn` mode
returns violations as warnings when a Job is created, before any pod exists.

**Network.** Ingress to the namespace is denied except to the gateway, which Job pods cannot
reach. Job pods may resolve DNS and connect to any address except the cloud instance-metadata
endpoints `169.254.169.254` and `fd00:ec2::254`. They can reach other services in the cluster
unless those services restrict their ingress.

## Quotas and limits

| Setting | `base` | `overlays/local` |
| --- | --- | --- |
| Pods (running at once) | 20 | 10 |
| CPU requests | 16 | 4 |
| Memory requests / limits | 64Gi / 64Gi | 8Gi / 12Gi |
| Ephemeral storage requests / limits | 200Gi / 256Gi | 40Gi / 50Gi |
| PersistentVolumeClaims / storage | 10 / 500Gi | 4 / 40Gi |
| Job objects, finished ones included | 500 | 200 |
| Container default request | 100m CPU, 256Mi memory, 1Gi ephemeral storage | same |
| Container default limit | 1Gi memory, 4Gi ephemeral storage, no CPU limit | same |
| Container maximum | 32Gi memory, 200Gi ephemeral storage | 8Gi, 30Gi |
| PersistentVolumeClaim maximum | 200Gi | 20Gi |

A Job that exceeds a quota or a maximum stays without pods; its `FailedCreate` events give the
reason. Override the values with a patch in your overlay, as `overlays/local` does.

## Testing

`planet/deploy/tests/gateway-test.sh` runs the gateway image with this configuration in Docker
against a stub API server and a Garage container, and checks CORS, the allow-list, header
handling, DELETE handling, rate limiting and the S3 listener. It needs Docker, openssl, python3
and curl 7.75 or later.
