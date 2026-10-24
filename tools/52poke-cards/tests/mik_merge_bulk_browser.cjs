// node tests/mik_merge_bulk_browser.cjs HTTP_URL OUTPUT_DIR EXPECTED_COUNT
// Uses only the read-only review HTTP API, never source exports or cloud APIs.
// PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE can select existing local installs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "@playwright/test");

(async () => {
  assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
    "Usage: node mik_merge_bulk_browser.cjs HTTP_URL OUTPUT_DIR EXPECTED_COUNT");
  const url = new URL(process.argv[2]);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) &&
    !url.username && !url.password, "Only a credential-free loopback HTTP URL is allowed.");
  const output = path.resolve(process.argv[3]), expected = Number(process.argv[4]);
  assert.ok(Number.isSafeInteger(expected) && expected >= 0, "Expected count must be a non-negative integer.");
  await fs.mkdir(output, {recursive:true});
  const browser = await chromium.launch({
    headless:true, args:["--no-sandbox"],
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
  });
  const errors = [], external = [];
  let firstId, blockedImageChecked = false, modelEvidenceChecked = false;
  try {
    const context = await browser.newContext({viewport:{width:1500, height:1000}, acceptDownloads:true});
    await context.route("**/*", route => {
      const request = new URL(route.request().url());
      if (["http:", "https:"].includes(request.protocol) && request.origin !== url.origin) {
        external.push(request.href); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    const endpoint = route => new URL(route, url.origin).href;
    const api = async route => {
      const response = await context.request.get(endpoint(route));
      assert.equal(response.status(), 200, route);
      return response.json();
    };
    const waitList = () => page.waitForFunction(() =>
      document.querySelector("#card-list").getAttribute("aria-busy") === "false");
    const waitCard = () => page.waitForFunction(() => !document.querySelector("#card-content").hidden);
    const search = async text => {
      const response = page.waitForResponse(response => {
        const request = new URL(response.url());
        return request.pathname === "/api/cards" && request.searchParams.get("q") === text && response.ok();
      });
      await page.locator("#search").fill(text);
      await response; await waitList();
    };
    const assertImage = async () => {
      await page.locator("#card-image").evaluate(async image => {
        if (!image.getAttribute("src")) throw new Error("Catalog image missing from detail DOM.");
        await image.decode();
        if (!image.naturalWidth) throw new Error("Image failed to decode.");
      });
    };
    const summary = await api("/api/summary");
    assert.equal(summary.total, expected);
    assert.equal(summary.ready + summary.needs_review + summary.blocked, expected);
    await page.goto(url.href);
    await page.waitForFunction(count => document.querySelector("#count-total").textContent.replace(/[,\s]/g, "") === String(count), expected);
    await waitList();
    const initial = await api("/api/cards?page_size=50");
    assert.equal(await page.locator(".queue-card").count(), Math.min(50, expected));
    assert.equal(await page.locator("img[onerror],script:not([src])").count(), 0);
    if (expected) {
      await waitCard();
      firstId = initial.cards[0].mik_id;
      const first = await api(`/api/card?${new URLSearchParams({mik_id:firstId})}`);
      if (first.card.image_url) await assertImage();
      if (first.detail.semantic_equivalence?.length) {
        await page.locator('[data-panel="evidence"]').click();
        assert.ok((await page.locator("#semantic-evidence").innerText()).length > 0);
        modelEvidenceChecked = true;
        await page.locator('[data-panel="compare"]').click();
      }

      // Last page is based on the supplied count, never a historical fixture size.
      await page.locator("#page-size").selectOption("200");
      await waitList();
      const lastPage = Math.ceil(expected / 200);
      await page.locator("#page-number").fill(String(lastPage));
      await page.locator("#go-page").click();
      await waitList();
      await page.waitForFunction(last => document.querySelector("#page-position").textContent.startsWith(`${last} /`), lastPage);
      const last = await api(`/api/cards?page_size=200&page=${lastPage}`);
      assert.equal(last.cards.length, (expected - 1) % 200 + 1);
      assert.equal(await page.locator(".queue-card").count(), last.cards.length);
      await page.locator(".queue-card").last().click();
      await waitCard();
      assert.match(await page.locator("#card-identity").innerText(),
        new RegExp(last.cards.at(-1).mik_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      // Every machine-status filter, including unmatched/blocked records.
      for (const status of ["ready", "needs_review", "blocked"]) {
        await page.locator("#status-filter").selectOption(status);
        await waitList();
        const filtered = await api(`/api/cards?page_size=200&status=${status}`);
        await page.waitForFunction(count => document.querySelector("#list-count").textContent.split(" / ")[0].replace(/,/g, "") === String(count), filtered.total);
        assert.equal(await page.locator(".queue-card").count(), Math.min(200, filtered.total));
      }
      if (summary.blocked) {
        const blocked = await api("/api/cards?status=blocked&page_size=200");
        let withImage = blocked.cards.find(card => card.image_url);
        for (let pageNumber = 2; !withImage && pageNumber <= blocked.pages; pageNumber++) {
          const next = await api(`/api/cards?status=blocked&page_size=200&page=${pageNumber}`);
          withImage = next.cards.find(card => card.image_url);
        }
        if (withImage) {
          await page.locator("#clear-filters").click();
          await search(withImage.mik_id);
          await page.locator(`[data-card-id="${withImage.mik_id}"]`).click();
          await waitCard();
          await assertImage();
          const detail = await api(`/api/card?${new URLSearchParams({mik_id:withImage.mik_id})}`);
          if (detail.detail.mik_metadata?.description)
            assert.ok((await page.locator("#mik-description").innerText()).includes(detail.detail.mik_metadata.description));
          blockedImageChecked = true;
        }
      }
      // Set/hold filters and exact-identity search, independent of fixture names.
      await page.locator("#clear-filters").click(); await waitList();
      if (summary.sets.length) {
        const set = summary.sets[0].set_code;
        await page.locator("#set-filter").selectOption(set); await waitList();
        const filtered = await api(`/api/cards?${new URLSearchParams({set, page_size:"200"})}`);
        assert.equal(await page.locator(".queue-card").count(), Math.min(200, filtered.total));
      }
      await page.locator("#clear-filters").click(); await waitList();
      if (summary.reasons.length) {
        const reason = summary.reasons[0].code;
        await page.locator("#reason-filter").selectOption(reason); await waitList();
        const filtered = await api(`/api/cards?${new URLSearchParams({reason, page_size:"200"})}`);
        assert.equal(await page.locator(".queue-card").count(), Math.min(200, filtered.total));
      }
      await page.locator("#clear-filters").click(); await waitList();
      await search(firstId);
      await page.locator(`[data-card-id="${firstId}"]`).click();
      await waitCard();
      const note = "本机浏览器测试意见 <img src=x onerror=alert(1)>";
      await page.locator("#review-notes").fill(note);
      await page.locator("#review-decision").selectOption("needs_review");
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#export-button").click();
      const downloaded = await downloadPromise, opinionPath = path.join(output, "human-opinions.json");
      await downloaded.saveAs(opinionPath);
      const opinions = JSON.parse(await fs.readFile(opinionPath, "utf8"));
      assert.equal(opinions.dataset_fingerprint, summary.dataset_fingerprint);
      assert.equal(opinions.cards.find(entry => entry.mik_id === firstId).review.notes, note);
      await page.reload(); await waitList(); await waitCard();
      assert.equal(await page.locator("#review-notes").inputValue(), note);
      // Valid import and invalid fingerprint/unknown identity imports are atomic.
      await page.locator("#review-notes").fill("temporary");
      await page.locator("#import-file").setInputFiles(opinionPath);
      await page.waitForFunction(() => document.querySelector("#announcement").textContent.includes("已导入"));
      assert.equal(await page.locator("#review-notes").inputValue(), note);
      const wrong = structuredClone(opinions);
      wrong.dataset_fingerprint = "wrong-dataset";
      const wrongPath = path.join(output, "wrong-fingerprint.json");
      await fs.writeFile(wrongPath, JSON.stringify(wrong));
      await page.locator("#import-file").setInputFiles(wrongPath);
      await page.waitForFunction(() => document.querySelector("#announcement").textContent.includes("数据指纹不同"));
      assert.equal(await page.locator("#review-notes").inputValue(), note);
      const unknown = structuredClone(opinions);
      unknown.cards[0].mik_id = "UNKNOWN/unknown-synthetic-review-id";
      const unknownPath = path.join(output, "unknown-identity.json");
      await fs.writeFile(unknownPath, JSON.stringify(unknown));
      await page.locator("#import-file").setInputFiles(unknownPath);
      await page.waitForFunction(() => document.querySelector("#announcement").textContent.includes("未知卡牌"));
      assert.equal(await page.locator("#review-notes").inputValue(), note);
      const mismatched = structuredClone(opinions);
      mismatched.cards[0].wiki_id = "wrong-candidate-identity";
      const mismatchPath = path.join(output, "wrong-candidate.json");
      await fs.writeFile(mismatchPath, JSON.stringify(mismatched));
      await page.locator("#import-file").setInputFiles(mismatchPath);
      await page.waitForFunction(() => document.querySelector("#announcement").textContent.includes("身份不同"));
      assert.equal(await page.locator("#review-notes").inputValue(), note);
      assert.equal(await page.locator("img[onerror]").count(), 0);
      await page.locator('[data-panel="compare"]').focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("#panel-evidence").isVisible(), true);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({path:path.join(output, "desktop.png"), fullPage:true});
    await page.setViewportSize({width:390, height:844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({path:path.join(output, "mobile.png"), fullPage:true});
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = {
      total:expected, bounded_pagination:true, last_page_verified:expected > 0,
      search_set_status_hold_filters:true, blocked_detail_image:blockedImageChecked,
      existing_model_evidence:modelEvidenceChecked, text_only_source_rendering:true,
      opinions_separate_reload_export_import:true, rejected_imports_atomic:true,
      desktop_mobile_no_overflow:true, external_requests:external, browser_errors:errors,
    };
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
