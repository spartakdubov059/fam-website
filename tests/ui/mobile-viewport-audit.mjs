import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const html = await readFile(resolve(process.cwd(), "index.html"), "utf8");
const listing = {
  id: "e65ad519-bcb1-4b6b-8514-5e1b2b82a1e9",
  user_id: "f5a84e7c-75ea-4b5c-94e4-2e3f9a8d5a1b",
  title: "Тестовый VR-шлем",
  description: "Полное тестовое описание VR-шлема. В нём есть важные подробности, которые должны полностью отображаться в отдельном окне объявления.",
  category: "Вещи",
  price_text: "10 000 ₽",
  created_at: "2026-11-12T12:00:00.000Z",
  status: "active",
  moderation_status: "approved",
  photo_status: "pending",
  image_url: null,
  is_event: false
};

const sdkMock = `
window.supabase = {
  createClient: function () {
    function query(table) {
      const result = {
        select: function () { return result; },
        eq: function () { return result; },
        or: function () { return result; },
        order: function () { return result; },
        limit: function () { return result; },
        then: function (resolve, reject) {
          const data = table === "listings" ? [${JSON.stringify(listing)}] : [];
          return Promise.resolve({ data: data, error: null }).then(resolve, reject);
        }
      };
      return result;
    }
    return {
      auth: {
        getSession: async function () { return { data: { session: null }, error: null }; }
      },
      from: query
    };
  }
};
`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 360, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));
await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0", route =>
  route.fulfill({ status: 200, contentType: "application/javascript", body: sdkMock })
);
await page.route("https://tfacqpljrvfpcrhdovbu.supabase.co/**", route =>
  route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
);

try {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.locator("#listingsGrid .l-card").waitFor({ state: "visible", timeout: 10000 });

  const widths = [
    { width: 360, height: 844, columns: 2 },
    { width: 360, height: 640, columns: 2 },
    { width: 375, height: 812, columns: 2 },
    { width: 375, height: 667, columns: 2 },
    { width: 390, height: 844, columns: 2 },
    { width: 430, height: 932, columns: 2 },
    { width: 667, height: 375, columns: 3 },
    { width: 844, height: 390, columns: 3 },
    { width: 768, height: 1024, columns: 3 },
    { width: 820, height: 1180, columns: 3 },
    { width: 834, height: 1112, columns: 3 },
    { width: 1024, height: 768, columns: 4 },
    { width: 1194, height: 834, columns: 4 },
    { width: 1366, height: 900, columns: 4 }
  ];

  for (const size of widths) {
    await page.setViewportSize({ width: size.width, height: size.height });
    const metrics = await page.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      };
      const grid = document.querySelector("#listingsGrid");
      const button = document.querySelector(".l-details-btn");
      return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        mainClientWidth: document.querySelector("main").clientWidth,
        mainScrollWidth: document.querySelector("main").scrollWidth,
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length : 0,
        header: rect(".header-inner"),
        main: rect("main"),
        categories: rect(".cat-tiles"),
        search: rect(".search-pill"),
        grid: rect("#listingsGrid"),
        tabbar: rect(".tabbar"),
        card: rect(".l-card"),
        detailsButtonHeight: button ? button.getBoundingClientRect().height : 0
      };
    });

    assert.equal(metrics.viewport, size.width, "Chromium viewport must match the requested width");
    assert.ok(metrics.documentWidth <= size.width + 1, `document has horizontal overflow at ${size.width}px: ${metrics.documentWidth}px`);
    assert.ok(metrics.bodyWidth <= size.width + 1, `body has horizontal overflow at ${size.width}px: ${metrics.bodyWidth}px`);
    assert.ok(metrics.mainScrollWidth <= metrics.mainClientWidth + 1, `main content overflows horizontally at ${size.width}px`);
    assert.equal(metrics.columns, size.columns, `unexpected card column count at ${size.width}px`);

    for (const [name, box] of Object.entries(metrics)) {
      if (!box || typeof box !== "object" || !("right" in box)) continue;
      assert.ok(box.left >= -1 && box.right <= size.width + 1, `${name} escapes viewport at ${size.width}px`);
    }
    assert.ok(metrics.detailsButtonHeight >= 40, `details button is too small at ${size.width}px`);

    await page.locator(".l-details-btn").click();
    const modalMetrics = await page.locator("#listingDetailsModal").evaluate(node => {
      const box = node.querySelector(".listing-details-content").getBoundingClientRect();
      return { open: node.classList.contains("open"), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    });
    assert.equal(modalMetrics.open, true, `details modal did not open at ${size.width}px`);
    assert.ok(modalMetrics.left >= -1 && modalMetrics.right <= size.width + 1, `details modal overflows horizontally at ${size.width}px`);
    assert.ok(modalMetrics.top >= -1 && modalMetrics.bottom <= size.height + 1, `details modal exceeds viewport at ${size.width}px`);

    const fullDescription = await page.locator("#listingDetailsBody .listing-detail-description").textContent();
    assert.equal(fullDescription, listing.description, "full description must be readable in the details dialog");
    const pendingPhotoText = await page.locator("#listingDetailsBody .listing-detail-photo-placeholder").textContent();
    assert.match(pendingPhotoText, /Фото проверяется/);
    await page.locator('[data-action="close-listing-details"]').click();

    const inspectSection = async (tab, section, visibleSelector) => {
      await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
      await page.waitForTimeout(500);
      const state = await page.evaluate(({ sectionId, visibleId }) => {
        const active = document.getElementById(sectionId);
        const visible = document.querySelector(visibleId);
        const box = active?.getBoundingClientRect();
        return {
          active: !!active && !active.classList.contains("hidden"),
          visible: !!visible && getComputedStyle(visible).display !== "none",
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          mainWidth: document.querySelector("main").clientWidth,
          mainScrollWidth: document.querySelector("main").scrollWidth,
          section: box ? { left: box.left, right: box.right, width: box.width } : null
        };
      }, { sectionId: section, visibleId: visibleSelector });
      assert.equal(state.active, true, `${tab} section is not active at ${size.width}px`);
      assert.equal(state.visible, true, `${tab} guest content is not visible at ${size.width}px`);
      assert.ok(state.documentWidth <= size.width + 1, `${tab} causes document overflow at ${size.width}px`);
      assert.ok(state.bodyWidth <= size.width + 1, `${tab} causes body overflow at ${size.width}px`);
      assert.ok(state.mainScrollWidth <= state.mainWidth + 1, `${tab} content overflows main at ${size.width}px`);
      assert.ok(state.section && state.section.left >= -1 && state.section.right <= size.width + 1, `${tab} escapes viewport at ${size.width}px`);
    };

    await inspectSection("favorites", "favoritesSection", "#favoritesEmpty");
    await inspectSection("profile", "profileSection", "#profileLoggedOut");
    await inspectSection("messages", "messagesSection", "#dialogsGuest");

    // Login and listing forms are checked without submitting or creating real records.
    await page.locator('#dialogsGuest [data-action="open-auth"]').click();
    const authMetrics = await page.locator("#authModal .modal-content").evaluate(node => {
      const box = node.getBoundingClientRect();
      return { open: node.closest(".modal").classList.contains("open"), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
    });
    assert.equal(authMetrics.open, true, `login modal did not open at ${size.width}px`);
    assert.ok(authMetrics.left >= -1 && authMetrics.right <= size.width + 1, `login modal overflows horizontally at ${size.width}px`);
    assert.ok(authMetrics.top >= -1 && authMetrics.bottom <= size.height + 1, `login modal exceeds viewport at ${size.width}px`);
    await page.locator('[data-action="close-auth-modal"]').click();

    await page.evaluate(() => window.openModal("listingModal"));
    const formMetrics = await page.locator("#listingModal .modal-content").evaluate(node => {
      const box = node.getBoundingClientRect();
      const controls = [...node.querySelectorAll(".form-control")].filter(el => el.getClientRects().length > 0).map(el => {
        const field = el.getBoundingClientRect();
        return { id: el.id, left: field.left, right: field.right, width: field.width };
      });
      return {
        open: node.closest(".modal").classList.contains("open"),
        left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width,
        controls
      };
    });
    assert.equal(formMetrics.open, true, `listing form did not open at ${size.width}px`);
    assert.ok(formMetrics.left >= -1 && formMetrics.right <= size.width + 1, `listing form overflows horizontally at ${size.width}px`);
    assert.ok(formMetrics.top >= -1 && formMetrics.bottom <= size.height + 1, `listing form exceeds viewport at ${size.width}px`);
    for (const control of formMetrics.controls) {
      assert.ok(control.left >= formMetrics.left - 1 && control.right <= formMetrics.right + 1, `listing form field ${control.id} escapes its modal at ${size.width}px: ${JSON.stringify(control)} modal=${JSON.stringify({left: formMetrics.left, right: formMetrics.right})}`);
    }
    await page.locator('[data-action="close-listing-modal"]').click();

    await page.locator('.tab-btn[data-tab="board"]').click();
    await page.waitForTimeout(500);

    console.log(JSON.stringify({
      width: size.width,
      height: size.height,
      columns: metrics.columns,
      documentWidth: metrics.documentWidth,
      cardWidth: Math.round(metrics.card?.width || 0),
      detailsModalWidth: Math.round(modalMetrics.width),
      authModalWidth: Math.round(authMetrics.width),
      listingFormWidth: Math.round(formMetrics.width),
      guestSections: "PASS",
      result: "PASS"
    }));
  }

  assert.deepEqual(pageErrors, [], "page must not throw JavaScript errors during viewport tests");
  console.log(`FAM responsive viewport audit: ${widths.length}/${widths.length} sizes passed (mobile, landscape, tablet and iPad).`);
} finally {
  await browser.close();
}
