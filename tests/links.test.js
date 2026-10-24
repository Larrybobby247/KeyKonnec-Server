// No database needed: node --test tests/links.test.js
process.env.CLIENT_URL='https://app.example.com/';process.env.JWT_SECRET='x';delete process.env.SITE_BASE_DOMAIN;
const {test}=require('node:test'),assert=require('node:assert'),http=require('http'),express=require('express');
const {publicUrl}=require('../src/extra4');
test('public website link: custom domain, subdomain, path, trailing slash, missing CLIENT_URL',()=>{
 assert.deepEqual(publicUrl({slug:'grand',customDomain:'book.grand.com',domainVerified:true}),{kind:'custom',url:'https://book.grand.com'});
 const p=publicUrl({slug:'grand'});assert.equal(p.url,'https://app.example.com/h/grand');assert.equal(p.kind,'path');assert.equal(p.path,'/h/grand');
 const old=process.env.CLIENT_URL;delete process.env.CLIENT_URL;const o=publicUrl({slug:'grand'},{get:h=>h==='origin'?'https://my-dashboard.app/':undefined});assert.equal(o.url,'https://my-dashboard.app/h/grand');assert.equal(publicUrl({slug:'grand'}).path,'/h/grand');process.env.CLIENT_URL=old;
 process.env.SITE_BASE_DOMAIN='keykonnec.com';assert.equal(publicUrl({slug:'grand'}).url,'https://grand.keykonnec.com');delete process.env.SITE_BASE_DOMAIN});
test('CORS: public routes allow other origins without cookies; private routes allow only the app origin with cookies',async()=>{
 const app=express();app.use(require('../src/cors'));app.all('*',(q,s)=>s.json({ok:1}));const srv=app.listen(0),port=srv.address().port,u=p=>`http://127.0.0.1:${port}${p}`;
 try{const hotel='https://grand.keykonnec.com',pre=(p,o)=>fetch(u(p),{method:'OPTIONS',headers:{Origin:o,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-requested-with,content-type'}});
  let r=await pre('/api/public/grand/book',hotel);assert.equal(r.headers.get('access-control-allow-origin'),hotel);assert.equal(r.headers.get('access-control-allow-credentials'),null);
  r=await fetch(u('/api/public/grand'),{headers:{Origin:hotel}});assert.equal(r.headers.get('access-control-allow-origin'),hotel);
  r=await fetch(u('/api/reservations'),{headers:{Origin:hotel}});assert.equal(r.headers.get('access-control-allow-origin'),'https://app.example.com');// not the hotel site, so the browser blocks it
  r=await fetch(u('/api/reservations'),{headers:{Origin:'https://app.example.com'}});assert.equal(r.headers.get('access-control-allow-origin'),'https://app.example.com');assert.equal(r.headers.get('access-control-allow-credentials'),'true')}finally{srv.close()}});
