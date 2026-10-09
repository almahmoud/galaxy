#!/bin/sh
# Runs the tool container protocol with Docker: stage-in prepares a shared
# volume, the generated run-tool wrapper runs as PID 1 of a busybox container,
# and `planet-stager wait` waits for the alive FIFO in a planet-runtime
# container, as stage-out does in a pod.
#
# Usage, from the repository root:
#   planet/runtime/tests/integration/run-tool.sh [RUNTIME_IMAGE] [TOOL_IMAGE]
set -eu

RUNTIME_IMAGE=${1:-planet-runtime:dev}
TOOL_IMAGE=${2:-busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e}
PREFIX="planet-run-tool-test-$$"
failures=0

cleanup() {
    for name in $(docker ps -aq --filter "name=$PREFIX"); do docker rm -f "$name" >/dev/null 2>&1 || true; done
    for volume in $(docker volume ls -q --filter "name=$PREFIX"); do docker volume rm "$volume" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT INT TERM

# run_case NAME COMMAND WALLTIME EXPECTED_TERMINATION EXPECTED_EXIT_CODE [kill]
run_case() {
    name=$1 command=$2 walltime=$3 expected_termination=$4 expected_exit=$5 mode=${6:-}
    volume="$PREFIX-$name"
    docker volume create "$volume" >/dev/null
    docker run --rm -u 0 -v "$volume:/planet" --entrypoint /bin/sh "$RUNTIME_IMAGE" -c 'chown 10001:10001 /planet'

    manifest=$(cat <<EOF
{"protocol": 1, "kind": "tool",
 "job": {"id": "t1", "walltime_seconds": $walltime, "slots": 2, "shell": "/bin/sh"},
 "tool": {"id": "busybox_test", "profile": "21.01", "command": $(printf '%s' "$command" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
          "inputs": [], "outputs": {"out": {"model_class": "ToolOutput", "name": "out", "format": "txt"}}},
 "params": {}, "inputs": {},
 "outputs": [{"name": "out", "uuid": "00000000-0000-4000-8000-000000000001"}]}
EOF
)
    printf '%s' "$manifest" | docker run --rm -i -v "$volume:/planet" -e PLANET_TERMINATION_LOG=/planet/stage-in.log \
        --entrypoint /bin/sh "$RUNTIME_IMAGE" -c 'cat > /planet/manifest.json && PLANET_MANIFEST_FILE=/planet/manifest.json planet-stager in 2>/dev/null'

    docker run -d --name "$PREFIX-wait-$name" -v "$volume:/planet" "$RUNTIME_IMAGE" \
        planet-stager wait --id-tag t1 >/dev/null
    started=$(date +%s)
    if [ "$mode" = kill ]; then
        docker run -d --name "$PREFIX-tool-$name" -u 10001:10001 -w /planet/job/working \
            -v "$volume:/planet" "$TOOL_IMAGE" /bin/sh /planet/bin/run-tool >/dev/null
        sleep 2
        docker kill --signal KILL "$PREFIX-tool-$name" >/dev/null
    else
        docker run --rm --name "$PREFIX-tool-$name" -u 10001:10001 -w /planet/job/working \
            -v "$volume:/planet" "$TOOL_IMAGE" /bin/sh /planet/bin/run-tool
    fi
    docker wait "$PREFIX-wait-$name" >/dev/null
    elapsed=$(($(date +%s) - started))
    result=$(docker logs "$PREFIX-wait-$name" 2>/dev/null | tail -n 1)
    stdout=$(docker run --rm -v "$volume:/planet" --entrypoint /bin/cat "$RUNTIME_IMAGE" /planet/job/outputs/tool_stdout)

    actual=$(printf '%s' "$result" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["termination"], r["exit_code"])')
    if [ "$actual" = "$expected_termination $expected_exit" ]; then
        echo "ok   $name: $actual after ${elapsed}s; tool stdout: $(printf '%s' "$stdout" | head -n 1)"
    else
        echo "FAIL $name: expected '$expected_termination $expected_exit', got '$actual' ($result)"
        failures=$((failures + 1))
    fi
    docker rm -f "$PREFIX-wait-$name" "$PREFIX-tool-$name" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null
}

run_case normal 'echo hello; (sleep 1; echo late) & wait' 60 normal 0
run_case failure 'echo failing; exit 3' 60 normal 3
run_case walltime 'echo started; sleep 300' 2 walltime 143
run_case killed 'echo started; sleep 300' 60 signal None kill

if [ "$failures" -ne 0 ]; then
    echo "$failures case(s) failed"
    exit 1
fi
echo "all cases passed"
