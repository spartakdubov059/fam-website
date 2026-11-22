import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TIME_AGO_FUNCTION = /^  function timeAgo\(isoOrMs\) \{[\s\S]*?^  \}/gm;

function extractTimeAgo(source) {
  if (typeof source !== "string") return null;
  const matches = [...source.matchAll(TIME_AGO_FUNCTION)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  return {
    body: match[0],
    outside: source.slice(0, match.index) +
      "__FAM_TIMEAGO_FUNCTION__" +
      source.slice(match.index + match[0].length),
  };
}

export function onlyTimeAgoChanged(before, after) {
  const previous = extractTimeAgo(before);
  const proposed = extractTimeAgo(after);
  return Boolean(
    previous &&
    proposed &&
    previous.body !== proposed.body &&
    previous.outside === proposed.outside
  );
}

export function assertOnlyTimeAgoChangedInCheckout() {
  const changed = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], {
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  if (changed.length !== 1 || changed[0] !== "index.html") {
    throw new Error("Existing timeAgo regression test cannot authorize changes outside index.html");
  }
  const before = execFileSync("git", ["show", "HEAD:index.html"], { encoding: "utf8" });
  const after = readFileSync("index.html", "utf8");
  if (!onlyTimeAgoChanged(before, after)) {
    throw new Error("Existing timeAgo regression test cannot authorize changes outside the timeAgo function");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assertOnlyTimeAgoChangedInCheckout();
    console.log("TimeAgo-only patch scope verified against clean git HEAD.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
