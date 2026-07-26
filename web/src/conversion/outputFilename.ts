export function makeImportFilename(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `path-import-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.db`;
}
