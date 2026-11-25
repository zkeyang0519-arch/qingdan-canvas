import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";

// Import configuration only. Credentials keep using their existing encrypted
// store; old chats, calls and account records are not imported.
export function inheritMcpConfiguration(sourceDirectory, directory, mappings) {
  const target = new DatabaseSync(
    path.join(directory, "mcp-connections.sqlite"),
  );
  try {
    target.exec(`CREATE TABLE IF NOT EXISTS inherited_mcp(server TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pi_migrations(name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,authMode TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offline',catalog TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS selections(binding TEXT NOT NULL,server TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,tools TEXT NOT NULL,PRIMARY KEY(binding,server));
      CREATE TABLE IF NOT EXISTS connector_preferences(server TEXT PRIMARY KEY,source TEXT NOT NULL);`);
    const sourceFile = path.join(sourceDirectory, "mcp-connections.sqlite");
    if (
      !target
        .prepare("SELECT 1 FROM pi_migrations WHERE name='existing-mcp-v1'")
        .get() &&
      existsSync(sourceFile)
    ) {
      const source = new DatabaseSync(sourceFile, { readOnly: true });
      target.exec("BEGIN IMMEDIATE");
      try {
        for (const row of source
          .prepare("SELECT id,name,url,authMode,catalog FROM servers")
          .all()) {
          target
            .prepare(
              "INSERT OR IGNORE INTO servers(id,name,url,authMode,catalog) VALUES(?,?,?,?,?)",
            )
            .run(row.id, row.name, row.url, row.authMode, row.catalog);
          target
            .prepare("INSERT OR IGNORE INTO inherited_mcp VALUES(?)")
            .run(row.id);
        }
        for (const mapping of mappings)
          for (const row of source
            .prepare("SELECT server,tools FROM selections WHERE binding=?")
            .all(mapping.from))
            target
              .prepare("INSERT OR IGNORE INTO selections VALUES(?,?,?)")
              .run(mapping.to, row.server, row.tools);
        if (
          source
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name='connector_preferences'",
            )
            .get()
        )
          for (const row of source
            .prepare("SELECT server,source FROM connector_preferences")
            .all())
            target
              .prepare(
                "INSERT OR IGNORE INTO connector_preferences VALUES(?,?)",
              )
              .run(row.server, row.source);
        target
          .prepare("INSERT INTO pi_migrations VALUES('existing-mcp-v1')")
          .run();
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      } finally {
        source.close();
      }
    }
    return new Set(
      target
        .prepare("SELECT server FROM inherited_mcp")
        .all()
        .map((row) => row.server),
    );
  } finally {
    target.close();
  }
}
