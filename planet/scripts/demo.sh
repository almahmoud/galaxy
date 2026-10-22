#!/usr/bin/env bash
# Local Planet demo: kind cluster, port-forwards, the built site and the demo data set.
set -euo pipefail

readonly CLUSTER=planet
readonly CONTEXT="kind-${CLUSTER}"
readonly NODE="${CLUSTER}-control-plane"
readonly NAMESPACE=planet
readonly RUNTIME_IMAGE=planet-runtime:dev
readonly SITE_URL=http://127.0.0.1:8787
readonly SITE_PORT=8787
# The addresses the Local Garage preset and the setup page expect.
readonly GATEWAY_PORT=8001
readonly S3_PORT=8002

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly repo_root
readonly planet_dir="$repo_root/planet"
readonly scripts_dir="$planet_dir/scripts"
readonly demo_dir="$planet_dir/build/demo"
readonly data_dir="$demo_dir/data"
readonly log_dir="$demo_dir/logs"
readonly credentials="$demo_dir/credentials.txt"
readonly images_file="$demo_dir/images.txt"
readonly profile_dir="$demo_dir/chrome-profile"
readonly forward_pid="$demo_dir/port-forward.pid"
readonly server_pid="$demo_dir/serve.pid"
readonly generated_data="$planet_dir/build/generated/static/planet/data"
# A kind binary in planet/build/bin takes precedence over the one on PATH, as in dev-cluster.sh.
PATH="$planet_dir/build/bin:$PATH"

usage() {
    cat <<EOF
Usage: $(basename "$0") <command> [options]

Commands:
  up        Prepare and start everything for the demo, then open ${SITE_URL} in Google Chrome:
            the planet-runtime:dev image, Planet's generated data and site (when missing), the demo
            data, the kind cluster "${CLUSTER}" with the runtime and tool images in place, the
            port-forwards (127.0.0.1:${GATEWAY_PORT} and :${S3_PORT}) and the site server (:${SITE_PORT}).
  down      Stop the site server and port-forwards, delete the cluster and the credentials file.
  status    Show what is running.
  copy NAME Copy a setting to the clipboard without printing it: token, access-key or secret-key.
  rehearse  Run the demo storyline in the Playwright browser against the running demo
            (tests/e2e/tests/demo.spec.ts); records the tool images in build/demo/images.txt,
            which the next "up" pulls into the cluster. Further arguments go to playwright test.

Options for up:
  --no-open        Do not open the browser.
  --fresh-browser  Open Chrome with a separate profile in build/demo/chrome-profile, removed by down,
                   so no settings or histories of an earlier session are shown.
  --build          Rebuild planet/dist even when it exists.

Files in planet/build/demo/: data/ (demo inputs), credentials.txt (mode 600), images.txt,
logs/ and the pid files of the background processes.
EOF
}

die() {
    echo "error: $*" >&2
    exit 1
}

info() {
    echo "$*" >&2
}

step() {
    echo "==> $*" >&2
}

require() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required ($2)"
}

kube() {
    kubectl --context "$CONTEXT" "$@"
}

docker_running() {
    docker info >/dev/null 2>&1
}

cluster_exists() {
    kind get clusters 2>/dev/null | grep -qx "$CLUSTER"
}

port_open() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

listeners() {
    { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; } | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# Prints the pid recorded in $1 when that process is alive and its command line contains $2.
live_pid() {
    local pid command
    [[ -f "$1" ]] || return 1
    pid="$(tr -cd '0-9' <"$1")"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [[ "$command" == *"$2"* ]] || return 1
    echo "$pid"
}

wait_until() {
    local seconds="$1"
    shift
    for _ in $(seq 1 "$((seconds * 2))"); do
        if "$@"; then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

site_answers() {
    curl -fsS -o /dev/null --max-time 2 "$SITE_URL/static/planet/build.json" 2>/dev/null
}

forward_open() {
    port_open "$GATEWAY_PORT" && port_open "$S3_PORT"
}

# Stops the process in pid file $1 (command line containing $2) and its children.
stop_process() {
    local file="$1" pattern="$2" name="$3" pid
    if ! pid="$(live_pid "$file" "$pattern")"; then
        rm -f "$file"
        return 0
    fi
    info "Stopping ${name} (pid ${pid})"
    local children child
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    # The parent first: dev-cluster.sh port-forward exits once kubectl, its child, ends instead of restarting it.
    kill -TERM "$pid" 2>/dev/null || true
    for child in $children; do
        kill -TERM "$child" 2>/dev/null || true
    done
    if ! wait_until 10 bash -c "! kill -0 $pid 2>/dev/null"; then
        kill -KILL "$pid" 2>/dev/null || true
    fi
    for child in $children; do
        if kill -0 "$child" 2>/dev/null; then
            kill -KILL "$child" 2>/dev/null || true
        fi
    done
    rm -f "$file"
}

check_load() {
    local ncpu stats total top
    ncpu="$(docker info --format '{{.NCPU}}' 2>/dev/null || echo 1)"
    stats="$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemPerc}}' 2>/dev/null || true)"
    if [[ -z "$stats" ]]; then
        info "Docker: no running containers"
        return
    fi
    total="$(awk -v node="$NODE" '$1 != node { gsub("%", "", $2); sum += $2 } END { printf "%.0f", sum }' <<<"$stats")"
    top="$(awk -v node="$NODE" '$1 != node { gsub("%", "", $2); if ($2 + 0 > 20) printf "%s %.0f%%\n", $1, $2 }' <<<"$stats" |
        sort -k2 -rn | head -5 | paste -sd ',' - | sed 's/,/, /g')"
    info "Docker: ${total}% CPU used by other containers, of $((ncpu * 100))% (${ncpu} CPUs); host load average:$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
    if ((total > ncpu * 50)); then
        cat >&2 <<EOF

warning: the Docker VM is heavily loaded (${total}% of $((ncpu * 100))% CPU) by containers that are not
         part of the demo: ${top:-none above 20%}.
         Jobs, uploads and page loads will be slower. Stop those workloads before the demo if you can.

EOF
    fi
}

ensure_runtime_image() {
    if docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1; then
        info "Image ${RUNTIME_IMAGE} present"
        return
    fi
    step "Building ${RUNTIME_IMAGE} (planet/runtime/Dockerfile)"
    docker build -f "$planet_dir/runtime/Dockerfile" -t "$RUNTIME_IMAGE" "$repo_root"
}

ensure_site() {
    local rebuild="$1"
    local -a build_env=(PLANET_ALLOW_UNPINNED_RUNTIME=1 "PLANET_RUNTIME_IMAGE=${RUNTIME_IMAGE}")
    if [[ ! -f "$generated_data/toolbox/panel.json" || ! -f "$generated_data/datatypes/index.json" ||
        ! -f "$generated_data/genomes.json" ]]; then
        step "Generating Planet's datatypes, genomes and toolbox (planet/scripts/generate-data.sh)"
        local -a generate_args=()
        if ! docker image inspect planet-runtime:test >/dev/null 2>&1; then
            info "planet-runtime:test is not built; the tool bundles are not validated"
            generate_args+=(--skip-validation)
        fi
        env "${build_env[@]}" "$scripts_dir/generate-data.sh" ${generate_args[@]+"${generate_args[@]}"}
        rebuild=1
    fi
    if [[ "$rebuild" == 1 || ! -f "$planet_dir/dist/index.html" ]]; then
        step "Building the site into planet/dist (planet/scripts/build-site.mjs)"
        env "${build_env[@]}" node "$scripts_dir/build-site.mjs"
    else
        info "Site planet/dist present (pass --build to rebuild it)"
    fi
    if ! grep -q "\"image\": *\"${RUNTIME_IMAGE}\"" "$planet_dir/dist/static/planet/data/runtime.json" 2>/dev/null; then
        info "warning: planet/dist was not built with PLANET_RUNTIME_IMAGE=${RUNTIME_IMAGE}; enter it as the runtime image on the setup page"
    fi
}

# Loads an image into the kind node; images kind cannot export are pulled by the node itself.
load_image() {
    local image="$1"
    if kind load docker-image "$image" --name "$CLUSTER" >>"$log_dir/images.log" 2>&1; then
        return 0
    fi
    info "  kind could not load ${image}; pulling it in the node instead"
    docker exec "$NODE" crictl pull "$image" >>"$log_dir/images.log" 2>&1
}

load_images() {
    step "Loading ${RUNTIME_IMAGE} into the cluster"
    load_image "$RUNTIME_IMAGE" || die "cannot load ${RUNTIME_IMAGE} into the cluster (see ${log_dir}/images.log)"
    if [[ ! -s "$images_file" ]]; then
        info "No ${images_file#"$repo_root"/}: tool images are pulled by the cluster on first use (run: $0 rehearse)"
        return
    fi
    # The node pulls the tool images itself. kind load registers an image from Docker under a generated name and a
    # new digest, not the registry reference the Jobs use, so the kubelet pulls it again or fails to start it.
    local image i
    local -a images=() pulls=()
    while IFS= read -r image || [[ -n "$image" ]]; do
        image="${image%%#*}"
        image="$(tr -d '[:space:]' <<<"$image")"
        [[ -n "$image" && "$image" != "$RUNTIME_IMAGE" ]] || continue
        images+=("$image")
    done <"$images_file"
    ((${#images[@]})) || return 0
    step "Pulling the tool images listed in ${images_file#"$repo_root"/} in the cluster"
    for image in "${images[@]}"; do
        info "  ${image}"
        docker exec "$NODE" crictl pull "$image" >>"$log_dir/images.log" 2>&1 &
        pulls+=("$!")
    done
    for i in "${!pulls[@]}"; do
        wait "${pulls[$i]}" ||
            info "  warning: cannot pull ${images[$i]}; the cluster pulls it when a job needs it"
    done
}

start_port_forward() {
    local pid
    if pid="$(live_pid "$forward_pid" "dev-cluster.sh port-forward")"; then
        info "Port-forward running (pid ${pid})"
    else
        local port busy
        for port in "$GATEWAY_PORT" "$S3_PORT"; do
            busy="$(listeners "$port")"
            [[ -z "$busy" ]] || die "127.0.0.1:${port} is in use by pid ${busy}; stop that process (an earlier port-forward?) and run up again"
        done
        step "Starting the port-forward (log: ${log_dir#"$repo_root"/}/port-forward.log)"
        nohup "$scripts_dir/dev-cluster.sh" port-forward >>"$log_dir/port-forward.log" 2>&1 </dev/null &
        echo "$!" >"$forward_pid"
    fi
    wait_until 30 forward_open || die "the port-forward did not open 127.0.0.1:${GATEWAY_PORT} and :${S3_PORT}; see ${log_dir}/port-forward.log"
}

start_server() {
    local pid
    if pid="$(live_pid "$server_pid" "serve-dist.mjs")"; then
        info "Site server running (pid ${pid})"
    else
        local busy
        busy="$(listeners "$SITE_PORT")"
        [[ -z "$busy" ]] || die "127.0.0.1:${SITE_PORT} is in use by pid ${busy}; stop that process and run up again"
        step "Starting the site server on ${SITE_URL} (log: ${log_dir#"$repo_root"/}/serve.log)"
        nohup node "$scripts_dir/serve-dist.mjs" "$SITE_PORT" >>"$log_dir/serve.log" 2>&1 </dev/null &
        echo "$!" >"$server_pid"
    fi
    wait_until 20 site_answers || die "the site server does not answer on ${SITE_URL}; see ${log_dir}/serve.log"
}

# Writes the token and Garage keys to credentials.txt (mode 600) and checks that the gateway accepts the token.
write_credentials() {
    local token storage access_key secret_key header status
    token="$("$scripts_dir/dev-cluster.sh" token 2>/dev/null)" || die "cannot read the planet-client token"
    storage="$("$scripts_dir/dev-cluster.sh" storage 2>/dev/null)" || die "cannot read the Garage keys"
    access_key="$(sed -n 's/^access key ID: *//p' <<<"$storage")"
    secret_key="$(sed -n 's/^secret access key: *//p' <<<"$storage")"
    [[ -n "$token" && -n "$access_key" && -n "$secret_key" ]] || die "dev-cluster.sh returned incomplete credentials"
    (
        umask 077
        cat >"$credentials" <<EOF
Planet demo settings for the setup page. Removed by: planet/scripts/demo.sh down

Cluster settings
  Gateway URL: http://127.0.0.1:${GATEWAY_PORT}
  Namespace: ${NAMESPACE}
  Token: ${token}
  Runtime image: ${RUNTIME_IMAGE}

Storage settings (Local Garage preset)
  Endpoint: http://127.0.0.1:${S3_PORT}
  Bucket: planet
  Access key ID: ${access_key}
  Secret access key: ${secret_key}
EOF
        header="$(mktemp "$demo_dir/.header.XXXXXX")"
        trap 'rm -f "$header"' EXIT
        printf 'Authorization: Bearer %s\n' "$token" >"$header"
        status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @"$header" -H "Origin: ${SITE_URL}" \
            "http://127.0.0.1:${GATEWAY_PORT}/api/v1/namespaces/${NAMESPACE}/pods?limit=1" || true)"
        rm -f "$header"
        [[ "$status" == 200 ]] || die "the gateway answered HTTP ${status:-000} to the planet-client token"
    )
    chmod 600 "$credentials"
}

open_browser() {
    local fresh="$1"
    if [[ "$fresh" == 1 ]]; then
        mkdir -p "$profile_dir"
        open -na "Google Chrome" --args --user-data-dir="$profile_dir" --no-first-run --no-default-browser-check \
            "$SITE_URL/" 2>/dev/null || info "Cannot start Google Chrome; open ${SITE_URL} in Chrome"
    else
        open -a "Google Chrome" "$SITE_URL/" 2>/dev/null || info "Cannot start Google Chrome; open ${SITE_URL} in Chrome"
    fi
}

print_checklist() {
    local opened="$1" this="planet/scripts/demo.sh"
    cat <<EOF

Planet demo is ready${opened:+ and open in Google Chrome}: ${SITE_URL}

Setup page (${SITE_URL}/welcome); values are in ${credentials}
  Cluster settings
    Gateway URL        http://127.0.0.1:${GATEWAY_PORT}
    Namespace          ${NAMESPACE}
    Token              paste after: ${this} copy token
    Job defaults and runtime:
      Runtime image    ${RUNTIME_IMAGE}
      Memory 2Gi, Scratch space 8Gi (optional: two jobs then run at the same time)
    Save, then Test connection
  Storage settings
    Preset             Local Garage
    Access key ID      paste after: ${this} copy access-key
    Secret access key  paste after: ${this} copy secret-key
    Save, then Test connection
  A browser that used Planet here before keeps settings of an earlier cluster: enter these again,
  or start with: ${this} up --fresh-browser

Demo data in ${data_dir}
  reference.fasta                       upload as is
  demo_R1.fastq.gz, demo_R2.fastq.gz    upload together as fastqsanger.gz, with
                                        "Create a collection from these files", type List of Pairs

Storyline
  fastp (Paired Collection: the reads) -> Map with minimap2 (genome from history: reference.fasta;
  Paired Collection: fastp's Paired-end output) -> Samtools flagstat and Samtools stats (collection:
  the minimap2 output) -> MultiQC (fastp, collection: the JSON report; Insert Results, Samtools,
  Insert Samtools output, stats, collection: the Samtools stats output) -> open the MultiQC Webpage
  with the eye icon.

Stop everything: ${this} down
EOF
}

# Reports what an interrupted or failed up left running.
report_failed_up() {
    local status=$?
    ((status != 0)) || return 0
    info ""
    info "WARNING: up did not finish (exit ${status}). Running now:"
    cmd_status || true
    info "Stop everything with: $0 down"
}

cmd_up() {
    local open=1 fresh=0 rebuild=0
    while (($#)); do
        case "$1" in
        --no-open) open=0 ;;
        --fresh-browser) fresh=1 ;;
        --build) rebuild=1 ;;
        *) die "unknown option for up: $1" ;;
        esac
        shift
    done
    require docker "https://docs.docker.com/get-docker/"
    require kubectl "https://kubernetes.io/docs/tasks/tools/"
    require kind "planet/scripts/dev-cluster.sh explains how to install it"
    require node "Node.js 22 or newer"
    require curl "used to check the site and the gateway"
    require lsof "used to find processes on the demo ports"
    docker_running || die "Docker is not running"
    mkdir -p "$demo_dir" "$log_dir"
    trap report_failed_up EXIT

    check_load
    ensure_runtime_image
    ensure_site "$rebuild"
    step "Writing the demo data (planet/scripts/demo-data.mjs)"
    node "$scripts_dir/demo-data.mjs" --out "$data_dir"
    step "Starting the kind cluster (planet/scripts/dev-cluster.sh up)"
    "$scripts_dir/dev-cluster.sh" up
    load_images
    start_port_forward
    start_server
    write_credentials
    info "Credentials written to ${credentials} (mode 600)"

    local opened=""
    if [[ "$open" == 1 ]]; then
        open_browser "$fresh"
        opened=1
    fi
    trap - EXIT
    print_checklist "$opened"
}

cmd_down() {
    mkdir -p "$demo_dir"
    stop_process "$server_pid" "serve-dist.mjs" "the site server"
    stop_process "$forward_pid" "dev-cluster.sh port-forward" "the port-forward"
    # The bracket keeps the pattern from matching the command line that contains it.
    local chrome_pattern="[-]-user-data-dir=${profile_dir}" chrome
    chrome="$(pgrep -f -- "$chrome_pattern" 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)"
    if [[ -n "$chrome" ]]; then
        info "Closing the demo Chrome profile (pid ${chrome})"
        # shellcheck disable=SC2086 # One argument per pid.
        kill -TERM $chrome 2>/dev/null || true
        wait_until 10 bash -c "! pgrep -f -- '${chrome_pattern}' >/dev/null" || true
    fi
    rm -f "$credentials"
    rm -rf "$profile_dir"
    if ! docker_running; then
        info "Docker is not running, so neither is the cluster"
    elif ! command -v kind >/dev/null 2>&1; then
        info "kind is not installed, so the cluster was not created by dev-cluster.sh"
    else
        "$scripts_dir/dev-cluster.sh" down
    fi

    local left=() port busy
    if docker_running && command -v kind >/dev/null 2>&1 && cluster_exists; then
        left+=("kind cluster ${CLUSTER}")
    fi
    for port in "$SITE_PORT" "$GATEWAY_PORT" "$S3_PORT"; do
        busy="$(listeners "$port")"
        [[ -z "$busy" ]] || left+=("a listener on 127.0.0.1:${port} (pid ${busy})")
    done
    if [[ -n "$(pgrep -f -- "$chrome_pattern" 2>/dev/null || true)" ]]; then
        left+=("Chrome with the demo profile")
    fi
    if ((${#left[@]})); then
        info ""
        info "WARNING: still running:"
        printf '  - %s\n' "${left[@]}" >&2
        exit 1
    fi
    info "Nothing of the demo is running; credentials removed."
}

cmd_status() {
    local pid state
    if ! docker_running; then
        info "Docker:        not running"
    elif ! command -v kind >/dev/null 2>&1; then
        info "kind:          not installed"
    elif cluster_exists; then
        info "Cluster:       ${CLUSTER} (context ${CONTEXT})"
        kube -n "$NAMESPACE" get pods 2>&1 | sed 's/^/  /' >&2 || true
        kube -n planet-storage get pods 2>&1 | sed 's/^/  /' >&2 || true
    else
        info "Cluster:       not created"
    fi
    if pid="$(live_pid "$forward_pid" "dev-cluster.sh port-forward")"; then
        state="running (pid ${pid})"
    else
        state="not running"
    fi
    info "Port-forward:  ${state}; 127.0.0.1:${GATEWAY_PORT} $(port_open "$GATEWAY_PORT" && echo open || echo closed), 127.0.0.1:${S3_PORT} $(port_open "$S3_PORT" && echo open || echo closed)"
    if pid="$(live_pid "$server_pid" "serve-dist.mjs")"; then
        state="running (pid ${pid})"
    else
        state="not running"
    fi
    info "Site server:   ${state}; ${SITE_URL} $(site_answers && echo answers || echo "does not answer")"
    info "Credentials:   $([[ -f "$credentials" ]] && echo "$credentials" || echo none)"
    info "Demo data:     $([[ -f "$data_dir/manifest.json" ]] && echo "$data_dir" || echo "not generated")"
    info "Tool images:   $([[ -s "$images_file" ]] && echo "$(grep -Ecv '^[[:space:]]*(#|$)' "$images_file") listed in $images_file" || echo "none recorded")"
}

cmd_copy() {
    local label
    case "${1:-}" in
    token) label="Token" ;;
    access-key) label="Access key ID" ;;
    secret-key) label="Secret access key" ;;
    *) die "usage: $0 copy token|access-key|secret-key" ;;
    esac
    [[ -f "$credentials" ]] || die "no ${credentials}; run: $0 up"
    require pbcopy "macOS clipboard"
    local value
    value="$(sed -n "s/^  ${label}: //p" "$credentials")"
    [[ -n "$value" ]] || die "${label} is missing from ${credentials}"
    printf '%s' "$value" | pbcopy
    info "${label} copied to the clipboard"
}

cmd_rehearse() {
    forward_open || die "the port-forward is not running; run: $0 up"
    [[ -f "$data_dir/manifest.json" ]] || node "$scripts_dir/demo-data.mjs" --out "$data_dir"
    export PLANET_E2E_CLUSTER=1
    exec "$scripts_dir/e2e.sh" demo.spec.ts "$@"
}

main() {
    local command="${1:-}"
    (($#)) && shift
    case "$command" in
    up) cmd_up "$@" ;;
    down) cmd_down ;;
    status) cmd_status ;;
    copy) cmd_copy "$@" ;;
    rehearse) cmd_rehearse "$@" ;;
    -h | --help | help) usage ;;
    *)
        usage >&2
        exit 2
        ;;
    esac
}

main "$@"
