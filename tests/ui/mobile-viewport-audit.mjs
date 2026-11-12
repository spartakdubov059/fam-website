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
const approvedListing = {
  id: "8b07e0b4-4fd3-4a95-9715-7cdac57d22b1",
  user_id: "f5a84e7c-75ea-4b5c-94e4-2e3f9a8d5a1b",
  title: "Тестовое объявление с фото",
  description: "Проверка показа изображения после успешной модерации.",
  category: "Вещи",
  price_text: "5 000 ₽",
  created_at: "2026-11-12T11:00:00.000Z",
  status: "active",
  moderation_status: "approved",
  photo_status: "approved",
  image_url: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
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
          const data = table === "listings" ? [${JSON.stringify(listing)}, ${JSON.stringify(approvedListing)}] : [];
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
await page.addInitScript(() => {
  window.__helperFetchCalls = 0;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    window.__helperFetchCalls += 1;
    return originalFetch(...args);
  };
});
await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0", route =>
  route.fulfill({ status: 200, contentType: "application/javascript", body: sdkMock })
);
await page.route("https://tfacqpljrvfpcrhdovbu.supabase.co/**", route =>
  route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
);

try {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.locator("#listingsGrid .l-card").first().waitFor({ state: "visible", timeout: 10000 });

  // Verify local category hints and the description helper using real form controls.
  await page.evaluate(() => window.openModal("listingModal"));
  const categoryHintResults = [];
  const checkHint = async ({ title, description = "", currentCategory = "Вещи", expectedCategory = null, shouldSelect = false }) => {
    await page.locator("#lCat").selectOption(currentCategory);
    await page.locator("#lTitle").fill(title);
    await page.locator("#lDesc").fill(description);
    await page.waitForTimeout(360);
    const hintButton = page.locator("#aiHints [data-action='select-hint-category']");
    const count = await hintButton.count();
    const hintText = await page.locator("#aiHints").textContent();

    if (expectedCategory && expectedCategory === currentCategory) {
      assert.equal(count, 0, `already-selected category should not show a selection button for "${title}"`);
      assert.ok(hintText && hintText.includes(expectedCategory), `selected category confirmation missing for "${title}": ${hintText}`);
    } else if (expectedCategory) {
      assert.equal(count, 1, `category suggestion missing for "${title}"`);
      const label = await hintButton.textContent();
      assert.ok(label && label.includes(expectedCategory), `wrong category suggestion for "${title}": ${label}`);
      if (shouldSelect) {
        await hintButton.click();
        assert.equal(await page.locator("#lCat").inputValue(), expectedCategory, "suggested category must be selectable");
      }
    } else {
      assert.equal(count, 0, `unexpected category suggestion for "${title}"`);
    }
    categoryHintResults.push({ title, suggestion: expectedCategory || null, selected: shouldSelect });
  };

  await checkHint({ title: "VR-шлем Meta Quest 3", expectedCategory: "Вещи" });
  await checkHint({ title: "Продам VR-шлем Meta Quest 3", currentCategory: "Услуги", expectedCategory: "Вещи", shouldSelect: true });
  await checkHint({ title: "Репетитор по английскому", currentCategory: "Вещи", expectedCategory: "Услуги", shouldSelect: true });
  await checkHint({ title: "Подготовка к ОГЭ по математике", currentCategory: "Вещи", expectedCategory: "Учёба", shouldSelect: true });
  await page.locator("#evOption").evaluate(node => { node.style.display = "block"; });
  await checkHint({ title: "Квиз по робототехнике", currentCategory: "Вещи", expectedCategory: "Мероприятия", shouldSelect: true });
  await page.locator("#evOption").evaluate(node => { node.style.display = "none"; });
  await checkHint({ title: "Конспект по физике", currentCategory: "Вещи", expectedCategory: "Учёба", shouldSelect: true });
  await checkHint({ title: "Люблю объяснять сложные темы", description: "Подготовка к контрольной по алгебре", currentCategory: "Вещи", expectedCategory: "Учёба" });
  await checkHint({ title: "Необычная идея для вечера", expectedCategory: null });

  // Description drafts are local templates: they include placeholders rather than invented facts.
  await page.locator("#lCat").selectOption("Вещи");
  await page.locator("#lTitle").fill("VR-шлем Meta Quest 3");
  await page.locator("#lDesc").fill("");
  const helperFetchesBefore = await page.evaluate(() => window.__helperFetchCalls);
  await page.locator('[data-action="open-description-helper"]').click();
  assert.equal(await page.locator("#descriptionHelperPanel").isVisible(), true, "description helper panel must open");
  let draft = await page.locator("#descriptionHelperDraft").textContent();
  assert.ok(draft.includes("VR-шлем Meta Quest 3"), "draft must use the entered title");
  assert.ok(draft.includes("Состояние: [укажите реальное состояние]"), "item draft must ask for real condition");
  await page.locator('[data-action="insert-description-draft"][data-mode="append"]').click();
  let inserted = await page.locator("#lDesc").inputValue();
  assert.ok(inserted.includes("VR-шлем Meta Quest 3") && inserted.includes("Комплектация:"), "item template must be inserted into description");

  await page.locator("#lDesc").fill("Уже указал важную информацию.");
  await page.locator('[data-action="open-description-helper"]').click();
  await page.locator('[data-action="insert-description-draft"][data-mode="append"]').click();
  inserted = await page.locator("#lDesc").inputValue();
  assert.ok(inserted.startsWith("Уже указал важную информацию."), "append mode must preserve existing description");
  assert.ok(inserted.includes("Состояние:"), "append mode must add the draft");

  await page.locator("#lDesc").fill("Старый текст, который заменяется.");
  await page.locator('[data-action="open-description-helper"]').click();
  await page.locator('[data-action="insert-description-draft"][data-mode="replace"]').click();
  inserted = await page.locator("#lDesc").inputValue();
  assert.ok(!inserted.includes("Старый текст"), "replace mode must replace the old description");

  await page.locator("#lCat").selectOption("Учёба");
  await page.locator('[data-action="open-description-helper"]').click();
  draft = await page.locator("#descriptionHelperDraft").textContent();
  assert.ok(draft.includes("Уровень:") && draft.includes("Формат:"), "study template must use study-specific prompts");
  await page.locator("#lCat").selectOption("Услуги");
  draft = await page.locator("#descriptionHelperDraft").textContent();
  assert.ok(draft.includes("Что входит:"), "service template must update when category changes");
  const helperFetchesAfter = await page.evaluate(() => window.__helperFetchCalls);
  assert.equal(helperFetchesAfter, helperFetchesBefore, "category hints and description helper must not call any API");
  await page.locator('[data-action="close-description-helper"]').click();
  await page.locator('[data-action="close-listing-modal"]').click();

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

    await page.locator("#listingsGrid .l-card").first().locator(".l-details-btn").click();
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

    const approvedCard = page.locator("#listingsGrid .l-card").nth(1);
    await approvedCard.locator(".l-details-btn").click();
    const approvedImage = await page.locator("#listingDetailsBody .listing-detail-image").evaluate(async img => {
      await img.decode();
      return { complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
    });
    assert.equal(approvedImage.complete, true, "approved photo must finish loading in details");
    assert.ok(approvedImage.naturalWidth > 0 && approvedImage.naturalHeight > 0, "approved photo must have non-zero intrinsic dimensions");
    const approvedDescription = await page.locator("#listingDetailsBody .listing-detail-description").textContent();
    assert.equal(approvedDescription, approvedListing.description, "approved listing description must be rendered");
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
      approvedPhoto: "PASS",
      categoryHints: "PASS"
    }));
  }

  assert.deepEqual(pageErrors, [], "page must not throw JavaScript errors during viewport tests");
  console.log(`FAM responsive viewport audit: ${widths.length}/${widths.length} sizes passed (mobile, landscape, tablet and iPad). Category hint cases: ${categoryHintResults.length}/${categoryHintResults.length} passed.`);
} finally {
  await browser.close();
}
