import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const sql = readFileSync(
  new URL("../../supabase/migrations/20261124200000_make_fam_avatars_private.sql", import.meta.url), "utf8"
);
const begin = html.indexOf("  let ownAvatarSignedUrl = null;");
const end = html.indexOf("  function updateAuthUI()", begin);
assert.ok(begin > 0 && end > begin, "Private avatar hydration functions must exist");
const source = html.slice(begin, end);
const host = "https://tfacqpljrvfpcrhdovbu.supabase.co";
const uid = "11111111-2222-4333-8444-555555555555";
const ownPath = uid + "/avatar_" + uid + "_sample.webp";
const stored = host + "/storage/v1/object/public/avatars/" + ownPath;
const signed = host + "/storage/v1/object/sign/avatars/" + ownPath + "?token=short-lived";

function app({ avatarUrl = stored, signedUrl = signed, error = null, viewerId = uid } = {}) {
  const nodes = Object.fromEntries(
    ["headerAvatar", "avatarPreview", "avatarSettingsPreview"].map(id => [
      id, {
        textContent: "",
        children: [],
        replaceChildren(image) { this.children = [image]; },
      },
    ])
  );
  const calls = [];
  const context = {
    URL, Date, decodeURIComponent,
    SUPABASE_URL: host,
    user: { id: viewerId },
    profile: { avatar_url: avatarUrl, first_name: "Ученик" },
    document: { createElement(tag) { assert.equal(tag, "img"); return {src: "", alt: ""}; } },
    $: id => nodes[id],
    sb: { storage: { from(bucket) {
      assert.equal(bucket, "avatars");
      return { async createSignedUrl(path, seconds) {
        calls.push({path, seconds});
        return { data: {signedUrl}, error };
      }};
    }}},
  };
  runInNewContext(source + "\nthis.privateAvatar = { ownAvatarStoragePath, hydrateOwnAvatar, renderOwnAvatarElements };", context);
  return { ...context.privateAvatar, nodes, calls };
}

test("avatars bucket is private and no public photo read policy remains", () => {
  assert.match(sql, /update\s+storage\.buckets[\s\S]*public\s*=\s*false/i);
  assert.match(sql, /drop policy if exists "public read avatars"/i);
  assert.match(sql, /for select\s+to authenticated/i);
  assert.match(sql, /bucket_id\s*=\s*'avatars'/i);
  assert.match(sql, /storage\.foldername\(name\)/i);
  assert.match(sql, /auth\.uid\(\)/i);
});

test("current user's avatar only appears after a valid short-lived signed URL", async () => {
  const h = app();
  h.renderOwnAvatarElements();
  assert.equal(h.nodes.headerAvatar.textContent, "У");
  assert.equal(h.nodes.headerAvatar.children.length, 0);
  assert.equal(h.ownAvatarStoragePath(), ownPath);
  await h.hydrateOwnAvatar();
  h.renderOwnAvatarElements();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, ownPath);
  assert.equal(h.calls[0].seconds, 3600);
  for (const node of Object.values(h.nodes)) {
    assert.equal(node.children.length, 1);
    assert.equal(node.children[0].src, signed);
    assert.notEqual(node.children[0].src, stored);
  }
  await h.hydrateOwnAvatar();
  assert.equal(h.calls.length, 1, "valid signed avatar should be reused");
});

test("another user's stored avatar URL must never be signed on this account", async () => {
  const other = host + "/storage/v1/object/public/avatars/other-user/photo.webp";
  const h = app({avatarUrl: other});
  assert.equal(h.ownAvatarStoragePath(), null);
  await h.hydrateOwnAvatar();
  h.renderOwnAvatarElements();
  assert.equal(h.calls.length, 0);
  assert.equal(h.nodes.avatarPreview.children.length, 0);
});

test("signing failure never falls back to a public URL", async () => {
  const h = app({signedUrl: null, error: {message: "simulated network failure"}});
  await h.hydrateOwnAvatar();
  h.renderOwnAvatarElements();
  assert.equal(h.nodes.headerAvatar.children.length, 0);
  assert.equal(h.nodes.headerAvatar.textContent, "У");
});

test("legacy public avatar location is never inserted into DOM markup", () => {
  assert.doesNotMatch(html, /<img src="\$\{esc\(profile\.avatar_url\)\}"/);
  assert.match(html, /void hydrateOwnAvatar\(\)\.then\(renderOwnAvatarElements\)/);
});
