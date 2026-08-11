# Path Import

Path Import converts Arc and Moves timeline backups into a Path import database. It runs locally in the browser, so backup data stays on the user's device.

## What it supports

- Arc exports and partial `Previous Backups` folders
- Moves storyline, activities, places, and summary exports at daily, monthly, yearly, or full-history scope
- Mixed or reorganized folders whose supported files are no longer in their original paths
- Writable folder selection on browsers with File System Access
- Directory input and zip fallbacks, with OPFS-backed downloads when available

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

Folder imports are indexed from browser `File` handles and each supported JSON file is read on demand. When the browser provides writable user-selected folder or file handles, the output database is streamed directly to that destination. Zip imports are indexed from the central directory and each supported entry is sliced and decompressed on demand, avoiding full-archive unzip in memory.

Large multi-year archives use either direct file saving or an OPFS-backed download, subject to the browser's local-storage quota. Browsers that provide neither path can still convert smaller archives through the bounded in-memory fallback.

An OPFS-backed download keeps its source file in the site's local storage for up to 24 hours so the browser can finish reading it safely. A later conversion removes expired files; clearing this site's data removes them immediately.


## License

MIT
