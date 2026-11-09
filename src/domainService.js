// Custom domain lifecycle: register, check, disconnect, background re-checks and the trusted host lookup used by routing and CORS.
// Status: pending_dns -> verifying -> configuring -> active (or failed). Only "active" resolves to a hotel or passes CORS.
const dns=require('dns').promises,Dm=require('./domains'),V=require('./vercel');
const D=()=>require('./models');
const lookup=async host=>{const t=async(f,...a)=>{try{return await dns[f](host,...a)}catch{return []}};const [a,cname,aaaa]=await Promise.all([t('resolve4'),t('resolveCname'),t('resolve6')]);return{a,cname,aaaa}};
const lookupTxt=async name=>{try{return(await dns.resolveTxt(name)).map(x=>x.join(''))}catch{return[]}};
const defaults=()=>({vercel:V.default,dnsLookup:lookup,txtLookup:lookupTxt,tls:V.tlsProbe,now:()=>Date.now()});
// One full check. Takes the saved state, returns the new state. Never throws for Vercel or DNS trouble: it records the problem and the next retry time instead.
exports.runCheck=async(domain,prev={},deps={})=>{const d={...defaults(),...deps},now=d.now(),out={...prev,lastCheckedAt:new Date(now)};
 try{
  let pd=await d.vercel.getProjectDomain(domain);if(!pd)pd=await d.vercel.addDomain(domain);// someone removed it from Vercel by hand: attach it again
  const apexName=pd.apexName||prev.apexName||Dm.apexOf(domain);let txtFound=false;
  const challenge=!pd.verified&&(pd.verification||[]).find(c=>String(c.type).toUpperCase()==='TXT');
  if(challenge){txtFound=(await d.txtLookup(challenge.domain)).some(x=>x===challenge.value||x.includes(challenge.value));if(txtFound)pd=await d.vercel.verifyDomain(domain)||pd}
  const config=await d.vercel.getConfig(domain),dnsInfo=await d.dnsLookup(domain);
  const ownership=!!pd.verified,ssl=ownership&&config.misconfigured===false?await d.tls(domain):{ready:false};
  const built=Dm.buildRecords({domain,apexName,pd,config}),ev=Dm.evaluate({pd,config,dns:dnsInfo,ssl,txtFound,windowStart:prev.windowStart,now});
  const records=built.records.length?built.records:(ownership?[]:prev.records||[]);
  Object.assign(out,{status:ev.status,steps:ev.steps,apex:built.apex,apexName,records,alternative:built.alternative,
   issues:ev.status==='active'?[]:Dm.diagnose({domain,apex:built.apex,records:built.records,dns:{...dnsInfo,txt:challenge?await d.txtLookup(challenge.domain):[]},pd,config}),
   configuredBy:config.configuredBy||null,ssl:{ready:!!ssl.ready,issuer:ssl.issuer||null,error:ssl.ready?null:ssl.error||null,checkedAt:new Date(now)},
   error:built.missingTargets&&!ownership?null:(built.missingTargets?'Vercel has not returned DNS targets for this domain yet. We will keep checking.':null),integrationError:null,driftFails:0});
  // an active domain needs two bad checks in a row before it is taken offline, so one DNS or API blip never causes an outage
  if(prev.status==='active'&&ev.status!=='active'&&(prev.driftFails||0)<2){out.status='active';out.steps=prev.steps;out.driftFails=(prev.driftFails||0)+1;out.error=null}
  if(out.status==='active'&&prev.status!=='active')out.activatedAt=new Date(now);
  if(out.status!==prev.status){out.attempts=0;if(out.status==='failed')out.error='We could not confirm your DNS records within 7 days. Check the records below, then press Check connection to try again.'}
  else out.attempts=(prev.attempts||0)+1;
 }catch(e){
  const kind=e&&e.kind||'unknown';
  if(e instanceof V.VercelError){
   out.attempts=(prev.attempts||0)+1;
   if(kind==='auth'||kind==='disabled')out.integrationError='Custom domains are temporarily unavailable. Please contact keykonnec support.';
   else out.error=kind==='conflict'?'This domain is already in use on another project.':kind==='invalid'?e.message:'Could not reach our hosting provider. We will retry automatically.';
   if(kind==='conflict'||kind==='invalid'){out.status='failed'}
   // a hiccup must not knock an active domain offline immediately: three failed re-checks in a row are needed
   if(prev.status==='active'&&kind!=='conflict'&&kind!=='invalid'){out.driftFails=(prev.driftFails||0)+1;out.status=out.driftFails>=3?'configuring':'active'}
   console.error('[domains] check failed',domain,kind,e.status||'');
  }else throw e}
 const delay=Dm.nextDelayMs(out.status,out.attempts||0);out.nextCheckAt=delay==null?null:new Date(now+delay);return out};
// What the dashboard sees. Never contains credentials.
exports.view=h=>{const s=h.domainState||{};if(!h.customDomain)return{configured:false,enabled:V.default.enabled()};
 return{configured:true,enabled:V.default.enabled(),domain:h.customDomain,status:s.pendingRemoval?'disconnecting':s.status||'pending_dns',steps:s.steps||{ownership:false,routing:false,ssl:false},apex:!!s.apex,records:s.records||[],alternative:s.alternative||null,issues:s.issues||[],ssl:s.ssl||{ready:false},
  configuredBy:s.configuredBy||null,error:s.integrationError||s.error||null,lastCheckedAt:s.lastCheckedAt||null,nextCheckAt:s.nextCheckAt||null,activatedAt:s.activatedAt||null,url:s.status==='active'&&!s.pendingRemoval?`https://${h.customDomain}`:null,pendingRemoval:!!s.pendingRemoval}};
const save=async(h,state,extra={})=>{const active=state.status==='active'&&!state.pendingRemoval;await D().Hotel.updateOne({_id:h._id},{$set:{domainState:state,domainVerified:active,...extra}});invalidate(h.customDomain);return D().Hotel.findById(h._id)};
// ---- register
exports.register=async(h,input,deps={})=>{const d={...defaults(),...deps},n=Dm.normalize(input);if(!n.ok)throw Object.assign(new Error(n.error),{status:400});
 if(!d.vercel.enabled())throw Object.assign(new Error('Custom domains are not enabled on this platform yet.'),{status:503});
 if(h.customDomain){if(h.customDomain===n.domain)return h;throw Object.assign(new Error('Disconnect your current domain before adding a different one.'),{status:409})}
 // Reserve it in our database first: the unique index makes two hotels racing for one domain impossible.
 try{await D().Hotel.updateOne({_id:h._id,$or:[{customDomain:{$exists:false}},{customDomain:null},{customDomain:''}]},{$set:{customDomain:n.domain,domainVerified:false,domainState:{status:'pending_dns',createdAt:new Date(),windowStart:new Date(),attempts:0,steps:{ownership:false,routing:false,ssl:false}}}})}
 catch(e){if(e&&e.code===11000)throw Object.assign(new Error('That domain is already connected to another hotel.'),{status:409});throw e}
 const fresh=await D().Hotel.findById(h._id);if(fresh.customDomain!==n.domain)throw Object.assign(new Error('Disconnect your current domain before adding a different one.'),{status:409});
 let pd;try{pd=await d.vercel.addDomain(n.domain)}catch(e){await D().Hotel.updateOne({_id:h._id,customDomain:n.domain},{$set:{domainVerified:false},$unset:{customDomain:'',domainState:''}});// undo our reservation: nothing was registered
  if(e.kind==='conflict')throw Object.assign(new Error('This domain is already in use on another keykonnec or Vercel project, so it cannot be connected.'),{status:409});
  if(e.kind==='invalid')throw Object.assign(new Error(e.message),{status:400});
  if(e.kind==='rate_limited')throw Object.assign(new Error('Too many requests. Please try again in a minute.'),{status:429});
  console.error('[domains] add failed',n.domain,e.kind,e.status||'');throw Object.assign(new Error('We could not register this domain right now. Please try again.'),{status:502})}
 const state=await exports.runCheck(n.domain,{...fresh.domainState,apexName:pd.apexName},d);return save(fresh,state)};
// ---- check now
exports.check=async(h,{manual=false,deps={}}={})=>{if(!h.customDomain)throw Object.assign(new Error('Add a domain first.'),{status:400});
 let prev=h.domainState||{};if(prev.pendingRemoval)return exports.finishRemoval(h,deps);
 if(manual&&prev.status==='failed')prev={...prev,status:'pending_dns',windowStart:new Date(),attempts:0};
 const state=await exports.runCheck(h.customDomain,prev,deps);return save(h,state)};
// ---- disconnect: stop resolving immediately, then remove from Vercel. If Vercel fails we keep a retryable "pendingRemoval" mark so the two sides never disagree for long.
exports.disconnect=async(h,deps={})=>{if(!h.customDomain)return h;const s={...(h.domainState||{}),pendingRemoval:true,status:'disconnecting'};
 await D().Hotel.updateOne({_id:h._id},{$set:{domainState:s,domainVerified:false}});invalidate(h.customDomain);return exports.finishRemoval(await D().Hotel.findById(h._id),deps)};
exports.finishRemoval=async(h,deps={})=>{const d={...defaults(),...deps};
 try{await d.vercel.removeDomain(h.customDomain)}catch(e){console.error('[domains] remove failed',h.customDomain,e.kind||'',e.status||'');
  const s={...(h.domainState||{}),pendingRemoval:true,removeError:'Vercel could not remove this domain yet. We will retry automatically.',nextCheckAt:new Date(Date.now()+3e5)};await D().Hotel.updateOne({_id:h._id},{$set:{domainState:s}});throw Object.assign(new Error('Your domain has been switched off and is being removed. This may take a few minutes.'),{status:202,pending:true})}
 const old=h.customDomain;await D().Hotel.updateOne({_id:h._id},{$set:{domainVerified:false},$unset:{customDomain:'',domainState:'',domainToken:''}});invalidate(old);return D().Hotel.findById(h._id)};
// ---- trusted host lookup (routing + CORS). Only an active, verified domain that is not being removed counts.
const cache=new Map(),TTL=60000;const invalidate=d=>{if(d)cache.delete(d)};exports.invalidate=invalidate;
exports.hotelByHost=async host=>{const n=Dm.normalize(host);if(!n.ok)return null;const hit=cache.get(n.domain);if(hit&&hit.exp>Date.now())return hit.v;
 const h=await D().Hotel.findOne({customDomain:n.domain,domainVerified:true,status:'active','domainState.status':'active','domainState.pendingRemoval':{$ne:true}}).select('slug customDomain').lean();
 const v=h?{slug:h.slug,domain:h.customDomain}:null;cache.set(n.domain,{v,exp:Date.now()+(v?TTL:15000)});if(cache.size>5000)cache.clear();return v};
// ---- background worker: domains whose next check is due. Sequential with a pause between calls to stay under Vercel's rate limits.
exports.processDue=async(deps={},limit=20)=>{const now=new Date(),due=await D().Hotel.find({customDomain:{$type:'string'},'domainState.nextCheckAt':{$lte:now}}).sort({'domainState.nextCheckAt':1}).limit(limit);let n=0;
 for(const h of due){try{if(h.domainState&&h.domainState.pendingRemoval)await exports.finishRemoval(h,deps);else await exports.check(h,{deps})}catch(e){if(!e.pending)console.error('[domains] worker',h.customDomain,e.message)}n++;await new Promise(r=>setTimeout(r,deps.pause==null?400:deps.pause));
}return n};
exports.start=()=>{if(!V.default.enabled()){console.log('[domains] VERCEL_TOKEN or VERCEL_PROJECT_ID missing: custom domains disabled');return}
 require('node-cron').schedule('* * * * *',()=>exports.processDue().catch(e=>console.error('[domains] tick',e.message)))};
