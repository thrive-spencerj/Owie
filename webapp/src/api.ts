import type { Database } from "bun:sqlite";

export function handleApi(
  db: Database,
  req: Request,
  url: URL,
): Response | Promise<Response> | undefined {
  void db;
  void req;
  void url;
  return undefined; // Task 5 implements the read API.
}
