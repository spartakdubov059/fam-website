import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const main = await readFile(resolve("index.html"), "utf8");
const styles = await readFile(resolve("school-pulse.css"),"utf8");
const script = await readFile(resolve("school-pulse.js"),"utf8");
const match=main.match(/<section id="schoolPulse"[^>]*>[\s\S]*?<\/section>/);
assert.ok(match, "School Pulse must stay inside the board");
const pageHtml='<!DOCTYPE html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<style>:root{--bg:#0F1014;--surface:#1A1C22;--text:#F5F6F8;--muted:#AEB3C0;--border:#2A2D36;--violet:#8B5CF6;--lime:#C8F542;}*{box-sizing:border-box}body{background:var(--bg);color:var(--text);font:14px sans-serif;margin:0;padding:14px}.hidden{display:none!important}input,select,textarea,button{font:inherit;}</style>'+
  '<style>'+styles+'</style></head><body>'+match[0]+'<script>'+script+'</script></body></html>';
const browser=await chromium.launch({headless:true});
const testId="8b07e0b4-4fd3-4a95-9715-7cdac57d22b1";
try{
  for(const width of [320,360,390,768,1024]){
    const page=await browser.newPage({viewport:{width,height:820},isMobile:width<=390,hasTouch:width<=390});
    const errors=[];page.on("pageerror",err=>errors.push(err.message));
    await page.setContent(pageHtml);
    await page.evaluate(id=>{
      let voted=null;
      const feed=()=>({
        announcements:[
          {id:"p1",title:"Новости школьного медиацентра",body:"Скоро объявим результаты конкурса проектов.",kind:"news",published_at:"2026-11-13"},
          {id:"p2",title:"Важное для участников",body:"Пожалуйста, следите за обновлениями внутри своей школы.",kind:"important",published_at:"2026-11-13"}
        ],
        polls:[{id,question:"Какую активность вы бы выбрали?",options:["Клуб проектов","Творческая мастерская","Школьный кинопоказ"],counts:null,total_votes:voted===null?0:1,my_vote:voted,closes_at:"2099-01-01"}]
      });
      const sb={rpc:async(name,args)=>{
        if(name==="fam_pulse_feed")return {data:feed(),error:null};
        if(name==="fam_vote_school_poll"){voted=args.p_choice_index;return {data:true,error:null};}
        return {data:null,error:new Error("bad rpc "+name)};
      }};
      window.pulse=window.FAMSchoolPulse.mount({sb,
        getViewer:()=>({id:"22222222-2222-4222-8222-222222222222",school_id:"school_a",role:"student"}),
        notify:()=>{}});
      void window.pulse.refresh();
    },testId);
    await page.locator("#pulseGrid .pulse-card").first().waitFor();
    assert.equal(await page.locator("#pulseGrid .pulse-card").count(),3,"card count");
    const geometry=await page.evaluate(()=>({
      documentWidth:document.documentElement.scrollWidth,
      viewportWidth:window.innerWidth,
      columns:getComputedStyle(document.getElementById("pulseGrid")).gridTemplateColumns.split(" ").length
    }));
    assert.ok(geometry.documentWidth <= geometry.viewportWidth+1,"Pulse overflow at "+width+"px: "+JSON.stringify(geometry));
    assert.equal(geometry.columns,width<=640?1:2,"grid columns at "+width);
    assert.equal(await page.locator("#pulseAdmin").isVisible(),false,"students must not see admin controls");
    await page.locator("[data-pulse-vote]").first().click();
    assert.equal(await page.locator("[data-pulse-vote]").first().isDisabled(),true);
    assert.equal(await page.locator(".pulse-result-fill").count(),0,"hide counts below five participants");
    assert.deepEqual(errors,[],"browser errors at "+width);
    await page.close();
  }
  console.log("School Pulse real-browser visual and voting audit: 5/5 widths passed.");
}finally{await browser.close();}
