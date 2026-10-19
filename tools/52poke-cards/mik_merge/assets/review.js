(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("review-data").textContent);
  const byId = new Map(data.cards.map(card => [card.id, card]));
  const storageKey = `mik-52poke-review-v1:${data.fingerprint}`;
  const decisionLabels = { unreviewed: "未审阅", accepted: "认可关联", needs_review: "需要复核", rejected: "拒绝关联" };
  const fieldLabels = { unreviewed: "待决定", mik: "采用 mik", "52poke": "保留 52poke", keep_both: "保留两份 / 待审" };
  const statusLabels = { equal: "相同", equivalent: "仅格式差异", different: "字面差异", missing: "一侧未提供", empty: "双方空白" };
  const decisions = Object.create(null);
  let activeId = data.cards[0].id;
  let currentTab = "compare";
  let imageSource = "mik";
  let storageAvailable = true;
  const $ = id => document.getElementById(id);
  const make = (tag, cls, text) => {
    const element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const blank = () => ({ mapping_decision: "unreviewed", field_preferences: Object.create(null), notes: "", updated_at: null });
  for (const card of data.cards) decisions[card.id] = blank();

  function exportDocument() {
    return {
      schema: "mik-52poke-review-decisions-v1",
      dataset_fingerprint: data.fingerprint,
      exported_at: new Date().toISOString(),
      snapshot: data.snapshot,
      scope: "Review opinions only; not merge patches or an engine mapping.",
      semantic_revision: data.semantic_revision,
      cards: data.cards.map(card => ({
        mik_id: card.id, wiki_candidate_id: card.wiki_id,
        wiki_block: card.raw.sample_comparison.wiki_candidate.block,
        source_provenance: card.provenance,
        supplement_proposals: card.supplements,
        review: {
          mapping_decision: decisions[card.id].mapping_decision,
          field_preferences: { ...decisions[card.id].field_preferences },
          notes: decisions[card.id].notes,
          updated_at: decisions[card.id].updated_at
        }
      }))
    };
  }

  function validateImport(document) {
    if (!document || document.schema !== "mik-52poke-review-decisions-v1")
      throw new Error("不是本审核页导出的意见格式。");
    if (document.dataset_fingerprint !== data.fingerprint)
      throw new Error("数据指纹不同：这些意见不属于当前冻结样本，未导入任何修改。");
    if (!Array.isArray(document.cards) || document.cards.length !== data.cards.length)
      throw new Error(`审核意见必须完整包含本组 ${data.cards.length} 张样本。`);
    const imported = Object.create(null);
    for (const entry of document.cards) {
      const card = byId.get(entry?.mik_id);
      if (!card || Object.hasOwn(imported, card.id) || entry.wiki_candidate_id !== card.wiki_id ||
          entry.wiki_block !== card.raw.sample_comparison.wiki_candidate.block)
        throw new Error("存在未知、重复或候选身份不一致的记录。");
      const value = entry.review;
      if (!value || !Object.hasOwn(decisionLabels, value.mapping_decision) || typeof value.notes !== "string" ||
          value.notes.length > 10000 || !value.field_preferences || typeof value.field_preferences !== "object" ||
          Array.isArray(value.field_preferences))
        throw new Error("审核状态、备注或字段选择无效。");
      const allowedFields = new Set(card.rows.filter(row => row.selectable).map(row => row.id));
      const preferences = Object.create(null);
      for (const [field, source] of Object.entries(value.field_preferences)) {
        if (!allowedFields.has(field) || !Object.hasOwn(fieldLabels, source))
          throw new Error("存在无效字段或来源选择；未导入任何修改。");
        preferences[field] = source;
      }
      imported[card.id] = {
        mapping_decision: value.mapping_decision, field_preferences: preferences,
        notes: value.notes, updated_at: typeof value.updated_at === "string" ? value.updated_at.slice(0, 64) : null
      };
    }
    return imported;
  }

  function notice(message, error = false) {
    $("announcement").textContent = message;
    $("announcement").hidden = false;
    $("announcement").classList.toggle("error", error);
    $("announcement").setAttribute("role", error ? "alert" : "status");
  }

  try {
    const cached = localStorage.getItem(storageKey);
    if (cached) {
      try { Object.assign(decisions, validateImport(JSON.parse(cached))); }
      catch { notice("未读取无法识别的浏览器缓存。你仍可从有效 JSON 备份导入意见。", true); }
    }
  } catch { storageAvailable = false; }

  function updateSaveStatus() {
    $("save-status").textContent = storageAvailable
      ? "自动保存在当前浏览器 · 建议导出 JSON 备份"
      : "浏览器无法自动保存 · 请及时导出 JSON 备份";
    $("save-status").classList.toggle("unsaved", !storageAvailable);
    const count = Object.values(decisions).filter(value => value.mapping_decision !== "unreviewed").length;
    $("review-progress").textContent = `${count} / ${data.cards.length} 已处理`;
  }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(exportDocument())); storageAvailable = true; }
    catch { storageAvailable = false; }
    updateSaveStatus();
  }

  function filteredCards() {
    const query = $("search").value.trim().toLocaleLowerCase();
    const status = $("status-filter").value;
    return data.cards.filter(card => {
      const haystack = [card.name, card.id, card.wiki_id, card.wiki_title, card.raw.mik.nameEn,
        card.raw.mik.description, ...card.rows.map(row => typeof row.wiki === "string" ? row.wiki : "")]
        .join("\n").toLocaleLowerCase();
      return (!query || haystack.includes(query)) && (status === "all" || decisions[card.id].mapping_decision === status);
    });
  }

  function renderQueue() {
    const cards = filteredCards();
    const changed = !cards.some(card => card.id === activeId);
    if (changed) activeId = cards[0]?.id ?? null;
    const fragment = document.createDocumentFragment();
    for (const card of cards) {
      const button = make("button", "queue-item");
      button.type = "button";
      button.dataset.cardId = card.id;
      button.setAttribute("aria-current", card.id === activeId ? "true" : "false");
      const image = make("img", "queue-thumb");
      image.src = card.mik_image.src; image.alt = ""; image.width = 35; image.height = 49;
      const copy = make("span", "queue-copy");
      copy.append(make("span", "queue-name", `${String(card.index).padStart(2, "0")}  ${card.name}`),
        make("span", "queue-key", card.id));
      const detail = make("span", "queue-detail");
      const state = make("span", "queue-review", decisionLabels[decisions[card.id].mapping_decision]);
      state.dataset.decision = decisions[card.id].mapping_decision;
      detail.append(state, make("span", "", `文本差异 ${card.text_difference_count}`));
      copy.append(detail); button.append(image, copy);
      button.addEventListener("click", () => { activeId = card.id; imageSource = "mik"; renderQueue(); renderCard(); });
      fragment.append(button);
    }
    $("card-list").replaceChildren(fragment);
    $("list-count").textContent = `${cards.length} / ${data.cards.length} 张符合筛选`;
    $("no-results").hidden = !!cards.length;
    $("card-content").hidden = !cards.length;
    $("previous").disabled = !cards.length || cards[0].id === activeId;
    $("next").disabled = !cards.length || cards.at(-1).id === activeId;
    $("next-review").disabled = $("next").disabled;
    $("position").textContent = cards.length ? `${cards.findIndex(card => card.id === activeId) + 1} / ${cards.length}` : "0 / 0";
    if (!cards.length) {
      $("card-title").textContent = "没有匹配的卡牌";
      $("card-subtitle").textContent = "来源与已有审核意见不会被筛选操作删除。";
    }
    return changed;
  }

  function move(offset) {
    const cards = filteredCards(), position = cards.findIndex(card => card.id === activeId);
    const next = cards[position + offset];
    if (!next) return;
    activeId = next.id; imageSource = "mik"; renderQueue(); renderCard();
  }

  function valueCell(row, source) {
    const cell = make("td", source === "wiki" ? "wiki-value" : "mik-value");
    cell.dataset.source = source === "wiki" ? "52poke" : "mik";
    if (source === "wiki" && row.provenance) {
      const label = row.provenance.declared_simplified_in_source
        ? "来源明确标记简中"
        : `中文回退 / ${row.provenance.source_language || "未知语言"}${row.provenance.conversion === "opencc-t2s" ? " · 已转简" : ""}`;
      cell.append(make("div", "field-provenance", label));
    }
    const value = make("div", "field-value");
    if (row[source] === null || row[source] === "") value.classList.add("empty-value");
    for (const [part, changed] of row.segments[source]) value.append(changed ? make("mark", "", part) : document.createTextNode(part));
    cell.append(value, make("div", "field-path", source === "mik" ? row.mik_path : row.wiki_path));
    if (source === "wiki" && row.equivalence) {
      cell.append(make("div", "equivalence-inline", equivalenceLabel(row.equivalence.decision)));
    }
    if (source === "wiki" && row.semantic) {
      cell.append(make("div", "semantic-score",
        `向量相似度 ${row.semantic.cosine.toFixed(4)} · 字面相似度 ${row.semantic.lexical.toFixed(4)}\n${row.semantic.deployment} · 不是正确率或规则等价判定`));
    }
    if (source === "wiki" && row.id === "weakness.value") {
      const proposal = byId.get(activeId)?.supplements?.[0];
      if (proposal) cell.append(make("div", "supplement-note",
        `建议补充 weaknessnumber = ${proposal.proposed_value}（mik 来源）。目前只是补充提案，未改写 Wiki 或正式库。`));
    }
    if (source === "wiki" && Object.values(row.languages).some(Boolean)) {
      const details = make("details", "language-details");
      details.append(make("summary", "", "跨语言原文"));
      for (const [language, text] of Object.entries(row.languages)) {
        if (!text) continue;
        const line = make("div", "language-text");
        line.append(make("strong", "", { en: "英文", ja: "日文", "zh-Hant": "繁体中文" }[language] || language),
          document.createTextNode(text));
        details.append(line);
      }
      cell.append(details);
    }
    return cell;
  }

  function renderTable(card) {
    const table = make("table", "compare-table");
    table.setAttribute("aria-label", `${card.name}：mik 与 52poke 的逐字段对照`);
    const columns = make("colgroup");
    for (const width of ["15%", "34%", "34%", "17%"]) {
      const col = make("col"); col.style.width = width; columns.append(col);
    }
    const head = make("thead"), heading = make("tr");
    for (const [text, cls] of [["字段", ""], ["mik · 简中来源", "mik-heading"], ["52poke · 派生规范化展示", "wiki-heading"], ["文字取舍", ""]]) {
      const th = make("th", cls, text); th.scope = "col"; heading.append(th);
    }
    head.append(heading); table.append(columns, head);
    const body = make("tbody");
    const rows = card.rows.filter(row => !$("differences-only").checked || ["different", "missing"].includes(row.status));
    let group = "";
    for (const row of rows) {
      if (row.group !== group) {
        const tr = make("tr"), th = make("th", "group-heading", row.group);
        th.colSpan = 4; th.scope = "colgroup"; tr.append(th); body.append(tr); group = row.group;
      }
      const tr = make("tr");
      tr.dataset.fieldId = row.id; tr.dataset.status = row.status;
      const label = make("th"); label.scope = "row";
      const status = make("span", "field-status", statusLabels[row.status]); status.dataset.status = row.status;
      label.append(make("span", "field-label", row.label), status);
      if (row.hint) label.append(make("div", "field-hint", row.hint));
      const choice = make("td");
      if (row.selectable) {
        const select = make("select", "source-choice");
        select.dataset.fieldChoice = row.id;
        select.setAttribute("aria-label", `${row.group} ${row.label}：选择文字来源`);
        for (const [value, label] of Object.entries(fieldLabels)) {
          const option = make("option", "", label); option.value = value; select.append(option);
        }
        select.value = decisions[card.id].field_preferences[row.id] || "unreviewed";
        select.classList.toggle("chosen", select.value !== "unreviewed");
        select.addEventListener("change", () => {
          decisions[card.id].field_preferences[row.id] = select.value;
          decisions[card.id].updated_at = new Date().toISOString();
          select.classList.toggle("chosen", select.value !== "unreviewed");
          persist();
        });
        choice.append(select);
      } else choice.append(make("span", "readonly-label", "只读对照"));
      tr.append(label, valueCell(row, "mik"), valueCell(row, "wiki"), choice);
      body.append(tr);
    }
    table.append(body);
    $("comparison-table").replaceChildren(table);
    $("comparison-table").hidden = !rows.length;
    $("no-differences").hidden = !!rows.length;
    const counts = card.counts;
    $("difference-summary").replaceChildren(
      make("span", "summary-diff", `字面差异 ${counts.different || 0}`),
      make("span", "summary-diff", `一侧未提供 ${counts.missing || 0}`),
      make("span", "", `仅格式差异 ${counts.equivalent || 0}`),
      make("span", "", `相同 ${counts.equal || 0}`)
    );
  }

  function renderImage() {
    const card = byId.get(activeId);
    if (!card) return;
    const image = imageSource === "mik" ? card.mik_image : card.wiki_image;
    for (const button of document.querySelectorAll("[data-image-source]"))
      button.setAttribute("aria-pressed", String(button.dataset.imageSource === imageSource));
    $("image-open").hidden = !image;
    $("image-empty").hidden = !!image;
    if (!image) {
      $("card-image").removeAttribute("src");
      $("image-caption").textContent = card.wiki_image_record?.wiki_filename
        ? `Wiki 记录了 ${card.wiki_image_record.wiki_filename}，但未找到哈希一致的本地文件。`
        : "这份 Wiki 展示记录没有已选卡图。";
      $("image-identity").textContent = "没有用 mik 图冒充 Wiki 卡图，也不会联网补图。";
      $("image-integrity").textContent = "";
      return;
    }
    $("card-image").src = image.src;
    $("card-image").alt = `${card.name} · ${imageSource === "mik" ? card.id : image.identity}`;
    $("image-caption").textContent = imageSource === "mik"
      ? `mik · ${card.id} · ${image.source_size.join(" × ")} px 原始 PNG`
      : `Wiki 页面卡图 · ${image.identity} · 源 ${image.source_size.join(" × ")} px`;
    $("image-identity").textContent = imageSource === "mik"
      ? "来源哈希已核验；印刷身份仍需你对照卡面确认。"
      : image.note;
    $("image-integrity").textContent = imageSource === "mik"
      ? "原始响应与图像 SHA-256 已校验"
      : "源文件 SHA-256 一致 · 页面内嵌压缩预览";
  }

  function infoTable(headers, rows) {
    const table = make("table", "info-table");
    const head = make("thead"), tr = make("tr");
    for (const name of headers) { const th = make("th", "", name); th.scope = "col"; tr.append(th); }
    head.append(tr); table.append(head);
    const body = make("tbody");
    for (const values of rows) {
      const row = make("tr");
      for (const value of values) row.append(make("td", "", value ?? "未提供"));
      body.append(row);
    }
    table.append(body); return table;
  }

  function renderSource(card) {
    const mik = card.raw.mik;
    const joined = field => card.printings.map(printing => printing[field] ?? "未提供").join("\n") || "无对应简中印刷行";
    $("supplement-section").hidden = !card.supplements?.length;
    $("supplement-proposals").replaceChildren(infoTable(["补充路径", "建议值", "来源与状态"], (card.supplements || []).map(proposal => [
      proposal.target, proposal.proposed_value,
      `${proposal.source.card_id} · ${proposal.source.field}\n仅缺失时补充 · 未应用`
    ])));
    $("printing-comparison").replaceChildren(infoTable(["字段", "mik 当前印刷", "Wiki 对应印刷行"], [
      ["系列", mik.setCode, joined("set_code")],
      ["卡号", mik.setCardsNum ? `${mik.cardIndex}/${mik.setCardsNum}` : `${mik.cardIndex}（分母未提供；字母编号不猜分母）`, joined("number")],
      ["画师", mik.artist || "空白", joined("illustrator")],
      ["稀有度", mik.rarity, joined("rarity")],
      ["规则标记", mik.regulationMark, joined("regulation_mark")],
      ["发行时间原值", mik.releaseDate, joined("release_date")],
      ["日期说明", "原值可能是 UTC；与发行地日期可相差一天", "不按日期字符串差异直接判定不同印刷"],
      ["来源记录赛制", JSON.stringify(mik.regulationLegal), "不是实时赛制合法性核准"],
    ]));
    const checks = make("div", "check-grid");
    const labels = {
      game: "实体 TCG", kind: "卡种", hp: "HP", type: "属性", stage: "进化阶段",
      attack_count: "招式数量", ability_count: "特性数量", retreat: "撤退费用", weakness_type: "弱点属性",
      no_resistance: "无抗性", basic_vs_special_energy: "基本 / 特殊能量区分",
      basic_darkness_energy_type: "恶能量属性", trainer_subtype: "训练家子类型"
    };
    for (const [key, value] of Object.entries(card.checks)) {
      let label = labels[key] || key;
      const attack = key.match(/^attacks\.(\d+)\.(.+)$/);
      if (attack) label = `招式 ${Number(attack[1]) + 1} · ${attack[2].startsWith("cost") ? "费用及 + 标记" : "伤害及运算符"}`;
      checks.append(make("div", `check-item${value ? "" : " failed"}`, `${value ? "✓" : "×"} ${label}`));
    }
    $("structural-checks").replaceChildren(checks);
    const list = make("dl", "provenance-list");
    const entries = [
      ["Wiki 候选", `${card.wiki_id} · block ${card.raw.sample_comparison.wiki_candidate.block}`],
      ["mik 名称召回", `${mik.name} / ${mik.nameEn || "英文名未提供"}`],
      ["Wiki 名称召回", `${card.raw.wiki.display_name} / ${card.raw.wiki.names?.en?.text || "英文名未提供"}`],
      ["ID 命名空间", "mik 标识对应本来源印刷版；52poke 标识对应规则页面。不是跨来源按 ID 相等关联。"],
      ["召回候选页", card.candidate_pages.join(" / ")],
      ["固定修订", card.provenance.wiki_revision_id],
      ["来源 effectId", mik.effectId + "（辅助线索，不等同跨源规则身份）"],
      ["mik metadata SHA-256", card.provenance.mik_metadata_sha256],
      ["mik 图片 SHA-256", card.provenance.mik_image_sha256],
      ["Wiki 原文 SHA-256", card.provenance.wiki_source_wikitext_sha256],
      ["数据指纹", data.fingerprint],
      ["Wiki 归属", "神奇宝贝百科及其贡献者 · 来源记录许可 CC BY-NC-SA 3.0；图像权利另计"],
    ];
    for (const [key, value] of entries) list.append(make("dt", "", key), make("dd", "", value));
    $("source-provenance").replaceChildren(list);
  }

  function renderRaw(card) {
    const fragment = document.createDocumentFragment();
    for (const [key, label] of [
      ["mik", "mik · 完整原始 metadata"],
      ["wiki", "52poke · 原始结构与所有印刷行"],
      ["wiki_display", "52poke · 简体展示与字段来源"],
      ["sample_comparison", "抽样检查记录 · 非审核结论"],
      ["normalized_wiki", "52poke · 规范化结构（原始结构在上方）"],
      ["normalized_wiki_display", "52poke · 规范化展示"],
      ["merged_candidate", "实际生成的合并候选 · 未写正式库"]
    ]) {
      const details = make("details", "raw-details");
      details.append(make("summary", "", label), make("pre", "", JSON.stringify(card.raw[key], null, 2)));
      fragment.append(details);
    }
    $("raw-content").replaceChildren(fragment);
  }

  function setTab(tab, focus = false) {
    currentTab = tab;
    for (const button of document.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
      $(`panel-${button.dataset.tab}`).hidden = !selected;
      if (selected && focus) button.focus();
    }
  }

  function equivalenceLabel(decision) {
    return {
      deterministic_equal: "确定性检查：原文相同或仅图标／空白差异",
      deterministic_equal_with_reminder: "确定性检查：仅多出有依据的标准提示",
      equivalent: "双模型：规则等价（机器判断）",
      equivalent_with_reminder: "双模型：正文等价＋标准规则提示",
      needs_review: "暂不通过：冲突、分歧或证据不足"
    }[decision] || "未知判定，不能放行";
  }

  function renderSemantic(card) {
    const labels = {
      timing: "使用时机", trigger: "触发条件", controller: "归属／玩家", targets: "对象",
      zones: "来源／目标区域", amounts: "数量／上下限", costs: "使用代价",
      operations: "操作／先后顺序", limits: "次数／持续期间", exceptions: "排除／可选条件"
    };
    const relations = {match:"一致", different:"冲突", unclear:"不确定", absent:"双方未涉及"};
    const verdicts = {equivalent:"等价", equivalent_with_reminder:"等价＋标准提示", different:"规则不同", uncertain:"不能确认"};
    const entries = card.semantic_equivalence;
    const accepted = entries.filter(entry => entry.machine_accepted).length;
    $("semantic-card-summary").textContent = `${accepted} / ${entries.length} 个效果字段通过自动检查。` +
      (card.merge_holds.length ? ` 本卡仍暂缓：${card.merge_holds.map(hold => hold.code).join("、")}` :
      " 本卡机器检查通过，但仍未写入正式库，也没有替你作人工核准。");
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const section = make("section", "semantic-evidence-card");
      section.dataset.equivalenceId = entry.id;
      section.append(make("h3", "", entry.id.split(":").at(-1)),
        make("div", `semantic-badge${entry.machine_accepted ? "" : " held"}`, equivalenceLabel(entry.decision)));
      if (entry.hold_reasons.length) section.append(make("p", "", `暂缓原因：${entry.hold_reasons.join("、")}`));
      if (!entry.reviews.length) section.append(make("p", "", entry.machine_accepted
        ? "两边文字经保留数字、运算符、否定与顺序的安全格式规范化后相同；不额外调用模型。空白效果不等于缺少卡牌通用规则。"
        : "两边文字有差异，尚未完成语义核验；不能自动通过。"));
      if (entry.context.mechanic_rule) {
        const context = make("p", "semantic-context", `已验证的共同上下文：${entry.context.mechanic_rule}\n来源技能模板：${entry.context.slot_template}。`);
        const link = make("a", "", `官方规则 · ${entry.context.official_rule.section} · 第${entry.context.official_rule.printed_page}页 ↗`);
        link.href = entry.context.official_rule.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        context.append(document.createElement("br"), link); section.append(context);
      }
      for (const review of entry.reviews) {
        const details = make("details", "semantic-reviewer");
        details.append(make("summary", "", `${review.deployment} · ${review.input_order_reversed ? "交换输入顺序复查" : "首次核验"} · ${verdicts[review.verdict]}`),
          make("p", "", review.summary));
        const wrapper = make("div", "semantic-table-wrap");
        wrapper.append(infoTable(["规则条件", "结果／解释", "mik逐字证据", "52poke逐字证据"],
          review.dimensions.map(item => [
            labels[item.dimension], `${relations[item.relation]}\n${item.explanation}`,
            item.left_quotes.join("\n") || (item.context_keys.length ? "共同机制规则（原文省略）" : "未涉及／未提供"),
            item.right_quotes.join("\n") || (item.context_keys.length ? "共同机制规则（原文省略）" : "未涉及／未提供")
          ])));
        details.append(wrapper, make("p", "small-note", `请求SHA-256：${review.request_sha256}\n响应SHA-256：${review.response_sha256}`));
        section.append(details);
      }
      fragment.append(section);
    }
    $("semantic-evidence").replaceChildren(fragment);
    const controls = data.equivalence.controls;
    if (!data.equivalence.model_review_complete || !data.equivalence.calibration_required) {
      $("equivalence-control-summary").textContent = data.equivalence.model_review_complete
        ? "本轮正文均可确定性比较，无需调用模型校准" : "模型校准尚未运行";
      $("equivalence-control-table").replaceChildren();
      return;
    }
    $("equivalence-control-summary").textContent = `反例／正例校准：${controls.filter(control => control.passed).length} / ${controls.length} 通过 · ` +
      (data.equivalence.calibration_passed ? "两模型均通过；不是全量准确率" : "校准失败：模型结论不得自动放行");
    $("equivalence-control-table").replaceChildren(infoTable(["人工构造测试", "应否等价", "两模型结论", "结果"],
      controls.map(control => [control.id.replace("control:", ""), control.expected_accept ? "应等价" : "不能放行",
        control.verdicts.map(verdict => verdicts[verdict]).join(" / "), control.passed ? "通过" : "失败"])));
  }

  function renderCard() {
    const card = byId.get(activeId);
    if (!card) return;
    $("card-title").textContent = card.name;
    $("card-subtitle").textContent = `${card.id}  →  ${card.wiki_id} · ${card.wiki_title} · ${card.merge_status === "ready" ? "检查通过（未入库）" : "需要复核（未入库）"}`;
    const warnings = document.createDocumentFragment();
    for (const text of card.warnings) warnings.append(make("li", "", text));
    $("warnings").replaceChildren(warnings);
    $("mik-source-link").href = card.mik_url;
    $("wiki-source-link").href = card.wiki_url;
    $("wiki-source-link").hidden = !card.wiki_url;
    renderImage(); renderTable(card); renderSource(card); renderRaw(card); renderSemantic(card);
    for (const radio of document.querySelectorAll('[name="mapping-decision"]'))
      radio.checked = radio.value === decisions[card.id].mapping_decision;
    $("review-notes").value = decisions[card.id].notes;
    $("decision-state").textContent = decisionLabels[decisions[card.id].mapping_decision];
    setTab(currentTab); updateSaveStatus();
  }

  $("search").addEventListener("input", () => { if (renderQueue()) { imageSource = "mik"; renderCard(); } });
  $("status-filter").addEventListener("change", () => { if (renderQueue()) { imageSource = "mik"; renderCard(); } });
  $("differences-only").addEventListener("change", () => { if (activeId) renderTable(byId.get(activeId)); });
  $("previous").addEventListener("click", () => move(-1));
  $("next").addEventListener("click", () => move(1));
  $("next-review").addEventListener("click", () => move(1));
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => setTab(button.dataset.tab));
    button.addEventListener("keydown", event => {
      const tabs = Array.from(document.querySelectorAll("[data-tab]"), item => item.dataset.tab);
      const index = tabs.indexOf(currentTab);
      let next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      if (event.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
      if (event.key === "Home") next = tabs[0];
      if (event.key === "End") next = tabs.at(-1);
      if (next) { event.preventDefault(); setTab(next, true); }
    });
  }
  for (const button of document.querySelectorAll("[data-image-source]"))
    button.addEventListener("click", () => { imageSource = button.dataset.imageSource; renderImage(); });

  $("image-open").addEventListener("click", () => {
    const card = byId.get(activeId), image = imageSource === "mik" ? card.mik_image : card.wiki_image;
    if (!image) return;
    $("image-dialog-title").textContent = `${card.name} · ${imageSource === "mik" ? "mik" : "52poke"} 卡图`;
    $("dialog-image-caption").textContent = `${$("image-caption").textContent}。${$("image-identity").textContent} 放大不会增加源图分辨率。`;
    $("dialog-image").src = image.src;
    $("dialog-image").alt = $("card-image").alt;
    $("dialog-image").dataset.nativeWidth = image.display_size[0];
    $("image-zoom").value = "1";
    $("dialog-image").style.width = `${image.display_size[0]}px`;
    $("image-dialog").showModal();
  });
  $("image-zoom").addEventListener("change", () => {
    $("dialog-image").style.width = `${Number($("dialog-image").dataset.nativeWidth) * Number($("image-zoom").value)}px`;
  });
  $("close-image").addEventListener("click", () => $("image-dialog").close());

  for (const radio of document.querySelectorAll('[name="mapping-decision"]'))
    radio.addEventListener("change", () => {
      if (!activeId || !radio.checked) return;
      decisions[activeId].mapping_decision = radio.value;
      decisions[activeId].updated_at = new Date().toISOString();
      $("decision-state").textContent = decisionLabels[radio.value];
      persist();
      if (renderQueue()) { imageSource = "mik"; renderCard(); }
    });
  $("review-notes").addEventListener("input", () => {
    if (!activeId) return;
    decisions[activeId].notes = $("review-notes").value;
    decisions[activeId].updated_at = new Date().toISOString();
    persist();
  });

  $("export-button").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(exportDocument(), null, 2) + "\n"], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = make("a");
    link.href = url; link.download = `mik-52poke-semantic-${data.cards.length}-review-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notice("审核意见已导出。文件包含来源指纹、候选关联、文字取舍和备注；不会执行数据合并。");
  });
  $("import-button").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("文件超过 2 MB，请选择本页导出的审核 JSON。");
      const imported = validateImport(JSON.parse(await file.text()));
      if (!confirm(`导入会替换本组 ${data.cards.length} 张样本当前的审核意见，是否继续？`)) return;
      Object.assign(decisions, imported);
      persist(); renderQueue(); renderCard();
      notice(`已恢复 ${data.cards.length} 张样本的审核意见，原始卡牌数据没有改动。`);
    } catch (error) { notice(`导入失败：${error.message}`, true); }
    finally { $("import-file").value = ""; }
  });
  $("snapshot-label").textContent = `52poke 快照 ${data.archive_release} · ${data.cards.length} 张冻结样本 · 样本时间 ${data.sampled_at.slice(0, 10)}`;
  if (data.semantic_probe) {
    $("similarity-controls").hidden = false;
    $("similarity-context").textContent =
      `${data.semantic_probe.deployment} · ${data.semantic_probe.dimensions} 维 · ${data.semantic_probe.sample_pairs} 组实际效果对照。下面是不能被高分误放行的反例：`;
    $("similarity-control-table").replaceChildren(infoTable(["反例", "余弦相似度"], data.semantic_probe.controls.map(control => [
      control.label, control.cosine.toFixed(4)
    ])));
  }
  renderQueue(); renderCard();
  if (location.hash === "#semantic") setTab("semantic");
})();
