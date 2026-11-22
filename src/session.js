// Login cookie settings, in one place so login and logout always use identical attributes.
// Safari on iPhone/iPad (every iOS browser) and Samsung Internet block cookies set by a *different site* than the page (third-party cookies).
// The login cookie therefore only survives if the API is on the SAME SITE as the app, e.g. app.keykonnec.com + api.keykonnec.com
// (or if the app proxies /api to the server, so the browser only ever talks to one host).
const Dm=require('./domains');
const hostOf=u=>{try{return new URL(u).hostname.toLowerCase()}catch{return ''}};
exports.sameSiteApi=(env=process.env)=>{const a=hostOf(env.API_URL||''),c=hostOf(env.CLIENT_URL||'');return !!a&&!!c&&Dm.apexOf(a)===Dm.apexOf(c)};
// COOKIE_SAMESITE (lax|strict|none) overrides everything. Otherwise: same-site API -> "lax" (works in Safari); anything else in production -> "none" (needs a cross-site cookie, which Safari refuses).
exports.sameSite=(env=process.env)=>{const f=String(env.COOKIE_SAMESITE||'').toLowerCase();if(['lax','strict','none'].includes(f))return f;
 if(env.NODE_ENV!=='production')return 'lax';return exports.sameSiteApi(env)?'lax':'none'};
exports.clearOptions=(env=process.env)=>{const ss=exports.sameSite(env);return{httpOnly:true,sameSite:ss,secure:env.NODE_ENV==='production'||ss==='none',path:'/',...(env.COOKIE_DOMAIN?{domain:env.COOKIE_DOMAIN}:{})}};
exports.options=(env=process.env)=>({...exports.clearOptions(env),maxAge:6048e5});
exports.warn=(env=process.env)=>{if(env.NODE_ENV==='production'&&exports.sameSite(env)==='none')console.warn('[session] Login cookie is cross-site (SameSite=None). Safari on iPhone and Samsung Internet will block it, so logins will not stick. Put the API on a subdomain of your app domain (e.g. api.yourdomain.com) and set API_URL, or proxy /api through the app.')};
