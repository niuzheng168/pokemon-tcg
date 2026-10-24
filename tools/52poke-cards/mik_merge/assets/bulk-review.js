(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const statusLabels = {ready: "机器就绪", needs_review: "需要复核", blocked: "阻断 / 未关联"};
  const decisionLabels = {unreviewed: "未审阅", accepted: "认可关联", needs_review: "需要复核", rejected: "拒绝关联"};
  const OPINION_SCHEMA = "mik-52poke-bulk-review-opinions-v1";
  const state = {
    fingerprint: null, revision: null, page: 1, pages: 0, total: 0, cards: [],
    activeId: null, active: null, opinions: new Map(),
    listRequest: 0, detailRequest: 0, panel: "compare", stale: false, importing: false,
  };
  let listController, detailController, searchTimer, refreshBusy = false;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const pretty = value => value == null ? "未提供" :
    typeof value === "string" ? value || "（空白）" : JSON.stringify(value, null, 2);
  const notice = (message, error = false) => {
    $("announcement").textContent = message;
    $("announcement").classList.toggle("error", error);
    $("announcement").hidden = false;
  };
  const key = () => `mik-52poke-bulk-opinions-v1:${state.fingerprint}`;
  const identity = card => ({mik_id: card.mik_id, wiki_id: card.wiki_id, image_sha256: card.image_sha256});
  const sameIdentity = (a, b) => a.mik_id === b.mik_id &&
    a.wiki_id === b.wiki_id && a.image_sha256 === b.image_sha256;
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

  async function api(path, signal) {
    const response = await fetch(path, {
      signal, cache: "no-store", credentials: "omit", mode: "same-origin", redirect: "error",
    });
    if (!response.ok) throw new Error(`本机数据暂不可用（HTTP ${response.status}）。可稍后刷新；不会省略失败记录。`);
    const result = await response.json();
    if (state.fingerprint && result.dataset_fingerprint !== state.fingerprint) {
      state.stale = true;
      $("review-decision").disabled = true;
      $("review-notes").disabled = true;
      throw new Error("数据指纹已变化，请刷新页面后继续；原有人工意见仍保留在旧指纹下。");
    }
    return result;
  }

  function opinionDocument() {
    return {
      schema: OPINION_SCHEMA, dataset_fingerprint: state.fingerprint,
      scope: "Human opinions only; not source edits, merge patches or admission.",
      exported_at: new Date().toISOString(),
      cards: Array.from(state.opinions.values()),
    };
  }

  function validateDocument(value) {
    if (!isObject(value) || value.schema !== OPINION_SCHEMA)
      throw new Error("不是全目录审阅页导出的意见格式，未导入任何修改。");
    if (value.dataset_fingerprint !== state.fingerprint)
      throw new Error("数据指纹不同，未导入任何修改。");
    if (!Array.isArray(value.cards) || value.cards.length > state.total)
      throw new Error("意见记录数量无效，未导入任何修改。");
    const result = new Map();
    for (const entry of value.cards) {
      const review = entry?.review;
      if (!isObject(entry) || typeof entry.mik_id !== "string" || !idPattern.test(entry.mik_id) ||
          result.has(entry.mik_id) || !(entry.wiki_id === null || typeof entry.wiki_id === "string") ||
          !(entry.image_sha256 === null || typeof entry.image_sha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.image_sha256)) ||
          !isObject(review) || !Object.hasOwn(decisionLabels, review.decision) ||
          typeof review.notes !== "string" || review.notes.length > 10000 ||
          !(review.updated_at === null || typeof review.updated_at === "string" && review.updated_at.length <= 64))
        throw new Error("存在无效、重复或超长的人工意见，未导入任何修改。");
      // Reconstruct rather than copying imported objects or prototype keys.
      result.set(entry.mik_id, {
        mik_id: entry.mik_id, wiki_id: entry.wiki_id, image_sha256: entry.image_sha256,
        review: {decision: review.decision, notes: review.notes, updated_at: review.updated_at},
      });
    }
    return result;
  }

  function updateOpinionCount() {
    $("opinion-count").textContent = `${state.opinions.size.toLocaleString("zh-CN")} 条本机意见`;
  }

  function persist() {
    try {
      localStorage.setItem(key(), JSON.stringify(opinionDocument()));
      $("save-status").textContent = "已保存到当前浏览器 · 与机器判定分离 · 建议导出 JSON 备份";
    } catch {
      $("save-status").textContent = "浏览器存储不可用或已满；当前意见仍在内存中，请立即导出备份。";
      notice("无法写入浏览器存储，请导出人工意见备份。", true);
    }
    updateOpinionCount();
  }

  function restore() {
    try {
      const cached = localStorage.getItem(key());
      if (cached) state.opinions = validateDocument(JSON.parse(cached));
    } catch {
      notice("未读取无效的浏览器意见缓存；仍可导入有效 JSON。", true);
    }
    updateOpinionCount();
  }

  function saveOpinion() {
    if (!state.active || state.stale || state.importing) return;
    const card = state.active.card;
    const entry = {
      ...identity(card),
      review: {
        decision: $("review-decision").value, notes: $("review-notes").value,
        updated_at: new Date().toISOString(),
      },
    };
    if (entry.review.decision === "unreviewed" && !entry.review.notes)
      state.opinions.delete(card.mik_id);
    else state.opinions.set(card.mik_id, entry);
    persist();
    const button = Array.from($("card-list").children).find(node => node.dataset.cardId === card.mik_id);
    if (button) updateHumanBadge(button, card);
  }

  function renderOpinion(card) {
    const saved = state.opinions.get(card.mik_id);
    const valid = saved && sameIdentity(saved, card);
    $("review-decision").value = valid ? saved.review.decision : "unreviewed";
    $("review-notes").value = valid ? saved.review.notes : "";
    $("review-decision").disabled = state.stale || state.importing;
    $("review-notes").disabled = state.stale || state.importing;
    $("save-status").textContent = saved && !valid
      ? "当前关联身份与已保存意见不同；旧意见仍保留，请核对后重新记录。"
      : "意见只保存在当前浏览器，不会改写候选；建议导出 JSON 备份。";
  }

  function updateHumanBadge(button, card) {
    button.querySelector(".human-badge")?.remove();
    const entry = state.opinions.get(card.mik_id);
    if (entry && sameIdentity(entry, card))
      button.querySelector(".sub").append(make("span", "badge human-badge", `人工：${decisionLabels[entry.review.decision]}`));
  }

  function updateOptions(id, entries, field, label, allText) {
    const select = $(id), current = select.value;
    const fragment = document.createDocumentFragment();
    const all = make("option", "", allText);
    all.value = "";
    fragment.append(all);
    for (const entry of entries) {
      const option = make("option", "", `${label(entry)}（${entry.count.toLocaleString("zh-CN")}）`);
      option.value = entry[field];
      fragment.append(option);
    }
    select.replaceChildren(fragment);
    if (entries.some(entry => entry[field] === current)) select.value = current;
  }

  async function refreshSummary() {
    if (refreshBusy || state.stale) return false;
    refreshBusy = true;
    try {
      const result = await api("/api/summary");
      const first = !state.fingerprint;
      if (first) {
        state.fingerprint = result.dataset_fingerprint;
        $("announcement").hidden = true;
      }
      state.total = result.total;
      for (const [id, value] of [
        ["total", result.total], ["candidate", result.candidate], ["ready", result.ready],
        ["review", result.needs_review], ["blocked", result.blocked],
      ]) $(`count-${id}`).textContent = value.toLocaleString("zh-CN");
      const judge = result.judge_progress;
      $("run-state").textContent = result.final ? "本机运行 · 已有最终统计" :
        Number.isFinite(judge?.completed_requests) && Number.isFinite(judge?.planned_requests)
          ? `本机核验 · ${judge.completed_requests} / ${judge.planned_requests} 请求`
          : "本机运行 · 持续更新";
      $("run-details").textContent = pretty({
        dataset_fingerprint: result.dataset_fingerprint, catalog_fingerprint: result.catalog_fingerprint,
        counts: result.status_counts, progress: result.progress,
        judge_progress: result.judge_progress, summary: result.summary,
      });
      updateOptions("set-filter", result.sets, "set_code", entry => entry.set_code, "全部系列");
      updateOptions("reason-filter", result.reasons, "code", entry => entry.code, "全部原因");
      if (first) restore();
      const changed = state.revision !== result.catalog_revision;
      state.revision = result.catalog_revision;
      return first || changed;
    } finally { refreshBusy = false; }
  }

  function cardButton(card) {
    const button = make("button", "queue-card");
    button.type = "button";
    button.dataset.cardId = card.mik_id;
    button.setAttribute("aria-current", String(card.mik_id === state.activeId));
    if (card.image_url) {
      const image = make("img");
      image.src = card.image_url;
      image.alt = "";
      image.loading = "lazy";
      image.width = 43; image.height = 60;
      image.addEventListener("error", () => image.replaceWith(make("span", "queue-placeholder", "无图")));
      button.append(image);
    } else button.append(make("span", "queue-placeholder", "无图"));
    const copy = make("span");
    copy.append(make("span", "name", card.name || "未提供名称"), make("span", "identity", card.mik_id));
    const sub = make("span", "sub");
    sub.append(make("span", `badge ${card.status}`, statusLabels[card.status]));
    if (card.holds.length) sub.append(make("span", "badge", `${card.holds.length} 项暂缓`));
    copy.append(sub); button.append(copy);
    updateHumanBadge(button, card);
    button.addEventListener("click", () => selectCard(card.mik_id).catch(handleError));
    return button;
  }

  function setPaging() {
    $("previous").disabled = state.page <= 1;
    $("next").disabled = state.page >= state.pages;
    $("page-position").textContent = `${state.pages ? state.page : 0} / ${state.pages} 页`;
    $("page-number").value = state.page;
    $("page-number").max = Math.max(1, state.pages);
  }

  async function loadPage({reset = false, reloadDetail = false} = {}) {
    if (state.stale) return;
    if (reset) state.page = 1;
    listController?.abort();
    listController = new AbortController();
    const serial = ++state.listRequest;
    const params = new URLSearchParams({
      page: state.page, page_size: $("page-size").value, q: $("search").value,
      status: $("status-filter").value, set: $("set-filter").value, reason: $("reason-filter").value,
    });
    $("card-list").setAttribute("aria-busy", "true");
    try {
      const result = await api(`/api/cards?${params}`, listController.signal);
      if (serial !== state.listRequest) return;
      if (result.pages && state.page > result.pages) {
        state.page = result.pages;
        await loadPage({reloadDetail});
        return;
      }
      state.cards = result.cards; state.pages = result.pages;
      const keep = result.cards.some(card => card.mik_id === state.activeId);
      const selected = keep ? state.activeId : result.cards[0]?.mik_id || null;
      state.activeId = selected;
      const fragment = document.createDocumentFragment();
      for (const card of result.cards) fragment.append(cardButton(card));
      $("card-list").replaceChildren(fragment);
      $("list-count").textContent = `${result.total.toLocaleString("zh-CN")} / ${result.catalog_total.toLocaleString("zh-CN")} 张`;
      $("empty").hidden = result.cards.length !== 0;
      setPaging();
      if (selected && (!keep || reloadDetail || !state.active)) await selectCard(selected);
      else if (!selected) {
        detailController?.abort();
        state.detailRequest++;
        state.active = null;
        $("card-content").hidden = true;
        $("card-title").textContent = "没有符合筛选的卡牌";
        $("detail-state").textContent = "";
      }
    } finally {
      if (serial === state.listRequest) $("card-list").setAttribute("aria-busy", "false");
    }
  }

  function dataBlock(label, value, open = false) {
    const details = make("details", "data-block");
    details.open = open;
    details.append(make("summary", "", label), make("pre", "", pretty(value)));
    return details;
  }

  function descriptions(value, wiki = false) {
    const fragment = document.createDocumentFragment();
    let found = 0;
    const add = (label, text) => {
      if (text == null || text === "") return;
      const section = make("div", "description-block");
      section.append(make("strong", "", label), make("span", "", pretty(text)));
      fragment.append(section); found++;
    };
    if (!isObject(value)) return make("p", "small", "尚无此来源的描述；此记录仍保留在目录中。");
    if (!wiki) {
      add("名称", value.name);
      add("英文名", value.nameEn);
      add("卡牌类型", value.cardType || value.card_type);
      add("描述", value.description);
      const attr = value.pokemonAttr || {};
      for (const [type, label] of [["ability", "特性"], ["attack", "招式"]]) {
        if (!Array.isArray(attr[type])) continue;
        attr[type].forEach((entry, index) => {
          add(`${label} ${index + 1} · ${entry.name || ""}`, entry.text ?? entry.description ?? entry.effect);
          if (type === "attack") add("伤害 / 费用", {damage: entry.damage, cost: entry.cost});
        });
      }
    } else {
      add("名称", value.display?.name ?? value.name ?? value.title);
      add("描述", value.display?.description ?? value.description);
      for (const [index, block] of (Array.isArray(value.blocks) ? value.blocks : []).entries()) {
        for (const [type, label] of [["abilities", "特性"], ["attacks", "招式"], ["effects", "效果"]]) {
          if (!Array.isArray(block[type])) continue;
          block[type].forEach((entry, offset) => {
            const shown = entry.display || entry;
            add(`${index + 1}.${offset + 1} ${label} · ${shown.name || ""}`,
              shown.effect ?? shown.text ?? shown.description ?? shown);
          });
        }
      }
    }
    if (!found) fragment.append(dataBlock("已有来源数据（展开）", value, true));
    return fragment;
  }

  function renderFields(value) {
    const target = $("field-diffs");
    target.replaceChildren();
    const rows = Array.isArray(value) ? value : Array.isArray(value?.rows) ? value.rows : [];
    if (!rows.length) {
      if (value && Object.keys(value).length) target.append(dataBlock("逐字段差异", value, true));
      else target.append(make("p", "small", "尚无逐字段差异结果。阻断项不会被视为“相同”。"));
      return;
    }
    const changes = rows.some(row => Object.hasOwn(row, "new_value") || Object.hasOwn(row, "old_value"));
    const wrap = make("div", "table-wrap"), table = make("table"), head = make("thead"), hr = make("tr");
    for (const label of ["字段 / 判定 / 来源", changes ? "候选采用值" : "MIK", changes ? "Wiki 合并前值" : "Wiki"])
      hr.append(make("th", "", label));
    head.append(hr); table.append(head);
    const body = make("tbody");
    for (const row of rows) {
      const tr = make("tr"), label = make("td", "", row.label || row.field || row.path || row.id || "字段");
      label.append(make("span", "small", [row.status, row.source].filter(Boolean).join(" · ")));
      tr.append(label,
        make("td", "", pretty(Object.hasOwn(row, "new_value") ? row.new_value : row.mik ?? row.left)),
        make("td", "", pretty(Object.hasOwn(row, "old_value") ? row.old_value : row.wiki ?? row.right)));
      body.append(tr);
    }
    table.append(body); wrap.append(table); target.append(wrap);
  }

  function renderEvidence(detail) {
    const candidates = detail.candidate_evidence ?? detail.result?.candidate_evidence ?? detail.row?.candidate_evidence;
    const target = $("candidate-evidence");
    target.replaceChildren();
    if (Array.isArray(candidates) && candidates.length) {
      candidates.forEach((entry, index) => target.append(dataBlock(
        `候选 ${index + 1} · ${entry.title ?? entry.wiki_id ?? entry.page_id ?? entry.id ?? "关联证据"}`, entry, index === 0)));
    } else if (candidates && Object.keys(candidates).length) target.append(dataBlock("候选证据", candidates, true));
    else target.append(make("p", "small", "尚无候选依据；未关联或阻断卡牌仍保留。"));
    const semantic = detail.semantic_equivalence ?? detail.result?.semantic_equivalence ?? detail.row?.semantic_equivalence;
    const entries = Array.isArray(semantic) ? semantic : Array.isArray(semantic?.pairs) ? semantic.pairs : [];
    const models = $("semantic-evidence");
    models.replaceChildren();
    for (const entry of entries) {
      const item = make("section", "evidence-item");
      item.append(make("h3", "", `${entry.id || "语义项"} · ${entry.decision ?? entry.status ?? "未决"}`));
      if (entry.left != null || entry.right != null) {
        const pair = make("div", "source-pair");
        for (const [label, text] of [["MIK 原文", entry.left], ["Wiki 原文", entry.right]]) {
          const block = make("div");
          block.append(make("strong", "small", label), make("blockquote", "", pretty(text)));
          pair.append(block);
        }
        item.append(pair);
      }
      if (entry.hold_reasons?.length) item.append(make("p", "", `暂缓：${entry.hold_reasons.join("；")}`));
      if (Array.isArray(entry.reviews)) {
        entry.reviews.forEach((review, index) => item.append(dataBlock(
          `模型 ${index + 1} · ${review.deployment || review.model || "已有核验"} · ${review.verdict || review.decision || ""}`,
          review, true)));
      }
      item.append(dataBlock("完整语义判定 / 硬性检查", entry));
      models.append(item);
    }
    if (!entries.length) {
      if (semantic && Object.keys(semantic).length) models.append(dataBlock("已有语义结果", semantic, true));
      else models.append(make("p", "small", "未运行模型、没有需核验的差异，或此卡已被前置条件阻断。不能据此推断语义通过。"));
    }
  }

  function renderDetail(result) {
    const card = result.card, detail = result.detail;
    $("card-title").textContent = card.name || card.mik_id;
    $("detail-state").textContent = result.detail_available ? "本机只读详情" : "等待详情生成";
    $("card-content").hidden = false;
    $("card-identity").textContent = `${card.mik_id} · ${card.card_type || "类型未提供"}\nWiki：${card.wiki_id ?? "尚未唯一关联"}`;
    $("card-badges").replaceChildren(
      make("span", `badge ${card.status}`, statusLabels[card.status]),
      make("span", "badge", `关联：${card.association_status || "未提供"}`),
      make("span", "badge", `语义：${card.semantic_status || "未提供"}`),
    );
    const reasons = $("card-reasons");
    reasons.replaceChildren();
    if (!card.holds.length) reasons.append(make("p", "small", "目录未列出暂缓项。机器就绪仍不代表人工核准或正式入库。"));
    for (const hold of card.holds) {
      const block = make("div", "hold");
      block.append(make("strong", "", hold.code));
      const rest = Object.fromEntries(Object.entries(hold).filter(([key]) => key !== "code"));
      if (Object.keys(rest).length) block.append(make("div", "", pretty(rest)));
      reasons.append(block);
    }
    $("card-hash").textContent = `图片 SHA-256：${card.image_sha256 || "未提供"}`;
    const image = $("card-image"), imageMessage = $("image-message");
    image.hidden = true; imageMessage.hidden = false;
    imageMessage.textContent = card.image_url ? "正在校验并加载本机卡图…" : "此记录尚无可用卡图";
    image.removeAttribute("src");
    if (card.image_url) {
      image.onload = () => { image.hidden = false; imageMessage.hidden = true; };
      image.onerror = () => { image.hidden = true; imageMessage.hidden = false; imageMessage.textContent = "图片尚不可用或校验失败（不加载外部图片）"; };
      image.alt = `${card.name || card.mik_id} · MIK 本机原图`;
      image.src = card.image_url;
    }
    renderFields(detail.field_diffs);
    $("mik-description").replaceChildren(descriptions(detail.mik_metadata));
    $("wiki-description").replaceChildren(descriptions(
      detail.normalized_wiki_display ?? detail.wiki_display ?? detail.normalized_wiki_source ?? detail.wiki_source, true));
    renderEvidence(detail);
    $("raw-data").replaceChildren();
    for (const [field, label] of [
      ["mik_metadata", "MIK 原始 metadata"], ["wiki_source", "Wiki 原始结构"],
      ["wiki_display", "Wiki 原始展示"], ["normalized_wiki_source", "Wiki 派生规范化结构"],
      ["normalized_wiki_display", "Wiki 派生规范化展示"], ["merged_candidate", "实际合并候选（未入库）"],
      ["row", "目录 / 阶段记录"], ["result", "机器判定"],
    ]) if (Object.hasOwn(detail, field)) $("raw-data").append(dataBlock(label, detail[field]));
    if (!$("raw-data").children.length) $("raw-data").append(make("p", "small", "此记录尚无详情，或已在源校验阶段阻断。"));
    renderOpinion(card);
    showPanel(state.panel);
  }

  async function selectCard(id) {
    if (state.stale) return;
    detailController?.abort();
    detailController = new AbortController();
    const serial = ++state.detailRequest;
    state.activeId = id;
    // Never let notes typed while a new card is loading attach to the old card.
    state.active = null;
    $("card-content").hidden = true;
    $("card-title").textContent = id;
    $("detail-state").textContent = "正在加载…";
    for (const button of $("card-list").children)
      button.setAttribute("aria-current", String(button.dataset.cardId === id));
    const result = await api(`/api/card?${new URLSearchParams({mik_id: id})}`, detailController.signal);
    if (serial !== state.detailRequest) return;
    state.active = result;
    renderDetail(result);
  }

  function showPanel(panel) {
    state.panel = panel;
    for (const name of ["compare", "evidence", "raw"]) $(`panel-${name}`).hidden = name !== panel;
    for (const button of document.querySelectorAll("[data-panel]"))
      button.setAttribute("aria-pressed", String(button.dataset.panel === panel));
  }

  function handleError(error) {
    if (error.name === "AbortError") return;
    notice(error.message || "本机审阅出现错误，请稍后刷新。", true);
  }

  async function importOpinions(file) {
    if (state.importing || state.stale) return;
    if (!file || file.size > 32 * 1024 * 1024) throw new Error("请选择不超过 32 MB 的意见 JSON。");
    state.importing = true;
    $("review-decision").disabled = true; $("review-notes").disabled = true;
    $("export-button").disabled = true;
    try {
      const imported = validateDocument(JSON.parse(await file.text()));
      notice("正在核对意见的卡牌身份；全部验证通过后才会替换本机意见…");
      // At most 200 rows/request, no 13k-item DOM or one HTTP call per opinion.
      // Scan the current index even for cached entries when the dataset is live.
      const found = new Set();
      let page = 1, pages = 1, revision;
      do {
        const result = await api(`/api/cards?page=${page}&page_size=200`);
        if (revision && revision !== result.catalog_revision)
          throw new Error("目录正在发布更新，请稍后重试；未导入任何修改。");
        revision = result.catalog_revision;
        pages = result.pages;
        for (const card of result.cards) {
          if (!imported.has(card.mik_id)) continue;
          if (!sameIdentity(imported.get(card.mik_id), card))
            throw new Error("关联或图片身份不同，未导入任何修改。");
          found.add(card.mik_id);
        }
        page++;
      } while (page <= pages && found.size < imported.size);
      if (found.size !== imported.size) throw new Error("存在未知卡牌，未导入任何修改。");
      if ((await api("/api/summary")).catalog_revision !== revision)
        throw new Error("目录正在发布更新，请稍后重试；未导入任何修改。");
      // Atomic application: neither localStorage nor in-memory opinions changes earlier.
      state.opinions = imported;
      persist();
      if (state.active) renderOpinion(state.active.card);
      for (const button of $("card-list").children) {
        const card = state.cards.find(entry => entry.mik_id === button.dataset.cardId);
        if (card) updateHumanBadge(button, card);
      }
      notice(`已导入 ${imported.size.toLocaleString("zh-CN")} 条人工意见（仅意见；不会修改任何源数据）。`);
    } finally {
      state.importing = false;
      $("export-button").disabled = false;
      $("review-decision").disabled = state.stale;
      $("review-notes").disabled = state.stale;
      $("import-file").value = "";
    }
  }

  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPage({reset: true}).catch(handleError), 200);
  });
  for (const id of ["status-filter", "set-filter", "reason-filter", "page-size"])
    $(id).addEventListener("change", () => loadPage({reset: true}).catch(handleError));
  $("clear-filters").addEventListener("click", () => {
    clearTimeout(searchTimer);
    for (const id of ["search", "status-filter", "set-filter", "reason-filter"]) $(id).value = "";
    loadPage({reset: true}).catch(handleError);
  });
  $("previous").addEventListener("click", () => { state.page--; loadPage().catch(handleError); });
  $("next").addEventListener("click", () => { state.page++; loadPage().catch(handleError); });
  function goPage() {
    const page = Number($("page-number").value);
    if (!Number.isInteger(page) || page < 1 || page > Math.max(1, state.pages)) {
      notice("页码超出当前筛选范围。", true); return;
    }
    state.page = page; loadPage().catch(handleError);
  }
  $("go-page").addEventListener("click", goPage);
  $("page-number").addEventListener("keydown", event => { if (event.key === "Enter") goPage(); });
  $("review-decision").addEventListener("change", saveOpinion);
  $("review-notes").addEventListener("input", saveOpinion);
  const tabs = Array.from(document.querySelectorAll("[data-panel]"));
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => showPanel(button.dataset.panel));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); showPanel(tabs[next].dataset.panel);
    });
  });
  $("export-button").addEventListener("click", () => {
    if (!state.fingerprint) return;
    const blob = new Blob([JSON.stringify(opinionDocument(), null, 2) + "\n"], {type: "application/json"});
    const url = URL.createObjectURL(blob), anchor = make("a");
    anchor.href = url; anchor.download = "mik-bulk-human-opinions.json";
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("import-file").addEventListener("change", () => importOpinions($("import-file").files[0]).catch(handleError));
  $("refresh").addEventListener("click", async () => {
    if (state.stale) { window.location.reload(); return; }
    try { await refreshSummary(); await loadPage({reloadDetail: true}); }
    catch (error) { handleError(error); }
  });
  (async () => {
    try {
      await refreshSummary();
      await loadPage();
    } catch (error) { handleError(error); }
    setInterval(async () => {
      if (document.hidden || state.importing) return;
      try {
        if (await refreshSummary()) await loadPage({reloadDetail: true});
      } catch (error) { handleError(error); }
    }, 5000);
  })();
})();
