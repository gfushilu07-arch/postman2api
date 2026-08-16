import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config";
import { db } from "../src/db/index";
import { requestLogs } from "../src/db/schema";
import {
  flushDatabaseWriteQueue,
  initializeDatabaseWriteQueue,
  resolveWriteWorkerUrl,
  writeRequestLog,
} from "../src/db/write-queue";

const requestLogIds = new Set<number>();

afterEach(async () => {
  await flushDatabaseWriteQueue();
  for (const id of requestLogIds) {
    await db.delete(requestLogs).where(eq(requestLogs.id, id));
  }
  requestLogIds.clear();
});

describe("SQLite write worker", () => {
  test("resolves the worker beside source code and inside the compiled db directory", () => {
    expect(resolveWriteWorkerUrl(
      "file:///workspace/src/db/write-queue.ts",
      "/workspace/src/db/write-queue.ts",
    ).pathname).toBe("/workspace/src/db/write-worker.ts");

    expect(resolveWriteWorkerUrl(
      "file:///app/dist/index.js",
      "/app/dist/index.js",
    ).pathname).toBe("/app/dist/db/write-worker.js");
  });

  test("starts and writes through the worker using only the test database", async () => {
    expect(config.runtimeEnvironment).toBe("test");
    expect(config.databasePath).not.toBe(
      new URL("../data/postman2api.db", import.meta.url).pathname,
    );

    await initializeDatabaseWriteQueue();
    await writeRequestLog({
      model: "write-worker-probe",
      status: "success",
    });
    await flushDatabaseWriteQueue();

    const [saved] = await db.select().from(requestLogs)
      .where(eq(requestLogs.model, "write-worker-probe"))
      .orderBy(requestLogs.id)
      .limit(1);
    expect(saved?.status).toBe("success");
    if (saved) requestLogIds.add(saved.id);
  });
});
