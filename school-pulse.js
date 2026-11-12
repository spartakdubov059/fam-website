(function(root){
  "use strict";
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, symbol =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[symbol]);
  function timeLabel(date){
    const parsed=new Date(date);
    if(!Number.isFinite(parsed.getTime()))return "Недавно";
    return parsed.toLocaleDateString("ru-RU",{day:"numeric",month:"short"});
  }
  function clamp(text,max){return String(text ?? "").slice(0,max);}
  function validFeed(raw){
    if(!raw||typeof raw!=="object"||!Array.isArray(raw.announcements)||!Array.isArray(raw.polls))return false;
    return true;
  }
  function announcementCard(item){
    const important=item?.kind==="important";
    return '<article class="pulse-card pulse-announcement'+(important?' is-important':'')+'">' +
      '<div class="pulse-card-overline"><span class="pulse-symbol" aria-hidden="true">'+(important?'✦':'◈')+'</span>'+
        '<span>'+(important?'ВАЖНОЕ':'АНОНС')+'</span><span class="pulse-date">'+escapeHtml(timeLabel(item?.published_at))+'</span></div>'+
      '<h3>'+escapeHtml(clamp(item?.title,90))+'</h3>'+
      '<p>'+escapeHtml(clamp(item?.body,450))+'</p></article>';
  }
  function pollCard(poll){
    const options=Array.isArray(poll?.options)?poll.options.slice(0,4):[];
    const counts=Array.isArray(poll?.counts)&&poll.counts.length===options.length?poll.counts:null;
    const total=Number.isFinite(Number(poll?.total_votes))?Math.max(0,Number(poll.total_votes)):0;
    const voted=Number.isInteger(poll?.my_vote)&&poll.my_vote>=0;
    const closed=new Date(poll?.closes_at).getTime()<=Date.now();
    const showResults=!!counts&&(voted||closed)&&total>=5;
    const pollId=escapeHtml(poll?.id||"");
    const content=options.map((option,index)=>{
      const selected=voted&&poll.my_vote===index;
      const percent=showResults?Math.round(100*Number(counts[index]||0)/total):0;
      const safeLabel=escapeHtml(clamp(option,70));
      if(showResults){
        return '<div class="pulse-result'+(selected?' is-selected':'')+'"><span>'+safeLabel+'</span>'+
          '<span>'+percent+'%</span><div class="pulse-result-fill" style="width:'+percent+'%"></div></div>';
      }
      return '<button type="button" class="pulse-option'+(selected?' is-selected':'')+'" data-pulse-vote="'+pollId+'" data-option-index="'+index+'" '+
        (voted||closed?'disabled':'')+'><span>'+safeLabel+'</span><span aria-hidden="true">'+(selected?'✓':'○')+'</span></button>';
    }).join("");
    const message=closed?'Опрос завершён':voted?(showResults?'Спасибо за голос!':'Спасибо! Итоги появятся после 5 голосов'):'Один голос от одного участника';
    return '<article class="pulse-card pulse-poll"><div class="pulse-card-overline">'+
      '<span class="pulse-symbol" aria-hidden="true">✧</span><span>ОПРОС</span><span class="pulse-date">'+escapeHtml(timeLabel(poll?.closes_at))+'</span></div>'+
      '<h3>'+escapeHtml(clamp(poll?.question,140))+'</h3><div class="pulse-options">'+content+'</div>'+
      '<div class="pulse-poll-foot"><span>'+escapeHtml(message)+'</span><span>'+total+' голосов</span></div></article>';
  }
  function mount({sb,getViewer,notify}){
    const rootNode=document.getElementById("schoolPulse");
    if(!rootNode)return null;
    const grid=document.getElementById("pulseGrid");
    const admin=document.getElementById("pulseAdmin");
    const announcer=document.getElementById("pulseAnnouncementForm");
    const poller=document.getElementById("pulsePollForm");
    const status=document.getElementById("pulseStatus");
    let loading=false,epoch=0;
    const alertUser=message=>(typeof notify==="function"?notify(message):window.alert(message));
    async function refresh(){
      const iteration=++epoch;
      const viewer=getViewer();
      if(!viewer?.id||!viewer?.school_id){
        rootNode.classList.add("hidden");
        grid.textContent="";
        return;
      }
      rootNode.classList.remove("hidden");
      admin.classList.toggle("hidden",viewer.role!=="school_admin");
      status.textContent="Обновляем новости школы…";
      const {data,error}=await sb.rpc("fam_pulse_feed");
      if(iteration!==epoch)return;
      if(error||!validFeed(data)){
        status.textContent="Лента школьных новостей пока недоступна.";
        grid.innerHTML='<div class="pulse-empty">Новости и опросы появятся после подключения школьного раздела.</div>';
        return;
      }
      const news=data.announcements.filter(item=>item&&typeof item.title==="string").slice(0,4);
      const polls=data.polls.filter(item=>item&&typeof item.question==="string"&&Array.isArray(item.options)&&item.options.length>=2).slice(0,3);
      grid.innerHTML=news.map(announcementCard).concat(polls.map(pollCard)).join("")||
        '<div class="pulse-empty">Школьных новостей пока нет. Загляните позже.</div>';
      status.textContent="Новости только вашей школы";
    }
    rootNode.addEventListener("click",async event=>{
      const button=event.target.closest("button[data-pulse-vote]");
      if(!button||!rootNode.contains(button)||loading)return;
      const viewer=getViewer();
      if(!viewer?.id||!viewer?.school_id)return alertUser("Войдите в школьный аккаунт.");
      const id=button.getAttribute("data-pulse-vote");
      const index=Number(button.getAttribute("data-option-index"));
      if(!/^[a-f0-9-]{36}$/i.test(id)||!Number.isInteger(index)||index<0||index>3)return;
      loading=true;
      button.disabled=true;
      try{
        const {data,error}=await sb.rpc("fam_vote_school_poll",{p_poll_id:id,p_choice_index:index});
        if(error)throw new Error("Не удалось учесть голос.");
        if(data===false)alertUser("Вы уже голосовали в этом опросе.");
        await refresh();
      }catch(err){
        alertUser(err.message||"Не удалось проголосовать.");
        button.disabled=false;
      }finally{loading=false;}
    });
    async function createRpc(form,method,args){
      if(loading)return;
      const viewer=getViewer();
      if(viewer?.role!=="school_admin")return alertUser("Публиковать может только подтверждённый администратор.");
      loading=true;
      const submit=form.querySelector('button[type="submit"]');
      if(submit)submit.disabled=true;
      try{
        const {data,error}=await sb.rpc(method,args);
        if(error||!data)throw new Error("Не удалось опубликовать. Проверьте правила и лимиты.");
        form.reset();
        await refresh();
        alertUser("Опубликовано для участников вашей школы.");
      }catch(error){alertUser(error.message||"Ошибка публикации.");}
      finally{loading=false;if(submit)submit.disabled=false;}
    }
    announcer?.addEventListener("submit",event=>{
      event.preventDefault();
      const title=clamp(announcer.elements.namedItem("title")?.value.trim(),90);
      const body=clamp(announcer.elements.namedItem("body")?.value.trim(),450);
      const kind=announcer.elements.namedItem("kind")?.value==="important"?"important":"news";
      if(title.length<4||body.length<4)return alertUser("Заполните заголовок и текст анонса.");
      void createRpc(announcer,"fam_publish_school_announcement",{p_title:title,p_body:body,p_kind:kind});
    });
    poller?.addEventListener("submit",event=>{
      event.preventDefault();
      const question=clamp(poller.elements.namedItem("question")?.value.trim(),140);
      const options=String(poller.elements.namedItem("options")?.value||"").split("\n").map(s=>s.trim()).filter(Boolean);
      if(question.length<8||options.length<2||options.length>4||options.some(o=>o.length>70)||
         new Set(options.map(s=>s.toLowerCase())).size!==options.length)
        return alertUser("Укажите вопрос и 2–4 разных варианта ответа, каждый до 70 символов.");
      void createRpc(poller,"fam_publish_school_poll",{p_question:question,p_options:options});
    });
    document.getElementById("pulseRefreshBtn")?.addEventListener("click",()=>{void refresh()});
    return {refresh};
  }
  const api=Object.freeze({mount,announcementCard,pollCard,validFeed});
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.FAMSchoolPulse=api;
})(typeof globalThis!=="undefined"?globalThis:this);
