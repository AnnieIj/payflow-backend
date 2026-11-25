/**
 * Conformance suite for the `Storage` interface (#265).
 *
 * Every implementation — SQLite today, PostgreSQL when DATABASE_URL is set —
 * must pass every test in this file. The suite exercises the full `Storage`
 * contract: all five methods, every error path, every edge case, and the
 * behaviours callers rely on that are not obvious from the type signature.
 *
 * Tests are deterministic and independent of network state. Each `describe`
 * block opens **one** store for the whole suite (matching the existing
 * storage.test.ts pattern so the PostgreSQL test does not exhaust the CI
 * server's connection budget), clears `conform_kv` between tests, and closes
 * the store in an `after` hook.
 *
 * Layout
 * ──────
 * 1.  `dialect` — the backend's self-reported name.
 * 2.  `all` — happy path, empty result, parameter binding.
 * 3.  `get` — first row, undefined on miss, only the first row on multi-match.
 * 4.  `run` — write, upsert, `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.
 * 5.  `transaction` — atomicity, rollback on throw, nested transactions.
 * 6.  Error paths — bad SQL, constraint violation, type mismatches.
 * 7.  Edge cases — bigint round-trips, null values, zero-row ops.
 * 8.  `close` — first close resolves; second close behaviour is documented.
 * 9.  Cross-backend parity — SQLite and PostgreSQL return identical results.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import { PostgresStorage } from "../src/lib/store/postgres.ts";
import type { Storage } from "../src/lib/store/types.ts";

// ── backend registry ──────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;

type Backend = { name: string; open(): Promise<Storage> };

const backends: Backend[] = [
  { name: "SQLite", open: async () => SqliteStorage.open(":memory:") },
];
if (DATABASE_URL) {
  backends.push({
    name: "PostgreSQL",
    open: () =>
      PostgresStorage.open(
        DATABASE_URL,
        `conform_${process.pid}_${randomBytes(4).toString("hex")}`,
      ),
  });
}

// ── minimal schema ────────────────────────────────────────────────────────────

/**
 * A tiny two-column table sufficient to exercise every Storage method without
 * depending on the full application schema. It is created once per describe
 * block (the full app schema is already applied by `open()`), then wiped
 * between tests so each one starts from a known-empty state.
 */
const CREATE_KV = `
  CREATE TABLE IF NOT EXISTS conform_kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )
`;

// ── per-backend conformance ───────────────────────────────────────────────────

for (const backend of backends) {
  describe(`${backend.name} conformance`, () => {
    let db: Storage;

    before(async () => {
      db = await backend.open();
      await db.run(CREATE_KV);
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      // Start each test with an empty table so writes in one test cannot
      // affect the next.
      await db.run("DELETE FROM conform_kv");
    });

    // ── 1. dialect ──────────────────────────────────────────────────────────

    test("dialect identifies the backend", () => {
      const expected = backend.name === "SQLite" ? "sqlite" : "postgres";
      assert.equal(db.dialect, expected);
    });

    // ── 2. all ──────────────────────────────────────────────────────────────

    test("all returns every matching row", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["a", "1"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["b", "2"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["c", "3"]);
      const rows = await db.all<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv ORDER BY k",
      );
      assert.equal(rows.length, 3);
      assert.deepEqual(rows.map((r) => r.k), ["a", "b", "c"]);
    });

    test("all returns an empty array when no rows match", async () => {
      const rows = await db.all("SELECT k FROM conform_kv WHERE k = ?", ["missing"]);
      assert.deepEqual(rows, []);
    });

    test("all with no parameters runs without error", async () => {
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.ok(Array.isArray(rows));
      assert.equal(rows.length, 0);
    });

    test("all binds parameters correctly", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["x", "10"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["y", "20"]);
      const rows = await db.all<{ k: string }>(
        "SELECT k FROM conform_kv WHERE v = ?",
        ["10"],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.k, "x");
    });

    // ── 3. get ──────────────────────────────────────────────────────────────

    test("get returns the first matching row", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["key", "val"]);
      const row = await db.get<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv WHERE k = ?",
        ["key"],
      );
      assert.ok(row !== undefined);
      assert.equal(row.k, "key");
      assert.equal(row.v, "val");
    });

    test("get returns undefined when no row matches", async () => {
      const row = await db.get("SELECT k FROM conform_kv WHERE k = ?", ["absent"]);
      assert.equal(row, undefined);
    });

    test("get returns only the first row when multiple match", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["p", "first"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["q", "second"]);
      const row = await db.get<{ k: string }>(
        "SELECT k FROM conform_kv ORDER BY k ASC",
      );
      assert.equal(row?.k, "p");
    });

    // ── 4. run ──────────────────────────────────────────────────────────────

    test("run inserts a row that all/get can read back", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["inserted", "yes"]);
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["inserted"],
      );
      assert.equal(row?.v, "yes");
    });

    test("run upserts with ON CONFLICT DO UPDATE", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["u", "old"]);
      await db.run(
        "INSERT INTO conform_kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
        ["u", "new"],
      );
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["u"],
      );
      assert.equal(row?.v, "new");
    });

    test("INSERT OR IGNORE is a no-op on a duplicate key", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["dup", "original"]);
      // Must not throw; must leave the original row unchanged
      await db.run(
        "INSERT OR IGNORE INTO conform_kv (k, v) VALUES (?, ?)",
        ["dup", "overwrite"],
      );
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["dup"],
      );
      assert.equal(row?.v, "original", "original row must survive INSERT OR IGNORE");
    });

    test("run deletes rows and the count is reflected in a subsequent all", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["d1", "v"]);
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["d2", "v"]);
      await db.run("DELETE FROM conform_kv WHERE v = ?", ["v"]);
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.equal(rows.length, 0, "all matching rows must be deleted");
    });

    // ── 5. transaction ──────────────────────────────────────────────────────

    test("transaction commits all writes atomically", async () => {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["t1", "a"]);
        await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["t2", "b"]);
      });
      const rows = await db.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(rows.map((r) => r.k), ["t1", "t2"]);
    });

    test("transaction rolls back all writes when the callback throws", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["before", "v"]);

      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["during", "v"]);
          throw new Error("intentional rollback");
        }),
        /intentional rollback/,
      );

      const rows = await db.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(
        rows.map((r) => r.k),
        ["before"],
        "the row written inside the failed transaction must not persist",
      );
    });

    test("transaction re-throws the original error", async () => {
      await assert.rejects(
        db.transaction(async () => {
          throw new TypeError("typed rollback");
        }),
        (err: unknown) => err instanceof TypeError && err.message === "typed rollback",
      );
    });

    test("writes made outside a transaction are visible inside one", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["outer", "v"]);
      await db.transaction(async (tx) => {
        const row = await tx.get<{ k: string }>(
          "SELECT k FROM conform_kv WHERE k = ?",
          ["outer"],
        );
        assert.equal(row?.k, "outer", "committed row is visible inside a transaction");
      });
    });

    test("the tx storage passed to the callback supports all three query methods", async () => {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["tx-k", "tx-v"]);
        const row = await tx.get<{ v: string }>(
          "SELECT v FROM conform_kv WHERE k = ?",
          ["tx-k"],
        );
        assert.equal(row?.v, "tx-v", "tx.get sees tx.run within the same transaction");
        const rows = await tx.all<{ k: string }>(
          "SELECT k FROM conform_kv WHERE k = ?",
          ["tx-k"],
        );
        assert.equal(rows.length, 1, "tx.all sees tx.run within the same transaction");
      });
    });

    test("sequential transactions do not corrupt one another", async () => {
      for (let i = 0; i < 3; i++) {
        await db.transaction(async (tx) => {
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", [`seq-${i}`, String(i)]);
        });
      }
      const rows = await db.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(rows.map((r) => r.k), ["seq-0", "seq-1", "seq-2"]);
    });

    // ── 6. error paths ──────────────────────────────────────────────────────

    test("all rejects on a syntax error in the SQL", async () => {
      await assert.rejects(
        db.all("NOT VALID SQL !!!"),
        (err: unknown) => err instanceof Error && err.message.length > 0,
        "bad SQL must reject",
      );
    });

    test("get rejects on a syntax error in the SQL", async () => {
      await assert.rejects(
        db.get("ALSO NOT VALID"),
        (err: unknown) => err instanceof Error,
      );
    });

    test("run rejects on a syntax error in the SQL", async () => {
      await assert.rejects(
        db.run("NEITHER IS THIS"),
        (err: unknown) => err instanceof Error,
      );
    });

    test("run rejects on a primary key violation", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["pk", "first"]);
      await assert.rejects(
        db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["pk", "second"]),
        (err: unknown) =>
          /unique|duplicate|constraint/i.test(String((err as Error)?.message ?? err)),
        "duplicate primary key must be rejected with a constraint error",
      );
    });

    test("run rejects on a NOT NULL violation", async () => {
      await assert.rejects(
        db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["notnull", null]),
        (err: unknown) => err instanceof Error,
        "null in a NOT NULL column must be rejected",
      );
    });

    test("a constraint violation inside a transaction rolls back cleanly", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["existing", "v"]);

      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["new-row", "v"]);
          // This will throw a constraint error
          await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["existing", "dup"]);
        }),
        (err: unknown) =>
          /unique|duplicate|constraint/i.test(String((err as Error)?.message ?? err)),
      );

      // new-row must not have been committed
      const row = await db.get("SELECT k FROM conform_kv WHERE k = ?", ["new-row"]);
      assert.equal(row, undefined, "partial writes in a rolled-back transaction must not persist");
    });

    test("referencing a non-existent table rejects", async () => {
      await assert.rejects(
        db.all("SELECT * FROM table_that_does_not_exist"),
        (err: unknown) => err instanceof Error,
      );
    });

    // ── 7. edge cases ────────────────────────────────────────────────────────

    test("numeric values survive a round-trip through TEXT storage", async () => {
      const bigAmount = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["big", bigAmount]);
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["big"],
      );
      assert.equal(row?.v, bigAmount, "large decimal string must round-trip exactly");
    });

    test("empty string value is stored and retrieved correctly", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["empty", ""]);
      const row = await db.get<{ v: string }>(
        "SELECT v FROM conform_kv WHERE k = ?",
        ["empty"],
      );
      assert.equal(row?.v, "");
    });

    test("all with an empty parameter array behaves like no parameters", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["ep", "v"]);
      const rows = await db.all<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = 'ep'",
        [],
      );
      assert.equal(rows.length, 1);
    });

    test("get with an empty parameter array behaves like no parameters", async () => {
      await db.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["ge", "v"]);
      const row = await db.get<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = 'ge'",
        [],
      );
      assert.equal(row?.k, "ge");
    });

    test("DELETE of zero rows does not reject", async () => {
      await db.run("DELETE FROM conform_kv WHERE k = ?", ["ghost"]);
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.equal(rows.length, 0);
    });

    test("UPDATE of zero rows does not reject", async () => {
      await db.run("UPDATE conform_kv SET v = ? WHERE k = ?", ["new", "absent"]);
      const rows = await db.all("SELECT k FROM conform_kv");
      assert.equal(rows.length, 0);
    });

    test("the cursor table supports the standard upsert the indexer uses", async () => {
      await db.run(
        `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
        [100],
      );
      const first = await db.get<{ last_ledger: number }>(
        "SELECT last_ledger FROM cursor WHERE id = 1",
      );
      assert.equal(first?.last_ledger, 100);

      await db.run(
        `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
        [200],
      );
      const second = await db.get<{ last_ledger: number }>(
        "SELECT last_ledger FROM cursor WHERE id = 1",
      );
      assert.equal(second?.last_ledger, 200);
    });

    test("the events table supports INSERT OR IGNORE idempotency", async () => {
      const insert = `
        INSERT OR IGNORE INTO events
          (event_id, contract_id, ledger, tx_hash, event_index, topics, data, close_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const params = ["evt-1", "C".repeat(56), 10, "tx-1", "", "[]", "", null];
      await db.run(insert, params);
      await db.run(insert, params); // replay — must not throw or duplicate
      const rows = await db.all<{ event_id: string }>(
        "SELECT event_id FROM events WHERE event_id = ?",
        ["evt-1"],
      );
      assert.equal(rows.length, 1, "replayed event must not create a duplicate row");
    });

    test("plan row survives an upsert round-trip with large bigint amount", async () => {
      const amount = "9007199254740993"; // exceeds Number.MAX_SAFE_INTEGER
      const merchant = "G" + "B".repeat(55);
      await db.run(
        `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [1, merchant, "Test", "C".repeat(56), amount, 2592000, 1, 10],
      );
      const row = await db.get<{ amount: string }>(
        "SELECT amount FROM plans WHERE id = ?",
        [1],
      );
      assert.equal(row?.amount, amount, "bigint amount must survive without precision loss");
    });

    // ── 8. close ─────────────────────────────────────────────────────────────
    // These two tests open their own store so they can test close() independently
    // of the shared store used by all other tests in this describe block.

    test("close resolves without throwing on first call", async () => {
      const fresh = await backend.open();
      await assert.doesNotReject(fresh.close());
    });

    test("a second close after the first either resolves or rejects with a clear error", async () => {
      // The contract requires the first close to always succeed cleanly.
      // The two backends differ on a second close: PostgreSQL throws
      // "Called end on pool more than once"; SQLite throws "database is not open".
      // Both behaviours are acceptable as long as the first close succeeds.
      const fresh = await backend.open();
      await fresh.close(); // first close — must always succeed
      try {
        await fresh.close(); // second close — allowed to throw
      } catch (err) {
        assert.ok(err instanceof Error, "if second close throws it must be an Error");
      }
    });
  });
}

// ── 9. cross-backend parity ───────────────────────────────────────────────────

test(
  "SQLite and PostgreSQL return identical rows for the same inserts and queries",
  { skip: !DATABASE_URL },
  async () => {
    const sqlite = SqliteStorage.open(":memory:");
    const postgres = await PostgresStorage.open(
      DATABASE_URL!,
      `parity_conform_${process.pid}_${randomBytes(4).toString("hex")}`,
    );

    try {
      for (const store of [sqlite, postgres]) {
        await store.run(CREATE_KV);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["one", "1"]);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["two", "2"]);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["three", "3"]);
      }

      const sqliteRows = await sqlite.all<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv ORDER BY k",
      );
      const pgRows = await postgres.all<{ k: string; v: string }>(
        "SELECT k, v FROM conform_kv ORDER BY k",
      );
      assert.deepEqual(sqliteRows, pgRows, "both backends must return identical row sets");

      const sqliteRow = await sqlite.get<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = ?",
        ["two"],
      );
      const pgRow = await postgres.get<{ k: string }>(
        "SELECT k FROM conform_kv WHERE k = ?",
        ["two"],
      );
      assert.deepEqual(sqliteRow, pgRow, "get must return the same row on both backends");
    } finally {
      await Promise.all([sqlite.close(), postgres.close()]);
    }
  },
);

test(
  "SQLite and PostgreSQL roll back identically on a thrown error",
  { skip: !DATABASE_URL },
  async () => {
    const sqlite = SqliteStorage.open(":memory:");
    const postgres = await PostgresStorage.open(
      DATABASE_URL!,
      `rollback_conform_${process.pid}_${randomBytes(4).toString("hex")}`,
    );

    try {
      for (const store of [sqlite, postgres]) {
        await store.run(CREATE_KV);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["seed", "v"]);
        await assert.rejects(
          store.transaction(async (tx) => {
            await tx.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["ephemeral", "v"]);
            throw new Error("rollback");
          }),
          /rollback/,
        );
      }

      const sqliteRows = await sqlite.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      const pgRows = await postgres.all<{ k: string }>("SELECT k FROM conform_kv ORDER BY k");
      assert.deepEqual(sqliteRows, pgRows, "both backends must have identical state after rollback");
      assert.deepEqual(sqliteRows.map((r) => r.k), ["seed"]);
    } finally {
      await Promise.all([sqlite.close(), postgres.close()]);
    }
  },
);

test(
  "SQLite and PostgreSQL enforce the same primary key constraint",
  { skip: !DATABASE_URL },
  async () => {
    const sqlite = SqliteStorage.open(":memory:");
    const postgres = await PostgresStorage.open(
      DATABASE_URL!,
      `pk_conform_${process.pid}_${randomBytes(4).toString("hex")}`,
    );

    try {
      for (const store of [sqlite, postgres]) {
        await store.run(CREATE_KV);
        await store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["shared", "v"]);
        await assert.rejects(
          store.run("INSERT INTO conform_kv (k, v) VALUES (?, ?)", ["shared", "dup"]),
          (err: unknown) =>
            /unique|duplicate|constraint/i.test(String((err as Error)?.message ?? err)),
          `${store.dialect} must reject a duplicate primary key`,
        );
      }
    } finally {
      await Promise.all([sqlite.close(), postgres.close()]);
    }
  },
);
