// Dormant, isolated orchestration primitive. No provider calls are configured by this module.
export function createLegacyAccountLinkService({ repository, verifyLegacyProof, verifyYandexProof, now=Date.now }={}) {
  // Trusted server adapters must verify independently issued proofs, bound to the same challenge.
  // This module is intentionally not wired to HTTP or a live database.
  const unavailable=()=>({ok:false,code:'LINK_UNAVAILABLE'});
  const configured=typeof repository?.linkVerifiedAccount==='function'&&typeof verifyLegacyProof==='function'&&typeof verifyYandexProof==='function'&&typeof now==='function'&&verifyLegacyProof!==verifyYandexProof;
  const hex64=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
  const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
  const validToken=x=>typeof x==='string'&&x.length>=20&&x.length<=8192;
  const fresh=(x,seconds)=>Number.isSafeInteger(x)&&x>=0&&x<=seconds&&seconds-x<=300;
  return Object.freeze({
    available:configured,
    async link(input) {
      if(!configured||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==3||
         !['challengeId','legacyProof','yandexProof'].every(k=>Object.hasOwn(input,k))||
         !hex64(input.challengeId)||!validToken(input.legacyProof)||!validToken(input.yandexProof)||
         input.legacyProof===input.yandexProof)return unavailable();
      const {challengeId,legacyProof,yandexProof}=input;
      try {
        const [source,target]=await Promise.all([
          verifyLegacyProof(legacyProof,challengeId),
          verifyYandexProof(yandexProof,challengeId)
        ]);
        const seconds=Math.floor(now()/1000);
        if(!Number.isSafeInteger(seconds)||seconds<0||
           !source||source.challengeId!==challengeId||!uuid(source.userId)||!hex64(source.profileVersion)||
           source.eligible!==true||!fresh(source.verifiedAt,seconds)||
           !target||target.challengeId!==challengeId||target.issuer!=='https://login.yandex.ru'||
           typeof target.subject!=='string'||!/^\d{1,40}$/.test(target.subject)||!fresh(target.verifiedAt,seconds))return unavailable();
        // Repository contract: in ONE serializable transaction recheck staging approval,
        // snapshot version, bound challenge/expiry, uniqueness in both directions,
        // and consume the challenge together with the insert. Never upsert an identity.
        const result=await repository.linkVerifiedAccount({
          challengeId,legacyUserId:source.userId,profileVersion:source.profileVersion,
          issuer:target.issuer,subject:target.subject
        });
        return result?.ok===true&&result.code==='LINKED'?{ok:true,code:'LINKED'}:unavailable();
      }catch{return unavailable();}
    }
  });
}
