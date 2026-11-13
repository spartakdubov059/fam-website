import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("independent QA rejects an applied patch with a failing regression test", () => {
  const root = mkdtempSync(join(tmpdir(), "fam-agent-qa-rejection-"));
  const fixturePath = join("tests", "synthetic-regression.test.mjs");
  const absoluteFixturePath = join(root, fixturePath);
  const original = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'test("synthetic invariant", () => assert.equal(2 + 2, 4));',
    "",
  ].join("\n");
  const broken = original.replace("assert.equal(2 + 2, 4)", "assert.equal(2 + 2, 5)");

  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(absoluteFixturePath, original);
    execFileSync("git", ["-C", root, "add", fixturePath]);
    execFileSync("git", [
      "-C", root, "-c", "user.name=FAM QA", "-c", "user.email=fam-qa@example.invalid",
      "commit", "--quiet", "-m", "synthetic fixture",
    ]);

    writeFileSync(absoluteFixturePath, broken);
    const patch = execFileSync("git", ["-C", root, "diff", "--no-ext-diff", "--no-color"], {
      encoding: "utf8",
    });
    assert.ok(patch.includes("assert.equal(2 + 2, 5)"), "fixture must contain a real Git patch");

    writeFileSync(absoluteFixturePath, original);
    const patchPath = join(root, "synthetic.patch");
    writeFileSync(patchPath, patch);
    execFileSync("git", ["-C", root, "apply", "--check", patchPath]);
    execFileSync("git", ["-C", root, "apply", patchPath]);
    assert.equal(readFileSync(absoluteFixturePath, "utf8"), broken);

    const qa = spawnSync(process.execPath, ["--test", fixturePath], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(qa.error, undefined, qa.error?.message);
    assert.notEqual(qa.status, 0, "independent regression QA must reject the deliberately broken patch");
    assert.match(qa.stdout + qa.stderr, /synthetic invariant|AssertionError/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
