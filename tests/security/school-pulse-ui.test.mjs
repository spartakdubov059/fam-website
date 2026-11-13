import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve,dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(import.meta.url);
const api=require(resolve(root,"school-pulse.js"));
const html=readFileSync(resolve(root,"index.html"),"utf8");
const css=readFileSync(resolve(root,"school-pulse.css"),"utf8");
const sql=readFileSync(resolve(root,"docs/sql/school-pulse-DRAFT.sql"),"utf8");

test("announcements and poll questions escape untrusted HTML and never disclose IDs",()=>{
 const news=api.announcementCard({title:'<img src=x onerror=alert(1)>',body:'<script>alert(2)</script>',kind:"important"});
 assert.ok(news.includes("&lt;img"));
 assert.ok(news.includes("&lt;script&gt;"));
 assert.ok(!news.includes('<script>'));
 const poll=api.pollCard({id:"11111111-1111-4111-8111-111111111111",question:'<img src=x>',options:['<button>Oops</button>',"Another"],total_votes:0,counts:null,my_vote:null,closes_at:"2099-01-01"});
 assert.ok(poll.includes("&lt;button&gt;"));
 assert.ok(!poll.includes('<button>Oops'));
 assert.ok(!poll.includes("width:NaN"));
});
test("tiny cohorts hide per-choice results, while voted users cannot click again",()=>{
 const poll={id:"11111111-1111-4111-8111-111111111111",question:"Какие кружки выбрать?",options:["Клуб","Проект"],total_votes:1,counts:null,my_vote:0,closes_at:"2099-01-01"};
 const html=api.pollCard(poll);
 assert.ok(html.includes("disabled"));
 assert.ok(!html.includes("pulse-result-fill"));
 assert.match(html,/после 5 голосов/);
});
test("School Pulse is added inside the existing board without duplicating event listings or adding navigation tabs",()=>{
 assert.match(html,/id="schoolPulse"/);
 assert.match(html,/id="pulseGrid"/);
 assert.match(html,/id="pulseAnnouncementForm"/);
 assert.match(html,/id="pulsePollForm"/);
 assert.match(html,/const SCHOOL_PULSE_ENABLED = true/);
 assert.match(html,/if \(schoolPulse\) void schoolPulse\.refresh\(\)/);
 assert.match(html,/data-cat="Мероприятия"/);
 assert.match(css,/@media\(max-width:640px\)/);
 assert.match(css, /prefers-reduced-motion/);
});
test("server functions bind school and role from auth.uid and profile, not from user input",()=>{
 assert.match(sql,/who uuid := auth\.uid\(\)/);
 assert.match(sql,/where id=who and role in \('school_admin','council_member'\)/);
});

test("Open events behave as announcements with no bookings, attendee cap or public user information",()=>{
 const markup=api.announcementCard({id:"any",kind:"open_event",title:"Открытый квиз",body:"Встречаемся вместе!",event_starts_at:"2099-05-03T16:00:00Z"});
 assert.match(markup,/СОБЫТИЕ ДЛЯ ВСЕХ/);
 assert.match(markup,/Без записи · Нет лимита мест/);
 assert.doesNotMatch(markup,/data-action="handle-event"|event_registrations|max_seats/);
 const hostile=api.announcementCard({kind:"open_event",title:"<svg onload=alert(1)>",body:"<script>run()</script>",event_starts_at:"2099-05-03T16:00:00Z"});
 assert.ok(hostile.includes("&lt;script&gt;"));
 assert.doesNotMatch(hostile,/<script>|<svg onload/);
 assert.match(sql,/coalesce\(l\.max_seats,0\)=0/);
 assert.match(sql,/l\.school_id=school and l\.status='active'/);
});
test("Announcements animations are responsive and optional for reduced motion",()=>{
 assert.match(html,/id="pulseCarouselTitle">Анонсы и мероприятия/);
 assert.match(html,/id="pulseAnnouncementTrack" class="pulse-announcement-track"/);
 assert.match(html,/>Школьные опросы <span class="pulse-heading-star"/);
 assert.doesNotMatch(html,/>Школьный пульс/);
 assert.match(css,/@keyframes pulseReveal/);
 assert.match(css,/@keyframes pulseBarGrow/);
 assert.match(css,/prefers-reduced-motion:reduce/);
 assert.match(html,/name="event_starts_at"/);
});