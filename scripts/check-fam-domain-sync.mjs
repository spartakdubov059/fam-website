import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const DOMAINS = Object.freeze([
  { name: "GitHub Pages", origin: "https://spartakdubov059.github.io", prefix: "/fam-website" },
  { name: "Netlify", origin: "https://famru.netlify.app", prefix: "" },
]);

const STATIC_EXTENSIONS = /\.(?:html?|css|mjs?|js|json|xml|txt|webmanifest|svg|png|jpe?g|webp|avif|gif|ico|mp3|wav|ogg|woff2?|ttf|otf|pdf|mp4|webm|map)$/i;
const EXCLUDED_PREFIXES = [
  ".github/",
  ".openai/",
  "docs/",
  "scripts/",
  "supabase/",
  "tests/",
  "node_modules/",
  "coverage/",
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isPublicAssetPath(value) {
  const path = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return false;
  if (EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))) return false;
  if (path.split("/").some(part => part.startsWith("."))) return false;
  return STATIC_EXTENSIONS.test(path);
}

export function selectPublicPaths(changedPaths, root = process.cwd()) {
  const candidates = new Set((changedPaths ?? []).map(String));
  for (const core of ["index.html", "school-pulse.js", "school-pulse.css", "fam-domain-health.json"]) {
    if (existsSync(resolve(root, core))) candidates.add(core);
  }
  return [...candidates]
    .filter(path => isPublicAssetPath(path) && existsSync(resolve(root, path)))
    .sort();
}

export function publicUrl(domain, path, cacheKey = "sync") {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${domain.origin}${domain.prefix}/${encodedPath}?fam_sync=${encodeURIComponent(cacheKey)}`;
}

export async function fetchDigest(fetchImpl, domain, path, cacheKey) {
  const response = await fetchImpl(publicUrl(domain, path, cacheKey), {
    redirect: "follow",
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    return { ok: false, status: response.status, digest: null };
  }
  return { ok: true, status: response.status, digest: sha256(Buffer.from(await response.arrayBuffer())) };
}

export async function comparePath(fetchImpl, domain, path, expectedDigest, cacheKey) {
  try {
    const actual = await fetchDigest(fetchImpl, domain, path, cacheKey);
    return { domain: domain.name, path, ...actual, matches: actual.ok && actual.digest === expectedDigest };
  } catch (error) {
    return { domain: domain.name, path, ok: false, status: "network-error", digest: null, matches: false,
      error: error instanceof Error ? error.message : String(error) };
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function changedPaths() {
  const before = process.env.GITHUB_EVENT_BEFORE;
  const sha = process.env.GITHUB_SHA || "HEAD";
  if (before && !/^0+$/.test(before)) {
    return gitOutput(["diff", "--name-only", `${before}...${sha}`]).split("\n").filter(Boolean);
  }
  return gitOutput(["show", "--pretty=format:", "--name-only", sha]).split("\n").filter(Boolean);
}

export async function verifyDomains({
  paths,
  root = process.cwd(),
  domains = DOMAINS,
  fetchImpl = fetch,
  cacheKey = process.env.GITHUB_SHA || "sync-check",
  timeoutMs = 10 * 60_000,
  intervalMs = 15_000,
  onAttempt = () => {},
}) {
  const selected = selectPublicPaths(paths, root);
  if (!selected.includes("index.html")) selected.unshift("index.html");
  if (!selected.length) throw new Error("No public files were selected for the domain sync check.");

  const expected = new Map(selected.map(path => [path, sha256(readFileSync(resolve(root, path)))]));
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let latest = [];

  while (Date.now() <= deadline) {
    attempt += 1;
    latest = (await Promise.all(domains.flatMap(domain =>
      selected.map(path => comparePath(fetchImpl, domain, path, expected.get(path), cacheKey))
    )));
    onAttempt({ attempt, results: latest });
    if (latest.every(result => result.matches)) return { attempts: attempt, paths: selected, results: latest };
    if (Date.now() + intervalMs > deadline) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  const mismatches = latest.filter(result => !result.matches).map(result =>
    `${result.domain} ${result.path}: ${result.status}${result.error ? ` (${result.error})` : ""}`
  );
  throw new Error(`Domains did not serve the same source files before timeout. ${mismatches.join("; ")}`);
}

async function main() {
  const paths = changedPaths();
  console.log(`Checking ${paths.length} changed repository paths and core FAM assets on both production domains.`);
  const result = await verifyDomains({
    paths,
    onAttempt: ({ attempt, results }) => {
      const waiting = results.filter(item => !item.matches);
      if (waiting.length) {
        console.log(`Attempt ${attempt}: waiting for ${waiting.length} file/domain checks to match.`);
      } else {
        console.log(`Attempt ${attempt}: all checked files match on both domains.`);
      }
    },
  });
  console.log(`Domain sync verified after ${result.attempts} attempt(s): ${result.paths.join(", ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
