import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DOCKER_HUB_CONFIG_KEY,
  mergeRegistryLogins,
  mirrorUrlToHostPort,
  mergeDockerDaemonJson,
  rewriteGhcrImageRefs,
  rewriteHubImageRefs,
  shouldSkipGhcrRewrite,
  shouldSkipHubRewrite,
  insecureRegistryHostsFromDockerInfo,
  isMirrorHostAllowed,
  isHubRegistryMirrorConfigured,
  registryMirrorsFromDockerInfo
} from "./docker-registry-mirror.js";

describe("mirrorUrlToHostPort", () => {
  it("strips scheme and trailing slash", () => {
    assert.equal(mirrorUrlToHostPort("http://10.0.0.5:5001/"), "10.0.0.5:5001");
    assert.equal(mirrorUrlToHostPort("https://registry.example.com:443"), "registry.example.com:443");
  });
});

describe("mergeDockerDaemonJson", () => {
  it("adds Hub registry-mirrors and insecure-registries for HTTP mirrors", () => {
    const { content, changed } = mergeDockerDaemonJson({
      existingJson: "{}",
      hubMirrorUrl: "http://10.0.0.5:5000",
      ghcrMirrorUrl: "http://10.0.0.5:5001"
    });
    const parsed = JSON.parse(content);
    assert.equal(changed, true);
    assert.deepEqual(parsed["registry-mirrors"], ["http://10.0.0.5:5000"]);
    assert.ok(parsed["insecure-registries"].includes("10.0.0.5:5000"));
    assert.ok(parsed["insecure-registries"].includes("10.0.0.5:5001"));
  });

  it("is idempotent when mirrors already configured", () => {
    const first = mergeDockerDaemonJson({
      existingJson: "{}",
      hubMirrorUrl: "http://10.0.0.5:5000",
      ghcrMirrorUrl: "http://10.0.0.5:5001"
    });
    const second = mergeDockerDaemonJson({
      existingJson: first.content,
      hubMirrorUrl: "http://10.0.0.5:5000",
      ghcrMirrorUrl: "http://10.0.0.5:5001"
    });
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
  });

  it("preserves unrelated daemon.json keys", () => {
    const { content } = mergeDockerDaemonJson({
      existingJson: JSON.stringify({ "log-driver": "json-file", "registry-mirrors": ["http://old:5000"] }),
      hubMirrorUrl: "http://10.0.0.5:5000"
    });
    const parsed = JSON.parse(content);
    assert.equal(parsed["log-driver"], "json-file");
    assert.deepEqual(parsed["registry-mirrors"], ["http://10.0.0.5:5000"]);
  });
});

describe("rewriteGhcrImageRefs", () => {
  it("rewrites ghcr.io image refs to the mirror host:port", () => {
    const input = `
services:
  api:
    image: ghcr.io/kumpedns/kumpedns-backend:latest
  nebula_client:
    image: ghcr.io/kumpeapps/managed-nebula/client:kumpeapps
`;
    const { content, rewrittenCount } = rewriteGhcrImageRefs(input, "10.0.0.5:5001");
    assert.equal(rewrittenCount, 2);
    assert.match(content, /image:\s*10\.0\.0\.5:5001\/kumpedns\/kumpedns-backend:latest/);
    assert.match(content, /image:\s*10\.0\.0\.5:5001\/kumpeapps\/managed-nebula\/client:kumpeapps/);
    assert.equal(content.includes("ghcr.io/"), false);
  });

  it("leaves non-ghcr images untouched", () => {
    const input = "services:\n  db:\n    image: busybox:1.36\n";
    const { content, rewrittenCount } = rewriteGhcrImageRefs(input, "10.0.0.5:5001");
    assert.equal(rewrittenCount, 0);
    assert.match(content, /busybox:1\.36/);
  });
});

describe("rewriteHubImageRefs", () => {
  it("rewrites official and namespaced Hub images through the Hub cache", () => {
    const input = `
services:
  init:
    image: busybox:1.36
  app:
    image: myuser/myapp:1.2.3
  explicit:
    image: docker.io/library/nginx:alpine
`;
    const { content, rewrittenCount } = rewriteHubImageRefs(input, "10.0.0.5:5000");
    assert.equal(rewrittenCount, 3);
    assert.match(content, /image:\s*10\.0\.0\.5:5000\/library\/busybox:1\.36/);
    assert.match(content, /image:\s*10\.0\.0\.5:5000\/myuser\/myapp:1\.2\.3/);
    assert.match(content, /image:\s*10\.0\.0\.5:5000\/library\/nginx:alpine/);
  });

  it("does not rewrite ghcr or already-mirrored host:port images", () => {
    const input = `
services:
  a:
    image: ghcr.io/org/img:latest
  b:
    image: 10.0.0.5:5001/org/img:latest
  c:
    image: quay.io/org/img:latest
`;
    const { content, rewrittenCount } = rewriteHubImageRefs(input, "10.0.0.5:5000");
    assert.equal(rewrittenCount, 0);
    assert.match(content, /ghcr\.io\/org\/img:latest/);
    assert.match(content, /10\.0\.0\.5:5001\/org\/img:latest/);
    assert.match(content, /quay\.io\/org\/img:latest/);
  });
});

describe("mergeRegistryLogins", () => {
  it("uses bot defaults then lets deploy overrides win per registry", () => {
    const merged = mergeRegistryLogins({
      botDefaults: [
        { registry: "docker.io", username: "bot-hub", password: "hub-token" },
        { registry: "ghcr.io", username: "bot-ghcr", password: "ghcr-token" }
      ],
      deployOverrides: [{ registry: "ghcr.io", username: "app", password: "app-token" }]
    });
    const byKey = Object.fromEntries(merged.map((l) => [l.registry, l]));
    assert.equal(byKey[DOCKER_HUB_CONFIG_KEY]?.username, "bot-hub");
    assert.equal(byKey["ghcr.io"]?.username, "app");
    assert.equal(byKey["ghcr.io"]?.password, "app-token");
  });

  it("reports which registries were overridden by deploy config", () => {
    const result = mergeRegistryLogins({
      botDefaults: [{ registry: "ghcr.io", username: "bot", password: "b" }],
      deployOverrides: [{ registry: "https://ghcr.io", username: "app", password: "a" }]
    });
    assert.ok(result.some((l) => l.registry === "ghcr.io" && l.overridden));
  });
});

describe("shouldSkipGhcrRewrite", () => {
  it("is true only when ghcr.io was overridden by deploy config", () => {
    assert.equal(
      shouldSkipGhcrRewrite([{ registry: "ghcr.io", username: "bot", password: "b", overridden: false }]),
      false
    );
    assert.equal(
      shouldSkipGhcrRewrite([{ registry: "ghcr.io", username: "app", password: "a", overridden: true }]),
      true
    );
  });
});

describe("shouldSkipHubRewrite", () => {
  it("is true only when Docker Hub was overridden by deploy config", () => {
    assert.equal(
      shouldSkipHubRewrite([
        { registry: DOCKER_HUB_CONFIG_KEY, username: "bot", password: "b", overridden: false }
      ]),
      false
    );
    assert.equal(
      shouldSkipHubRewrite([
        { registry: DOCKER_HUB_CONFIG_KEY, username: "app", password: "a", overridden: true }
      ]),
      true
    );
  });
});

describe("insecureRegistryHostsFromDockerInfo", () => {
  it("collects IndexConfigs entries marked Secure=false", () => {
    const json = JSON.stringify({
      InsecureRegistryCIDRs: ["127.0.0.0/8"],
      IndexConfigs: {
        "docker.io": { Name: "docker.io", Secure: true, Official: true },
        "10.0.0.5:5000": { Name: "10.0.0.5:5000", Secure: false, Official: false },
        "10.0.0.5:5001": { Name: "10.0.0.5:5001", Secure: false, Official: false }
      }
    });
    const hosts = insecureRegistryHostsFromDockerInfo(json);
    assert.equal(hosts.has("10.0.0.5:5000"), true);
    assert.equal(hosts.has("10.0.0.5:5001"), true);
    assert.equal(hosts.has("docker.io"), false);
  });

  it("returns empty set on invalid json so rewrites are skipped safely", () => {
    assert.equal(insecureRegistryHostsFromDockerInfo("not-json").size, 0);
  });
});

describe("isMirrorHostAllowed", () => {
  it("is true only when mirror host:port is in the insecure set", () => {
    const hosts = new Set(["10.0.0.5:5000", "10.0.0.5:5001"]);
    assert.equal(isMirrorHostAllowed("http://10.0.0.5:5000", hosts), true);
    assert.equal(isMirrorHostAllowed("http://10.0.0.5:5001/", hosts), true);
    assert.equal(isMirrorHostAllowed("http://10.0.0.5:5000", new Set()), false);
  });
});

describe("isHubRegistryMirrorConfigured", () => {
  it("matches daemon registry-mirrors entries to the Hub cache URL", () => {
    assert.equal(
      isHubRegistryMirrorConfigured("http://172.16.20.11:5000", ["http://172.16.20.11:5000/"]),
      true
    );
    assert.equal(
      isHubRegistryMirrorConfigured("http://172.16.20.11:5000", ["http://other:5000"]),
      false
    );
    assert.equal(isHubRegistryMirrorConfigured("http://172.16.20.11:5000", []), false);
  });
});

describe("registryMirrorsFromDockerInfo", () => {
  it("reads Mirrors from RegistryConfig json", () => {
    const mirrors = registryMirrorsFromDockerInfo(
      JSON.stringify({ Mirrors: ["http://172.16.20.11:5000/"], IndexConfigs: {} })
    );
    assert.deepEqual(mirrors, ["http://172.16.20.11:5000/"]);
  });
});
