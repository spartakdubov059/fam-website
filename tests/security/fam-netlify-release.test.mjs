import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFAMNetlifyRelease, CORE_FILES } from "../../scripts/build-fam-netlify-release.mjs";
const netlifyWorkflow = readFileSync(new URL("../../.github/workflows/fam-netlify-production.yml", import.meta.url), "utf8");

test("Netlify publishing is opt-in and the paused workflow reports the free publisher", () => {
  assert.match(netlifyWorkflow, /FAM_NETLIFY_PUBLISH_ENABLED != 'true'/);
  assert.match(netlifyWorkflow, /FAM_NETLIFY_PUBLISH_ENABLED == 'true'/);
  assert.match(netlifyWorkflow, /GitHub Pages remains the active free publisher/);
  const publishJob = netlifyWorkflow.slice(netlifyWorkflow.indexOf("  publish:"));
  assert.match(publishJob, /NETLIFY_AUTH_TOKEN: \$\{\{ secrets\.NETLIFY_AUTH_TOKEN \}\}/);
});

test("Netlify deploy contains only the public FAM app, never CI, Git or database files", () => {
  const root = mkdtempSync(join(tmpdir(), "fam-netlify-release-"));
  try {
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, ".well-known"));
    mkdirSync(join(root, ".github"));
    mkdirSync(join(root, "supabase"));
    mkdirSync(join(root, ".git"));
    for (const file of CORE_FILES) {
      writeFileSync(join(root, file),
        file === "fam-domain-health.json" ? '{"site":"famru","ok":true}' : "FAM test");
    }
    writeFileSync(join(root, "banner-1.webp"), "public artwork");
    writeFileSync(join(root, "assets", "fam-art.svg"), "<svg/>");
    writeFileSync(join(root, ".well-known", "fam-domain-health.json"), '{"site":"famru","ok":true}');
    writeFileSync(join(root, ".github", "workflow.yml"), "private CI");
    writeFileSync(join(root, "supabase", "schema.sql"), "private migrations");
    writeFileSync(join(root, ".git", "config"), "private repo metadata");
    const published = buildFAMNetlifyRelease({root});
    for (const expected of [
      "index.html", "school-pulse.js", "school-pulse.css", "price-format.js",
      "fam-domain-health.json", "banner-1.webp", "assets/fam-art.svg",
      ".well-known/fam-domain-health.json", "_headers"
    ]) {
      assert.ok(published.includes(expected), "missing public file: " + expected);
      assert.ok(existsSync(join(root, "dist", expected)));
    }
    for (const forbidden of [".github", ".git", "supabase", "tests", "scripts"]) {
      assert.equal(existsSync(join(root, "dist", forbidden)), false);
    }
    const headers = readFileSync(join(root, "dist", "_headers"), "utf8");
    assert.match(headers, /Access-Control-Allow-Origin: https:\/\/spartakdubov059\.github\.io/);
    assert.match(headers, /Cache-Control: no-store/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("invalid readiness marker rejects release before any deploy", () => {
  const root = mkdtempSync(join(tmpdir(), "fam-netlify-marker-"));
  try {
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, ".well-known"));
    for (const file of CORE_FILES) {
      writeFileSync(join(root, file),
        file === "fam-domain-health.json" ? '{"site":"famru","ok":false}' : "FAM test");
    }
    writeFileSync(join(root, ".well-known", "fam-domain-health.json"), '{"site":"famru","ok":true}');
    assert.throws(() => buildFAMNetlifyRelease({root}), /ready=true/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
