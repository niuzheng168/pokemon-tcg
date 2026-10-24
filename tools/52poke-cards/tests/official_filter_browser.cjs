// Synthetic, offline end-to-end test. Never edits real reviews or calls Foundry.
const assert=require("node:assert/strict");
const http=require("node:http");
const {spawn,execFileSync}=require("node:child_process");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {chromium}=require("@playwright/test");
(async()=>{
  const tool=path.resolve(__dirname,".."),python=path.join(tool,".venv/bin/python");
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),"official-filter-browser-"));
  const env={...process.env,PYTHONPATH:tool,TEST_ROOT:temporary};
  execFileSync(python,["-c",`
import os,json
from pathlib import Path
from PIL import Image
from official_filter.core import Store,checksum
root=Path(os.environ['TEST_ROOT']); images=root/'images'; images.mkdir()
rows=[]
for i in range(6):
 p=images/f'temp{i}.png';Image.new('RGB',(300+i,420+i),(30+i*30,100,70)).save(p);sha=checksum(p);p.rename(images/(sha+'.png'))
 rows.append({'sha256':sha,'bytes':(images/(sha+'.png')).stat().st_size,'width':300+i,'height':420+i,'suffix':'.png',
 'source_url':'https://image.pokemon.com.cn/test.png','source_pages':['https://www.pokemon.cn/tcg/product/test.html']})
receipts=root/'receipts.jsonl';receipts.write_text('\\n'.join(json.dumps(r) for r in rows)+'\\n')
s=Store(root/'state');s.seed(receipts,images,root/'derived',root/'reports')
for i,r in enumerate(s.rows()):
 s.prepare_one(r)
 if i==5:continue
 for phase in ('primary','secondary'):
  label='card' if i<2 else 'non_card' if i<4 else 'card' if phase=='primary' else 'non_card'
  v={'id':r['short_id'],'label':label,'kind':'card_front' if label=='card' else 'product','confidence':99,
  'full_card':label=='card','reason':'合成测试证据，不是真实图片准确率。'}
  s.save_vote(r['id'],phase,v,model='synthetic-'+phase)
s.export()
`],{env});
  const dynamic=process.env.TEST_SSH_FORWARD==="dynamic";
  const forwarded=dynamic||process.env.TEST_SSH_FORWARD==="1";
  const proxies=[];
  let forwardedBase,backend,rewriteHost=false;
  async function startProxy(){
    const proxy=http.createServer((req,res)=>{
      const headers={...req.headers};
      if(rewriteHost)headers.host=new URL(backend).host;
      const upstream=http.request(backend+req.url,{method:req.method,headers},response=>{
        res.writeHead(response.statusCode,response.headers);response.pipe(res);
      });
      upstream.on("error",()=>{res.writeHead(502);res.end();});req.pipe(upstream);
    });
    await new Promise(resolve=>proxy.listen(0,"127.0.0.1",resolve));
    proxies.push(proxy);
    return "http://localhost:"+proxy.address().port;
  }
  if(forwarded)forwardedBase=await startProxy();
  const child=spawn(python,["-u","-m","official_filter","--state",path.join(temporary,"state"),"serve","--port","0",
    ...(dynamic?["--ssh-forwarded"]:forwarded?["--forwarded-origin",forwardedBase]:[])],{env,stdio:["ignore","pipe","pipe"]});
  let browser;
  try {
    backend=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Test server did not start")),15000);
      child.stdout.on("data",data=>{const match=data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      child.once("exit",code=>reject(new Error("Test server exited: "+code)));
    });
    let base=forwardedBase||backend;
    if(forwarded){
      for(const mode of [false,true]){
        rewriteHost=mode;
        const response=await fetch(base+"/api/catalog");
        assert.equal(response.status,200);
        assert.equal((await response.json()).summary.total,6);
      }
      if(dynamic){
        // Allocate another frontend port without restarting/reconfiguring
        // the backend, just as a reconnecting SSH client does.
        base=await startProxy();
        assert.notEqual(base,forwardedBase);
        assert.equal((await fetch(base+"/api/catalog")).status,200);
      }
      rewriteHost=process.env.TEST_PROXY_PRESERVE_HOST!=="1";
    }
    browser=await chromium.launch({headless:true,args:["--no-sandbox"]});
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const external=[],errors=[];
    await context.route("**/*",route=>{const u=new URL(route.request().url());if(["http:","https:"].includes(u.protocol)&&u.origin!==base){external.push(u.href);return route.abort();}return route.continue();});
    const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
    await page.goto(base);await page.waitForFunction(()=>document.querySelector("#total").textContent==="6");
    assert.equal(await page.locator(".tile").count(),2);
    for(const label of ["card","non_card","review"]){
      await page.locator(`[data-label="${label}"]`).click();
      assert.equal(await page.locator(".tile").count(),2);
      const images=page.locator(".tile-visual img");
      await images.first().evaluate(img=>img.decode());
    }
    await page.locator("#show-all").click();assert.equal(await page.locator(".tile").count(),6);
    await page.locator("#select-page").check();assert.match(await page.locator("#batch-count").textContent(),/6/);
    await page.locator('[data-save="non_card"]').click();
    await page.waitForFunction(()=>document.querySelector("#human-count").textContent==="6");
    assert.equal(await page.locator("#count-non_card").textContent(),"6");
    await page.locator("#select-page").check();await page.locator('[data-save="reset"]').click();
    await page.waitForFunction(()=>document.querySelector("#human-count").textContent==="0");
    await page.locator('[data-label="card"]').click();await page.locator(".tile-visual").first().click();
    await page.waitForFunction(()=>document.querySelector("#detail").open);
    await page.locator("#detail-image").evaluate(img=>img.decode());
    await page.locator("#note").fill('人工标记 <script>not executed</script>');
    await page.locator('[data-detail-save="non_card"]').click();
    await page.waitForFunction(()=>document.querySelector("#human-count").textContent==="1");
    assert.match(await page.locator("#detail-badge").textContent(),/人工确认/);
    await page.reload();await page.waitForFunction(()=>document.querySelector("#human-count").textContent==="1");
    await page.locator('[data-label="non_card"]').click();
    assert.equal(await page.locator(".tile").count(),3);
    const api=await (await context.request.get(base+"/api/catalog")).json();
    const reviewed=api.images.find(r=>r.human);
    const reset=await context.request.post(base+"/api/review",{data:{ids:[reviewed.id],label:"reset",revision:api.summary.review_revision}});
    assert.equal(reset.status(),200);
    const denied=await context.request.post(base+"/api/review",{headers:{Origin:"https://evil.invalid"},data:{ids:[reviewed.id],label:"card",revision:99}});
    assert.equal(denied.status(),403);
    assert.equal((await context.request.get(base+"/.env.foundry")).status(),404);
    if(dynamic){
      const before=await (await context.request.get(base+"/api/catalog")).json();
      const attackerContext=await browser.newContext();
      try{
        const attacker=await attackerContext.newPage();
        const attackOrigin="http://localhost:"+(new URL(base).port==="59996"?"59995":"59996");
        await attacker.route(attackOrigin+"/",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><title>Offline cross-origin test</title>"}));
        await attacker.goto(attackOrigin+"/");
        // text/plain is a simple request, so a rejected preflight alone
        // cannot conceal an accidentally accepted cross-port mutation.
        await attacker.evaluate(async({base,id,revision})=>{
          try{await fetch(base+"/api/review",{method:"POST",headers:{"Content-Type":"text/plain"},
            body:JSON.stringify({ids:[id],label:"non_card",revision})});}catch{}
        },{base,id:before.images[0].id,revision:before.summary.review_revision});
        const after=await (await context.request.get(base+"/api/catalog")).json();
        assert.equal(after.summary.review_revision,before.summary.review_revision);
        assert.equal(after.summary.human_reviewed,before.summary.human_reviewed);
      }finally{await attackerContext.close();}
    }
    await page.setViewportSize({width:390,height:844});await page.reload();
    await page.waitForFunction(()=>document.querySelector("#total").textContent==="6");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"Mobile page overflows viewport");
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log(JSON.stringify({passed:true,test:"offline synthetic review workflow",ssh_forwarded:forwarded,dynamic_ports:dynamic,
      proxy_rewrites_host:forwarded&&rewriteHost,filters:3,batch_review:true,persistence:true,csrf_rejected:true,mobile:true,external_requests:0}));
  }finally{
    if(browser)await browser.close();child.kill();
    for(const proxy of proxies){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
    await fs.rm(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
