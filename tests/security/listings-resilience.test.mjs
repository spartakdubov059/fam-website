import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const match = html.match(/  function renderListings\(\) \{[\s\S]*?\n  \}/);
assert.ok(match, "renderListings must exist");

function renderBoard({ failed, listings = [], signedIn = true }) {
  const grid = { innerHTML: "", querySelector: () => ({ addEventListener(_name, cb) { grid.retry = cb; } }) };
  const search = { value: "" };
  let retries = 0;
  const context = {
    $: id => id === "listingsGrid" ? grid : id === "searchInput" ? search : null,
    listings, listingsLoadFailed: failed, curCat: "Все", ARROW: "",
    user: signedIn ? { id: "test-student" } : null,
    listingCard: l => "<article>" + l.title + "</article>",
    loadAll: () => { retries++; }
  };
  runInNewContext(match[0] + "\nthis.renderListings = renderListings;", context);
  context.renderListings();
  return { grid, retries: () => retries };
}

test("a failed listing request shows an explicit retry instead of false empty results", () => {
  const page = renderBoard({ failed: true });
  assert.match(page.grid.innerHTML, /Не удалось обновить объявления/);
  assert.match(page.grid.innerHTML, /role="alert"/);
  assert.doesNotMatch(page.grid.innerHTML, /Ничего не найдено/);
  assert.equal(typeof page.grid.retry, "function");
  page.grid.retry();
  assert.equal(page.retries(), 1);
});

test("failed refresh preserves already rendered listings", () => {
  const page = renderBoard({ failed: true, listings: [{ status: "active", title: "Книга", description: "", category: "Вещи" }] });
  assert.match(page.grid.innerHTML, /Книга/);
  assert.match(page.grid.innerHTML, /Не удалось обновить объявления/);
});

test("genuinely empty successful result shows normal empty state without retry", () => {
  const page = renderBoard({ failed: false });
  assert.match(page.grid.innerHTML, /Ничего не найдено/);
  assert.doesNotMatch(page.grid.innerHTML, /Не удалось обновить объявления/);
  assert.equal(page.grid.retry, undefined);
});

test("independent backend failures do not wipe cached registrations, ideas, or favorites", () => {
  assert.match(html, /listingsLoadFailed = Boolean\(results\[0\]\?\.error\)/);
  assert.match(html, /if \(!results\[2\]\.error\) regs = results\[2\]\.data \|\| \[\]/);
  assert.match(html, /if \(!results\[3\]\.error\) \{/);
  assert.match(html, /if \(!results\[4\]\.error\) favorites = results\[4\]\.data \|\| \[\]/);
});


test("signed-out school visitors get an explicit login gate", () => {
  const page = renderBoard({ failed: false, signedIn: false });
  assert.match(page.grid.innerHTML, /Войдите, чтобы смотреть объявления/);
  assert.match(page.grid.innerHTML, /data-action="open-auth"/);
  assert.doesNotMatch(page.grid.innerHTML, /Ничего не найдено/);
});
