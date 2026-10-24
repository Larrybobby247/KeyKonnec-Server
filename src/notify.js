const axios=require('axios'),{Notification}=require('./models');
const phone=p=>{let d=String(p||'').replace(/\D/g,'');if(d.startsWith('0'))d='234'+d.slice(1);return d.length>=10?d:null};
exports.configured=()=>!!(process.env.WHATSAPP_TOKEN&&process.env.WHATSAPP_PHONE_ID);
// WhatsApp Cloud API template message. Templates must be created and approved in Meta Business Manager (see docs/OPERATIONS.md).
exports.whatsapp=async({hotel,to,template,params})=>{const n=phone(to);if(!n||!exports.configured())return 'skipped';let rec;
 try{rec=await Notification.create({hotel,to:n,subject:template,channel:'whatsapp',status:'queued'});
  const r=await axios.post(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`,{messaging_product:'whatsapp',to:n,type:'template',template:{name:process.env['WA_TPL_'+template.toUpperCase()]||template,language:{code:process.env.WA_LANG||'en'},components:[{type:'body',parameters:params.map(t=>({type:'text',text:String(t)}))}]}},{headers:{Authorization:'Bearer '+process.env.WHATSAPP_TOKEN},timeout:10000});
  rec.status='sent';rec.providerId=r.data.messages&&r.data.messages[0]&&r.data.messages[0].id}
 catch(e){if(rec){rec.status='failed';rec.error=String(e.response?.data?.error?.message||e.message)}}
 try{rec&&await rec.save()}catch{}return rec?rec.status:'failed'};
// Only hotels whose plan includes WhatsApp send guest messages. Never throws.
exports.guest=async(r,template,params)=>{try{if((await require('./billing').entitlements(r.hotel)).plan.features.includes('whatsapp'))return await exports.whatsapp({hotel:r.hotel,to:r.guest.phone,template,params})}catch{}};
