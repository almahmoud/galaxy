/**
 * TCP relay for the cluster tests (PLANET_E2E_CLUSTER=1). Pages in the Playwright container call the gateway at
 * http://127.0.0.1:8001 and the S3 listener at http://127.0.0.1:8002, the addresses a user's browser uses with
 * `dev-cluster.sh port-forward`; this relay forwards those ports to the port-forward listeners on the Docker host.
 *
 * Usage: node cluster-relay.mjs [port...]   (default 8001 8002; upstream host PLANET_E2E_RELAY_HOST)
 */
import { createConnection, createServer } from "node:net";

const upstreamHost = process.env.PLANET_E2E_RELAY_HOST || "host.docker.internal";
const ports = (process.argv.length > 2 ? process.argv.slice(2) : ["8001", "8002"]).map(Number);

for (const port of ports) {
    const server = createServer((client) => {
        const upstream = createConnection({ host: upstreamHost, port });
        const close = () => {
            client.destroy();
            upstream.destroy();
        };
        client.on("error", close).on("close", close);
        upstream.on("error", close).on("close", close);
        client.pipe(upstream).pipe(client);
    });
    server.on("error", (error) => {
        console.error(`relay: cannot listen on 127.0.0.1:${port}: ${error.message}`);
        process.exit(1);
    });
    server.listen(port, "127.0.0.1", () => console.log(`relay: 127.0.0.1:${port} -> ${upstreamHost}:${port}`));
}
