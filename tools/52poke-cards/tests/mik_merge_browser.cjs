// Usage: node tests/mik_merge_browser.cjs /absolute/run/semantic-v2/review.html [output-dir]
// Runtime artifacts go to the OS temp directory by default, never into source.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "@playwright/test");

(async () => {
  assert.ok(process.argv[2], "Pass a generated local review.html.");
  const htmlPath = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mik-merge-browser"));
  await fs.mkdir(output, {recursive:true});
  const browser = await chromium.launch({
    headless:true, args:["--no-sandbox"],
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
  });
  const errors=[], requests=[];
  try {
    const context = await browser.newContext({offline:true, viewport:{width:1500,height:1000}, acceptDownloads:true});
    const page = await context.newPage();
    page.on("pageerror", error=>errors.push(error.message));
    page.on("request", request=>{if (/^https?:/.test(request.url())) requests.push(request.url());});
    await page.goto(pathToFileURL(htmlPath).href + "#semantic");
    await page.locator("#card-list button").first().waitFor();
    const data = await page.locator("#review-data").evaluate(node=>JSON.parse(node.textContent));
    assert.equal(await page.locator("#card-list button").count(), data.cards.length);
    assert.equal(await page.locator("#panel-semantic").isVisible(), true);
    assert.match(await page.locator("#review-progress").innerText(), new RegExp(`^0 / ${data.cards.length}`));
    assert.ok(data.cards.every(card=>!card.raw.merged_candidate.human_reviewed));
    for (const card of data.cards) {
      await page.locator(`[data-card-id="${card.id}"]`).click();
      await page.locator("#card-image").evaluate(image=>image.decode());
    }
    const judged = data.cards.find(card=>card.semantic_equivalence.some(entry=>entry.reviews.length));
    if (judged) {
      await page.locator(`[data-card-id="${judged.id}"]`).click();
      await page.locator(".semantic-reviewer").first().locator("summary").click();
      assert.equal(await page.locator(".semantic-reviewer").first().locator("tbody tr").count(), 10);
      assert.match(await page.locator("#equivalence-control-summary").innerText(), /12 \/ 12 通过/);
    }
    await page.locator("#tab-semantic").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#panel-raw").isVisible(), true);
    await page.locator("#tab-compare").click();
    const note="浏览器测试备注 <img src=x onerror=alert(1)>";
    await page.locator("#review-notes").fill(note);
    const active = await page.locator('[aria-current="true"][data-card-id]').getAttribute("data-card-id");
    await page.locator('[name="mapping-decision"][value="needs_review"]').check();
    const downloadEvent=page.waitForEvent("download");
    await page.locator("#export-button").click();
    const download=await downloadEvent;
    const exportedPath=path.join(output,"review-opinions.json");
    await download.saveAs(exportedPath);
    const exported=JSON.parse(await fs.readFile(exportedPath,"utf8"));
    assert.equal(exported.cards.length,data.cards.length);
    assert.equal(exported.cards.find(card=>card.mik_id===active).review.notes,note);
    await page.reload();
    await page.locator(`[data-card-id="${active}"]`).click();
    assert.equal(await page.locator("#review-notes").inputValue(),note);
    assert.equal(await page.locator("img[onerror]").count(),0);
    exported.dataset_fingerprint="wrong-inputs";
    const wrong=path.join(output,"wrong-opinions.json");
    await fs.writeFile(wrong,JSON.stringify(exported));
    await page.locator("#import-file").setInputFiles(wrong);
    await page.waitForFunction(()=>document.querySelector("#announcement").textContent.includes("数据指纹不同"));
    assert.equal(await page.locator("#review-notes").inputValue(),note);
    await page.locator("#tab-semantic").click();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(output,"desktop.png"),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(output,"mobile.png"),fullPage:true});
    assert.deepEqual(errors,[]);
    assert.deepEqual(requests,[]);
    const result={cards:data.cards.length, status_counts:data.equivalence.status_counts,
      offline_render:true, semantic_hash_navigation:true, all_four_keyboard_tabs:true,
      literal_evidence_visible:!!judged, model_and_human_opinions_separate:true,
      notes_reload_and_export:true, wrong_fingerprint_import_atomic:true,
      desktop_mobile_no_overflow:true, automatic_http_requests:requests,browser_errors:errors};
    await fs.writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");
    console.log(JSON.stringify(result,null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
