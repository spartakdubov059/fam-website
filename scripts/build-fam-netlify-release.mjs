import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A deliberately small public bundle. Never publish the repository root:
// it contains source migrations, CI files and Git metadata.
export const CORE_FILES = Object.freeze([
  "index.html", "school-pulse.js", "school-pulse.css",
  "price-format.js", "supabase-cdn-fallback.js",
  "fam-domain-health.json", "robots.txt", "sitemap.xml",
  "tradelot-cd656f38020c27e8cd7b32546c7a0242.txt",
]);
const IMAGE_PATTERN = /^banner-[a-z0-9-]+\.(?:jpe?g|png|webp|avif)$/i;
const SAFE_ASSET = /\.(?:svg|png|jpe?g|webp|avif|gif|ico|woff2?)$/i;
const NETLIFY_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY

/
  Cache-Control: no-cache, no-store, must-revalidate

/index.html
  Cache-Control: no-cache, no-store, must-revalidate

/fam-domain-health.json
  Access-Control-Allow-Origin: https://spartakdubov059.github.io
  Cache-Control: no-store
`;

function copyRelative(root, dest, relative, published) {
  const source = join(root, relative);
  if (!existsSync(source)) throw new Error(`Missing required FAM static file: ${relative}`);
  const target = join(dest, relative);
  mkdirSync(resolve(target, ".."), { recursive: true });
  copyFileSync(source, target);
  published.push(relative);
}

export function buildFAMNetlifyRelease({ root = process.cwd(), destination = join(root, "dist") } = {}) {
  const sourceRoot = resolve(root);
  const targetRoot = resolve(destination);
  // The caller controls the target path; never permit a source tree delete.
  if (targetRoot === sourceRoot || sourceRoot.startsWith(targetRoot + "/")) {
    throw new Error("Release directory must not contain the source tree");
  }
  if (basename(targetRoot) !== "dist") throw new Error("Release destination must be named dist");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  const files = [];
  for (const filename of CORE_FILES) copyRelative(sourceRoot, targetRoot, filename, files);
  for (const item of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (item.isFile() && IMAGE_PATTERN.test(item.name)) {
      copyRelative(sourceRoot, targetRoot, item.name, files);
    }
  }
  for (const item of readdirSync(join(sourceRoot, "assets"), { withFileTypes: true })) {
    if (!item.isFile() || !SAFE_ASSET.test(item.name)) {
      throw new Error(`Unsupported FAM public asset: ${item.name}`);
    }
    copyRelative(sourceRoot, targetRoot, join("assets", item.name), files);
  }
  copyRelative(sourceRoot, targetRoot, join(".well-known", "fam-domain-health.json"), files);
  writeFileSync(join(targetRoot, "_headers"), NETLIFY_HEADERS, "utf8");
  files.push("_headers");
  const health = JSON.parse(readFileSync(join(targetRoot, "fam-domain-health.json"), "utf8"));
  if (health.site !== "famru" || health.ok !== true) {
    throw new Error("Netlify health marker does not declare ready=true");
  }
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = buildFAMNetlifyRelease();
  console.log(`Packaged ${files.length} public FAM files for Netlify, excluding repository internals.`);
}
