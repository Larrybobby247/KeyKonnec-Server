// Vercel REST API client for custom domains (one shared Vercel project hosts every hotel domain).
// Endpoints (https://vercel.com/docs/rest-api/reference/endpoints/projects):
//   POST   /v10/projects/{p}/domains            add a domain
//   GET    /v9/projects/{p}/domains/{domain}     get a project domain
//   POST   /v9/projects/{p}/domains/{domain}/verify
//   DELETE /v9/projects/{p}/domains/{domain}
//   GET    /v6/domains/{domain}/config?projectIdOrName=  routing + recommended DNS records
// The token only ever lives in the server environment; it is never logged or returned.
const axios=require('axios'),tls=require('tls');
class VercelError extends Error{constructor(kind,message,status,code){super(message);this.kind=kind;this.status=status;this.code=code}}
exports.VercelError=VercelError;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
exports.createClient=(o={})=>{
 const env=o.env||process.env,http=o.http||axios,wait=o.sleep||sleep,token=()=>env.VERCEL_TOKEN,project=()=>env.VERCEL_PROJECT_ID,team=()=>env.VERCEL_TEAM_ID;
 const enabled=()=>!!(token()&&project());
 const state={pausedUntil:0};
 // Sends one request; waits and retries on rate limits (429) and Vercel 5xx, honouring Retry-After / X-RateLimit-Reset. Never throws raw axios errors (they can contain the Authorization header).
 const call=async(method,path,{params,data}={})=>{
  if(!enabled())throw new VercelError('disabled','Custom domains are not enabled on this platform yet.');
  for(let attempt=0;;attempt++){
   const now=Date.now();if(state.pausedUntil>now&&attempt===0)throw new VercelError('rate_limited','Vercel is rate limiting requests. Try again shortly.',429);
   let r;try{r=await http({method,url:'https://api.vercel.com'+path,params:{...(team()?{teamId:team()}:{}),...params},data,headers:{Authorization:'Bearer '+token(),'Content-Type':'application/json'},timeout:15000,validateStatus:()=>true})}
   catch(e){if(attempt<2){await wait(500*(attempt+1));continue}throw new VercelError('network','Could not reach Vercel.')}
   if(r.status===429||r.status>=500){const ra=+r.headers?.['retry-after']||0,reset=+r.headers?.['x-ratelimit-reset']||0,ms=Math.min(15000,Math.max(500,ra?ra*1000:reset?reset*1000-Date.now():1000*(attempt+1)));
    if(r.status===429)state.pausedUntil=Date.now()+Math.min(ms,60000);
    if(attempt<2&&ms<=10000){await wait(ms);continue}throw new VercelError(r.status===429?'rate_limited':'unavailable','Vercel is busy. Try again shortly.',r.status)}
   return r}};
 const err=r=>{const e=r.data&&r.data.error||{},code=e.code||'',msg=String(e.message||'');return{code,msg}};
 const fail=(r,what)=>{const {code,msg}=err(r);if(r.status===401||r.status===403)throw new VercelError('auth',`Vercel rejected our credentials while ${what}.`,r.status,code);
  if(r.status===409||/already (assigned|in use)|owner already has/i.test(msg)||code==='domain_already_in_use')throw new VercelError('conflict','This domain is already in use on another project.',r.status,code);
  if(r.status===400||r.status===422)throw new VercelError('invalid',msg||'Vercel did not accept this domain.',r.status,code);
  throw new VercelError('unknown',`Vercel returned an error while ${what}.`,r.status,code)};
 const P=()=>encodeURIComponent(project());
 return{enabled,
  async addDomain(name){const r=await call('POST',`/v10/projects/${P()}/domains`,{data:{name}});
   if(r.status>=200&&r.status<300)return r.data;
   const {code,msg}=err(r);if(r.status===400&&(code==='domain_already_exists'||/already exists|already added/i.test(msg))){const pd=await this.getProjectDomain(name);if(pd)return pd}
   return fail(r,'adding the domain')},
  async getProjectDomain(name){const r=await call('GET',`/v9/projects/${P()}/domains/${encodeURIComponent(name)}`);if(r.status===404)return null;if(r.status>=200&&r.status<300)return r.data;return fail(r,'reading the domain')},
  async verifyDomain(name){const r=await call('POST',`/v9/projects/${P()}/domains/${encodeURIComponent(name)}/verify`);if(r.status>=200&&r.status<300)return r.data;
   if(r.status===400||r.status===409){return{...(await this.getProjectDomain(name)||{}),verified:false}}return fail(r,'verifying the domain')},
  async getConfig(name){const r=await call('GET',`/v6/domains/${encodeURIComponent(name)}/config`,{params:{projectIdOrName:project()}});if(r.status>=200&&r.status<300)return r.data;return fail(r,'checking DNS configuration')},
  async removeDomain(name){const r=await call('DELETE',`/v9/projects/${P()}/domains/${encodeURIComponent(name)}`);if(r.status===404||(r.status>=200&&r.status<300))return true;return fail(r,'removing the domain')}}};
// SSL readiness: a real TLS handshake with the hostname. Succeeds only when a valid, trusted certificate that covers the hostname is being served.
exports.tlsProbe=(host,timeout=8000)=>new Promise(res=>{let done=false;const fin=v=>{if(!done){done=true;try{s.destroy()}catch{}res(v)}};
 const s=tls.connect({host,port:443,servername:host,rejectUnauthorized:true,timeout},()=>{const c=s.getPeerCertificate();fin({ready:!!s.authorized,issuer:c&&c.issuer&&(c.issuer.O||c.issuer.CN)||null,validTo:c&&c.valid_to||null})});
 s.on('error',e=>fin({ready:false,error:e.code||'TLS_ERROR'}));s.on('timeout',()=>fin({ready:false,error:'TIMEOUT'}))});
exports.default=exports.createClient();
