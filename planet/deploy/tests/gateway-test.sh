#!/usr/bin/env bash
# Runs the gateway configuration in Docker against a stub Kubernetes API server and a real
# Garage, and checks CORS, the route allow-list, header stripping, DELETE handling, rate
# limiting and the S3 listener. Requires docker, openssl, python3 and curl 7.75 or later.
# Containers and the network are removed on exit; pulled images are kept.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_IMAGE="$(sed -n 's|^ *image: \(nginxinc/nginx-unprivileged:.*\)$|\1|p' "$DEPLOY_DIR/base/gateway.yaml")"
GARAGE_IMAGE="$(sed -n 's|^ *image: \(dxflrs/garage:.*\)$|\1|p' "$DEPLOY_DIR/components/garage/garage.yaml")"
ORIGIN="http://localhost:8787"
TOKEN="Bearer test-token"

run_id="planet-gw-test-$$"
work="$(mktemp -d)"
passed=0
failed=0

cleanup() {
    docker rm -f "$run_id-gateway" "$run_id-kube" "$run_id-garage" >/dev/null 2>&1 || true
    docker network rm "$run_id" >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

check() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        passed=$((passed + 1))
        echo "ok    $name"
    else
        failed=$((failed + 1))
        echo "FAIL  $name: expected [$expected], got [$actual]"
    fi
}

check_contains() {
    local name="$1" needle="$2" haystack="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        passed=$((passed + 1))
        echo "ok    $name"
    else
        failed=$((failed + 1))
        echo "FAIL  $name: [$needle] not in [$haystack]"
    fi
}

# request <curl args...>: prints the status code; headers and body go to $work.
request() {
    curl -s --path-as-is -o "$work/body" -D "$work/headers" -w '%{http_code}' "$@"
}

header() {
    { grep -i "^$1:" "$work/headers" || true; } | head -n 1 | cut -d' ' -f2- | tr -d '\r'
}

header_count() {
    grep -ci "^$1:" "$work/headers" || true
}

upstream() {
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$work/body" "$1"
}

echo "nginx:  $NGINX_IMAGE"
echo "garage: $GARAGE_IMAGE"

# Stub API server certificate, signed by a throwaway CA.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=planet-test-ca" \
    -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=kubernetes" \
    -keyout "$work/server.key" -out "$work/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:kubernetes.default.svc\nextendedKeyUsage=serverAuth\n' >"$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
    -days 1 -extfile "$work/server.ext" -out "$work/server.crt" 2>/dev/null
chmod 644 "$work/server.key"

mkdir -p "$work/stub" "$work/config"
cp "$work/server.crt" "$work/server.key" "$work/stub/"
cat >"$work/stub/nginx.conf" <<'EOF'
pid /tmp/nginx.pid;
events {}
http {
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    server {
        listen 443 ssl;
        ssl_certificate /stub/server.crt;
        ssl_certificate_key /stub/server.key;
        location / {
            default_type application/json;
            add_header Access-Control-Allow-Origin "https://evil.example" always;
            add_header Warning '299 - "stub warning"' always;
            return 200 '{"method":"$request_method","uri":"$request_uri","host":"$host","authorization":"$http_authorization","impersonate_user":"$http_impersonate_user","impersonate_group":"$http_impersonate_group","cookie":"$http_cookie","origin":"$http_origin","content_length":"$http_content_length"}';
        }
    }
}
EOF

cp "$DEPLOY_DIR/base/gateway/nginx.conf" "$DEPLOY_DIR/base/gateway/kube-api.conf.template" \
    "$DEPLOY_DIR/base/gateway/start.sh" "$DEPLOY_DIR/overlays/local/allowed-origins.map" \
    "$DEPLOY_DIR/components/garage/s3.conf.template" "$work/config/"

garage_key="GK$(openssl rand -hex 12)"
garage_secret="$(openssl rand -hex 32)"

docker network create "$run_id" >/dev/null
docker run -d --name "$run_id-kube" --network "$run_id" --network-alias kubernetes.default.svc \
    --sysctl net.ipv4.ip_unprivileged_port_start=0 --read-only --tmpfs /tmp \
    -v "$work/stub:/stub:ro" "$NGINX_IMAGE" nginx -c /stub/nginx.conf -g 'daemon off;' >/dev/null
docker run -d --name "$run_id-garage" --network "$run_id" --network-alias garage.planet-storage.svc \
    --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /var/lib/garage:uid=1000,gid=1000,mode=0700 \
    -v "$DEPLOY_DIR/components/garage/garage.toml:/etc/garage/garage.toml:ro" \
    -e GARAGE_CONFIG_FILE=/etc/garage/garage.toml -e GARAGE_DEFAULT_BUCKET=planet \
    -e GARAGE_RPC_SECRET="$(openssl rand -hex 32)" \
    -e GARAGE_DEFAULT_ACCESS_KEY="$garage_key" -e GARAGE_DEFAULT_SECRET_KEY="$garage_secret" \
    --entrypoint /garage "$GARAGE_IMAGE" server --single-node --default-bucket >/dev/null

gateway_args=(--network "$run_id" --user 101:101 --read-only --cap-drop ALL
    --security-opt no-new-privileges --tmpfs /tmp --tmpfs /etc/nginx/conf.d:mode=1777
    -e PLANET_NAMESPACE=planet
    -v "$work/config:/etc/nginx/planet:ro" -v "$work/ca.crt:/etc/planet/kube-ca/ca.crt:ro"
    --entrypoint /bin/sh)

syntax="$(docker run --rm "${gateway_args[@]}" "$NGINX_IMAGE" /etc/nginx/planet/start.sh -t 2>&1 || true)"
check_contains "nginx -t accepts the configuration" "test is successful" "$syntax"
bad_ns="$(docker run --rm "${gateway_args[@]}" -e 'PLANET_NAMESPACE=x/../y' "$NGINX_IMAGE" \
    /etc/nginx/planet/start.sh -t 2>&1 || true)"
check_contains "start.sh rejects an invalid namespace" "must be a namespace name" "$bad_ns"

docker run -d --name "$run_id-gateway" "${gateway_args[@]}" \
    -p 127.0.0.1::8080 -p 127.0.0.1::8081 -p 127.0.0.1::8090 \
    "$NGINX_IMAGE" /etc/nginx/planet/start.sh >/dev/null
api="http://$(docker port "$run_id-gateway" 8080/tcp | head -n 1)"
s3="http://$(docker port "$run_id-gateway" 8081/tcp | head -n 1)"
health="http://$(docker port "$run_id-gateway" 8090/tcp | head -n 1)"

for _ in $(seq 1 50); do
    curl -sf "$health/healthz" >/dev/null 2>&1 && break
    sleep 0.2
done
check "health endpoint" 200 "$(request "$health/healthz")"

echo "-- Kubernetes API listener"
check "preflight from an allowed origin" 204 "$(request -X OPTIONS -H "Origin: $ORIGIN" \
    -H "Access-Control-Request-Method: DELETE" -H "Access-Control-Request-Headers: authorization" \
    "$api/apis/batch/v1/namespaces/planet/jobs/x")"
check "preflight Allow-Origin" "$ORIGIN" "$(header Access-Control-Allow-Origin)"
check "preflight Allow-Methods" "GET, POST, DELETE" "$(header Access-Control-Allow-Methods)"
check "preflight Allow-Headers" "Authorization, Content-Type, Accept" "$(header Access-Control-Allow-Headers)"
check "preflight Max-Age" 7200 "$(header Access-Control-Max-Age)"
check "preflight Vary" Origin "$(header Vary)"

check "preflight from another origin" 403 "$(request -X OPTIONS -H "Origin: https://evil.example" \
    -H "Access-Control-Request-Method: GET" "$api/version")"
check "no Allow-Origin for another origin" "" "$(header Access-Control-Allow-Origin)"
check "GET from another origin" 403 "$(request -H "Origin: https://evil.example" "$api/version")"
check "origin null" 403 "$(request -H "Origin: null" "$api/version")"

check "GET /version" 200 "$(request -H "Origin: $ORIGIN" -H "Authorization: $TOKEN" "$api/version")"
check "single Allow-Origin, upstream value hidden" "1 $ORIGIN" \
    "$(header_count Access-Control-Allow-Origin) $(header Access-Control-Allow-Origin)"
check "Expose-Headers" "Date, Warning, Audit-Id, Retry-After" "$(header Access-Control-Expose-Headers)"
check "no preflight headers on simple responses" "" "$(header Access-Control-Allow-Methods)"
check_contains "Warning passed through" "stub warning" "$(header Warning)"
check "bearer token forwarded" "$TOKEN" "$(upstream authorization)"
check "upstream Host" kubernetes.default.svc "$(upstream host)"
check "Origin removed upstream" "" "$(upstream origin)"
check "GET /version without Origin" 200 "$(request "$api/version")"
check "no Allow-Origin without Origin" "" "$(header Access-Control-Allow-Origin)"

check "POST selfsubjectrulesreviews" 200 "$(request -X POST -H "Content-Type: application/json" \
    -d '{}' "$api/apis/authorization.k8s.io/v1/selfsubjectrulesreviews")"
check "list jobs with query" 200 "$(request "$api/apis/batch/v1/namespaces/planet/jobs?labelSelector=a%3Db&watch=1")"
check "query string forwarded" "/apis/batch/v1/namespaces/planet/jobs?labelSelector=a%3Db&watch=1" "$(upstream uri)"
check "POST job" 200 "$(request -X POST -H "Content-Type: application/json" -H "Impersonate-User: admin" \
    -H "Impersonate-Group: system:masters" -H "Cookie: a=b" -d '{"kind":"Job"}' \
    "$api/apis/batch/v1/namespaces/planet/jobs")"
check "Impersonate-User stripped" "" "$(upstream impersonate_user)"
check "Impersonate-Group stripped" "" "$(upstream impersonate_group)"
check "Cookie stripped" "" "$(upstream cookie)"
check "request body length forwarded" 14 "$(upstream content_length)"
check "GET job" 200 "$(request "$api/apis/batch/v1/namespaces/planet/jobs/planet-ab12cd34-1-a1")"
check "GET pod" 200 "$(request "$api/api/v1/namespaces/planet/pods/planet-ab12cd34-1-a1-x7k2p")"
check "GET pod log" 200 "$(request "$api/api/v1/namespaces/planet/pods/p-1/log?container=tool&follow=true")"
check "list pods" 200 "$(request "$api/api/v1/namespaces/planet/pods?labelSelector=x")"
check "list events" 200 "$(request "$api/api/v1/namespaces/planet/events?fieldSelector=involvedObject.name%3Dj")"

check "DELETE job" 200 "$(request -X DELETE "$api/apis/batch/v1/namespaces/planet/jobs/j-1?propagationPolicy=Orphan")"
check "DELETE forces Background propagation" \
    "DELETE /apis/batch/v1/namespaces/planet/jobs/j-1?propagationPolicy=Background" \
    "$(upstream method) $(upstream uri)"
check "DELETE with a body" 400 "$(request -X DELETE -H "Content-Type: application/json" \
    -d '{"propagationPolicy":"Orphan"}' "$api/apis/batch/v1/namespaces/planet/jobs/j-1")"
check "DELETE with a chunked body" 400 "$(request -X DELETE -H "Transfer-Encoding: chunked" \
    -d 'x' "$api/apis/batch/v1/namespaces/planet/jobs/j-1")"
check "DELETE with an empty body" 200 "$(request -X DELETE -H "Content-Length: 0" \
    "$api/apis/batch/v1/namespaces/planet/jobs/j-1")"

check "dot segments resolved before matching" 200 "$(request "$api/api/v1/namespaces/planet/pods/a/../b")"
check "normalized path forwarded" "/api/v1/namespaces/planet/pods/b" "$(upstream uri)"
check "merged slashes" 200 "$(request "$api//api/v1//namespaces/planet/pods")"
check "merged path forwarded" "/api/v1/namespaces/planet/pods" "$(upstream uri)"
for path in \
    "/api/v1/namespaces/kube-system/pods" \
    "/api/v1/namespaces/planet/secrets" \
    "/api/v1/namespaces/planet/configmaps/kube-root-ca.crt" \
    "/api/v1/namespaces/planet/pods/p-1/exec" \
    "/api/v1/namespaces/planet/pods/p-1/attach" \
    "/api/v1/namespaces/planet/pods/%2e%2e/%2e%2e/kube-system/secrets" \
    "/api/v1/namespaces/planet/pods/a%2f..%2f..%2fsecrets" \
    "/apis/batch/v1/namespaces/planet/jobs/UPPER" \
    "/apis/batch/v1/namespaces/planet/jobs/j-1/status" \
    "/apis/batch/v1/jobs" \
    "/apis/rbac.authorization.k8s.io/v1/clusterroles" \
    "/healthz" \
    "/"; do
    check "GET $path denied" 403 "$(request "$api$path")"
done
check "POST pod denied" 403 "$(request -X POST -d '{}' "$api/api/v1/namespaces/planet/pods")"
check "PUT job denied" 403 "$(request -X PUT -d '{}' "$api/apis/batch/v1/namespaces/planet/jobs/j-1")"
check "PATCH job denied" 403 "$(request -X PATCH -d '{}' "$api/apis/batch/v1/namespaces/planet/jobs/j-1")"
check "DELETE pod denied" 403 "$(request -X DELETE "$api/api/v1/namespaces/planet/pods/p-1")"
check "DELETE job collection denied" 403 "$(request -X DELETE "$api/apis/batch/v1/namespaces/planet/jobs")"
check "denial is a Kubernetes Status" Forbidden "$(upstream reason)"
check "denial carries Allow-Origin" "$ORIGIN" "$(request -H "Origin: $ORIGIN" "$api/api/v1/namespaces/planet/secrets" >/dev/null
    header Access-Control-Allow-Origin)"
check "insecureSkipTLSVerifyBackend rejected" 403 \
    "$(request "$api/api/v1/namespaces/planet/pods/p-1/log?insecureSkipTLSVerifyBackend=true")"
check "encoded parameter name rejected" 403 \
    "$(request "$api/api/v1/namespaces/planet/pods/p-1/log?insecureSkipTLSVerify%42ackend=true")"
check "bare insecureSkipTLSVerifyBackend rejected" 403 \
    "$(request "$api/api/v1/namespaces/planet/pods/p-1/log?container=tool&insecureSkipTLSVerifyBackend")"
check "oversized body rejected" 413 "$(head -c 1100000 /dev/zero | request -X POST --data-binary @- \
    "$api/apis/batch/v1/namespaces/planet/jobs")"

echo "-- S3 listener"
check "S3 preflight" 204 "$(request -X OPTIONS -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: PUT" \
    -H "Access-Control-Request-Headers: authorization,x-amz-date,x-amz-content-sha256" "$s3/planet/a")"
check "S3 preflight Allow-Methods" "GET, PUT, POST, DELETE, HEAD" "$(header Access-Control-Allow-Methods)"
check_contains "S3 preflight Allow-Headers" "X-Amz-Content-Sha256" "$(header Access-Control-Allow-Headers)"
check "S3 preflight from another origin" 403 "$(request -X OPTIONS -H "Origin: https://evil.example" \
    -H "Access-Control-Request-Method: PUT" "$s3/planet/a")"

for _ in $(seq 1 50); do
    [[ "$(request "$s3/planet")" != 502 ]] && break
    sleep 0.2
done
check "unsigned request reaches Garage and is refused" 403 \
    "$(request -H "Origin: $ORIGIN" "$s3/planet/x?X-Amz-Signature=do-not-log")"
check "S3 error carries Allow-Origin" "$ORIGIN" "$(header Access-Control-Allow-Origin)"

sigv4=(--aws-sigv4 "aws:amz:garage:s3" --user "$garage_key:$garage_secret" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD")
head -c 6291456 /dev/urandom >"$work/object"
check "signed PUT through the gateway, Origin signed (6 MiB)" 200 "$(request "${sigv4[@]}" -H "Origin: $ORIGIN" \
    -X PUT --data-binary @"$work/object" "$s3/planet/test/object")"
check_contains "ETag exposed" ETag "$(header Access-Control-Expose-Headers)"
etag="$(header ETag)"
check_contains "PUT returned an ETag" '"' "$etag"
check "signed GET returns the object" "$(shasum -a 256 <"$work/object")" \
    "$(curl -s "${sigv4[@]}" "$s3/planet/test/object" | shasum -a 256)"
check "signed ranged GET" 206 "$(request "${sigv4[@]}" -H "Range: bytes=0-9" "$s3/planet/test/object")"
check "Content-Range" "bytes 0-9/6291456" "$(header Content-Range)"
check "signed HEAD ETag" "$etag" "$(request "${sigv4[@]}" -I "$s3/planet/test/object" >/dev/null
    header ETag)"
check "signed DELETE" 204 "$(request "${sigv4[@]}" -X DELETE "$s3/planet/test/object")"

logs="$(docker logs "$run_id-gateway" 2>&1)"
if [[ "$logs" == *do-not-log* ]]; then
    check "query strings kept out of the access log" absent present
else
    check "query strings kept out of the access log" absent absent
fi

echo "-- Limits and upstream failure"
codes="$(seq 1 120 | xargs -P 40 -I{} curl -s -o /dev/null -w '%{http_code}\n' "$api/version" | sort | uniq -c)"
check_contains "burst beyond the rate limit gets 429" 429 "$codes"
sleep 3
docker stop "$run_id-kube" >/dev/null
check "unreachable API server" 503 "$(request "$api/version")"
check "unreachable API server Status reason" ServiceUnavailable "$(upstream reason)"

echo
echo "$passed passed, $failed failed"
[[ "$failed" -eq 0 ]]
