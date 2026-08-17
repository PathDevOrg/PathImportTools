import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { productCopy } from "../../src/app/productCopy";

describe("productCopy", () => {
  test("shows Path as the visible product name", () => {
    const visibleText = JSON.stringify(productCopy);

    expect(productCopy.appName).toBe("Path Import");
    expect(productCopy.githubRepoLabel).toBe("View source on GitHub");
    expect(visibleText).not.toContain("Aura");
  });

  test("keeps the page focused on the import workflow", () => {
    const appSource = readFileSync(new URL("../../src/app/App.tsx", import.meta.url), "utf8");
    const componentSource = readFileSync(new URL("../../src/components/ImportStages.tsx", import.meta.url), "utf8");

    expect(productCopy.heroTitle).toBe("Convert Arc and Moves backups locally");
    expect(productCopy.heroBody).toBe("Select a backup folder. Path Import creates a database file locally.");
    expect(productCopy.githubRepoHref).toBe("https://github.com/PathDevOrg/PathImportTools");
    expect(appSource).toContain("githubRepoHref");
    expect(appSource).toContain("github-badge");
    expect(appSource).toContain("pickDirectoryFiles");
    expect(appSource).toContain("outputDirectoryRef");
    expect(componentSource).toContain("privacy-footer");
    expect(appSource).not.toContain("<PrivacyList />");
    expect(appSource).not.toContain("WorkflowSteps");
    expect(appSource).not.toContain("workflow-steps");
    expect(appSource).not.toContain("productCopy.localBadge");
    expect(appSource).not.toContain("productCopy.emptyBody");
    expect(appSource).not.toContain("productCopy.emptyTitle");
    expect(appSource).not.toContain("app-download-panel");
    expect(appSource).not.toContain("<Apple");
    expect(JSON.stringify(productCopy)).not.toContain("Supports Arc Export");
    expect(JSON.stringify(productCopy)).not.toContain("Local conversion");
    expect(JSON.stringify(productCopy)).not.toContain("workflowStep");
  });
});
