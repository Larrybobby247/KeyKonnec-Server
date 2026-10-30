const axios=require('axios'),{Notification}=require('./models');
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const link=s=>esc(s).replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" style="color:#1c5d57;word-break:break-all">$1</a>');
const C={ink:'#202B2A',muted:'#74817E',primary:'#0D2B2A',secondary:'#1C5D57',accent:'#D9A441',mist:'#EEF4F2',line:'#E3EAE8'};
const SERIF="Georgia,'Times New Roman',serif",SANS="-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TONES={green:['#E4F4EC','#176B47'],amber:['#FBF1DC','#8A5A00'],red:['#FCE8E6','#A12B20'],blue:['#E3F0FA','#195A8C'],gray:['#EEF1F0','#44514E']};
const button=([label,url],accent)=>`<table role="presentation" cellspacing="0" cellpadding="0" style="margin:22px 0 6px"><tr><td style="border-radius:999px;background:${accent?C.accent:C.secondary}"><a href="${esc(url)}" style="display:inline-block;padding:13px 28px;font:700 15px ${SANS};color:${accent?C.primary:'#ffffff'};text-decoration:none;border-radius:999px">${esc(label)}</a></td></tr></table>`;
const rowsTable=rows=>`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden">${rows.map(([k,v,strong],i)=>`<tr><td style="padding:11px 16px;font:13px ${SANS};color:${C.muted};${i?`border-top:1px solid ${C.line};`:''}${strong?`background:${C.mist};`:''}vertical-align:top">${esc(k)}</td><td align="right" style="padding:11px 16px;font:${strong?'700 16px':'600 14px'} ${SANS};color:${strong?C.primary:C.ink};${i?`border-top:1px solid ${C.line};`:''}${strong?`background:${C.mist};`:''}vertical-align:top">${link(v)}</td></tr>`).join('')}</table>`;
/**
 * Branded email layout (table based, so it renders in Gmail, Outlook and Apple Mail).
 * `lines` may contain:
 *   'text'                    a paragraph (links become clickable; a line that is only a link becomes a button)
 *   ['Label','Value']         a row in a details table (consecutive rows are grouped); ['Total','N1','strong'] highlights a row
 *   {heading:'text'}          a small section heading
 *   {button:['Label','url']}  a call-to-action button ({button:[..],accent:true} for the gold style)
 *   {note:'text'}             a muted callout box
 * opts: {brand, logo, badge:[text,tone], preheader, footer, linkLabel}
 */
exports.tpl=(title,lines=[],opts={})=>{const out=[];let rows=[];const flush=()=>{if(rows.length)out.push(rowsTable(rows));rows=[]};
 for(const l of lines.filter(x=>x!=null&&x!==false)){
  if(Array.isArray(l)){rows.push([l[0],l[1],l[2]==='strong']);continue}flush();
  if(typeof l==='string'){/^https?:\/\/\S+$/.test(l.trim())?out.push(button([opts.linkLabel||'Open link',l.trim()])+`<p style="margin:6px 0 0;font:12px ${SANS};color:${C.muted};word-break:break-all">${link(l.trim())}</p>`):out.push(`<p style="margin:0 0 14px;font:15px/1.65 ${SANS};color:${C.ink}">${link(l)}</p>`)}
  else if(l.heading)out.push(`<h3 style="margin:24px 0 4px;font:700 12px ${SANS};letter-spacing:.09em;text-transform:uppercase;color:${C.secondary}">${esc(l.heading)}</h3>`);
  else if(l.button)out.push(button(l.button,l.accent));
  else if(l.note)out.push(`<div style="margin:16px 0;padding:14px 16px;background:${C.mist};border-left:3px solid ${C.accent};border-radius:8px;font:13px/1.6 ${SANS};color:${C.ink}">${link(l.note)}</div>`)}
 flush();
 const brand=opts.brand||'keykonnec',bt=opts.badge&&opts.badge[0],tone=TONES[(opts.badge&&opts.badge[1])||'gray'];
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="margin:0;padding:0;background:${C.mist}">${opts.preheader?`<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>`:''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.mist};padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px">
<tr><td style="background:${C.primary};border-radius:18px 18px 0 0;padding:22px 32px;border-bottom:3px solid ${C.accent};font:700 22px ${SERIF};color:#ffffff">${opts.logo?`<img src="${esc(opts.logo)}" alt="" width="34" height="34" style="vertical-align:middle;border-radius:50%;margin-right:10px">`:''}<span style="vertical-align:middle">${esc(brand)}</span></td></tr>
<tr><td style="background:#ffffff;padding:32px 32px 26px;border-radius:0 0 18px 18px">
${bt?`<span style="display:inline-block;margin-bottom:12px;padding:4px 12px;border-radius:999px;background:${tone[0]};color:${tone[1]};font:700 12px ${SANS};letter-spacing:.03em">${esc(bt)}</span>`:''}
<h1 style="margin:0 0 18px;font:700 26px/1.25 ${SERIF};color:${C.primary}">${esc(title)}</h1>${out.join('')}</td></tr>
<tr><td style="padding:18px 20px;text-align:center;font:12px/1.6 ${SANS};color:${C.muted}">${opts.footer?esc(opts.footer)+'<br>':''}${brand==='keykonnec'?'Sent by keykonnec, hotel booking made simple.':'Booking powered by keykonnec'}</td></tr>
</table></td></tr></table></body></html>`};
const toText=h=>String(h).replace(/<(style|title)[\s\S]*?<\/\1>/gi,'').replace(/<div style="display:none[^>]*>[\s\S]*?<\/div>/gi,'').replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,(m,u,t)=>{const x=t.replace(/<[^>]+>/g,'').trim();return x===u?u:`${x} (${u})`}).replace(/<\/td>\s*<td/gi,': <td').replace(/<br\s*\/?>|<\/(p|tr|h\d|div|table)>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
exports.toText=toText;
// Never throws: a failed email must not affect bookings or payments. Returns 'sent' or 'failed' and logs the attempt.
// opts: {replyTo} so a guest's reply reaches the hotel.
exports.send=async(to,subject,html,hotel,opts={})=>{let n;const list=[].concat(to).filter(Boolean);try{n=await Notification.create({to:list.join(', '),subject,hotel,status:'queued'});
 if(!process.env.RESEND_API_KEY)throw new Error('RESEND_API_KEY not set');if(!list.length)throw new Error('No recipient');
 await axios.post('https://api.resend.com/emails',{from:process.env.MAIL_FROM,to:list,subject,html,text:toText(html),...(opts.replyTo?{reply_to:opts.replyTo}:{})},{headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY}});n.status='sent'}
 catch(e){if(n){n.status='failed';n.error=String(e.response?.data?.message||e.message)}}
 try{n&&await n.save()}catch{}return n?n.status:'failed'};
