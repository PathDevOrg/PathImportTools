# Path Import

Path Import converts Arc and Moves timeline backups into a Path import database. It runs locally in the browser, so backup data stays on the user's device.

## What it supports

- Arc `Export/JSON`
- Arc `Previous Backups`
- Moves `moves_export/json/daily/storyline`
- Writable folder selection on browsers with File System Access
- Directory input and zip fallbacks for cross-platform use

## Development

```bash
npm install
npm run security:deps
npm test
npm run typecheck
npm run build
npm run test:smoke
npm run dev
```

## Privacy model

The selected files are read by a browser Worker. Conversion uses SQLite WASM and OPFS when available. No server upload, account, telemetry, or external API call is part of the conversion path.

Folder imports are indexed from browser `File` handles and each supported JSON file is read on demand. On browsers with File System Access, the output database is streamed to a file in the selected folder. Zip imports are indexed from the central directory and each supported entry is sliced and decompressed on demand, avoiding full-archive unzip in memory.


## License

MIT
