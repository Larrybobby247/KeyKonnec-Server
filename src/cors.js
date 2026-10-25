const cors=require('cors');
// CLIENT_URL may be written with a trailing slash; browsers send the origin without one, so normalise it.
const APP=String(process.env.CLIENT_URL||'').trim().replace(/\/+$/,'');
// Public hotel websites can be served from a subdomain or a custom domain, so the public routes accept any origin but WITHOUT cookies.
// Everything else (dashboard, admin, account) only accepts the app origin with cookies.
const app=cors({origin:APP||false,credentials:true}),pub=cors({origin:true,credentials:false}),PUBLIC_API=/^\/api\/(public\/|contact$|plans$)/;
// The plan list is public, but the dashboard (same app origin) may also ask for it with cookies, so that origin gets credentials too.
module.exports=(q,s,n)=>(PUBLIC_API.test(q.path)&&!(q.path==='/api/plans'&&APP&&q.headers.origin===APP)?pub:app)(q,s,n);
