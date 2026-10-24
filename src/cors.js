const cors=require('cors');
// CLIENT_URL may be written with a trailing slash; browsers send the origin without one, so normalise it.
const APP=String(process.env.CLIENT_URL||'').trim().replace(/\/+$/,'');
// Public hotel websites can be served from a subdomain or a custom domain, so the public routes accept any origin but WITHOUT cookies.
// Everything else (dashboard, admin, account) only accepts the app origin with cookies.
const app=cors({origin:APP||false,credentials:true}),pub=cors({origin:true,credentials:false}),PUBLIC_API=/^\/api\/(public\/|contact$|plans$)/;
module.exports=(q,s,n)=>(PUBLIC_API.test(q.path)?pub:app)(q,s,n);
