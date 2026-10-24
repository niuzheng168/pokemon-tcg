"use strict";
const $ = id => document.getElementById(id);
const names = {card:"明确是宝可梦卡牌",non_card:"明确不是纯卡图",review:"需要你复核",all:"全部官网图片"};
const kinds = {card_front:"卡牌正面",card_back:"卡背",multi_card:"多卡拼图",product:"商品",packaging:"包装",poster:"海报",banner:"横幅 / 背景",logo:"Logo / 图标",photo:"实拍场景",accessory:"周边",other:"其他",uncertain:"不确定"};
const methods = {two_model_consensus:"双模型一致",enlarged_majority:"放大复判通过",two_single_image_consensus:"双单图模型一致",disagreement:"模型有分歧",geometry_hold:"画幅待检查",layout_hold:"整图版式待检查",pending:"等待模型判别",image_error:"预览处理异常",provider_hold:"模型服务拒绝自动判别"};
const state = {images:[], summary:{}, label:"review", page:1, size:72, selected:new Set(), current:null, saving:false};
const number = v => Number(v || 0).toLocaleString("zh-CN");
function node(tag, cls, text) {
  const el=document.createElement(tag); if(cls)el.className=cls; if(text!==undefined)el.textContent=text; return el;
}
function toast(text) {
  $("toast").textContent=text; $("toast").hidden=false; clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>$("toast").hidden=true,4200);
}
function filtered() {
  const q=$("search").value.trim().toLowerCase(),kind=$("kind-filter").value;
  const result=state.images.filter(r=>(state.label==="all"||r.label===state.label) &&
    (!kind||r.ai.kind===kind) && (!q||[r.id,r.short_id,r.ai.reason,r.human?.note,...r.sources].join(" ").toLowerCase().includes(q)));
  const sort=$("sort").value;
  return result.sort((a,b)=>{
    if(sort==="resolution")return ((b.width||0)*(b.height||0))-((a.width||0)*(a.height||0));
    if(sort==="score")return a.ai.score-b.ai.score||a.short_id.localeCompare(b.short_id);
    if(sort==="priority"){
      const p=r=>({disagreement:0,geometry_hold:1,layout_hold:1,image_error:2,pending:4}[r.ai.method]??3);
      return p(a)-p(b)||a.ai.score-b.ai.score||a.short_id.localeCompare(b.short_id);
    }
    return a.short_id.localeCompare(b.short_id);
  });
}
function visible() {const rows=filtered();return rows.slice((state.page-1)*state.size,state.page*state.size);}
function updateSelection() {
  const page=visible(),count=state.selected.size;
  $("selected-count").textContent=count?`已选 ${number(count)} 张`:"未选择图片";
  $("batch-count").textContent=`已选 ${number(count)} 张`;$("batch").hidden=!count;
  $("select-page").checked=!!page.length&&page.every(r=>state.selected.has(r.id));
  $("select-page").indeterminate=page.some(r=>state.selected.has(r.id))&&!$("select-page").checked;
  for(const tile of $("grid").children){const selected=state.selected.has(tile.dataset.id);tile.classList.toggle("selected",selected);tile.querySelector("input").checked=selected;}
}
function choose(label) {
  state.label=label;state.page=1;state.selected.clear();
  for(const button of document.querySelectorAll("[data-label]"))button.setAttribute("aria-pressed",String(button.dataset.label===label));
  $("section-title").textContent=names[label];$("section-eyebrow").textContent=label==="review"?"REVIEW QUEUE":"IMAGE LIBRARY";render();
}
function render() {
  const rows=filtered(),pages=Math.max(1,Math.ceil(rows.length/state.size));state.page=Math.min(state.page,pages);
  $("grid").replaceChildren();$("empty").hidden=!!rows.length;$("loading").hidden=true;
  $("result-count").textContent=`${number(rows.length)} 张 · 仅显示当前分类`;
  for(const row of rows.slice((state.page-1)*state.size,state.page*state.size)){
    const tile=node("article","tile");tile.dataset.id=row.id;
    const visual=node("div","tile-visual");visual.tabIndex=0;visual.setAttribute("role","button");visual.setAttribute("aria-label",`查看 ${row.short_id} 图片详情`);
    const check=node("input");check.type="checkbox";check.setAttribute("aria-label",`选择 ${row.short_id}`);
    check.addEventListener("click",e=>e.stopPropagation());check.addEventListener("change",()=>{check.checked?state.selected.add(row.id):state.selected.delete(row.id);updateSelection();});
    visual.append(check,node("span","tile-number",row.short_id));
    if(row.thumb_url){const img=node("img");img.src=row.thumb_url;img.loading="lazy";img.alt=`${row.short_id} ${kinds[row.ai.kind]||""}`;visual.append(img);}else visual.append(node("span","muted","预览暂不可用"));
    visual.addEventListener("click",()=>detail(row.id));visual.addEventListener("keydown",e=>{if(e.target===visual&&["Enter"," "].includes(e.key)){e.preventDefault();detail(row.id);}});
    const info=node("div","tile-info"),line=node("div","tile-line");
    line.append(node("span",`badge ${row.label}`,row.human?"人工确认":kinds[row.ai.kind]||"待判别"),node("span","dimension",`${row.width||"?"} × ${row.height||"?"}`));
    const foot=node("div","tile-foot");foot.append(node("span","",row.human?"你的审核结果":methods[row.ai.method]||"模型判定"),node("span","",row.ai.score?`模型评分 ${row.ai.score}/100`:""));
    info.append(line,node("p","tile-reason",row.human?.note||row.ai.reason),foot);
    const actions=node("div","tile-actions");for(const [label,text]of [["card","✓ 是卡图"],["non_card","▧ 非纯卡图"],["review","? 待复核"]]){const b=node("button","",text);b.addEventListener("click",()=>save([row.id],label));actions.append(b);}
    tile.append(visual,info,actions);$("grid").append(tile);
  }
  $("grid").setAttribute("aria-busy","false");$("page-info").textContent=`${state.page} / ${pages}`;
  $("page-number").max=String(pages);$("page-number").value=String(state.page);
  $("previous").disabled=state.page<=1;$("next").disabled=state.page>=pages;updateSelection();
}
async function load({quiet=false}={}) {
  try {
    const response=await fetch("/api/catalog",{cache:"no-store"});if(!response.ok)throw new Error("读取分类结果失败");
    const data=await response.json();state.images=data.images;state.summary=data.summary;
    $("total").textContent=number(data.summary.total);$("human-count").textContent=number(data.summary.human_reviewed);
    for(const label of ["card","non_card","review"])$("count-"+label).textContent=number(data.summary.counts[label]);
    const reviewed=data.summary.two_model_reviewed,progress=data.summary.progress||{};
    const first=data.images.filter(r=>r.votes.primary).length;
    $("run-status").textContent=data.summary.pipeline_complete&&progress.finished?
      `自动分类完成 · 双模型 ${number(reviewed)} 张${data.summary.provider_held_images?` · 服务拒绝保留 ${number(data.summary.provider_held_images)} 张`:""}`:
      ["adjudicator","verifier","frame_audit"].includes(progress.phase)&&!progress.finished?
      `${progress.phase==="frame_audit"?"整图版式复判":"单图放大复判"} · ${number(progress.completed_images)} / ${number(progress.planned_images)}`:
      reviewed===data.summary.total?`双模型判别完成 · ${number(reviewed)} 张`:
      `首轮 ${number(first)} / ${number(data.summary.total)} · 双模型 ${number(reviewed)}`;
    if(progress.errors)$("run-status").textContent+=` · ${progress.errors} 个调用异常已保留`;
    render();
    if($("detail").open&&state.current)fillDetail(state.current);
  }catch(error){if(!quiet){$("loading").textContent="无法读取数据，请确认本地审核服务仍在运行。";toast(error.message);}}
}
function detail(id) {state.current=id;fillDetail(id);if(!$("detail").open)$("detail").showModal();}
function fillDetail(id) {
  const row=state.images.find(r=>r.id===id);if(!row)return;
  const list=filtered(),index=list.findIndex(r=>r.id===id);
  $("detail-id").textContent=`${row.short_id} / 官网原始图片`;$("detail-position").textContent=index<0?"":`${index+1} / ${list.length}`;
  $("detail-image").src=row.thumb_url||"";$("original-link").href=row.original_url;
  $("detail-badge").className=`badge ${row.label}`;$("detail-badge").textContent=names[row.label]+(row.human?" · 人工确认":" · 模型判定");
  $("detail-kind").textContent=kinds[row.ai.kind]||"等待视觉判别";$("detail-dimensions").textContent=`${row.width||"?"} × ${row.height||"?"} 像素 · ${(row.bytes/1024/1024).toFixed(2)} MB · 模型评分 ${row.ai.score}/100`;
  $("detail-reason").textContent=row.human?.note||row.ai.reason;$("detail-hash").textContent=row.id;$("note").value=row.human?.note||"";
  $("votes").replaceChildren();
  const phaseNames={primary:"第一次视觉判别",secondary:"第二模型独立判别",adjudicator:"单图放大复判",verifier:"另一模型独立单图复核"};
  for(const [phase,vote]of Object.entries(row.votes)){
    const box=node("div","vote"),top=node("div");top.append(node("b","",phaseNames[phase]||phase),node("span","",`${vote.confidence}/100`));
    box.append(top,node("strong","",vote.model||"Foundry 视觉模型"),node("p","",`${names[vote.label]} · ${vote.reason}`));$("votes").append(box);
  }
  if(!Object.keys(row.votes).length)$("votes").append(node("p","muted","模型尚未完成判别，请稍后刷新。"));
  $("sources").replaceChildren();
  for(const source of row.sources){try{const u=new URL(source);if(u.protocol!=="https:")continue;const a=node("a","",u.hostname+u.pathname);a.href=source;a.target="_blank";a.rel="noopener noreferrer";$("sources").append(a);}catch{}}
}
function step(direction) {
  const rows=filtered(),index=rows.findIndex(r=>r.id===state.current),next=rows[index+direction];
  if(next)detail(next.id);else toast("已到当前筛选结果的边界。");
}
async function save(ids,label,note="") {
  if(state.saving)return;state.saving=true;
  const advance=$("detail").open&&state.label==="review"&&!["review","reset"].includes(label)&&ids.includes(state.current);
  const queue=advance?filtered():[],position=queue.findIndex(r=>r.id===state.current);
  const nextId=advance?(queue[position+1]?.id||queue[position-1]?.id):null;
  try {
    const response=await fetch("/api/review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids,label,note,revision:state.summary.review_revision})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||"保存失败");
    for(const id of ids)state.selected.delete(id);
    toast(result.warning||(label==="reset"?`已恢复 ${ids.length} 张图片的 AI 判定`:`已保存 ${ids.length} 张图片的审核结果`));
    await load({quiet:true});
    if(advance){if(nextId&&state.images.some(r=>r.id===nextId&&r.label==="review"))detail(nextId);else $("detail").close();}
  }catch(error){toast(error.message);await load({quiet:true});}finally{state.saving=false;}
}
$("refresh").addEventListener("click",()=>load());
for(const button of document.querySelectorAll("[data-label]"))button.addEventListener("click",()=>choose(button.dataset.label));
$("show-all").addEventListener("click",()=>choose("all"));
for(const id of ["search","kind-filter","sort"])$(id).addEventListener(id==="search"?"input":"change",()=>{state.page=1;render();});
$("page-size").addEventListener("change",()=>{state.size=Number($("page-size").value);state.page=1;render();});
$("select-page").addEventListener("change",()=>{for(const row of visible())$("select-page").checked?state.selected.add(row.id):state.selected.delete(row.id);updateSelection();});
$("clear-selection").addEventListener("click",()=>{state.selected.clear();updateSelection();});
for(const button of document.querySelectorAll("[data-save]"))button.addEventListener("click",()=>save([...state.selected],button.dataset.save));
for(const button of document.querySelectorAll("[data-detail-save]"))button.addEventListener("click",()=>save([state.current],button.dataset.detailSave,$("note").value));
$("reset-detail").addEventListener("click",()=>save([state.current],"reset"));
$("close-detail").addEventListener("click",()=>$("detail").close());
$("detail-previous").addEventListener("click",()=>step(-1));$("detail-next").addEventListener("click",()=>step(1));
$("previous").addEventListener("click",()=>{state.page--;render();$("section-title").scrollIntoView({block:"start"});});
$("next").addEventListener("click",()=>{state.page++;render();$("section-title").scrollIntoView({block:"start"});});
function goPage(){state.page=Math.max(1,Math.min(Number($("page-number").max),Number($("page-number").value)||1));render();}
$("go-page").addEventListener("click",goPage);$("page-number").addEventListener("keydown",e=>{if(e.key==="Enter")goPage();});
document.addEventListener("keydown",e=>{
  if(["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)||!$("detail").open)return;
  if(e.key==="ArrowLeft")step(-1);if(e.key==="ArrowRight")step(1);
  const label={"1":"card","2":"non_card","3":"review"}[e.key];
  if(label){e.preventDefault();save([state.current],label,$("note").value);}
});
load();
setInterval(()=>{if(!state.saving&&!$("detail").open)load({quiet:true});},30000);
