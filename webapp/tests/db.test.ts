import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db";

describe("openDb", () => {
  test("creates the three tables and is idempotent", () => {
    const db = openDb(":memory:");
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("boards");
    expect(tables).toContain("samples");
    expect(tables).toContain("sessions");
    // Re-running schema creation must not throw.
    expect(() => openDb(":memory:")).not.toThrow();
  });

  test("samples has an index on board and ts", () => {
    const db = openDb(":memory:");
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index'",
      )
      .all()
      .map((r) => r.name);
    expect(idx).toContain("idx_samples_board_ts");
  });
});
