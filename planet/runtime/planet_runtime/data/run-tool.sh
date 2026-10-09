#!/bin/sh
# Entry point of the tool container; runs as PID 1 of its PID namespace.
# Every process it starts inherits the write end of the "alive" FIFO, so the
# stage-out container sees POLLHUP once all of them are gone, however they end.
# The walltime is enforced here; activeDeadlineSeconds is only a backstop.
C=${ctl}
exec 9<>"$$C/alive"
: > "$$C/started"
trap 'kill -TERM -1 2>/dev/null' TERM INT

: "$${GALAXY_SLOTS:=${slots}}"
export GALAXY_SLOTS
if [ -z "$${GALAXY_MEMORY_MB:-}" ] && [ -n "${memory_mb}" ]; then
    GALAXY_MEMORY_MB=${memory_mb}
    export GALAXY_MEMORY_MB
fi
walltime="$${PLANET_WALLTIME_SECONDS:-${walltime}}"

(
    trap '' TERM INT
    exec 9>&-
    sleep "$$walltime" && : > "$$C/walltime" && kill -TERM -1 2>/dev/null
    sleep ${grace}
    kill -KILL -1 2>/dev/null
) &

${shell} ${job_script} &
child=$$!
while :; do
    wait "$$child"
    rc=$$?
    kill -0 "$$child" 2>/dev/null || break
done
echo "$$rc" > "$$C/rc.tmp" && mv "$$C/rc.tmp" "$$C/rc"
exit 0
