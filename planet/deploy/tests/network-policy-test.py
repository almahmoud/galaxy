#!/usr/bin/env python3
"""Renders the overlays with kubectl and checks which connections their NetworkPolicies admit.

ipBlock rules are matched against every address, pods and nodes included, as Calico and kindnet
do. Cilium never matches cluster pods or nodes with ipBlock rules, which only denies more.
Requires python3 3.10 or later and kubectl 1.30 or later; no cluster is contacted.
"""

import ipaddress
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import (
    dataclass,
    field,
)

DEPLOY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATEWAY_ACCESS = "planet.galaxyproject.org/gateway-access"
JOB_LABELS = {
    "batch.kubernetes.io/job-name": "planet-j1-1",
    "batch.kubernetes.io/controller-uid": "0b6f6f1e-0000-4000-8000-000000000001",
    "job-name": "planet-j1-1",
}

passed = 0
failed = 0


@dataclass
class Endpoint:
    """A pod (namespace set) or an address outside the cluster's pods (namespace None)."""

    ip: str
    namespace: str | None = None
    labels: dict = field(default_factory=dict)


def check(name: str, expected, actual) -> None:
    global passed, failed
    if actual == expected:
        passed += 1
        print(f"ok    {name}")
    else:
        failed += 1
        print(f"FAIL  {name}: expected [{expected}], got [{actual}]")


def kubectl(*args: str, stdin: str | None = None) -> str:
    env = dict(os.environ, KUBECONFIG=os.devnull)
    return subprocess.run(["kubectl", *args], input=stdin, capture_output=True, text=True, check=True, env=env).stdout


def render(directory: str) -> list[dict]:
    manifests = kubectl("kustomize", "--load-restrictor", "LoadRestrictionsNone", directory)
    # A local annotate converts the YAML stream to JSON without contacting a server.
    stream = kubectl("annotate", "--local", "--overwrite", "-f", "-", "-o", "json", "planet-test-", stdin=manifests)
    decoder = json.JSONDecoder()
    objects: list[dict] = []
    position = 0
    while True:
        while position < len(stream) and stream[position].isspace():
            position += 1
        if position == len(stream):
            return objects
        obj, position = decoder.raw_decode(stream, position)
        objects.extend(obj["items"] if obj.get("kind") == "List" else [obj])


def selects(selector: dict, labels: dict) -> bool:
    for key, value in (selector.get("matchLabels") or {}).items():
        if labels.get(key) != value:
            return False
    for expression in selector.get("matchExpressions") or []:
        key, operator, values = expression["key"], expression["operator"], expression.get("values") or []
        if operator == "In":
            matched = key in labels and labels[key] in values
        elif operator == "NotIn":
            matched = key not in labels or labels[key] not in values
        elif operator == "Exists":
            matched = key in labels
        elif operator == "DoesNotExist":
            matched = key not in labels
        else:
            raise ValueError(f"unknown operator {operator}")
        if not matched:
            return False
    return True


def ports_match(ports: list | None, port: int, protocol: str) -> bool:
    if not ports:
        return True
    for entry in ports:
        if entry.get("protocol", "TCP") != protocol:
            continue
        if "port" not in entry:
            return True
        number = entry["port"]
        if not isinstance(number, int):
            raise ValueError(f"named port {number} is not modelled")
        if number <= port <= entry.get("endPort", number):
            return True
    return False


def in_block(block: dict, ip: str) -> bool:
    address = ipaddress.ip_address(ip)
    if address not in ipaddress.ip_network(block["cidr"]):
        return False
    return not any(address in ipaddress.ip_network(cidr) for cidr in block.get("except") or [])


class Cluster:
    def __init__(self, objects: list[dict]):
        self.objects = objects
        self.policies = [o for o in objects if o["kind"] == "NetworkPolicy"]
        self.namespace_labels = {
            o["metadata"]["name"]: o["metadata"].get("labels") or {} for o in objects if o["kind"] == "Namespace"
        }

    def has(self, kind: str, name: str) -> bool:
        return any(o["kind"] == kind and o["metadata"]["name"] == name for o in self.objects)

    def deployment_pod(self, name: str, ip: str) -> Endpoint:
        deployment = next(o for o in self.objects if o["kind"] == "Deployment" and o["metadata"]["name"] == name)
        return Endpoint(ip, deployment["metadata"]["namespace"], deployment["spec"]["template"]["metadata"]["labels"])

    def labels_of(self, namespace: str, extra: dict | None = None) -> dict:
        labels = dict(self.namespace_labels.get(namespace, {}))
        labels.update(extra or {})
        labels["kubernetes.io/metadata.name"] = namespace
        return labels

    def admits(self, source: Endpoint, destination: Endpoint, port: int, protocol: str = "TCP") -> bool:
        return self._allowed(source, destination, port, protocol, "Egress") and self._allowed(
            destination, source, port, protocol, "Ingress"
        )

    def _allowed(self, subject: Endpoint, other: Endpoint, port: int, protocol: str, direction: str) -> bool:
        if subject.namespace is None:
            return True
        rules_key, peers_key = ("egress", "to") if direction == "Egress" else ("ingress", "from")
        selecting = [
            policy
            for policy in self.policies
            if policy["metadata"]["namespace"] == subject.namespace
            and direction in policy_types(policy)
            and selects(policy["spec"]["podSelector"], subject.labels)
        ]
        if not selecting:
            return True
        for policy in selecting:
            for rule in policy["spec"].get(rules_key) or []:
                peers = rule.get(peers_key)
                if peers and not any(
                    self._peer_matches(peer, other, policy["metadata"]["namespace"]) for peer in peers
                ):
                    continue
                if ports_match(rule.get("ports"), port, protocol):
                    return True
        return False

    def _peer_matches(self, peer: dict, other: Endpoint, policy_namespace: str) -> bool:
        if "ipBlock" in peer:
            return in_block(peer["ipBlock"], other.ip)
        if other.namespace is None:
            return False
        if "namespaceSelector" in peer:
            if not selects(peer["namespaceSelector"], self.labels_of(other.namespace)):
                return False
        elif other.namespace != policy_namespace:
            return False
        return selects(peer.get("podSelector") or {}, other.labels)


def policy_types(policy: dict) -> list[str]:
    spec = policy["spec"]
    return spec.get("policyTypes") or (["Ingress", "Egress"] if "egress" in spec else ["Ingress"])


def check_ip_blocks(name: str, cluster: Cluster) -> None:
    """The API server's own rules: canonical CIDRs, each exception strictly inside its block."""
    problems = []
    for policy in cluster.policies:
        for rule in (policy["spec"].get("egress") or []) + (policy["spec"].get("ingress") or []):
            for peer in rule.get("to") or rule.get("from") or []:
                block = peer.get("ipBlock")
                if not block:
                    continue
                network = ipaddress.ip_network(block["cidr"])
                if str(network) != block["cidr"]:
                    problems.append(block["cidr"])
                for cidr in block.get("except") or []:
                    excluded = ipaddress.ip_network(cidr)
                    if str(excluded) != cidr or excluded.version != network.version or excluded == network:
                        problems.append(cidr)
                    elif not excluded.subnet_of(network):
                        problems.append(cidr)
    check(f"{name}: ipBlock CIDRs valid", [], problems)


def check_cluster(name: str, cluster: Cluster) -> None:
    garage = cluster.has("Deployment", "garage")
    tunnel = cluster.has("Deployment", "cloudflared")
    private = cluster.has("NetworkPolicy", "planet-jobs-egress-private")

    job = Endpoint("10.244.1.10", "planet", JOB_LABELS)
    gateway = cluster.deployment_pod("planet-gateway", "10.244.1.20")
    other_planet_pod = Endpoint("10.244.1.30", "planet", {"app.kubernetes.io/name": "debug"})
    dns = Endpoint("10.244.0.2", "kube-system", {"k8s-app": "kube-dns"})
    metrics = Endpoint("10.244.0.3", "kube-system", {"k8s-app": "metrics-server"})
    tenant = Endpoint("10.244.2.10", "tenant-a", {"app": "web"})
    cluster.namespace_labels["ingress-system"] = {GATEWAY_ACCESS: "true"}
    ingress = Endpoint("10.244.3.10", "ingress-system", {"app.kubernetes.io/name": "envoy"})
    ingress_job = Endpoint("10.244.3.11", "ingress-system", {**JOB_LABELS, "app": "batch"})

    def admits(source, destination, port, protocol="TCP"):
        return "admitted" if cluster.admits(source, destination, port, protocol) else "denied"

    def external(ip):
        return Endpoint(ip)

    check_ip_blocks(name, cluster)

    # Job pod egress.
    check(f"{name}: job -> cluster DNS (UDP)", "admitted", admits(job, dns, 53, "UDP"))
    check(f"{name}: job -> cluster DNS (TCP)", "admitted", admits(job, dns, 53))
    check(f"{name}: job -> other kube-system pod", "denied", admits(job, metrics, 443))
    check(f"{name}: job -> private resolver", "denied", admits(job, external("10.0.0.10"), 53, "UDP"))
    check(f"{name}: job -> kubernetes Service address", "denied", admits(job, external("10.96.0.1"), 443))
    check(f"{name}: job -> API server on a node", "denied", admits(job, external("172.18.0.2"), 6443))
    check(f"{name}: job -> kubelet", "denied", admits(job, external("192.168.10.5"), 10250))
    check(f"{name}: job -> CGNAT range pod", "denied", admits(job, external("100.64.3.4"), 8080))
    for ip in ("169.254.169.254", "169.254.170.2", "169.254.169.252", "168.63.129.16", "100.100.100.200"):
        check(f"{name}: job -> metadata {ip}", "denied", admits(job, external(ip), 80))
    for ip in ("fd00:ec2::254", "fd20:ce::254", "fe80::1", "fd12:3456::10"):
        check(f"{name}: job -> {ip}", "denied", admits(job, external(ip), 80))
    for ip in ("104.18.2.3", "52.216.8.9", "2606:4700::6810:203"):
        check(f"{name}: job -> public S3 {ip}", "admitted", admits(job, external(ip), 443))
    check(f"{name}: job -> gateway", "denied", admits(job, gateway, 8080))
    check(f"{name}: job -> tenant pod", "denied", admits(job, tenant, 8080))

    # Gateway ingress.
    check(f"{name}: tenant -> gateway", "denied", admits(tenant, gateway, 8080))
    check(f"{name}: other pod in planet -> gateway", "denied", admits(other_planet_pod, gateway, 8080))
    check(f"{name}: labelled namespace -> gateway", "admitted", admits(ingress, gateway, 8080))
    check(f"{name}: Job pod in labelled namespace -> gateway", "denied", admits(ingress_job, gateway, 8080))
    check(f"{name}: labelled namespace -> gateway health port", "denied", admits(ingress, gateway, 8090))
    check(f"{name}: host or outside address -> gateway", "denied", admits(external("172.18.0.2"), gateway, 8080))
    check(f"{name}: tenant -> job pod", "denied", admits(tenant, job, 8080))

    # S3 listener and Garage.
    s3_listener = "admitted" if garage else "denied"
    check(f"{name}: labelled namespace -> S3 listener", s3_listener, admits(ingress, gateway, 8081))
    check(f"{name}: tenant -> S3 listener", "denied", admits(tenant, gateway, 8081))
    check(f"{name}: job -> S3 listener", "denied", admits(job, gateway, 8081))
    if garage:
        garage_pod = cluster.deployment_pod("garage", "10.244.5.10")
        check(f"{name}: job -> Garage S3", "admitted", admits(job, garage_pod, 3900))
        check(f"{name}: job -> Garage admin", "denied", admits(job, garage_pod, 3903))
        check(f"{name}: gateway -> Garage S3", "admitted", admits(gateway, garage_pod, 3900))
        check(f"{name}: tenant -> Garage S3", "denied", admits(tenant, garage_pod, 3900))

    # Cloudflare Tunnel.
    if tunnel:
        cloudflared = cluster.deployment_pod("cloudflared", "10.244.4.10")
        edge_other = Endpoint("10.244.4.11", "planet-edge", {"app.kubernetes.io/name": "debug"})
        check(f"{name}: cloudflared -> gateway", "admitted", admits(cloudflared, gateway, 8080))
        check(f"{name}: cloudflared -> S3 listener", s3_listener, admits(cloudflared, gateway, 8081))
        check(f"{name}: other pod in planet-edge -> gateway", "denied", admits(edge_other, gateway, 8080))
    else:
        lookalike = Endpoint("10.244.4.10", "planet-edge", {"app.kubernetes.io/name": "cloudflared"})
        check(f"{name}: planet-edge without the component -> gateway", "denied", admits(lookalike, gateway, 8080))

    # overlays/example/egress-private.yaml and cluster-ranges.yaml.
    if private:
        check(f"{name}: job -> admitted private endpoint", "admitted", admits(job, external("10.20.0.15"), 443))
        check(
            f"{name}: job -> admitted private endpoint, other port", "denied", admits(job, external("10.20.0.15"), 80)
        )
        check(f"{name}: job -> neighbouring private address", "denied", admits(job, external("10.20.0.16"), 443))
        check(f"{name}: job -> added IPv4 cluster range", "denied", admits(job, external("203.0.113.7"), 443))
        check(f"{name}: job -> added IPv6 cluster range", "denied", admits(job, external("2001:db8::7"), 443))


def main() -> int:
    deploy = os.path.realpath(DEPLOY_DIR)
    with tempfile.TemporaryDirectory() as temporary:
        work = os.path.realpath(temporary)

        def overlay(name: str, kustomization: dict) -> str:
            directory = os.path.join(work, name)
            os.makedirs(directory)
            header = {"apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization"}
            with open(os.path.join(directory, "kustomization.yaml"), "w") as handle:
                json.dump({**header, **kustomization}, handle)
            return directory

        def path(*parts: str) -> str:
            # Relative to an overlay directly under work: kustomize refuses absolute kustomization paths.
            return os.path.relpath(os.path.join(deploy, *parts), os.path.join(work, "overlay"))

        configurations = {
            "local": os.path.join(deploy, "overlays", "local"),
            "example": os.path.join(deploy, "overlays", "example"),
            "local+tunnel": overlay(
                "local-tunnel",
                {"resources": [path("overlays", "local")], "components": [path("components", "cloudflare-tunnel")]},
            ),
            "example+tunnel+egress": overlay(
                "example-extras",
                {
                    "resources": [path("overlays", "example"), path("overlays", "example", "egress-private.yaml")],
                    "components": [path("components", "cloudflare-tunnel")],
                    "patches": [
                        {
                            "path": path("overlays", "example", "cluster-ranges.yaml"),
                            "target": {"kind": "NetworkPolicy", "name": "planet-jobs-egress"},
                        }
                    ],
                },
            ),
        }
        for name, directory in configurations.items():
            print(f"-- {name}")
            check_cluster(name, Cluster(render(directory)))

    print()
    print(f"{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
