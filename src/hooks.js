const axios=require('axios'),crypto=require('crypto'),dns=require('dns').promises,{Webhook,Delivery}=require('./models');
const priv=ip=>/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|f[cd]|fe80)/i.test(ip);
// Blocks non-https URLs and private addresses so a URL cannot point at internal services.
exports.safeUrl=async u=>{const x=new URL(u);if(x.protocol!=='https:')throw new Error('URL must use https');const a=await dns.lookup(x.hostname,{all:true});if(!a.length||a.some(r=>priv(r.address)))throw new Error('That address is not allowed')};
const BACKOFF=[60,300,1800,7200,21600];// seconds before retries 1 to 5, so up to 6 attempts in total
async function deliver(d){const w=await Webhook.findById(d.webhook);if(!w||!w.active){await Delivery.updateOne({_id:d._id},{status:'failed',nextAttempt:null});return}
 let ok=false,code,error;
 try{await exports.safeUrl(w.url);const r=await axios.post(w.url,d.body,{timeout:5000,maxRedirects:0,validateStatus:()=>true,headers:{'Content-Type':'application/json','X-Keykonnec-Event':d.event,'X-Keykonnec-Delivery':String(d._id),'X-Keykonnec-Signature':crypto.createHmac('sha256',w.secret).update(d.body).digest('hex')}});code=r.status;ok=r.status<300}catch(e){error=e.message}
 const attempts=d.attempts+1,done=ok||attempts>=BACKOFF.length+1;
 await Delivery.updateOne({_id:d._id},{status:ok?'delivered':done?'failed':'retrying',code,error,attempts,nextAttempt:done?null:new Date(Date.now()+BACKOFF[attempts-1]*1000)});
 await Webhook.updateOne({_id:w._id},ok?{failures:0}:done?{$inc:{failures:1}}:{});
 if(!ok&&done&&w.failures+1>=5)await Webhook.updateOne({_id:w._id},{active:false})}
// The same body (with a stable event id) is re-sent on retry, so receivers can de-duplicate.
exports.emit=(hotel,event,data)=>{(async()=>{for(const w of await Webhook.find({hotel,active:true,events:event})){
 const d=await Delivery.create({hotel,webhook:w._id,event,status:'pending',attempts:0,nextAttempt:new Date(),body:JSON.stringify({event,id:crypto.randomUUID(),created:new Date(),data})});await deliver(d)}})().catch(()=>{})};
exports.retry=async()=>{for(const d of await Delivery.find({status:{$in:['pending','retrying']},nextAttempt:{$lte:new Date()}}).limit(100))await deliver(d)};
