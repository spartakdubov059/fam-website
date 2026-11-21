import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOMAINS,
  comparePath,
  isPublicAssetPath,
  publicUrl,
  selectPublicPaths,
  sha256,
} from "../../scripts/check-fam-domain-sync.mjs";

test("maps the same repository asset to each live domain", () => {
  assert.equal(
    publicUrl(DOMAINS[0], "school-pulse.js", "abc123"),
    "https://spartakdubov059.github.io/fam-website/school-pulse.js?fam_sync=abc123",
  );
  assert.equal(
    publicUrl(DOMAINS[1], "images/banner one.jpg", "abc123"),
    "https://famru.netlify.app/images/banner%20one.jpg?fam_sync=abc123",
  );
});

test("only shared public static assets are selected", () => {
  assert.equal(isPublicAssetPath("index.html"), true);
  assert.equal(isPublicAssetPath("assets/banner.webp"), true);
  assert.equal(isPublicAssetPath("fam-domain-health.json"), false);
  assert.equal(isPublicAssetPath(".github/workflows/site.yml"), false);
  assert.equal(isPublicAssetPath("supabase/functions/moderate/index.ts"), false);
  assert.equal(isPublicAssetPath("../secrets.json"), false);
  assert.equal(isPublicAssetPath("/absolute/index.html"), false);
});

test("adds core FAM files and ignores host-specific and non-public paths", () => {
  const root = mkdtempSync(join(tmpdir(), "fam-domain-sync-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "index.html"), "<main>FAM</main>");
    writeFileSync(join(root, "school-pulse.js"), "window.FAM = true;");
    writeFileSync(join(root, "school-pulse.css"), ".fam{}");
    writeFileSync(join(root, "fam-domain-health.json"), '{"site":"famru"}');
    writeFileSync(join(root, "scripts", "check.mjs"), "console.log('test')");
    const selected = selectPublicPaths(
      ["scripts/check.mjs", "school-pulse.js", "fam-domain-health.json"],
      root,
    );
    assert.deepEqual(selected, ["index.html", "school-pulse.css", "school-pulse.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compares a live response with the expected source digest", async () => {
  const body = Buffer.from("FAM release");
  const fetchMatching = async () => new Response(body, { status: 200 });
  const fetchStale = async () => new Response("old release", { status: 200 });
  const matching = await comparePath(fetchMatching, DOMAINS[1], "index.html", sha256(body), "release");
  const stale = await comparePath(fetchStale, DOMAINS[1], "index.html", sha256(body), "release");
  assert.equal(matching.matches, true);
  assert.equal(stale.matches, false);
});

test("reports unavailable or missing deploy files as mismatches", async () => {
  const fetchMissing = async () => new Response("not found", { status: 404 });
  const result = await comparePath(fetchMissing, DOMAINS[0], "index.html", sha256("FAM"), "release");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.matches, false);
});
