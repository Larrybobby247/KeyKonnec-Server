// No database, network or real domain needed: node --test tests/domains.test.js
// Everything here uses fakes for Vercel, DNS, TLS and the database. See DOMAINS.md for what still has to be tested live.
process.env.CLIENT_URL='https://app.example.com';process.env.JWT_SECRET='x';process.env.SITE_BASE_DOMAIN='keykonnec.com';
const {test}=require('node:test'),assert=require('node:assert'),Module=require('module'),express=require('express');
const Dm=require('../src/domains'),V=require('../src/vercel');

// ---------- validation ----------
test('normalize: accepts apex and subdomains, strips protocol, path, port, case and trailing dot',()=>{
 for(const [i,o] of [['Hotel.com','hotel.com'],['https://Book.Hotel.com/rooms?x=1','book.hotel.com'],['book.hotel.com:443','book.hotel.com'],['book.hotel.com.','book.hotel.com'],['  www.hotel.co.uk ','www.hotel.co.uk'],['bücher.de','xn--bcher-kva.de']]){const r=Dm.normalize(i);assert.ok(r.ok,i);assert.equal(r.domain,o)}});
test('normalize: rejects invalid, reserved and platform domains',()=>{
 for(const bad of ['','localhost','hotel','192.168.1.1','*.hotel.com','-bad.com','a..com','hotel.c','my.vercel.app','grand.keykonnec.com','keykonnec.com','app.example.com','x_y.com','http://','a'.repeat(64)+'.com'])assert.equal(Dm.normalize(bad).ok,false,bad);
 assert.equal(Dm.normalize(null).ok,false)});
test('apex detection handles two-level suffixes and Vercel apexName',()=>{
 assert.equal(Dm.isApex('hotel.com'),true);assert.equal(Dm.isApex('book.hotel.com'),false);assert.equal(Dm.isApex('hotel.co.ke'),true);assert.equal(Dm.isApex('book.hotel.co.ke'),false);assert.equal(Dm.isApex('www.hotel.com','hotel.com'),false);
 assert.equal(Dm.relativeHost('_vercel.hotel.com','hotel.com'),'_vercel');assert.equal(Dm.relativeHost('hotel.com','hotel.com'),'@');assert.equal(Dm.relativeHost('book.hotel.com','hotel.com'),'book')});

// ---------- DNS instructions come from Vercel's answers ----------
const cfg=(o={})=>({configuredBy:null,misconfigured:true,acceptedChallenges:['dns-01','http-01'],recommendedIPv4:[{rank:1,value:['203.0.113.7']},{rank:2,value:['203.0.113.9']}],recommendedCNAME:[{rank:1,value:'abc123.vercel-dns-017.com.'},{rank:2,value:'cname.vercel-dns.com'}],...o});
test('records: apex gets the A record Vercel recommends, subdomain gets the recommended CNAME, TXT only when Vercel asks',()=>{
 let r=Dm.buildRecords({domain:'hotel.com',apexName:'hotel.com',pd:{verified:true},config:cfg()});
 assert.deepEqual(r.records.map(x=>[x.type,x.host,x.value,x.purpose]),[['A','@','203.0.113.7','routing']]);assert.ok(r.alternative.includes('abc123.vercel-dns-017.com'));
 r=Dm.buildRecords({domain:'book.hotel.com',apexName:'hotel.com',pd:{verified:true},config:cfg()});assert.deepEqual(r.records.map(x=>[x.type,x.host,x.value]),[['CNAME','book','abc123.vercel-dns-017.com']]);
 r=Dm.buildRecords({domain:'book.hotel.com',apexName:'hotel.com',pd:{verified:false,verification:[{type:'TXT',domain:'_vercel.hotel.com',value:'vc-domain-verify=book.hotel.com,abc',reason:'pending'}]},config:cfg()});
 assert.deepEqual(r.records.map(x=>[x.type,x.host,x.purpose]),[['TXT','_vercel','ownership'],['CNAME','book','routing']]);
 r=Dm.buildRecords({domain:'hotel.com',apexName:'hotel.com',pd:{verified:true},config:cfg({recommendedIPv4:[],recommendedCNAME:[]}),env:{}});assert.equal(r.missingTargets,true);assert.deepEqual(r.records,[]);
 r=Dm.buildRecords({domain:'hotel.com',apexName:'hotel.com',pd:{verified:true},config:cfg({recommendedIPv4:[]}),env:{VERCEL_DNS_A:'198.51.100.1'}});assert.equal(r.records[0].value,'198.51.100.1');assert.equal(r.records[0].source,'env')});
test('diagnose: explains wrong, missing and conflicting records',()=>{
 const rec=[{type:'CNAME',purpose:'routing',value:'cname.vercel-dns.com',fullName:'book.hotel.com'}];
 assert.match(Dm.diagnose({domain:'book.hotel.com',records:rec,dns:{a:[],cname:[]},config:cfg()})[0],/No CNAME record/);
 assert.match(Dm.diagnose({domain:'book.hotel.com',records:rec,dns:{a:['1.2.3.4'],cname:[]},config:cfg()})[0],/Remove it and add the CNAME/);
 assert.match(Dm.diagnose({domain:'book.hotel.com',records:rec,dns:{cname:['other.example.net.']},config:cfg()})[0],/points to other\.example\.net/);
 const a=[{type:'A',purpose:'routing',value:'203.0.113.7',fullName:'hotel.com'}];
 assert.match(Dm.diagnose({domain:'hotel.com',records:a,dns:{a:['9.9.9.9']},config:cfg()})[0],/points to 9\.9\.9\.9 but should point to 203\.0\.113\.7/);
 assert.match(Dm.diagnose({domain:'hotel.com',records:[{type:'TXT',purpose:'ownership',value:'vc=1',fullName:'_vercel.hotel.com'}],dns:{txt:[]},config:cfg()})[0],/TXT record _vercel\.hotel\.com has not been found/);
 assert.ok(Dm.diagnose({domain:'hotel.com',records:a,dns:{a:[]},config:cfg({configuredBy:'http'})}).some(x=>/proxy/.test(x)))});

// ---------- status rules ----------
test('evaluate: only ownership + routing + SSL is active; a TXT record alone never is',()=>{
 const ok={pd:{verified:true},config:{misconfigured:false,configuredBy:'CNAME'},ssl:{ready:true}};
 assert.equal(Dm.evaluate(ok).status,'active');
 assert.equal(Dm.evaluate({...ok,ssl:{ready:false}}).status,'configuring');
 assert.equal(Dm.evaluate({...ok,config:{misconfigured:true,configuredBy:'CNAME'}}).status,'configuring');
 assert.equal(Dm.evaluate({pd:{verified:false},config:cfg(),dns:{},ssl:{ready:false},txtFound:false}).status,'pending_dns');
 assert.equal(Dm.evaluate({pd:{verified:false},config:cfg(),dns:{},ssl:{ready:false},txtFound:true}).status,'verifying');
 assert.equal(Dm.evaluate({pd:{verified:true},config:cfg(),dns:{a:[],cname:[]},ssl:{ready:false}}).status,'pending_dns');
 assert.equal(Dm.evaluate({pd:{verified:false},config:cfg(),txtFound:true,ssl:{},windowStart:new Date(Date.now()-8*864e5)}).status,'failed');
 assert.equal(Dm.evaluate({...ok,windowStart:new Date(Date.now()-30*864e5)}).status,'active');
 assert.equal(Dm.nextDelayMs('active',3),864e5);assert.equal(Dm.nextDelayMs('failed',3),null);assert.equal(Dm.nextDelayMs('pending_dns',0),6e4);assert.equal(Dm.nextDelayMs('pending_dns',50),18e5)});

// ---------- Vercel client (fake HTTP) ----------
const fakeHttp=script=>{const calls=[];const f=async req=>{calls.push(req);const r=script.shift();if(r instanceof Error)throw r;return{headers:{},...r}};f.calls=calls;return f};
const client=(script,env={})=>{const http=fakeHttp(script);return{http,c:V.createClient({http,env:{VERCEL_TOKEN:'tok_secret',VERCEL_PROJECT_ID:'prj_1',...env},sleep:async()=>{}})}};
test('vercel client: uses the documented endpoints, team id and bearer token',async()=>{
 const {c,http}=client([{status:200,data:{name:'book.hotel.com',verified:true}},{status:200,data:{name:'book.hotel.com'}},{status:200,data:{verified:true}},{status:200,data:cfg({misconfigured:false})},{status:200,data:{}}],{VERCEL_TEAM_ID:'team_9'});
 await c.addDomain('book.hotel.com');await c.getProjectDomain('book.hotel.com');await c.verifyDomain('book.hotel.com');await c.getConfig('book.hotel.com');await c.removeDomain('book.hotel.com');
 assert.deepEqual(http.calls.map(x=>x.method+' '+x.url.replace('https://api.vercel.com','')),['POST /v10/projects/prj_1/domains','GET /v9/projects/prj_1/domains/book.hotel.com','POST /v9/projects/prj_1/domains/book.hotel.com/verify','GET /v6/domains/book.hotel.com/config','DELETE /v9/projects/prj_1/domains/book.hotel.com']);
 assert.deepEqual(http.calls[0].data,{name:'book.hotel.com'});assert.equal(http.calls[0].params.teamId,'team_9');assert.equal(http.calls[3].params.projectIdOrName,'prj_1');assert.equal(http.calls[0].headers.Authorization,'Bearer tok_secret')});
test('vercel client: maps errors, tolerates 404 on remove, treats "already on this project" as success, never leaks the token',async()=>{
 let {c}=client([{status:409,data:{error:{code:'domain_already_in_use',message:'The domain is already assigned to another Vercel project'}}}]);await assert.rejects(c.addDomain('a.com'),e=>e.kind==='conflict');
 ({c}=client([{status:400,data:{error:{code:'domain_already_exists',message:'domain already exists'}}},{status:200,data:{name:'a.com',verified:true}}]));assert.equal((await c.addDomain('a.com')).verified,true);
 ({c}=client([{status:404,data:{}}]));assert.equal(await c.removeDomain('a.com'),true);({c}=client([{status:404,data:{}}]));assert.equal(await c.getProjectDomain('a.com'),null);
 ({c}=client([{status:403,data:{error:{message:'Forbidden tok_secret'}}}]));await assert.rejects(c.getConfig('a.com'),e=>e.kind==='auth'&&!String(e.message).includes('tok_secret'));
 ({c}=client([new Error('socket hang up Authorization: Bearer tok_secret'),new Error('x'),new Error('y')]));await assert.rejects(c.getConfig('a.com'),e=>e.kind==='network'&&!String(e.message).includes('tok_secret'));
 ({c}=client([{status:400,data:{error:{message:'The domain is not valid'}}}]));await assert.rejects(c.addDomain('a.com'),e=>e.kind==='invalid'&&/not valid/.test(e.message));
 c=V.createClient({env:{}});assert.equal(c.enabled(),false);await assert.rejects(c.getConfig('a.com'),e=>e.kind==='disabled')});
test('vercel client: retries 429 and 5xx using Retry-After, then reports rate limiting',async()=>{
 let {c,http}=client([{status:429,headers:{'retry-after':'1'},data:{}},{status:200,data:cfg({misconfigured:false})}]);assert.equal((await c.getConfig('a.com')).misconfigured,false);assert.equal(http.calls.length,2);
 ({c,http}=client([{status:503,data:{}},{status:503,data:{}},{status:503,data:{}}]));await assert.rejects(c.getConfig('a.com'),e=>e.kind==='unavailable');
 ({c}=client([{status:429,headers:{'retry-after':'120'},data:{}}]));await assert.rejects(c.getConfig('a.com'),e=>e.kind==='rate_limited');await assert.rejects(c.getConfig('a.com'),e=>e.kind==='rate_limited')});

// ---------- runCheck: the verification state machine with fake Vercel / DNS / TLS ----------
const DS=require('../src/domainService');
const fakeVercel=o=>({enabled:()=>true,calls:[],async getProjectDomain(){this.calls.push('get');return o.pd===undefined?{name:'x',verified:true,apexName:'hotel.com'}:o.pd},async addDomain(n){this.calls.push('add');return o.added||{name:n,verified:true,apexName:'hotel.com'}},async verifyDomain(){this.calls.push('verify');return o.verified||{verified:true,apexName:'hotel.com'}},async getConfig(){this.calls.push('config');if(o.configErr)throw o.configErr;return o.config||cfg()},async removeDomain(){this.calls.push('remove');if(o.removeErr)throw o.removeErr;return true}});
const deps=o=>({vercel:fakeVercel(o),dnsLookup:async()=>o.dns||{a:[],cname:[],aaaa:[]},txtLookup:async()=>o.txt||[],tls:async()=>o.tls||{ready:false,error:'ECONNREFUSED'},now:()=>Date.parse('2026-11-08T10:00:00Z')});
const TXT={verified:false,apexName:'hotel.com',verification:[{type:'TXT',domain:'_vercel.hotel.com',value:'vc-verify=abc',reason:'pending'}]};
test('check: nothing in DNS yet -> pending_dns with the exact records and a retry time',async()=>{
 const s=await DS.runCheck('book.hotel.com',{},deps({pd:TXT}));assert.equal(s.status,'pending_dns');assert.deepEqual(s.records.map(r=>r.type),['TXT','CNAME']);assert.ok(s.nextCheckAt>new Date('2026-11-08T10:00:00Z'));assert.ok(s.issues.some(i=>/TXT record/.test(i)));assert.equal(s.steps.ownership,false)});
test('check: TXT present -> Vercel verify endpoint is called -> then routing decides (configuring while CNAME is missing)',async()=>{
 const d=deps({pd:TXT,txt:['vc-verify=abc'],verified:{verified:true,apexName:'hotel.com'},config:cfg({configuredBy:null,misconfigured:true})});
 const s=await DS.runCheck('book.hotel.com',{},d);assert.ok(d.vercel.calls.includes('verify'));assert.equal(s.steps.ownership,true);assert.equal(s.status,'pending_dns');// verified but no routing DNS seen yet
 const d2=deps({pd:TXT,txt:['vc-verify=abc'],verified:{verified:false,apexName:'hotel.com',verification:TXT.verification}});assert.equal((await DS.runCheck('book.hotel.com',{},d2)).status,'verifying')});
test('check: CNAME found but still misconfigured -> configuring; correct + no cert yet -> configuring; correct + cert -> active',async()=>{
 let s=await DS.runCheck('book.hotel.com',{},deps({config:cfg({configuredBy:'CNAME',misconfigured:true}),dns:{a:[],cname:['wrong.example.net']}}));assert.equal(s.status,'configuring');assert.ok(s.issues.some(i=>/points to wrong\.example\.net/.test(i)));
 const good=cfg({configuredBy:'CNAME',misconfigured:false});
 s=await DS.runCheck('book.hotel.com',{},deps({config:good,tls:{ready:false,error:'CERT_NOT_YET_VALID'}}));assert.equal(s.status,'configuring');assert.equal(s.ssl.ready,false);assert.equal(s.steps.ssl,false);
 s=await DS.runCheck('book.hotel.com',{status:'configuring'},deps({config:good,tls:{ready:true,issuer:"Let's Encrypt"}}));assert.equal(s.status,'active');assert.equal(s.ssl.ready,true);assert.ok(s.activatedAt);assert.equal(s.issues.length,0)});
test('check: apex domain works the same (A record)',async()=>{const s=await DS.runCheck('hotel.com',{},deps({config:cfg({configuredBy:'A',misconfigured:false}),tls:{ready:true}}));assert.equal(s.status,'active');assert.equal(s.apex,true);assert.equal(s.records[0].type,'A');assert.equal(s.records[0].host,'@')});
test('check: domain removed from Vercel by hand is attached again',async()=>{const d=deps({pd:null});await DS.runCheck('book.hotel.com',{},d);assert.deepEqual(d.vercel.calls.slice(0,2),['get','add'])});
test('check: Vercel trouble keeps the previous status, records a retry and hides details; auth errors show a neutral message',async()=>{
 let s=await DS.runCheck('book.hotel.com',{status:'configuring',attempts:2},deps({configErr:new V.VercelError('unavailable','x',503)}));assert.equal(s.status,'configuring');assert.ok(s.nextCheckAt);assert.match(s.error,/retry/);
 s=await DS.runCheck('book.hotel.com',{status:'pending_dns'},deps({configErr:new V.VercelError('auth','secret detail',403)}));assert.match(s.integrationError,/contact keykonnec support/);assert.ok(!JSON.stringify(s).includes('secret detail'));
 s=await DS.runCheck('book.hotel.com',{status:'pending_dns'},deps({pd:null,added:undefined,configErr:new V.VercelError('conflict','x',409)}));assert.equal(s.status,'failed')});
test('check: an active domain survives one or two bad checks but not three',async()=>{
 const bad=deps({config:cfg({configuredBy:null,misconfigured:true})});let s={status:'active',steps:{ownership:true,routing:true,ssl:true}};
 s=await DS.runCheck('book.hotel.com',s,bad);assert.equal(s.status,'active');s=await DS.runCheck('book.hotel.com',s,bad);assert.equal(s.status,'active');s=await DS.runCheck('book.hotel.com',s,bad);assert.notEqual(s.status,'active');
 let a={status:'active',driftFails:0};const err=deps({configErr:new V.VercelError('network','x')});for(let i=0;i<2;i++)a=await DS.runCheck('book.hotel.com',a,err);assert.equal(a.status,'active');a=await DS.runCheck('book.hotel.com',a,err);assert.equal(a.status,'configuring')});
test('check: gives up after 7 days without success but a manual check can restart it',async()=>{
 const old=new Date('2026-10-20T00:00:00Z'),s=await DS.runCheck('book.hotel.com',{status:'pending_dns',windowStart:old},deps({pd:TXT}));assert.equal(s.status,'failed');assert.equal(s.nextCheckAt,null);assert.match(s.error,/Check connection/)});

// ---------- registration / disconnect with a fake database ----------
function fakeDb(){const hotels=new Map(),match=(h,f)=>Object.entries(f).every(([k,v])=>k==='$or'?v.some(x=>match(h,x)):k==='_id'?String(h._id)===String(v):v&&typeof v==='object'&&'$exists' in v?(v.$exists?h[k]!==undefined:h[k]===undefined):v&&typeof v==='object'&&'$type' in v?typeof h[k]==='string':v&&typeof v==='object'&&'$ne' in v?h[k]!==v.$ne:k.includes('.')?false:v===null?h[k]==null:h[k]===v);
 const Hotel={async updateOne(f,u){const h=[...hotels.values()].find(x=>match(x,f));if(!h)return{matchedCount:0};
  if(u.$set&&u.$set.customDomain&&[...hotels.values()].some(x=>x!==h&&x.customDomain===u.$set.customDomain)){throw Object.assign(new Error('dup'),{code:11000})}
  Object.assign(h,u.$set||{});for(const k of Object.keys(u.$unset||{}))delete h[k];return{matchedCount:1}},async findById(id){const h=hotels.get(String(id));return h?JSON.parse(JSON.stringify(h),(k,v)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)?new Date(v):v):null},
  findOne(f){const h=[...hotels.values()].find(x=>x.customDomain===f.customDomain&&x.domainVerified===f.domainVerified&&x.status==='active'&&x.domainState&&x.domainState.status==='active'&&!x.domainState.pendingRemoval);return{select:()=>({lean:async()=>h?{slug:h.slug,customDomain:h.customDomain}:null})}},
  find(){return{sort:()=>({limit:async()=>[...hotels.values()].filter(h=>typeof h.customDomain==='string'&&h.domainState&&h.domainState.nextCheckAt&&new Date(h.domainState.nextCheckAt)<=new Date('2099-01-01'))})}}};
 return{hotels,Hotel,add:(id,o={})=>{const h={_id:id,slug:'h'+id,status:'active',...o};hotels.set(String(id),h);return h}}}
const db=fakeDb(),orig=Module._load;Module._load=function(r,p,...a){if(r==='./models'&&p&&/domainService/.test(p.filename))return db;return orig.call(this,r,p,...a)};
const fresh=id=>db.Hotel.findById(id);
test('register: saves the domain with Vercel\'s real DNS records and starts at pending_dns',async()=>{
 db.add(1);const d=deps({pd:TXT,added:TXT});const h=await DS.register(await fresh(1),'https://Book.Hotel.com/',d);
 assert.equal(h.customDomain,'book.hotel.com');assert.equal(h.domainVerified,false);assert.equal(h.domainState.status,'pending_dns');const v=DS.view(h);assert.equal(v.status,'pending_dns');assert.equal(v.records[0].type,'TXT');assert.equal(v.records[1].value,'abc123.vercel-dns-017.com');assert.equal(v.url,null);assert.ok(!JSON.stringify(v).includes('tok_'));
 assert.equal(await DS.hotelByHost('book.hotel.com'),null)});// not active: must not resolve
test('register: a different domain needs a disconnect first; the same domain is idempotent; invalid input is refused',async()=>{
 await assert.rejects(DS.register(await fresh(1),'other.com',deps({})),e=>e.status===409);await DS.register(await fresh(1),'book.hotel.com',deps({}));
 await assert.rejects(DS.register(await fresh(1),'not a domain',deps({})),e=>e.status===400);
 await assert.rejects(DS.register(await fresh(1),'',deps({})),e=>e.status===400)});
test('register: a domain already used by another hotel is refused (unique index) and Vercel is not called',async()=>{
 db.add(2);const d=deps({});await assert.rejects(DS.register(await fresh(2),'book.hotel.com',d),e=>e.status===409&&/another hotel/.test(e.message));assert.equal(d.vercel.calls.length,0);assert.equal((await fresh(2)).customDomain,undefined)});
test('register: if Vercel refuses (domain on another project) our reservation is rolled back so both sides agree',async()=>{
 db.add(3);const d=deps({});d.vercel.addDomain=async()=>{throw new V.VercelError('conflict','taken',409)};
 await assert.rejects(DS.register(await fresh(3),'taken.com',d),e=>e.status===409&&/already in use/.test(e.message));const h=await fresh(3);assert.equal(h.customDomain,undefined);assert.equal(h.domainState,undefined);
 d.vercel.addDomain=async()=>{throw new V.VercelError('network','x')};await assert.rejects(DS.register(await fresh(3),'a.com',d),e=>e.status===502);assert.equal((await fresh(3)).customDomain,undefined);
 db.add(4);await assert.rejects(DS.register(await fresh(4),'a.com',{...deps({}),vercel:{enabled:()=>false}}),e=>e.status===503)});
test('routing + CORS only trust ACTIVE domains; becoming active and disconnecting take effect immediately',async()=>{
 DS.invalidate('book.hotel.com');let h=await fresh(1);const good=deps({config:cfg({configuredBy:'CNAME',misconfigured:false}),tls:{ready:true}});
 h=await DS.check(h,{deps:good});assert.equal(h.domainState.status,'active');assert.equal(h.domainVerified,true);assert.deepEqual(await DS.hotelByHost('Book.Hotel.COM'),{slug:'h1',domain:'book.hotel.com'});assert.equal(await DS.hotelByHost('evil.com'),null);assert.equal(await DS.hotelByHost('www.book.hotel.com'),null);
 const {allowed}=require('../src/cors');assert.equal(await allowed('https://book.hotel.com'),true);assert.equal(await allowed('http://book.hotel.com'),false);assert.equal(await allowed('https://www.book.hotel.com'),false);assert.equal(await allowed('https://evil.com'),false);assert.equal(await allowed('https://app.example.com'),true);assert.equal(await allowed('https://grand.keykonnec.com'),true);assert.equal(await allowed('https://keykonnec.com.evil.com'),false);assert.equal(await allowed('not a url'),false);
 const live=express();live.use(require('../src/cors'));live.all('*',(q,s)=>s.json({ok:1}));const srv=live.listen(0),u=p=>`http://127.0.0.1:${srv.address().port}${p}`;
 try{let r=await fetch(u('/api/public/h1'),{headers:{Origin:'https://book.hotel.com'}});assert.equal(r.headers.get('access-control-allow-origin'),'https://book.hotel.com');assert.equal(r.headers.get('access-control-allow-credentials'),null);
  r=await fetch(u('/api/reservations'),{headers:{Origin:'https://book.hotel.com'}});assert.notEqual(r.headers.get('access-control-allow-origin'),'https://book.hotel.com');// dashboard routes never accept custom domains
  await DS.disconnect(await fresh(1),deps({}));DS.invalidate('book.hotel.com');r=await fetch(u('/api/public/h1'),{headers:{Origin:'https://book.hotel.com'}});assert.equal(r.headers.get('access-control-allow-origin'),null)}finally{srv.close()}});
test('disconnect: removes the domain from Vercel and our database',async()=>{const h=await fresh(1);assert.equal(h.customDomain,undefined);assert.equal(h.domainVerified,false);assert.equal(await DS.hotelByHost('book.hotel.com'),null)});
test('disconnect: if Vercel removal fails the domain is switched off at once and removal is retried by the worker',async()=>{
 db.add(5,{customDomain:'stay.hotel.com',domainVerified:true,domainState:{status:'active'}});const d=deps({removeErr:new V.VercelError('unavailable','x',503)});
 await assert.rejects(DS.disconnect(await fresh(5),d),e=>e.status===202&&e.pending);let h=await fresh(5);assert.equal(h.domainVerified,false);assert.equal(h.domainState.pendingRemoval,true);assert.equal(DS.view(h).status,'disconnecting');assert.equal(DS.view(h).url,null);assert.equal(await DS.hotelByHost('stay.hotel.com'),null);
 h.domainState.nextCheckAt=new Date(0);db.hotels.get('5').domainState.nextCheckAt=new Date(0);
 const n=await DS.processDue({...deps({}),pause:0});assert.ok(n>=1);h=await fresh(5);assert.equal(h.customDomain,undefined)});
test('worker: due domains are re-checked sequentially and failures of one do not stop the others',async()=>{
 db.add(6,{customDomain:'one.hotel.com',domainState:{status:'pending_dns',nextCheckAt:new Date(0)}});db.add(7,{customDomain:'two.hotel.com',domainState:{status:'pending_dns',nextCheckAt:new Date(0)}});
 const d={...deps({config:cfg({configuredBy:'CNAME',misconfigured:false}),tls:{ready:true}}),pause:0};let n=0;const orig=d.vercel.getConfig;d.vercel.getConfig=async function(){if(n++===0)throw new V.VercelError('rate_limited','x',429);return orig.call(this)};
 await DS.processDue(d);assert.equal((await fresh(6)).domainState.status,'pending_dns');assert.equal((await fresh(7)).domainState.status,'active')});
test('manual check from failed restarts the 7-day window; checks without a domain are refused',async()=>{
 db.add(8,{customDomain:'late.hotel.com',domainState:{status:'failed',windowStart:new Date('2026-01-01')}});const h=await DS.check(await fresh(8),{manual:true,deps:deps({pd:TXT})});assert.equal(h.domainState.status,'pending_dns');
 db.add(9);await assert.rejects(DS.check(await fresh(9)),e=>e.status===400)});
test.after?.(()=>{Module._load=orig});
