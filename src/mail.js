const axios=require('axios'),{Notification}=require('./models');
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
exports.tpl=(title,lines)=>`<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2 style="color:#1c5d57">${esc(title)}</h2>${lines.map(l=>`<p>${esc(l).replace(/(https?:\/\/\S+)/g,'<a href="$1">$1</a>')}</p>`).join('')}<p style="color:#888;font-size:12px">keykonnec</p></div>`;
// Never throws: a failed email must not affect bookings or payments. Returns 'sent' or 'failed' and logs the attempt.
exports.send=async(to,subject,html,hotel)=>{let n;try{n=await Notification.create({to,subject,hotel,status:'queued'});
 if(!process.env.RESEND_API_KEY)throw new Error('RESEND_API_KEY not set');
 await axios.post('https://api.resend.com/emails',{from:process.env.MAIL_FROM,to,subject,html},{headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY}});n.status='sent'}
 catch(e){if(n){n.status='failed';n.error=String(e.response?.data?.message||e.message)}}
 try{n&&await n.save()}catch{}return n?n.status:'failed'};
