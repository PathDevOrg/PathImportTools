# Path Import

Path Import converts Arc and Moves timeline backups into a Path import database. It runs locally in the browser as a PWA, so backup data stays on the user's device.

## What it supports

- Arc `Export/JSON`
- Arc `Previous Backups`
- Moves `moves_export/json/daily/storyline`
- Folder selection on browsers that expose directory input
- Zip fallback for cross-platform use
- Conversion progress with file indexing, parsing, database writing, verification, and export phases

## Development

```bash
npm install
npm run security:deps
npm test
npm run typecheck
npm run build
npm run dev
```

The web app is in `apps/web`. The conversion logic is in `packages/converter`. Vendored Path schema migrations are in `packages/aura-schema/migrations`.

## Privacy model

The selected files are read by a browser Worker. Conversion uses SQLite WASM and OPFS when available. No server upload, account, telemetry, or external API call is part of the conversion path.

Folder imports are indexed from browser `File` handles and each supported JSON file is read on demand. Zip imports are indexed from the central directory and each supported entry is sliced and decompressed on demand, avoiding full-archive unzip in memory.

## License

MIT
