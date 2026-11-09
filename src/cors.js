const cors=require('cors'),DS=require('./domainService');
// CLIENT_URL may be written with a trailing slash; browsers send the origin without one, so normalise it.
const APP=String(process.env.CLIENT_URL||'').trim().replace(/\/+$/,'');
const baseDomain=()=>String(process.env.SITE_BASE_DOMAIN||'').trim().toLowerCase();
// Dashboard, admin and account routes: only the app origin, with cookies.
const app=cors({origin:APP||false,credentials:true}),PUBLIC_API=/^\/api\/(public\/|contact$|plans$)/;
// Public hotel-website routes (no cookies): the app, any keykonnec hotel subdomain, and custom domains that are verified AND active. Everything else is refused: no wildcard.
// The check reads the hotel's domain record (cached for a minute), so connecting or disconnecting a domain takes effect almost immediately.
const allowed=async origin=>{let u;try{u=new URL(origin)}catch{return false}
 if(u.protocol!=='https:'&&!(u.hostname==='localhost'||u.hostname==='127.0.0.1'))return false;
 if(APP&&origin===APP)return true;
 const b=baseDomain();if(b&&u.hostname.endsWith('.'+b)&&u.hostname!==b)return true;
 return !!(await DS.hotelByHost(u.hostname).catch(()=>null))};
exports.allowed=allowed;
const pub=cors({credentials:false,origin:(origin,cb)=>{if(!origin)return cb(null,true);allowed(origin).then(ok=>cb(null,ok),()=>cb(null,false))}});
// The plan list is public, but the dashboard (same app origin) may also ask for it with cookies, so that origin gets credentials too.
module.exports=(q,s,n)=>(PUBLIC_API.test(q.path)&&!(q.path==='/api/plans'&&APP&&q.headers.origin===APP)?pub:app)(q,s,n);
module.exports.allowed=allowed;
