const D=require('./models'),inv=require('./inventory'),bill=require('./billing'),mail=require('./mail'),hooks=require('./hooks'),pricing=require('./pricing'),e2=require('./extra2'),plans=require('./plans'),E=require('./emails');
const {z}=require('zod'),axios=require('axios'),bcrypt=require('bcryptjs'),crypto=require('crypto'),cron=require('node-cron'),rate=require('express-rate-limit');
const day=x=>new Date(x).toISOString().slice(0,10),hex=n=>crypto.randomBytes(n).toString('hex'),bad=m=>Object.assign(new Error(m),{status:400});
const tellOwner=async(h,sub,lines)=>{const u=await D.User.findOne({'memberships.hotel':h,'memberships.role':'owner'});u&&mail.send(u.email,sub,mail.tpl(sub,lines),h)};
const feat=async(q,f)=>(await bill.entitlements(q.hotelId)).plan.features.includes(f);
// ---------- reservation changes, with automatic price difference handling ----------
async function quoteFor(hotel,r,b){const [t,h,{plan}]=[await D.RoomType.findById(r.roomType),await D.Hotel.findById(hotel),await bill.entitlements(hotel)],qty=b.qty||r.qty,o={hotel:h,plan,type:t,checkIn:b.checkIn,checkOut:b.checkOut,qty,manual:true};
 try{return{k:await pricing.quote({...o,promo:r.promoCode}),qty}}catch{try{return{k:await pricing.quote(o),qty}}catch(e){return{error:e.message}}}}// if the original code no longer validates, the discount is dropped
async function applyModify(hotel,id,b,user){const r=await D.Reservation.findOne({_id:id,hotel,status:{$in:['confirmed','requested']}});if(!r)return{error:'This reservation cannot be changed'};
 b={...b,checkIn:new Date(b.checkIn),checkOut:new Date(b.checkOut)};if(b.checkOut<=b.checkIn)return{error:'Check-out must be after check-in'};
 const {k,qty,error}=await quoteFor(hotel,r,b);if(error)return{error};
 await inv.release(r.roomType,inv.nightsOf(r.checkIn,r.checkOut),r.qty);
 try{await inv.reserve(r.roomType,b.checkIn,b.checkOut,qty)}catch(e){await inv.reserve(r.roomType,r.checkIn,r.checkOut,r.qty).catch(()=>{});return{error:e.message==='SOLD_OUT'?'Those dates are not available.':e.message}}
 const old=r.total,from={in:r.checkIn,out:r.checkOut};r.checkIn=b.checkIn;r.checkOut=b.checkOut;r.qty=qty;r.accommodation=k.accommodation;r.discount=k.discount;r.tax=k.tax;r.total=k.total;if(b.notes)r.notes=b.notes;
 r.balanceDue=r.paid<r.total?(k.dueDate||r.checkIn):undefined;r.balanceReminded=false;r.paymentStatus=r.paid>=r.total?'paid':r.paid>0?'partial':'unpaid';await r.save();
 await D.Hold.updateOne({reservation:r._id},{checkIn:b.checkIn,checkOut:b.checkOut,qty});
 let refunded=0,left=r.paid-r.total;// price went down below what was paid: refund the difference, newest payment first
 if(left>0)for(const p of await D.Payment.find({reservation:r._id,status:'success',refundStatus:{$ne:'pending'},$or:[{source:'platform'},{verified:true}]}).sort({createdAt:-1})){if(left<=0)break;const amt=Math.min(p.amount-p.refundedAmount,left);if(amt<=0)continue;if(!(await e2.doRefund(hotel,p._id,amt,user))){refunded+=amt;left-=amt}}
 await D.Audit.create({user,hotel,action:'reservation.modify',entity:'Reservation',entityId:r._id,detail:{from,oldTotal:old,newTotal:r.total,refunded}});
 if(r.guest.email){const [hh,tt]=await Promise.all([D.Hotel.findById(hotel).lean(),D.RoomType.findById(r.roomType).lean()]),m=E.guestModified({hotel:hh,r,type:tt,refunded});mail.send(r.guest.email,m.subject,m.html,hotel)}
 hooks.emit(hotel,'reservation.modified',{reference:r.reference});return{total:r.total,diff:r.total-old,refunded,owing:Math.max(0,r.total-r.paid)}}
async function doCancel(hotel,id,user){const r=await D.Reservation.findOne({_id:id,hotel,status:{$in:['pending','confirmed','requested']}});if(!r)return 'This reservation cannot be cancelled';
 const h=await D.Hold.findOne({reservation:r._id,status:'converted'});if(h){await inv.release(r.roomType,inv.nightsOf(r.checkIn,r.checkOut),r.qty);h.status='released';await h.save()}
 r.status='cancelled';await r.save();await D.Audit.create({user,hotel,action:'reservation.cancelled',entity:'Reservation',entityId:r._id});
 if(r.guest.email){const [hh,tt]=await Promise.all([D.Hotel.findById(hotel).lean(),D.RoomType.findById(r.roomType).lean()]),m=E.guestCancelled({hotel:hh,r,type:tt});mail.send(r.guest.email,m.subject,m.html,hotel)}hooks.emit(hotel,'reservation.cancelled',{reference:r.reference})}
exports.requestApproval=async(q,action,payload)=>{const a=await D.Approval.create({hotel:q.hotelId,action,payload,requestedBy:q.user.id});await D.Audit.create({user:q.user.id,hotel:q.hotelId,action:'approval.requested',entity:'Approval',entityId:a._id,detail:{action}});tellOwner(q.hotelId,'An action needs your approval',[`Type: ${action}. Open Integrations in your dashboard to decide.`])};
const execApproval=async(a,user)=>{const p=a.payload;if(a.action==='refund')return e2.doRefund(a.hotel,p.payment,p.amount,user);if(a.action==='cancel')return doCancel(a.hotel,p.reservation,user);
 if(a.action==='modify')return (await applyModify(a.hotel,p.reservation,p,user)).error;return 'Unknown action'};
// ---------- iCal channel sync (export to Booking.com/Airbnb/Expedia, import their bookings as blocks) ----------
const parseIcs=txt=>{const L=txt.replace(/\r?\n[ \t]/g,'').split(/\r?\n/),out=[];let c=null;
 for(const l of L){if(l.startsWith('BEGIN:VEVENT'))c={};else if(l.startsWith('END:VEVENT')){if(c&&c.s)out.push(c);c=null}else if(c){const i=l.indexOf(':'),key=l.slice(0,i).split(';')[0],val=l.slice(i+1);if(key==='DTSTART')c.s=val.slice(0,8);if(key==='DTEND')c.e=val.slice(0,8);if(key==='UID')c.uid=val;if(key==='STATUS'&&/CANCEL/i.test(val))c.x=1}}
 const D8=v=>new Date(Date.UTC(+v.slice(0,4),+v.slice(4,6)-1,+v.slice(6,8)));
 return out.filter(e=>!e.x&&/^\d{8}/.test(e.s)).map(e=>{const a=D8(e.s);let b=e.e&&/^\d{8}/.test(e.e)?D8(e.e):new Date(+a+864e5);if(b<=a)b=new Date(+a+864e5);return{uid:e.uid||e.s+'-'+e.e,from:a,to:b}}).filter(e=>e.to>new Date()&&e.from<new Date(Date.now()+400*864e5)).slice(0,500)};
exports.parseIcs=parseIcs;
async function syncFeed(f){const conflicts=[];
 try{await hooks.safeUrl(f.url);const r=await axios.get(f.url,{timeout:10000,maxContentLength:2e6,maxRedirects:0,responseType:'text'}),want=new Map(parseIcs(String(r.data)).map(e=>[e.uid,e]));
  for(const b of await D.Block.find({feed:f._id,source:'ota'})){const w=want.get(b.uid);if(w&&+w.from===+b.from&&+w.to===+b.to)want.delete(b.uid);else{await inv.release(b.roomType,inv.nightsOf(b.from,b.to),b.qty);await D.Block.deleteOne({_id:b._id})}}
  const t=await D.RoomType.findById(f.roomType);
  for(const e of want.values()){try{await inv.reserve(f.roomType,e.from,e.to,1);await D.Block.create({hotel:f.hotel,branch:t.branch,roomType:f.roomType,qty:1,from:e.from,to:e.to,reason:'Imported from '+f.name,source:'ota',feed:f._id,uid:e.uid})}catch(x){if(x.message==='SOLD_OUT')conflicts.push(day(e.from)+' to '+day(e.to));else throw x}}
  const msg=conflicts.length?'Possible double booking for: '+conflicts.slice(0,5).join(', '):'';if(msg&&msg!==f.lastError)tellOwner(f.hotel,'Channel sync conflict',[f.name+': '+msg]);
  await D.IcalFeed.updateOne({_id:f._id},{lastSync:new Date(),lastError:msg})}
 catch(e){await D.IcalFeed.updateOne({_id:f._id},{lastError:String(e.message).slice(0,200)})}}
// ---------- WhatsApp delivery status webhook ----------
exports.waVerify=(q,s)=>q.query['hub.verify_token']&&q.query['hub.verify_token']===process.env.WHATSAPP_VERIFY_TOKEN?s.send(q.query['hub.challenge']):s.sendStatus(403);
exports.waEvents=async(q,s)=>{const secret=process.env.WHATSAPP_APP_SECRET,a=Buffer.from(String(q.headers['x-hub-signature-256']||'').replace('sha256=','')),b=Buffer.from(secret?crypto.createHmac('sha256',secret).update(q.body).digest('hex'):'x');
 if(!secret||a.length!==b.length||!crypto.timingSafeEqual(a,b))return s.sendStatus(401);
 try{for(const en of JSON.parse(q.body).entry||[])for(const c of en.changes||[])for(const st of c.value.statuses||[])await D.Notification.updateOne({providerId:st.id},{status:st.status,...(st.errors?{error:st.errors[0].title}:{})})}catch{}s.sendStatus(200)};
let bankCache;const banks=async()=>{if(bankCache&&bankCache.t>Date.now()-864e5)return bankCache.list;const list=(await bill.banks()).map(b=>({name:b.name,code:b.code}));bankCache={t:Date.now(),list};return list};
exports.mount=({api,auth,need,admin,audit,parse,wrap})=>{
 const mgr=need('owner','manager'),fin=need('owner','manager','accountant'),gate=f=>wrap(async(q,s,n)=>(await feat(q,f))?n():s.status(402).json({error:`This is not included in your plan (${f}). Upgrade to use it.`})),month=q=>/^\d{4}-\d{2}$/.test(String(q.query.month))?String(q.query.month):day(new Date()).slice(0,7);
 // hotel settings incl. logo and gallery (Cloudinary images only)
 api.patch('/hotel',auth,mgr,wrap(async(q,s)=>{const cl=z.string().url().startsWith('https://res.cloudinary.com/');
  const b=parse(z.object({name:z.string().min(2),phone:z.string(),address:z.string(),holdMinutes:z.number().int().min(5).max(60),depositPercent:z.number().int().min(10).max(100),balanceDueDays:z.number().int().min(0).max(60),taxPercent:z.number().min(0).max(30),maxAdvanceDays:z.number().int().min(1).max(730),cutoffHour:z.number().int().min(0).max(23),policies:z.object({cancellation:z.string().max(1000),checkInTime:z.string().max(20),checkOutTime:z.string().max(20)}).partial(),logo:cl,addGallery:cl,removeGallery:z.string()}).partial(),q.body);
  const {addGallery,removeGallery,...set}=b;if(addGallery&&((await D.Hotel.findById(q.hotelId).select('gallery')).gallery||[]).length>=12)throw bad('You can add up to 12 gallery photos');
  s.json(await D.Hotel.findByIdAndUpdate(q.hotelId,{$set:set,...(addGallery?{$push:{gallery:addGallery}}:{}),...(removeGallery?{$pull:{gallery:removeGallery}}:{})},{new:true}).select('-payout.subaccountCode -icalToken -website.draft -website.published'))}));
 // price changes after editing a booking: extra is requested from the guest, a lower price refunds the difference
 api.patch('/reservations/:id',auth,wrap(async(q,s)=>{const b=parse(z.object({checkIn:z.coerce.date(),checkOut:z.coerce.date(),qty:z.number().int().min(1).max(10).optional(),notes:z.string().optional()}),q.body);
  const r=await D.Reservation.findOne({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches},status:{$in:['confirmed','requested']}});if(!r)return s.status(409).json({error:'This reservation cannot be changed'});
  if(q.role!=='owner'&&await feat(q,'approvals')){const p=await quoteFor(q.hotelId,r,b);if(p.error)return s.status(409).json({error:p.error});
   if(p.k.total<r.total){await exports.requestApproval(q,'modify',{reservation:r.id,checkIn:b.checkIn,checkOut:b.checkOut,qty:b.qty,notes:b.notes});return s.status(202).json({pending:true,message:'A lower price needs the owner\'s approval. Request sent.'})}}
  const out=await applyModify(q.hotelId,r.id,b,q.user.id);out.error?s.status(409).json({error:out.error}):s.json(out)}));
 // approvals for refunds, cancelling paid bookings and price reductions
 api.get('/approvals',auth,need('owner'),wrap(async(q,s)=>s.json(await D.Approval.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(50).populate('requestedBy','name'))));
 api.post('/approvals/:id/:act(approve|reject)',auth,need('owner'),wrap(async(q,s)=>{const a=await D.Approval.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId,status:'pending'},{status:q.params.act==='approve'?'approved':'rejected',decidedBy:q.user.id,decidedAt:new Date()});if(!a)return s.status(409).json({error:'Already decided'});
  if(q.params.act==='approve'){const e=await execApproval(a,q.user.id);if(e){await D.Approval.updateOne({_id:a._id},{status:'pending'});return s.status(409).json({error:e})}}await audit(q,'approval.'+q.params.act,'Approval',a.id);s.json({ok:true})}));
 // payout account: creates a Paystack subaccount so booking money goes to the hotel's bank and our commission is split off at payment time
 api.get('/banks',auth,need('owner'),wrap(async(q,s)=>s.json(await banks())));
 const acct=z.object({bankCode:z.string().max(10),accountNumber:z.string().regex(/^\d{10}$/)});
 api.post('/payout-account/resolve',auth,need('owner'),rate({windowMs:60000,limit:10}),wrap(async(q,s)=>{const b=parse(acct,q.body);try{s.json({accountName:(await bill.resolveAccount(b.accountNumber,b.bankCode)).account_name})}catch{s.status(400).json({error:'We could not verify that account. Check the bank and account number.'})}}));
 api.post('/payout-account',auth,need('owner'),rate({windowMs:36e5,limit:10}),wrap(async(q,s)=>{const b=parse(acct.extend({password:z.string()}),q.body);
  if(!await bcrypt.compare(b.password,q.user.passwordHash))return s.status(403).json({error:'Wrong password'});// changing where money goes needs the password again
  const bank=(await banks()).find(x=>x.code===b.bankCode);if(!bank)throw bad('Unknown bank');let a;try{a=await bill.resolveAccount(b.accountNumber,b.bankCode)}catch{throw bad('We could not verify that account.')}
  const h=await D.Hotel.findById(q.hotelId);let code=h.payout&&h.payout.subaccountCode;
  if(code)await bill.updateSubaccount(code,{business_name:h.name,settlement_bank:b.bankCode,account_number:b.accountNumber});else code=(await bill.createSubaccount({business_name:h.name,settlement_bank:b.bankCode,account_number:b.accountNumber,percentage_charge:0})).subaccount_code;
  h.payout={bankName:bank.name,bankCode:b.bankCode,accountName:a.account_name,last4:b.accountNumber.slice(-4),subaccountCode:code};await h.save();await audit(q,'payout.set','Hotel',h.id,{bank:bank.name,last4:h.payout.last4});
  tellOwner(q.hotelId,'Payout account updated',[`Online booking payments will be credited to ${bank.name} ending ${h.payout.last4}. If this was not you, contact support now.`]);
  s.json({payout:{bankName:bank.name,accountName:a.account_name,last4:h.payout.last4}})}));
 // iCal
 api.get('/ical/:token/:rt',wrap(async(q,s)=>{const h=await D.Hotel.findOne({icalToken:q.params.token});if(!h)return s.sendStatus(404);const t=await D.RoomType.findOne({_id:q.params.rt.replace(/\.ics$/,''),hotel:h.id});if(!t)return s.sendStatus(404);
  const [rs,bs]=await Promise.all([D.Reservation.find({hotel:h.id,roomType:t._id,status:{$in:['confirmed','checked_in']},checkOut:{$gte:new Date()}}).limit(1000).lean(),D.Block.find({roomType:t._id,source:{$ne:'ota'},to:{$gte:new Date()}}).limit(500).lean()]);
  const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z',d8=x=>day(x).replace(/-/g,''),ev=(u,a,b,m)=>`BEGIN:VEVENT\r\nUID:${u}@keykonnec\r\nDTSTAMP:${stamp}\r\nDTSTART;VALUE=DATE:${d8(a)}\r\nDTEND;VALUE=DATE:${d8(b)}\r\nSUMMARY:${m}\r\nEND:VEVENT\r\n`;
  s.type('text/calendar').send('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//keykonnec//EN\r\n'+rs.map(r=>ev('res-'+r._id,r.checkIn,r.checkOut,'Booked')).join('')+bs.map(b=>ev('blk-'+b._id,b.from,b.to,'Blocked')).join('')+'END:VCALENDAR\r\n')}));
 api.get('/ical-info',auth,need('owner'),gate('channels'),wrap(async(q,s)=>{const h=await D.Hotel.findById(q.hotelId);if(!h.icalToken){h.icalToken=hex(24);await h.save()}
  s.json({exports:(await D.RoomType.find({hotel:q.hotelId,active:true}).limit(100)).map(t=>({id:t.id,name:t.name,url:`${process.env.API_URL}/api/ical/${h.icalToken}/${t.id}.ics`})),feeds:await D.IcalFeed.find({hotel:q.hotelId})})}));
 api.post('/ical-feeds',auth,need('owner'),gate('channels'),wrap(async(q,s)=>{const b=parse(z.object({roomType:z.string(),name:z.string().min(2).max(40),url:z.string().url()}),q.body);try{await hooks.safeUrl(b.url)}catch(e){throw bad(e.message)}
  if(!await D.RoomType.exists({_id:b.roomType,hotel:q.hotelId}))throw bad('Room type not found');const f=await D.IcalFeed.create({...b,hotel:q.hotelId});await syncFeed(f);s.status(201).json(await D.IcalFeed.findById(f.id))}));
 api.post('/ical-feeds/:id/sync',auth,need('owner'),gate('channels'),wrap(async(q,s)=>{const f=await D.IcalFeed.findOne({_id:q.params.id,hotel:q.hotelId});if(!f)return s.sendStatus(404);await syncFeed(f);s.json(await D.IcalFeed.findById(f.id))}));
 api.delete('/ical-feeds/:id',auth,need('owner'),gate('channels'),wrap(async(q,s)=>{const f=await D.IcalFeed.findOneAndDelete({_id:q.params.id,hotel:q.hotelId});if(!f)return s.sendStatus(404);for(const b of await D.Block.find({feed:f._id})){await inv.release(b.roomType,inv.nightsOf(b.from,b.to),b.qty);await D.Block.deleteOne({_id:b._id})}s.json({ok:true})}));
 // post-stay feedback
 api.post('/public/booking/:ref/feedback',rate({windowMs:60000,limit:10}),wrap(async(q,s)=>{const b=parse(z.object({rating:z.number().int().min(1).max(5),comment:z.string().max(1000).optional()}),q.body);
  const r=await D.Reservation.findOne({reference:q.params.ref,manageToken:String(q.query.token),status:'checked_out'});if(!r)return s.status(404).json({error:'Feedback opens after your stay'});await D.Feedback.updateOne({reservation:r._id},{$set:{hotel:r.hotel,...b}},{upsert:true});s.json({ok:true})}));
 api.get('/reports/feedback',auth,mgr,gate('reports_plus'),wrap(async(q,s)=>{const f=await D.Feedback.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(200).lean();s.json({count:f.length,average:f.length?f.reduce((t,x)=>t+x.rating,0)/f.length:0,recent:f.slice(0,10)})}));
 // accounting exports (files you import into Xero or QuickBooks; not a live sync)
 api.get('/reports/accounting.csv',auth,fin,gate('exports'),wrap(async(q,s)=>{const m=month(q),[y,mo]=m.split('-').map(Number),from=new Date(Date.UTC(y,mo-1,1)),to=new Date(Date.UTC(y,mo,1));
  const ps=await D.Payment.find({hotel:q.hotelId,status:'success',createdAt:{$gte:from,$lt:to},$or:[{source:'platform'},{verified:true}]}).populate('reservation','reference guest.name').limit(5000).lean(),c=v=>'"'+String(v??'').replace(/"/g,'""')+'"',qb=q.query.format==='quickbooks';
  const rows=ps.map(p=>(qb?[day(p.createdAt),`Booking ${p.reservation&&p.reservation.reference} (${p.source==='platform'?'online':'manual'})`,p.amount]:[p.reservation&&p.reservation.guest.name,p.reference,day(p.createdAt),day(p.createdAt),`Room booking ${p.reservation&&p.reservation.reference}`,1,p.amount,'200','No VAT']).map(c).join(','));
  s.type('text/csv').send([qb?'Date,Description,Amount':'*ContactName,*InvoiceNumber,*InvoiceDate,*DueDate,Description,*Quantity,*UnitAmount,*AccountCode,*TaxType'].concat(rows).join('\n'))}));
 api.post('/admin/plans/reseed',...admin,wrap(async(q,s)=>{await plans.reseed();s.json({ok:true})}));
};
exports.jobs=()=>{
 cron.schedule('* * * * *',()=>hooks.retry().catch(console.error));
 cron.schedule('*/30 * * * *',async()=>{for(const f of await D.IcalFeed.find().limit(200))await syncFeed(f)});
 cron.schedule('0 9 * * *',async()=>{const cache={};for(const r of await D.Reservation.find({status:'checked_out',feedbackSent:{$ne:true},updatedAt:{$gt:new Date(Date.now()-3*864e5)}}).limit(500)){
  const P=cache[r.hotel]||(cache[r.hotel]=(await bill.entitlements(r.hotel)).plan.features);
  if(P.includes('reports_plus')&&r.guest.email){const h=await D.Hotel.findById(r.hotel);mail.send(r.guest.email,`How was your stay at ${h.name}?`,mail.tpl('Tell us about your stay',['Thank you for staying with '+h.name+'.',`${process.env.CLIENT_URL}/feedback/${r.reference}?token=${r.manageToken}`]),r.hotel)}
  await D.Reservation.updateOne({_id:r._id},{feedbackSent:true})}});
};
