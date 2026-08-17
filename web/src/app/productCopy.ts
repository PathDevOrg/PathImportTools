export const productCopy = {
  appName: "Path Import",
  githubRepoLabel: "View source on GitHub",
  githubRepoHref: "https://github.com/PathDevOrg/PathImportTools",
  navHomeLabel: "Path Import home",
  heroTitle: "Convert Arc and Moves backups locally",
  heroBody: "Select a backup folder. Path Import creates a database file locally.",
  selectFolderLabel: "Select backup folder",
  workingStep: "Step 2 of 3",
  workingTitle: "Converting data",
  workingBody: "Path Import is reading files, resolving overlaps, and preparing your database.",
  workingFallback: "Preparing files",
  cancelLabel: "Cancel conversion",
  cancelConfirm: "Cancel this conversion? Any progress will be discarded.",
  completeStep: "Step 3 of 3",
  completeTitle: "Import file ready",
  completeSavedBody:
    "Your import database was saved in the selected folder. Open Path on your iPhone and import it from Settings.",
  completeDownloadBody:
    "Your import database downloaded automatically. Open Path on your iPhone and import it from Settings.",
  savedStatus: "Saved to disk",
  downloadAgainLabel: "Download again",
  chooseAnotherLabel: "Choose another folder",
  errorTitle: "This folder was not recognized",
  errorFallback: "Choose the folder that contains Arc Export, Arc Previous Backups, or Moves json/daily/storyline.",
  errorUnknownTitle: "Something went wrong",
  privacyStatement:
    "Path Import is designed to work offline: everything you select is read and converted entirely on this device, with no uploads, and you can disconnect from the internet once the app has loaded.",
} as const;
