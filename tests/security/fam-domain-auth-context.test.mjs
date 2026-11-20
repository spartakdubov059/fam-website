import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const script = html.match(/<head>\s*<script>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(script, "fallback redirect must have an inline startup script");

function simulate({ session = null, search = "", hash = "", deferHealth = false, healthOk = true, markerReady = true } = {}) {
  const navigations = [];
  const images = [];
  let fetchCount = 0;
  let storedSession = session;
  let resolveHealth;
  const response = { ok: healthOk, json: async () => ({ site: "famru", ok: markerReady }) };
  const context = {
    window: {
      location: {
        hostname: "spartakdubov059.github.io", pathname: "/fam-website/",
        search, hash, replace: url => navigations.push(url),
      },
      localStorage: { getItem: () => storedSession },
      AbortController: class { abort() {} },
    },
    fetch: () => {
      fetchCount++;
      return deferHealth ? new Promise(resolve => { resolveHealth = resolve; }) : Promise.resolve(response);
    },
    Image: class {
      naturalWidth = 0;
      set src(url) { images.push({ url, element: this }); }
    },
    AbortController: class { abort() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  runInNewContext(script, context, { timeout: 1000 });
  return {
    navigations, get fetchCount() { return fetchCount; },
    get imageCount() { return images.length; },
    get imageUrl() { return images[0]?.url; },
    resolveImage(ok) {
      const image = images[images.length - 1]?.element;
      assert.ok(image, "an image reachability probe must exist");
      image.naturalWidth = ok ? 1200 : 0;
      if (ok) image.onload?.(); else image.onerror?.();
    },
    setSession(value) { storedSession = value; },
    respond() { if (resolveHealth) resolveHealth(response); },
    settle: () => new Promise(resolve => setImmediate(resolve)),
  };
}

const signedIn = JSON.stringify({ access_token: "local-access-token", refresh_token: "local-refresh-token" });

test("an existing GitHub Pages login uses the canonical host when it is healthy", async () => {
  const page = simulate({ session: signedIn });
  await page.settle();
  assert.equal(page.fetchCount, 1);
  assert.deepEqual(page.navigations, ["https://famru.netlify.app/"]);
});

test("Supabase email confirmation callback remains on the intended host", async () => {
  const page = simulate({ search: "?code=confirmation" });
  await page.settle();
  assert.equal(page.fetchCount, 0);
  assert.deepEqual(page.navigations, ["https://famru.netlify.app/"]);
});

test("new guest still redirects to healthy primary host with URL state preserved", async () => {
  const page = simulate({ search: "?utm_source=school", hash: "#board" });
  await page.settle();
  assert.equal(page.fetchCount, 1);
  assert.deepEqual(page.navigations, ["https://famru.netlify.app/?utm_source=school#board"]);
});

test("late login state does not split users across healthy domains", async () => {
  const page = simulate({ deferHealth: true });
  assert.equal(page.fetchCount, 1);
  page.setSession(signedIn);
  page.respond();
  await page.settle();
  assert.deepEqual(page.navigations, ["https://famru.netlify.app/"]);
});


test("missing Netlify readiness marker never redirects even if its assets might load", async () => {
  const page = simulate({ healthOk: false });
  await page.settle();
  assert.equal(page.fetchCount, 1);
  assert.equal(page.imageCount, 0, "image reachability is not application readiness");
  assert.deepEqual(page.navigations, []);
});

test("a 200 response without an explicit ready flag keeps the independent fallback", async () => {
  const page = simulate({ markerReady: false });
  await page.settle();
  assert.deepEqual(page.navigations, []);
});

test("a ready marker redirects even when local session state exists", async () => {
  const page = simulate({ deferHealth: true });
  page.setSession(signedIn);
  page.respond();
  await page.settle();
  assert.deepEqual(page.navigations, []);
});
