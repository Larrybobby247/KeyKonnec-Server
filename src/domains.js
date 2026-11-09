// Pure helpers for custom domains: validation, DNS instructions built from Vercel's real answers, and the status rules. No network or database here, so it is fully unit-tested.
const {domainToASCII}=require('url'),net=require('net');
const TWO_LEVEL=new Set('co.uk org.uk ac.uk gov.uk com.ng org.ng net.ng edu.ng gov.ng co.ke or.ke ac.ke go.ke co.za org.za com.au net.au org.au co.nz com.br co.in com.gh co.tz co.ug com.eg co.zw com.sa com.tr co.jp com.mx com.sg'.split(' '));
const hostOf=u=>{try{return new URL(/^https?:\/\//.test(u)?u:'https://'+u).hostname.toLowerCase()}catch{return ''}};
// Hosts that belong to the platform itself can never be claimed by a hotel.
exports.platformHosts=(env=process.env)=>[env.SITE_BASE_DOMAIN,hostOf(env.CLIENT_URL||''),hostOf(env.API_URL||''),hostOf(env.VITE_APP_HOST||''),...String(env.RESERVED_DOMAINS||'').split(',')].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean);
const BLOCKED=['vercel.app','vercel.com','now.sh','vercel.dev','localhost','local','internal','test','invalid','example','onion'];
exports.normalize=(input,env=process.env)=>{
 let d=String(input==null?'':input).trim().toLowerCase();if(!d)return{ok:false,error:'Enter a domain such as book.yourhotel.com.'};
 d=d.replace(/^[a-z][a-z0-9+.-]*:\/\//,'').replace(/[\/?#].*$/,'').replace(/^[^@]*@/,'');
 if(/^\[/.test(d)||/:\d+$/.test(d)&&!/^[^:]+:\d+$/.test(d))return{ok:false,error:'That does not look like a domain name.'};
 d=d.replace(/:\d+$/,'').replace(/\.+$/,'');
 if(d.includes('*'))return{ok:false,error:'Wildcard domains are not supported. Use a specific domain such as book.yourhotel.com.'};
 if(net.isIP(d))return{ok:false,error:'Use a domain name, not an IP address.'};
 const a=domainToASCII(d);if(!a)return{ok:false,error:'That does not look like a valid domain name.'};d=a;
 if(d.length>253)return{ok:false,error:'That domain name is too long.'};
 const labels=d.split('.');if(labels.length<2)return{ok:false,error:'Enter a full domain such as yourhotel.com.'};
 if(!labels.every(l=>l.length>=1&&l.length<=63&&/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)))return{ok:false,error:'That does not look like a valid domain name.'};
 const tld=labels[labels.length-1];if(!(/^[a-z]{2,63}$/.test(tld)||/^xn--[a-z0-9-]{1,59}$/.test(tld)))return{ok:false,error:'That domain ending is not valid.'};
 if(BLOCKED.some(b=>d===b||d.endsWith('.'+b)))return{ok:false,error:'That domain cannot be used.'};
 if(exports.platformHosts(env).some(h=>d===h||d.endsWith('.'+h)))return{ok:false,error:'That domain belongs to keykonnec and cannot be used as a custom domain.'};
 return{ok:true,domain:d}};
// Registrable domain (apex). Vercel's own apexName is preferred when we have it; this is the fallback.
exports.apexOf=d=>{const l=d.split('.');return l.length>=3&&TWO_LEVEL.has(l.slice(-2).join('.'))?l.slice(-3).join('.'):l.slice(-2).join('.')};
exports.isApex=(d,apexName)=>d===(apexName||exports.apexOf(d));
// Host as DNS panels want it: "@" for the apex itself, otherwise the part before the apex.
exports.relativeHost=(full,apexName)=>{const f=String(full||'').toLowerCase().replace(/\.$/,''),a=String(apexName||'').toLowerCase();return !a||f===a?'@':f.endsWith('.'+a)?f.slice(0,-(a.length+1)):f};
const rank1=list=>[...(list||[])].sort((x,y)=>(x.rank||99)-(y.rank||99))[0];
const trimDot=v=>String(v||'').replace(/\.$/,'').toLowerCase();
// DNS instructions from Vercel's real responses. Ownership (TXT) is only listed when Vercel asks for it; routing is an A record for an apex domain and a CNAME for a subdomain.
exports.buildRecords=({domain,apexName,pd,config,env=process.env})=>{const apex=exports.isApex(domain,apexName),an=apexName||exports.apexOf(domain),out=[];
 for(const c of (pd&&!pd.verified&&pd.verification)||[])out.push({type:String(c.type).toUpperCase(),host:exports.relativeHost(c.domain,an),fullName:c.domain,value:c.value,purpose:'ownership',purposeText:'Proves you own this domain',required:true,reason:c.reason});
 let route=null;
 if(apex){const r=rank1(config&&config.recommendedIPv4),v=r&&Array.isArray(r.value)?r.value[0]:r&&r.value;if(v)route={type:'A',value:String(v),source:'vercel'};else if(env.VERCEL_DNS_A)route={type:'A',value:env.VERCEL_DNS_A,source:'env'}}
 else{const r=rank1(config&&config.recommendedCNAME);if(r&&r.value)route={type:'CNAME',value:trimDot(r.value),source:'vercel'};else if(env.VERCEL_DNS_CNAME)route={type:'CNAME',value:trimDot(env.VERCEL_DNS_CNAME),source:'env'}}
 if(route)out.push({...route,host:exports.relativeHost(domain,an),fullName:domain,purpose:'routing',purposeText:apex?'Points your domain to your keykonnec website':'Points this address to your keykonnec website',required:true});
 const alt=apex&&rank1(config&&config.recommendedCNAME);
 return{apex,records:out,alternative:alt&&alt.value?`If your DNS provider supports ALIAS, ANAME or CNAME flattening for the root domain, you can use that with ${trimDot(alt.value)} instead of the A record.`:null,missingTargets:!route}};
const same=(a,b)=>trimDot(a)===trimDot(b);
// Plain-language problems found by comparing what is in DNS with what Vercel expects.
exports.diagnose=({domain,apex,records,dns,pd,config})=>{const issues=[],route=records.find(r=>r.purpose==='routing'),own=records.find(r=>r.purpose==='ownership'&&r.type==='TXT');
 if(own){const t=(dns.txt||[]).some(x=>x===own.value||x.includes(own.value));if(!t)issues.push(`The TXT record ${own.fullName} has not been found yet.`)}
 if(route&&route.type==='A'){const a=dns.a||[];if(!a.length)issues.push(`No A record found for ${domain}. Add an A record with value ${route.value}.`);else if(!a.includes(route.value)&&(config&&config.misconfigured!==false))issues.push(`${domain} points to ${a.join(', ')} but should point to ${route.value}. Remove the old A record.`);if((dns.cname||[]).length)issues.push(`${domain} has a CNAME record. A root domain cannot have both. Remove it and use the A record.`)}
 if(route&&route.type==='CNAME'){const c=dns.cname||[];if(!c.length){if((dns.a||[]).length)issues.push(`${domain} has an A record. Remove it and add the CNAME record to ${route.value}.`);else issues.push(`No CNAME record found for ${domain}. Add a CNAME record pointing to ${route.value}.`)}else if(!c.some(x=>same(x,route.value))&&(config&&config.misconfigured!==false))issues.push(`${domain} points to ${c.map(trimDot).join(', ')} but should point to ${route.value}.`)}
 if((dns.aaaa||[]).length&&config&&config.misconfigured)issues.push('An IPv6 (AAAA) record exists for this domain and may send visitors elsewhere. Remove it unless it was provided by Vercel.');
 if(config&&config.configuredBy==='http')issues.push('Your domain appears to be behind a proxy such as Cloudflare. Turn the proxy off (DNS only) until the domain is active.');
 return issues};
exports.FAIL_AFTER_MS=7*864e5;
// Ownership + routing + SSL decide the status. A TXT record on its own never makes a domain active.
exports.evaluate=({pd,config,dns={},ssl,txtFound,windowStart,now=Date.now()})=>{
 const ownership=!!(pd&&pd.verified),routing=!!(config&&config.misconfigured===false),sslReady=!!(ssl&&ssl.ready),dnsSeen=!!(config&&config.configuredBy)||(dns.a||[]).length>0||(dns.cname||[]).length>0;
 let status;
 if(ownership&&routing&&sslReady)status='active';
 else if(!ownership)status=txtFound?'verifying':'pending_dns';
 else if(!routing&&!dnsSeen)status='pending_dns';
 else status='configuring';
 if(status!=='active'&&windowStart&&now-new Date(windowStart)>exports.FAIL_AFTER_MS)status='failed';
 return{status,steps:{ownership,routing,ssl:sslReady}}};
// Re-check schedule: quick at first, then every 30 minutes; active domains are re-checked daily; failed ones only when the owner asks.
exports.nextDelayMs=(status,attempts)=>status==='active'?864e5:status==='failed'?null:[6e4,12e4,3e5,6e5,9e5][Math.min(attempts,5)]||18e5;
