#!/bin/sh
# Renders the server templates for this namespace into /etc/nginx/conf.d and starts nginx.
# Arguments replace the default "-g 'daemon off;'", for example "-t" to test the configuration.
set -eu

case "${PLANET_NAMESPACE:-}" in
"" | *[!a-z0-9-]*)
    echo "start.sh: PLANET_NAMESPACE must be a namespace name, got '${PLANET_NAMESPACE:-}'" >&2
    exit 1
    ;;
esac

for template in /etc/nginx/planet/*.conf.template; do
    [ -f "$template" ] || continue
    # shellcheck disable=SC2016,SC2094 # The variable list is literal; input and output differ.
    envsubst '${PLANET_NAMESPACE}' <"$template" >"/etc/nginx/conf.d/$(basename "$template" .template)"
done

if [ "$#" -eq 0 ]; then
    set -- -g 'daemon off;'
fi
exec nginx -c /etc/nginx/planet/nginx.conf "$@"
