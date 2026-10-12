#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Pool } from "pg";

const require = createRequire(import.meta.url);
const { createRateLimiter } = require("../api/_lib/rate-limit.js");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const secret = "ci-only-rate-limit-secret-which-is-long-enough";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log("PASS", name);
}

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_counters (
      key_hash TEXT NOT NULL,
      window_start BIGINT NOT NULL,
      count INTEGER NOT NULL CHECK (count > 0),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (key_hash, window_start)
    )
  `);
  await pool.query("TRUNCATE rate_limit_counters");
  let now = Date.now();
  const limiter = createRateLimiter({
    query: async (statement, params) => (await pool.query(statement, params)).rows,
    secret,
    now: () => now,
    cleanupEvery: 3,
  });

  await test("enforces the fixed-window threshold", async () => {
    await pool.query("TRUNCATE rate_limit_counters");
    assert.equal((await limiter({ scope: "threshold", identifier: "ip-1", limit: 2, windowSeconds: 60 })).allowed, true);
    assert.equal((await limiter({ scope: "threshold", identifier: "ip-1", limit: 2, windowSeconds: 60 })).allowed, true);
    const third = await limiter({ scope: "threshold", identifier: "ip-1", limit: 2, windowSeconds: 60 });
    assert.equal(third.allowed, false);
    assert.equal(third.count, 3);
    assert.ok(third.retryAfter >= 1 && third.retryAfter <= 60);
  });

  await test("increments counters atomically under concurrent requests", async () => {
    await pool.query("TRUNCATE rate_limit_counters");
    const results = await Promise.all(Array.from({ length: 40 }, () =>
      limiter({ scope: "concurrency", identifier: "shared-client", limit: 100, windowSeconds: 60 })
    ));
    assert.equal(Math.max(...results.map((item) => item.count)), 40);
    const rows = await pool.query("SELECT count FROM rate_limit_counters");
    assert.equal(Number(rows.rows[0].count), 40);
  });

  await test("starts a new counter after the window expires", async () => {
    await pool.query("TRUNCATE rate_limit_counters");
    const first = await limiter({ scope: "expiry", identifier: "client", limit: 5, windowSeconds: 60 });
    now += 61_000;
    const nextWindow = await limiter({ scope: "expiry", identifier: "client", limit: 5, windowSeconds: 60 });
    assert.equal(first.count, 1);
    assert.equal(nextWindow.count, 1);
  });

  await test("persists only an HMAC digest, not the raw identifier", async () => {
    await pool.query("TRUNCATE rate_limit_counters");
    const raw = "198.51.100.27-sensitive-test-identifier";
    await limiter({ scope: "privacy", identifier: raw, limit: 5, windowSeconds: 60 });
    const rows = await pool.query("SELECT key_hash FROM rate_limit_counters");
    assert.match(rows.rows[0].key_hash, /^[a-f0-9]{64}$/);
    assert.equal(rows.rows[0].key_hash.includes(raw), false);
    assert.equal(rows.rows[0].key_hash, rows.rows[0].key_hash.toLowerCase());
  });

  await test("cleans up expired rows in bounded batches", async () => {
    await pool.query("TRUNCATE rate_limit_counters");
    await pool.query(
      "INSERT INTO rate_limit_counters (key_hash, window_start, count, expires_at) VALUES ($1, $2, 1, now() - interval '1 hour')",
      ["a".repeat(64), -999]
    );
    const policy = { scope: "cleanup", identifier: "same-key", limit: 10, windowSeconds: 60 };
    await limiter(policy);
    await limiter(policy);
    await limiter(policy);
    const rows = await pool.query("SELECT key_hash FROM rate_limit_counters WHERE key_hash = $1", ["a".repeat(64)]);
    assert.equal(rows.rowCount, 0);
  });

  console.log(`PASS: ${passed} PostgreSQL rate-limit integration tests`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
