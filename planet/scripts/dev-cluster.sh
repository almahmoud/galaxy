#!/usr/bin/env bash
# Local kind cluster for Planet development.
set -euo pipefail

readonly CLUSTER=planet
readonly CONTEXT="kind-${CLUSTER}"
readonly KIND_VERSION=v0.33.0
readonly GATEWAY_PORT="${PLANET_GATEWAY_PORT:-8001}"
readonly S3_PORT="${PLANET_S3_PORT:-8002}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../deploy" && pwd)"
readonly DEPLOY_DIR
# A kind binary in planet/build/bin takes precedence over the one on PATH.
PATH="$(dirname "$DEPLOY_DIR")/build/bin:$PATH"

usage() {
    cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  up            Create the kind cluster "${CLUSTER}" and apply planet/deploy/overlays/local.
  down          Delete the kind cluster "${CLUSTER}" and everything stored in it.
  status        Show the cluster, the Planet workloads and the port-forward listeners.
  token         Print the planet-client token to stdout.
  storage       Print the Garage S3 settings, including the secret key, to stdout.
  port-forward  Forward the gateway to 127.0.0.1:${GATEWAY_PORT} (Kubernetes API) and
                127.0.0.1:${S3_PORT} (S3) until interrupted.

kind ${KIND_VERSION} is used from planet/build/bin when present, else from PATH.

Environment:
  PLANET_GATEWAY_PORT  Local port for the Kubernetes API listener (default 8001).
  PLANET_S3_PORT       Local port for the S3 listener (default 8002).
EOF
}

die() {
    echo "error: $*" >&2
    exit 1
}

info() {
    echo "$*" >&2
}

kube() {
    kubectl --context "$CONTEXT" "$@"
}

require() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required ($2)"
}

require_kind() {
    if ! command -v kind >/dev/null 2>&1; then
        local os arch
        os="$(uname -s | tr '[:upper:]' '[:lower:]')"
        case "$(uname -m)" in
        x86_64 | amd64) arch=amd64 ;;
        arm64 | aarch64) arch=arm64 ;;
        *) arch="$(uname -m)" ;;
        esac
        cat >&2 <<EOF
error: kind is not installed. Install kind ${KIND_VERSION}, for example:

  curl -fsSLO https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${os}-${arch}
  curl -fsSLO https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${os}-${arch}.sha256sum
  shasum -a 256 -c kind-${os}-${arch}.sha256sum
  mkdir -p planet/build/bin && install -m 0755 kind-${os}-${arch} planet/build/bin/kind

or with Go: go install sigs.k8s.io/kind@${KIND_VERSION}
EOF
        exit 1
    fi
    local version
    version="$(kind version -q 2>/dev/null || true)"
    if [[ "$version" != "${KIND_VERSION#v}" ]]; then
        info "warning: kind ${version:-unknown} found; this script is tested with ${KIND_VERSION}"
    fi
}

cluster_exists() {
    kind get clusters 2>/dev/null | grep -qx "$CLUSTER"
}

require_cluster() {
    require kubectl "https://kubernetes.io/docs/tasks/tools/"
    require_kind
    cluster_exists || die "cluster ${CLUSTER} does not exist; run: $0 up"
}

ensure_garage_credentials() {
    if kube -n planet-storage get secret garage-credentials >/dev/null 2>&1; then
        return
    fi
    info "Creating Secret planet-storage/garage-credentials with random keys"
    local dir
    dir="$(mktemp -d)"
    # shellcheck disable=SC2064 # $dir is local, so expand it now.
    trap "rm -rf '$dir'" EXIT
    chmod 700 "$dir"
    # Key IDs follow Garage's own format: GK and 24 hex characters.
    printf 'GK%s' "$(openssl rand -hex 12)" >"$dir/access-key-id"
    openssl rand -hex 32 | tr -d '\n' >"$dir/secret-access-key"
    openssl rand -hex 32 | tr -d '\n' >"$dir/rpc-secret"
    kube -n planet-storage create secret generic garage-credentials \
        --from-file="$dir/access-key-id" \
        --from-file="$dir/secret-access-key" \
        --from-file="$dir/rpc-secret" >/dev/null
    rm -rf "$dir"
    trap - EXIT
}

wait_for_token() {
    for _ in $(seq 1 30); do
        if [[ -n "$(kube -n planet get secret planet-client-token -o jsonpath='{.data.token}' 2>/dev/null)" ]]; then
            return
        fi
        sleep 1
    done
    die "the planet-client token was not issued within 30 s"
}

cmd_up() {
    require docker "https://docs.docker.com/get-docker/"
    require kubectl "https://kubernetes.io/docs/tasks/tools/"
    require openssl "used to generate the Garage keys"
    require_kind
    docker info >/dev/null 2>&1 || die "Docker is not running"

    if cluster_exists; then
        info "Cluster ${CLUSTER} exists"
    else
        kind create cluster --name "$CLUSTER" --config "$DEPLOY_DIR/kind/cluster.yaml" --wait 120s
    fi

    kube apply -k "$DEPLOY_DIR/overlays/local"
    ensure_garage_credentials
    kube -n planet rollout status deployment/planet-gateway --timeout=180s
    kube -n planet-storage rollout status deployment/garage --timeout=300s
    wait_for_token

    cat >&2 <<EOF

Planet is deployed on kind-${CLUSTER}.
  $0 port-forward   # gateway on 127.0.0.1:${GATEWAY_PORT}, S3 on 127.0.0.1:${S3_PORT}
  $0 token          # Kubernetes token for the Planet settings page
  $0 storage        # S3 settings for the Planet settings page
EOF
}

cmd_down() {
    require_kind
    if cluster_exists; then
        kind delete cluster --name "$CLUSTER"
    else
        info "Cluster ${CLUSTER} does not exist"
    fi
}

cmd_status() {
    require_kind
    if ! cluster_exists; then
        info "Cluster ${CLUSTER}: not created"
        return
    fi
    require kubectl "https://kubernetes.io/docs/tasks/tools/"
    info "Cluster ${CLUSTER} (context ${CONTEXT})"
    kube get nodes -o wide
    kube -n planet get deployments,pods,jobs
    kube -n planet-storage get deployments,pods,persistentvolumeclaims
    if command -v lsof >/dev/null 2>&1; then
        local port
        for port in "$GATEWAY_PORT" "$S3_PORT"; do
            if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
                info "127.0.0.1:${port}: listening"
            else
                info "127.0.0.1:${port}: not listening (run: $0 port-forward)"
            fi
        done
    fi
}

cmd_token() {
    require_cluster
    info "Token of ServiceAccount planet/planet-client. Equivalent command:"
    info "  kubectl --context ${CONTEXT} -n planet get secret planet-client-token -o jsonpath='{.data.token}' | base64 --decode"
    local token
    token="$(kube -n planet get secret planet-client-token -o jsonpath='{.data.token}')"
    [[ -n "$token" ]] || die "the token has not been issued yet"
    printf '%s' "$token" | base64 --decode
    if [[ -t 1 ]]; then
        echo
    fi
}

cmd_storage() {
    require_cluster
    local encoded access_key secret_key
    encoded="$(kube -n planet-storage get secret garage-credentials -o jsonpath='{.data.access-key-id} {.data.secret-access-key}')" ||
        die "Secret planet-storage/garage-credentials not found; run: $0 up"
    read -r access_key secret_key <<<"$encoded"
    cat <<EOF
endpoint:          http://127.0.0.1:${S3_PORT}
cluster endpoint:  http://garage.planet-storage.svc:3900
bucket:            planet
region:            garage
path-style:        true
access key ID:     $(printf '%s' "$access_key" | base64 --decode)
secret access key: $(printf '%s' "$secret_key" | base64 --decode)
EOF
}

cmd_port_forward() {
    require_cluster
    if command -v lsof >/dev/null 2>&1; then
        local port
        for port in "$GATEWAY_PORT" "$S3_PORT"; do
            if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
                die "port ${port} is in use; set PLANET_GATEWAY_PORT or PLANET_S3_PORT to use another port"
            fi
        done
    fi
    require curl "used to check that the port-forward answers"
    local forward=""
    # kubectl runs in the background, where a script's children ignore Ctrl-C; stop it on the way out.
    trap '[[ -z "$forward" ]] || kill "$forward" 2>/dev/null; exit 0' INT TERM
    info "Forwarding 127.0.0.1:${GATEWAY_PORT} -> gateway:8080 and 127.0.0.1:${S3_PORT} -> gateway:8081 (Ctrl-C to stop)"
    # kubectl port-forward exits when the gateway pod is replaced, and can keep running on a connection to the API
    # server that no longer opens streams ("error creating error stream ... Timeout occurred"). Either way, start a
    # new one.
    while true; do
        # Not through kube(): $! must be kubectl itself, not a subshell running the function.
        kubectl --context "$CONTEXT" -n planet port-forward --address 127.0.0.1 service/planet-gateway \
            "${GATEWAY_PORT}:8080" "${S3_PORT}:8081" &
        forward=$!
        watch_forward "$forward"
        wait "$forward" 2>/dev/null || true
        forward=""
        info "port-forward stopped; reconnecting in 2 s"
        sleep 2
    done
}

# Any HTTP answer through both forwarded ports, within 5 s each.
forward_answers() {
    curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${GATEWAY_PORT}/healthz" &&
        curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${S3_PORT}/"
}

# Returns when kubectl port-forward (pid $1) exits, or after stopping it when two of the last three checks failed: a
# failing port-forward often still answers some requests. The ports are checked every 6 s.
watch_forward() {
    local pid="$1" results="" tick=0
    while kill -0 "$pid" 2>/dev/null; do
        sleep 2
        ((++tick % 3 == 0)) || continue
        if forward_answers; then
            results+="+"
        else
            results+="-"
        fi
        ((${#results} <= 3)) || results="${results:1}"
        if [[ "$results" == *-*-* ]]; then
            info "port-forward does not answer; restarting it"
            kill "$pid" 2>/dev/null || true
            for _ in 1 2 3 4 5; do
                kill -0 "$pid" 2>/dev/null || return 0
                sleep 1
            done
            kill -KILL "$pid" 2>/dev/null || true
            return
        fi
    done
}

main() {
    case "${1:-}" in
    up) cmd_up ;;
    down) cmd_down ;;
    status) cmd_status ;;
    token) cmd_token ;;
    storage) cmd_storage ;;
    port-forward) cmd_port_forward ;;
    -h | --help | help) usage ;;
    *)
        usage >&2
        exit 2
        ;;
    esac
}

main "$@"
