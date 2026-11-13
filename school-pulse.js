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
    const openEvent=item?.kind==="open_event";
    const dateSource=item?.event_starts_at || item?.event_date;
    const eventDay=dateSource ? new Date(
      item?.event_date && !item?.event_starts_at ? item.event_date+"T12:00:00" : dateSource
    ) : null;
    const eventLabel=eventDay&&Number.isFinite(eventDay.getTime())
      ? eventDay.toLocaleDateString("ru-RU",{day:"numeric",month:"long"})
      : "Скоро";
    const rawTime=typeof item?.event_time==="string" ? item.event_time.slice(0,5) : "";
    const eventTime=rawTime || (item?.event_starts_at
      ? new Date(item.event_starts_at).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}) : "");
    return '<article class="pulse-card pulse-announcement'+(important?' is-important':'')+(openEvent?' is-open-event':'')+'">' +
      '<div class="pulse-card-overline"><span class="pulse-symbol" aria-hidden="true">'+(openEvent?'↗':important?'✦':'◈')+'</span>'+
        '<span>'+(openEvent?'СОБЫТИЕ ДЛЯ ВСЕХ':important?'ВАЖНОЕ':'АНОНС')+'</span>'+
        '<span class="pulse-date">'+escapeHtml(openEvent?eventLabel:timeLabel(item?.published_at))+'</span></div>'+
      '<h3>'+escapeHtml(clamp(item?.title,90))+'</h3>'+
      '<p>'+escapeHtml(clamp(item?.body,450))+'</p>'+
      (openEvent?'<div class="pulse-open-foot"><span class="pulse-open-label"><span class="pulse-open-dot" aria-hidden="true"></span>Без записи · Нет лимита мест</span>'+
        (eventTime?'<time>'+escapeHtml(eventTime)+'</time>':'')+'</div>':'')+'</article>';
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
    const carousel=document.getElementById("pulseAnnouncementCarousel");
    const announcementTrack=document.getElementById("pulseAnnouncementTrack");
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
        carousel?.classList.add("hidden");
        grid.textContent="";
        if(announcementTrack)announcementTrack.textContent="";
        return;
      }
      const isStaff=["school_admin","council_member"].includes(viewer.role);
      admin.classList.toggle("hidden",!isStaff);
      status.textContent="Загружаем опросы…";
      const {data,error}=await sb.rpc("fam_pulse_feed");
      if(iteration!==epoch)return;
      if(error||!validFeed(data)){
        status.textContent="Не удалось обновить опросы.";
        grid.innerHTML='<div class="pulse-empty">Опросы пока недоступны. Обновите позже.</div>';
        carousel?.classList.add("hidden");
        return;
      }
      const news=data.announcements.filter(item=>item&&typeof item.title==="string").slice(0,6);
      const polls=data.polls.filter(item=>item&&typeof item.question==="string"&&Array.isArray(item.options)&&item.options.length>=2).slice(0,3);
      if(announcementTrack)announcementTrack.innerHTML=news.map(announcementCard).concat(polls.map(pollCard)).join("");
      carousel?.classList.toggle("hidden",news.length===0&&polls.length===0);
      grid.innerHTML="";
      grid.querySelectorAll(".pulse-card").forEach((card,index)=>card.style.setProperty("--pulse-order",String(Math.min(index,7))));
      rootNode.classList.toggle("hidden",!isStaff);
      status.textContent="Опросы для участников вашей школы";
    }
    document.querySelectorAll("[data-pulse-scroll]").forEach(button=>button.addEventListener("click",()=>{
      const direction=Number(button.getAttribute("data-pulse-scroll"));
      const card=announcementTrack?.querySelector(".pulse-card");
      if(!announcementTrack||!card||!Number.isFinite(direction))return;
      announcementTrack.scrollBy({left:direction*(card.getBoundingClientRect().width+10),behavior:"smooth"});
    }));
    announcementTrack?.addEventListener("click",async event=>{
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
      if(!["school_admin","council_member"].includes(viewer?.role))return alertUser("Публикация доступна только подтверждённому Совету школы.");
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
      const selected=announcer.elements.namedItem("kind")?.value;
      const kind=["news","important","open_event"].includes(selected)?selected:"news";
      const rawEventTime=String(announcer.elements.namedItem("event_starts_at")?.value||"");
      const parsedEventTime=kind==="open_event"?new Date(rawEventTime):null;
      const eventIso=parsedEventTime&&Number.isFinite(parsedEventTime.getTime())?parsedEventTime.toISOString():null;
      if(title.length<4||body.length<4)return alertUser("Заполните заголовок и текст анонса.");
      if(kind==="open_event"&&(!eventIso||parsedEventTime.getTime()<=Date.now()+10*60*1000))
        return alertUser("Укажите будущую дату и время события.");
      void createRpc(announcer,"fam_publish_school_announcement",{
        p_title:title,p_body:body,p_kind:kind,p_event_starts_at:eventIso
      });
    });
    const kindSelect=announcer?.elements.namedItem("kind");
    const updateEventFields=()=>{
      const block=document.getElementById("pulseEventDateRow");
      const input=announcer?.elements.namedItem("event_starts_at");
      const isEvent=kindSelect?.value==="open_event";
      block?.classList.toggle("hidden",!isEvent);
      if(input)input.required=isEvent;
    };
    kindSelect?.addEventListener("change",updateEventFields);
    updateEventFields();
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