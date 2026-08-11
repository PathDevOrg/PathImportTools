export type AuraSchemaFile = {
  version: number;
  name: string;
};

export const schemaFile: AuraSchemaFile = { version: 12, name: "V12_schema.sql" };

export function getLatestSchemaVersion(): number {
  return schemaFile.version;
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
