import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyAccountLinkService } from '../services/legacy-account-link.mjs';
const fixture = ()=>{
 const challengeId='a'.repeat(64), profileVersion='b'.repeat(64), seconds=1800000000;
 const input={challengeId,legacyProof:'synthetic-legacy-proof-01',yandexProof:'synthetic-yandex-proof-01'};
 const source={challengeId,userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',profileVersion,eligible:true,verifiedAt:seconds-30};
 const target={challengeId,issuer:'https://login.yandex.ru',subject:'123456789',verifiedAt:seconds-20};
 const calls=[];
 const options={now:()=>seconds*1000,verifyLegacyProof:async(token,c)=>token===input.legacyProof&&c===challengeId?source:null,verifyYandexProof:async(token,c)=>token===input.yandexProof&&c===challengeId?target:null,repository:{async linkVerifiedAccount(args){calls.push(args);return {ok:true,code:'LINKED'};}}};
 return {input,source,target,options,calls,seconds};
};
const cases = [
  ["accepts two fresh independently verified proofs", ()=>{}, true],
  ["rejects unverified old account", f=>f.options.verifyLegacyProof=async()=>null, false],
  ["rejects unverified Yandex identity", f=>f.options.verifyYandexProof=async()=>null, false],
  ["rejects stale old proof", f=>f.source.verifiedAt=f.seconds-301, false],
  ["rejects stale target proof", f=>f.target.verifiedAt=f.seconds-301, false],
  ["rejects future verification time", f=>f.target.verifiedAt=f.seconds+1, false],
  ["rejects incorrect source challenge", f=>f.source.challengeId='c'.repeat(64), false],
  ["rejects incorrect target challenge", f=>f.target.challengeId='c'.repeat(64), false],
  ["rejects wrong provider", f=>f.target.issuer='https://synthetic.invalid', false],
  ["rejects invalid provider subject", f=>f.target.subject='user@invalid', false],
  ["rejects ineligible legacy account", f=>f.source.eligible=false, false],
  ["rejects unversioned profile", f=>f.source.profileVersion='unknown', false],
  ["rejects invalid source UUID", f=>f.source.userId='forged', false],
  ["rejects client-supplied role", f=>f.input.role='school_admin', false],
  ["rejects identical proof tokens", f=>f.input.yandexProof=f.input.legacyProof, false],
  ["rejects malformed challenge", f=>f.input.challengeId='bad', false],
  ["fails closed on proof adapter error", f=>f.options.verifyLegacyProof=async()=>{throw Error('private');}, false],
  ["rejects using the same verifier twice", f=>f.options.verifyYandexProof=f.options.verifyLegacyProof, false]
];
for(const [name,mutate,ok] of cases) test(name,async()=>{const f=fixture();mutate(f);const result=await createLegacyAccountLinkService(f.options).link(f.input);assert.deepEqual(result,ok?{ok:true,code:'LINKED'}:{ok:false,code:'LINK_UNAVAILABLE'});assert.equal(f.calls.length,ok?1:0);if(ok)assert.deepEqual(f.calls[0],{challengeId:f.input.challengeId,legacyUserId:f.source.userId,profileVersion:f.source.profileVersion,issuer:f.target.issuer,subject:f.target.subject});});

test('repository conflict cannot overwrite a profile', async()=>{
  const f=fixture();
  f.options.repository.linkVerifiedAccount=async()=>({ok:false,code:'IDENTITY_EXISTS',privateValue:'do not expose'});
  assert.deepEqual(await createLegacyAccountLinkService(f.options).link(f.input),{ok:false,code:'LINK_UNAVAILABLE'});
});
test('repository error is not leaked', async()=>{
  const f=fixture();
  f.options.repository.linkVerifiedAccount=async()=>{throw Error('private data');};
  assert.deepEqual(await createLegacyAccountLinkService(f.options).link(f.input),{ok:false,code:'LINK_UNAVAILABLE'});
});
test('missing repository fails closed', async()=>{
  const f=fixture();delete f.options.repository;
  const service=createLegacyAccountLinkService(f.options);
  assert.equal(service.available,false);
  assert.deepEqual(await service.link(f.input),{ok:false,code:'LINK_UNAVAILABLE'});
});
