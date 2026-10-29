// SPDX-License-Identifier: Apache-2.0
//
// deploy/vector/vector.yaml authenticates every ClickHouse sink with ${VAR}
// references. Vector >= 0.57 stopped expanding those by default: the sinks then
// send the literal "${CLICKHOUSE_USER}", ClickHouse answers 403, and Vector DROPS
// the batch as non-retriable. `vector validate --no-environment` and the golden
// tests (deploy/vector/tests.yaml) can't see this — neither one reaches a sink —
// so pin the compose side here instead.
import { describe, expect, test } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname;

describe("vector config interpolation", async () => {
  const config = await Bun.file(ROOT + "deploy/vector/vector.yaml").text();
  const compose = Bun.YAML.parse(await Bun.file(ROOT + "docker-compose.yml").text()) as any;
  const env: Record<string, string> = compose.services.vector.environment;
  const used = [...new Set([...config.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]))];

  test("vector.yaml still interpolates (else this guard is moot)", () => {
    expect(used.length).toBeGreaterThan(0);
  });

  test("compose turns interpolation back on for vector", () => {
    expect(String(env.VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION)).toBe("true");
  });

  test("every ${VAR} in vector.yaml is set on the vector service", () => {
    expect(used.filter((v) => !(v in env))).toEqual([]);
  });
});
