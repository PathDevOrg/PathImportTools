export type AuraSchemaFile = {
  version: number;
  name: string;
};

export const schemaFile: AuraSchemaFile = { version: 12, name: "V12_schema.sql" };

export function getLatestSchemaVersion(): number {
  return schemaFile.version;
}
