export type AuraMigrationFile = {
  version: number;
  name: string;
};

export const migrationFiles: AuraMigrationFile[] = [
  { version: 1, name: "V1_schema.sql" },
  { version: 2, name: "V2_timeline_view.sql" },
  { version: 3, name: "V3_optimization.sql" },
  { version: 4, name: "V4_device_motion.sql" },
  { version: 5, name: "V5_refined_tracks.sql" },
  { version: 6, name: "V6_estimated_quality.sql" },
  { version: 7, name: "V7_stay_name_rules.sql" },
  { version: 8, name: "V8_timeline_query_indexes.sql" },
  { version: 9, name: "V9_move_mode_decisions.sql" }
];

export function getLatestSchemaVersion(): number {
  return migrationFiles.reduce((latest, file) => Math.max(latest, file.version), 0);
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (!quote && char === "-" && next === "-") {
      const newline = sql.indexOf("\n", index + 2);
      if (newline === -1) {
        break;
      }
      index = newline;
      current += "\n";
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          current += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
}
