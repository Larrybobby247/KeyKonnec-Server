const D=require('./models'),inv=require('./inventory'),bill=require('./billing'),mail=require('./mail'),hooks=require('./hooks'),pricing=require('./pricing'),pdf=require('./pdf'),notify=require('./notify'),base=require('./extra'),alerts=require('./alerts'),E=require('./emails');
const {z}=require('zod'),crypto=require('crypto'),dns=require('dns').promises,cron=require('node-cron'),rate=require('express-rate-limit'),mongoose=require('mongoose');
const OID=x=>new mongoose.Types.ObjectId(String(x)),day=x=>new Date(x).toISOString().slice(0,10),sha=x=>crypto.createHash('sha256').update(String(x)).digest('hex'),hex=n=>crypto.randomBytes(n).toString('hex');
const wa=(phone,text)=>{let p=String(phone||'').replace(/\D/g,'');if(p.startsWith('0'))p='234'+p.slice(1);return `https://wa.me/${p}?text=${encodeURIComponent(text)}`};
const tellOwner=async(h,sub,lines)=>{const u=await D.User.findOne({'memberships.hotel':h,'memberships.role':'owner'});u&&mail.send(u.email,sub,mail.tpl(sub,lines),h)};
const bad=m=>Object.assign(new Error(m),{status:400}),esc=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
async function doRefund(hotel,pid,amount,user){const p=await D.Payment.findOne({_id:pid,hotel});
 if(!p||!['success','needs_refund'].includes(p.status)||p.refundStatus==='pending')return 'This payment cannot be refunded';
 const left=p.amount-p.refundedAmount,amt=Math.min(left,+amount||left);if(amt<=0)return 'Already fully refunded';
 if(p.source==='manual_external'){if(p.verified)await base.applyRefund(p,amt);else await D.Payment.updateOne({_id:p._id},{status:'reversed'});await D.Payment.updateOne({_id:p._id},{refundStatus:'refunded'})}
 else{await bill.refund(p.reference,amt);await D.Payment.updateOne({_id:p._id},{refundStatus:'pending'})}// finishes when Paystack's refund.processed webhook arrives
 await D.Audit.create({user,hotel,action:'payment.refund',entity:'Payment',entityId:p._id,detail:{amount:amt}})}
const r2=n=>Math.round(n*100)/100;
const statementRows=async(hotel,month)=>{const [y,m]=month.split('-').map(Number),from=new Date(Date.UTC(y,m-1,1)),to=new Date(Date.UTC(y,m,1));
 const cs=await D.Commission.find({hotel,createdAt:{$gte:from,$lt:to}}).populate('reservation','reference').lean();
 const rows=cs.map(c=>({ref:c.reservation?c.reservation.reference:'-',date:day(c.createdAt),base:c.base,rate:c.rate||0,amount:c.amount+(c.adjustments||[]).reduce((t,a)=>t+a.amount,0),status:c.status}));
 const free=await D.Reservation.find({hotel,source:'online',commissionRate:0,paid:{$gt:0},createdAt:{$gte:from,$lt:to}}).limit(1000).lean();
 return rows.concat(free.filter(r=>!cs.some(c=>c.reservation&&String(c.reservation._id)===String(r._id))).map(r=>({ref:r.reference,date:day(r.createdAt),base:r.accommodation,rate:0,amount:0,status:'no commission'})))};
exports.doRefund=doRefund;
const rcx=async r=>({type:await D.RoomType.findById(r.roomType).lean(),rooms:await D.Room.find({_id:{$in:r.assignedRooms||[]}}).select('number').sort({number:1}).lean()});
exports.mount=({api,auth,need,admin,audit,parse,wrap})=>{
 const mb=q=>q.user.memberships[0].branches.map(String),can=(q,b)=>mb(q).includes(String(b)),F=async q=>(await bill.entitlements(q.hotelId)).plan.features,feat=async(q,f)=>(await F(q)).includes(f);
 const deny=(s,f)=>s.status(402).json({error:`This is not included in your plan (${f}). Upgrade to use it.`});
 const gate=f=>wrap(async(q,s,n)=>(await feat(q,f))?n():deny(s,f)),fin=need('owner','manager','accountant'),mgr=need('owner','manager'),month=q=>/^\d{4}-\d{2}$/.test(String(q.query.month))?String(q.query.month):day(new Date()).slice(0,7);
 api.get('/health',wrap(async(q,s)=>s.json({ok:true,db:mongoose.connection.readyState===1})));
 // ================= public booking =================
 const pubH=wrap(async(q,s,n)=>{const h=await D.Hotel.findOne({slug:q.params.slug,status:'active'});if(!h||!(h.website&&h.website.status==='published'))return s.status(404).json({error:'not_published'});q.h=h;q.ent=await bill.entitlements(h.id);n()});
 const live=p=>{const t=new Date();return (!p.validFrom||p.validFrom<=t)&&(!p.validTo||p.validTo>=t)};
 api.get('/public/by-domain',wrap(async(q,s)=>{const h=await D.Hotel.findOne({customDomain:String(q.query.host||'').toLowerCase(),domainVerified:true,status:'active'});h?s.json({slug:h.slug}):s.sendStatus(404)}));
 api.get('/public/recover/:token',wrap(async(q,s)=>{const e=await D.Enquiry.findOne({token:q.params.token});if(!e)return s.sendStatus(404);const h=await D.Hotel.findById(e.hotel);s.json({slug:h.slug,roomType:e.roomType,checkIn:e.checkIn,checkOut:e.checkOut,name:e.name,email:e.email})}));
 api.get('/public/:slug',pubH,wrap(async(q,s)=>{s.set('Cache-Control','public, max-age=15, stale-while-revalidate=30');const h=q.h,f={hotel:h.id,active:true},P=q.ent.plan.features;if(q.query.branch)f.branch=q.query.branch;
  const [types,branches,promos]=await Promise.all([D.RoomType.find(f).select('-hotel'),D.Branch.find({hotel:h.id,status:'active'}).select('name address').lean(),P.includes('pricing')?D.Promo.find({hotel:h.id,public:true,active:true}):[]]);
  s.json({site:(h.website&&h.website.published)||{},hotel:{slug:h.slug,name:h.name,phone:h.phone,address:h.address,policies:h.policies,taxPercent:h.taxPercent,online:P.includes('online_payments')&&!!h.payout&&!!h.payout.subaccountCode,logo:h.logo,gallery:h.gallery,deposit:P.includes('deposits')?h.depositPercent:100,whatsapp:P.includes('whatsapp'),widget:P.includes('widget')},types,branches:branches.filter(b=>types.some(t=>String(t.branch)===String(b._id))).length>1?branches.filter(b=>types.some(t=>String(t.branch)===String(b._id))):[],offers:promos.filter(live).map(p=>({code:p.code,label:p.label,type:p.type,value:p.value}))})}));
 api.get('/public/:slug/availability',pubH,wrap(async(q,s)=>{const {checkIn,checkOut}=parse(z.object({checkIn:z.coerce.date(),checkOut:z.coerce.date()}),q.query);if(checkOut<=checkIn)return s.status(400).json({error:'Check-out must be after check-in'});
  const f={hotel:q.h.id,active:true};if(q.query.branch)f.branch=q.query.branch;
  s.json(await Promise.all((await D.RoomType.find(f)).map(async t=>{const o={id:t.id,name:t.name,capacity:t.capacity,description:t.description,images:t.images,featured:t.featured};
   try{const k=await pricing.quote({hotel:q.h,plan:q.ent.plan,type:t,checkIn,checkOut});return{...o,nights:k.nights,unitTotal:k.total,available:await inv.freeRooms(t._id,checkIn,checkOut)}}catch(e){if(e.status!==400)throw e;return{...o,available:0,restriction:e.message}}})))}));
 api.get('/public/:slug/quote',pubH,wrap(async(q,s)=>{const b=parse(z.object({roomType:z.string(),checkIn:z.coerce.date(),checkOut:z.coerce.date(),qty:z.coerce.number().int().min(1).max(5).default(1),promo:z.string().optional()}),q.query);
  const t=await D.RoomType.findOne({_id:b.roomType,hotel:q.h.id,active:true});if(!t)return s.sendStatus(404);s.json(await pricing.quote({hotel:q.h,plan:q.ent.plan,type:t,...b}))}));
 api.post('/public/:slug/book',pubH,rate({windowMs:60000,limit:10}),wrap(async(q,s)=>{
  const b=parse(z.object({roomType:z.string(),checkIn:z.coerce.date(),checkOut:z.coerce.date(),adults:z.number().int().min(1),qty:z.number().int().min(1).max(5).default(1),promo:z.string().optional(),recover:z.string().optional(),marketingConsent:z.boolean().default(false),guest:z.object({name:z.string().min(2),email:z.string().email(),phone:z.string().min(7)})}),q.body);
  const t=await D.RoomType.findOne({_id:b.roomType,hotel:q.h.id,active:true});if(!t||b.checkIn<new Date(Date.now()-864e5))return s.status(400).json({error:'Invalid request'});
  if(b.adults>t.capacity*b.qty)return s.status(400).json({error:'Too many guests for this room'});
  const {plan,sub}=q.ent,online=plan.features.includes('online_payments')&&!!q.h.payout&&!!q.h.payout.subaccountCode;
  if(plan.monthlyBookings){const m=new Date();m.setUTCDate(1);m.setUTCHours(0,0,0,0);if(await D.Reservation.countDocuments({hotel:q.h.id,createdAt:{$gte:m}})>=plan.monthlyBookings)return s.status(402).json({error:'This hotel is not accepting new online bookings right now. Please contact the hotel.'})}
  const k=await pricing.quote({hotel:q.h,plan,type:t,checkIn:b.checkIn,checkOut:b.checkOut,qty:b.qty,promo:b.promo});
  try{await inv.reserve(t._id,b.checkIn,b.checkOut,b.qty)}catch(e){return e.message==='SOLD_OUT'?s.status(409).json({error:'Sorry, that room was just taken. Try other dates or another room.'}):Promise.reject(e)}
  if(k.promoId&&!await D.Promo.findOneAndUpdate({_id:k.promoId,$expr:{$or:[{$not:['$maxUses']},{$lt:['$used','$maxUses']}]}},{$inc:{used:1}})){await inv.release(t._id,inv.nightsOf(b.checkIn,b.checkOut),b.qty);return s.status(409).json({error:'That code has just run out'})}
  const ref='KK-'+hex(4).toUpperCase(),token=hex(24);
  const r=await D.Reservation.create({hotel:q.h.id,branch:t.branch,roomType:t.id,guest:b.guest,checkIn:b.checkIn,checkOut:b.checkOut,adults:b.adults,qty:b.qty,accommodation:k.accommodation,discount:k.discount,promoCode:k.promoCode,tax:k.tax,total:k.total,deposit:k.deposit,balanceDue:k.dueDate,currency:q.h.currency,reference:ref,manageToken:token,commissionRate:sub.status==='trialing'?0:(plan.commissionRate||0),marketingConsent:b.marketingConsent,status:online?'pending':'requested'});
  if(b.recover)await D.Enquiry.updateOne({token:b.recover,hotel:q.h.id},{status:'converted',reservation:r.id});hooks.emit(q.h.id,'reservation.created',{reference:ref});
  const hold={hotel:q.h.id,branch:t.branch,roomType:t.id,checkIn:b.checkIn,checkOut:b.checkOut,qty:b.qty,reservation:r.id};
  if(!online){await D.Hold.create({...hold,expiresAt:new Date('2999-01-01'),status:'converted'});alerts.bookingRequest(r);
   return s.status(201).json({reference:ref,token,status:'requested',message:'Booking request sent. The hotel will contact you with payment instructions. No payment has been taken.'})}
  await D.Hold.create({...hold,expiresAt:new Date(Date.now()+q.h.holdMinutes*6e4)});const pr='PAY-'+hex(8);
  const charge=r2((r.commissionRate||0)*k.accommodation*(k.deposit/k.total)),sa=q.h.payout.subaccountCode,init=await bill.initialize(b.guest.email,k.deposit,pr,`${process.env.CLIENT_URL}/booking/${ref}?token=${token}`,{subaccount:sa,charge});
  await D.Payment.create({hotel:q.h.id,branch:t.branch,reservation:r.id,amount:k.deposit,currency:q.h.currency,source:'platform',method:'paystack',reference:pr,commission:charge,subaccount:sa});
  s.status(201).json({reference:ref,token,status:'pending',checkoutUrl:init.authorization_url})}));
 api.post('/public/booking/:ref/pay-balance',rate({windowMs:60000,limit:10}),wrap(async(q,s)=>{const r=await D.Reservation.findOne({reference:q.params.ref,manageToken:String(q.query.token)});
  if(!r||!['confirmed','checked_in'].includes(r.status)||r.paid>=r.total||!r.guest.email)return s.status(409).json({error:'There is no balance to pay online'});
  const hh=await D.Hotel.findById(r.hotel);if(!(await bill.entitlements(r.hotel)).plan.features.includes('online_payments')||!hh.payout||!hh.payout.subaccountCode)return s.status(409).json({error:'Online payment is not available. Please pay the hotel directly.'});
  const amount=r.total-r.paid,ref='BAL-'+hex(8),charge=r2((r.commissionRate||0)*r.accommodation*(amount/r.total)),sa=hh.payout.subaccountCode,init=await bill.initialize(r.guest.email,amount,ref,`${process.env.CLIENT_URL}/booking/${r.reference}?token=${r.manageToken}`,{subaccount:sa,charge});
  await D.Payment.create({hotel:r.hotel,branch:r.branch,reservation:r._id,amount,currency:r.currency,source:'platform',method:'paystack',reference:ref,kind:'balance',commission:charge,subaccount:sa});s.json({checkoutUrl:init.authorization_url})}));
 api.get('/public/booking/:ref/receipt',wrap(async(q,s)=>{const r=await D.Reservation.findOne({reference:q.params.ref,manageToken:String(q.query.token)});if(!r)return s.sendStatus(404);
  const p=await D.Payment.findOne({reservation:r._id,status:'success'}).sort({createdAt:-1});if(!p)return s.status(404).json({error:'No payment yet'});pdf.receipt(s,{hotel:await D.Hotel.findById(r.hotel),r,p,...await rcx(r)})}));
 api.post('/public/:slug/enquiry',pubH,rate({windowMs:60000,limit:10}),wrap(async(q,s)=>{if(!q.ent.plan.features.includes('whatsapp'))return s.sendStatus(404);
  const b=parse(z.object({name:z.string().min(2),phone:z.string().min(7),email:z.string().email().optional().or(z.literal('')),roomType:z.string().optional(),checkIn:z.coerce.date().optional(),checkOut:z.coerce.date().optional(),consent:z.boolean().default(false)}),q.body);
  const rt=b.roomType&&await D.RoomType.findOne({_id:b.roomType,hotel:q.h.id}),e=await D.Enquiry.create({...b,roomType:rt?rt.id:undefined,hotel:q.h.id,branch:rt?rt.branch:undefined,source:'whatsapp',token:hex(12)});
  tellOwner(q.h.id,'New WhatsApp enquiry',[`${b.name}, ${b.phone}`]);
  s.status(201).json({link:wa(q.h.phone,`Hello ${q.h.name}, I am ${b.name}. I would like to book${rt?' a '+rt.name:''}${b.checkIn?' from '+day(b.checkIn)+' to '+day(b.checkOut):''}. Ref ${e.token.slice(0,6).toUpperCase()}`)})}));
 // ================= receipts, statements, reports =================
 api.get('/payments/:id/receipt',auth,need('owner','manager','accountant','receptionist'),wrap(async(q,s)=>{const p=await D.Payment.findOne({_id:q.params.id,hotel:q.hotelId,status:'success'});if(!p)return s.sendStatus(404);const rr=await D.Reservation.findById(p.reservation);if(rr&&['confirmed','checked_in'].includes(rr.status)&&!(rr.assignedRooms||[]).length)await inv.assignRooms(rr);pdf.receipt(s,{hotel:await D.Hotel.findById(q.hotelId),r:rr,p,...await rcx(rr)})}));
 api.get('/reports/commission-statement',auth,fin,wrap(async(q,s)=>{const m=month(q);pdf.statement(s,{hotel:await D.Hotel.findById(q.hotelId),month:m,rows:await statementRows(q.hotelId,m)})}));
 api.get('/admin/statement',...admin,wrap(async(q,s)=>{const m=month(q),h=await D.Hotel.findById(q.query.hotel);if(!h)return s.sendStatus(404);pdf.statement(s,{hotel:h,month:m,rows:await statementRows(h.id,m)})}));
 api.get('/reports/outstanding',auth,fin,wrap(async(q,s)=>s.json(await D.Reservation.find({hotel:q.hotelId,status:{$in:['requested','confirmed','checked_in']},$expr:{$gt:['$total','$paid']}}).sort({balanceDue:1}).limit(100).select('reference guest total paid balanceDue checkIn'))));
 api.get('/reports/payments.csv',auth,fin,gate('exports'),wrap(async(q,s)=>{const c=v=>'"'+String(v??'').replace(/"/g,'""')+'"',ps=await D.Payment.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(5000).populate('reservation','reference').lean();
  s.type('text/csv').send(['date,reservation,type,method,reference,amount,status,verified,refunded'].concat(ps.map(p=>[day(p.createdAt),p.reservation&&p.reservation.reference,p.source,p.method,p.reference,p.amount,p.status,p.verified,p.refundedAmount].map(c).join(','))).join('\n'))}));
 api.get('/reports/advanced',auth,fin,gate('analytics'),wrap(async(q,s)=>{const H=OID(q.hotelId),from=new Date(Date.now()-30*864e5),ids=(await D.RoomType.find({hotel:q.hotelId}).select('_id')).map(t=>t._id),rooms=await D.Room.countDocuments({roomType:{$in:ids},active:true});
  const [x]=await D.Reservation.aggregate([{$match:{hotel:H}},{$facet:{
   recent:[{$match:{status:{$in:['confirmed','checked_in','checked_out']},checkIn:{$gte:from}}},{$group:{_id:null,rev:{$sum:'$accommodation'},nights:{$sum:{$multiply:['$qty',{$divide:[{$subtract:['$checkOut','$checkIn']},864e5]}]}}}}],
   monthly:[{$match:{status:{$nin:['cancelled','expired']}}},{$group:{_id:{$dateToString:{format:'%Y-%m',date:'$checkIn'}},revenue:{$sum:'$paid'},bookings:{$sum:1}}},{$sort:{_id:-1}},{$limit:6}],
   flags:[{$group:{_id:null,n:{$sum:1},noShow:{$sum:{$cond:[{$eq:['$status','no_show']},1,0]}}}}],
   repeat:[{$match:{'guest.email':{$nin:[null,'']}}},{$group:{_id:'$guest.email',n:{$sum:1}}},{$match:{n:{$gt:1}}},{$count:'guests'}]}}]);
  const rc=x.recent[0]||{rev:0,nights:0},fl=x.flags[0]||{n:0,noShow:0};s.json({adr:rc.nights?rc.rev/rc.nights:0,revpar:rooms?rc.rev/(rooms*30):0,monthly:x.monthly.reverse(),noShows:fl.noShow,noShowRate:fl.n?fl.noShow/fl.n:0,repeatGuests:x.repeat[0]?x.repeat[0].guests:0})}));
 api.get('/reports/recovery',auth,wrap(async(q,s)=>{const P=await F(q);if(!P.includes('whatsapp'))return deny(s,'enquiry tracking');s.json(await D.Enquiry.aggregate([{$match:{hotel:OID(q.hotelId)}},{$group:{_id:{source:'$source',status:'$status'},n:{$sum:1}}}]))}));
 api.get('/audit',auth,mgr,gate('reports_plus'),wrap(async(q,s)=>{const p=Math.max(1,+q.query.page||1);s.json(await D.Audit.find({hotel:q.hotelId}).sort({createdAt:-1}).skip((p-1)*50).limit(50).populate('user','name').lean())}));
 // ================= pricing: rules, promos =================
 api.get('/price-rules',auth,gate('pricing'),wrap(async(q,s)=>s.json(await D.PriceRule.find({hotel:q.hotelId}).sort({from:-1}).limit(100).populate('roomType','name').lean())));
 api.post('/price-rules',auth,mgr,gate('pricing'),wrap(async(q,s)=>{const b=parse(z.object({roomTypes:z.array(z.string()).max(50).default([]),from:z.coerce.date(),to:z.coerce.date(),price:z.number().min(0),label:z.string().max(60).optional()}),q.body);if(b.to<b.from)throw bad('End date is before start date');
  const ts=b.roomTypes.length?await D.RoomType.find({_id:{$in:b.roomTypes},hotel:q.hotelId}):[null];if(b.roomTypes.length&&ts.length!==b.roomTypes.length)throw bad('Room type not found');
  const out=await D.PriceRule.insertMany(ts.map(t=>({hotel:q.hotelId,roomType:t?t._id:null,from:b.from,to:b.to,price:b.price,label:b.label})));await audit(q,'pricing.rule','PriceRule',out[0].id,{count:out.length});s.status(201).json(out)}));
 api.delete('/price-rules/:id',auth,mgr,gate('pricing'),wrap(async(q,s)=>{await D.PriceRule.deleteOne({_id:q.params.id,hotel:q.hotelId});s.json({ok:true})}));
 api.get('/promos',auth,gate('pricing'),wrap(async(q,s)=>s.json(await D.Promo.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(100))));
 api.post('/promos',auth,mgr,gate('pricing'),wrap(async(q,s)=>{const b=parse(z.object({code:z.string().min(3).max(20),label:z.string().max(80).optional(),type:z.enum(['percent','fixed']),value:z.number().positive(),validFrom:z.coerce.date().optional(),validTo:z.coerce.date().optional(),maxUses:z.number().int().min(1).optional(),minNights:z.number().int().min(1).optional(),public:z.boolean().default(false)}),q.body);
  if(b.type==='percent'&&b.value>100)throw bad('A percentage cannot be over 100');try{s.status(201).json(await D.Promo.create({...b,code:b.code.trim().toUpperCase(),hotel:q.hotelId}))}catch(e){e.code===11000?s.status(409).json({error:'That code already exists'}):Promise.reject(e)}}));
 api.delete('/promos/:id',auth,mgr,gate('pricing'),wrap(async(q,s)=>{await D.Promo.updateOne({_id:q.params.id,hotel:q.hotelId},{active:false});s.json({ok:true})}));
 // ================= calendar and date-range blocks =================
 api.get('/calendar',auth,wrap(async(q,s)=>{const days=Math.min(62,Math.max(1,+q.query.days||31)),from=q.query.from?new Date(q.query.from):new Date();from.setUTCHours(0,0,0,0);const to=new Date(+from+days*864e5);
  const f={hotel:q.hotelId,active:true,branch:{$in:q.user.memberships[0].branches}};if(q.query.branch&&can(q,q.query.branch))f.branch=q.query.branch;
  const types=await D.RoomType.find(f).limit(100),nights=await D.Night.find({roomType:{$in:types.map(t=>t._id)},date:{$gte:from,$lt:to}}).lean(),out=[];
  for(const t of types){const used=Array(days).fill(0);nights.filter(n=>String(n.roomType)===String(t._id)).forEach(n=>{used[Math.round((n.date-from)/864e5)]=n.used});out.push({id:t.id,name:t.name,cap:await inv.capacity(t._id),used})}
  s.json({from,days,types:out,blocks:await D.Block.find({hotel:q.hotelId,to:{$gte:from},from:{$lt:to}}).limit(100).populate('roomType','name').lean()})}));
 api.post('/blocks',auth,mgr,wrap(async(q,s)=>{const b=parse(z.object({roomTypes:z.array(z.string()).min(1).max(20),qty:z.number().int().min(1).max(50).default(1),from:z.coerce.date(),to:z.coerce.date(),reason:z.string().max(200).optional(),kind:z.enum(['blocked','maintenance']).default('blocked')}),q.body);if(b.to<=b.from)throw bad('End date must be after start date');
  if(b.roomTypes.length>1&&!await feat(q,'pricing'))return deny(s,'bulk blocking');const done=[];
  try{for(const id of b.roomTypes){const t=await D.RoomType.findOne({_id:id,hotel:q.hotelId});if(!t||!can(q,t.branch))throw bad('Room type not found');await inv.reserve(t._id,b.from,b.to,b.qty);done.push(t)}}
  catch(e){for(const t of done)await inv.release(t._id,inv.nightsOf(b.from,b.to),b.qty);return e.message==='SOLD_OUT'?s.status(409).json({error:'Not enough free rooms to block for those dates.'}):Promise.reject(e)}
  const out=[];for(const t of done)out.push(await D.Block.create({hotel:q.hotelId,branch:t.branch,roomType:t.id,qty:b.qty,from:b.from,to:b.to,reason:b.reason,kind:b.kind,createdBy:q.user.id}));await audit(q,'block.create','Block',out[0].id);s.status(201).json(out)}));
 api.delete('/blocks/:id',auth,mgr,wrap(async(q,s)=>{const b=await D.Block.findOneAndDelete({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}});if(!b)return s.sendStatus(404);await inv.release(b.roomType,inv.nightsOf(b.from,b.to),b.qty);await audit(q,'block.delete','Block',b.id);s.json({ok:true})}));
 // One list for the booking calendar: reservations, blocked or maintenance periods, and housekeeping tasks.
 api.get('/calendar/events',auth,wrap(async(q,s)=>{const from=new Date(q.query.from),to=new Date(q.query.to);if(isNaN(from)||isNaN(to)||to<=from||to-from>93*864e5)return s.status(400).json({error:'Choose a date range of up to three months.'});
  const br=q.query.branch&&can(q,q.query.branch)?[q.query.branch]:mb(q),hk=await feat(q,'housekeeping');
  const [rs,bs,ts]=await Promise.all([D.Reservation.find({hotel:q.hotelId,branch:{$in:br},status:{$nin:['cancelled','expired']},checkIn:{$lt:to},checkOut:{$gt:from}}).populate('roomType','name').populate('assignedRooms','number').select('-manageToken').limit(500).lean(),
   D.Block.find({hotel:q.hotelId,branch:{$in:br},to:{$gt:from},from:{$lt:to}}).populate('roomType','name').limit(300).lean(),
   hk?D.Task.find({hotel:q.hotelId,branch:{$in:br},status:{$ne:'done'}}).populate('room','number').limit(300).lean():[]]);
  const d0=x=>{const d=new Date(x);d.setUTCHours(0,0,0,0);return d},events=[];
  for(const r of rs)events.push({id:'res-'+r._id,kind:'reservation',refId:r._id,title:r.guest.name,roomType:r.roomType&&r.roomType.name,rooms:(r.assignedRooms||[]).map(x=>x.number),status:r.status,from:r.checkIn,to:r.checkOut,reference:r.reference,qty:r.qty,total:r.total,paid:r.paid,paymentStatus:r.paymentStatus});
  for(const b of bs)events.push({id:'blk-'+b._id,kind:'block',blockKind:b.kind||'blocked',reason:b.reason||'',refId:b._id,title:b.reason||(b.kind==='maintenance'?'Maintenance':'Blocked'),roomType:b.roomType&&b.roomType.name,qty:b.qty,from:b.from,to:b.to,source:b.source||'manual'});
  for(const t of ts){const f=t.from?d0(t.from):d0(t.createdAt),e=t.to?new Date(+d0(t.to)+864e5):new Date(+f+864e5);if(e>from&&f<to)events.push({id:'tsk-'+t._id,kind:'task',refId:t._id,taskType:t.type,title:(t.type==='cleaning'?'Cleaning':'Maintenance')+(t.room?' · Room '+t.room.number:''),room:t.room&&t.room.number,note:t.note,status:t.status,from:f,to:e})}
  s.json({from,to,events})}));
 api.patch('/blocks/:id',auth,mgr,wrap(async(q,s)=>{const b=parse(z.object({qty:z.number().int().min(1).max(50).optional(),from:z.coerce.date().optional(),to:z.coerce.date().optional(),reason:z.string().max(200).optional(),kind:z.enum(['blocked','maintenance']).optional()}),q.body);
  const o=await D.Block.findOne({_id:q.params.id,hotel:q.hotelId,branch:{$in:mb(q)}});if(!o)return s.sendStatus(404);
  const n={qty:b.qty===undefined?o.qty:b.qty,from:b.from||o.from,to:b.to||o.to};if(n.to<=n.from)throw bad('End date must be after start date');
  if(+n.from!==+o.from||+n.to!==+o.to||n.qty!==o.qty){await inv.release(o.roomType,inv.nightsOf(o.from,o.to),o.qty);
   try{await inv.reserve(o.roomType,n.from,n.to,n.qty)}catch(e){await inv.reserve(o.roomType,o.from,o.to,o.qty).catch(()=>{});return e.message==='SOLD_OUT'?s.status(409).json({error:'Not enough free rooms to block for those dates.'}):Promise.reject(e)}}
  Object.assign(o,n);if(b.reason!==undefined)o.reason=b.reason;if(b.kind)o.kind=b.kind;await o.save();await audit(q,'block.update','Block',o.id);s.json(o)}));
 // ================= room assignment, upgrades, history =================
 const myRes=q=>D.Reservation.findOne({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches},status:{$in:['confirmed','checked_in']}});
 api.post('/reservations/:id/assign-rooms',auth,need('owner','manager','receptionist'),wrap(async(q,s)=>{const ids=z.array(z.string()).min(1).parse(q.body.rooms),r=await myRes(q);if(!r||ids.length>r.qty)return s.status(409).json({error:'Cannot assign rooms to this reservation'});
  const rooms=await D.Room.find({_id:{$in:ids},hotel:q.hotelId,roomType:r.roomType,active:true,status:{$nin:['maintenance','out_of_service']}});if(rooms.length!==ids.length)return s.status(400).json({error:'Choose available rooms of the booked type (not in maintenance)'});
  if(await D.Reservation.exists({_id:{$ne:r._id},assignedRooms:{$in:ids},status:{$in:['confirmed','checked_in']},checkIn:{$lt:r.checkOut},checkOut:{$gt:r.checkIn}}))return s.status(409).json({error:'One of those rooms is already assigned for these dates'});
  r.assignedRooms=ids;await r.save();await audit(q,'reservation.assign','Reservation',r.id,{rooms:ids});s.json(r)}));
 api.post('/reservations/:id/change-room',auth,mgr,gate('room_ops'),wrap(async(q,s)=>{const b=parse(z.object({roomType:z.string(),keepPrice:z.boolean().default(true)}),q.body),r=await myRes(q);if(!r)return s.status(409).json({error:'Cannot change this reservation'});
  const t=await D.RoomType.findOne({_id:b.roomType,hotel:q.hotelId,branch:r.branch,active:true});if(!t||String(t._id)===String(r.roomType))return s.status(400).json({error:'Choose a different room type in the same branch'});
  try{await inv.reserve(t._id,r.checkIn,r.checkOut,r.qty)}catch(e){return e.message==='SOLD_OUT'?s.status(409).json({error:'No rooms of that type are free for these dates'}):Promise.reject(e)}
  await inv.release(r.roomType,inv.nightsOf(r.checkIn,r.checkOut),r.qty);const old=r.roomType;r.upgradedFrom=old;r.roomType=t.id;r.assignedRooms=[];
  if(!b.keepPrice){const k=await pricing.quote({hotel:await D.Hotel.findById(q.hotelId),plan:(await bill.entitlements(q.hotelId)).plan,type:t,checkIn:r.checkIn,checkOut:r.checkOut,qty:r.qty,manual:true});r.accommodation=k.accommodation;r.tax=k.tax;r.total=k.total}
  await r.save();await inv.assignRooms(r);await D.Hold.updateOne({reservation:r._id},{roomType:t.id});await audit(q,'reservation.change-room','Reservation',r.id,{from:old,to:t.id});s.json(r)}));
 api.get('/rooms/:id/history',auth,wrap(async(q,s)=>s.json(await D.Audit.find({hotel:q.hotelId,entity:'Room',entityId:q.params.id}).sort({createdAt:-1}).limit(50).populate('user','name').lean())));
 // ================= guests =================
 const gOk=need('owner','manager','receptionist');
 api.get('/guests/notes',auth,gOk,gate('reports_plus'),wrap(async(q,s)=>s.json(await D.GuestNote.findOne({hotel:q.hotelId,email:String(q.query.email).toLowerCase()})||{})));
 api.put('/guests/notes',auth,gOk,gate('reports_plus'),wrap(async(q,s)=>{const b=parse(z.object({email:z.string().email(),notes:z.string().max(2000).optional(),preferences:z.string().max(1000).optional(),tags:z.array(z.string().max(30)).max(10).optional()}),q.body);
  s.json(await D.GuestNote.findOneAndUpdate({hotel:q.hotelId,email:b.email.toLowerCase()},{$set:b},{upsert:true,new:true}))}));
 api.get('/guests/export.csv',auth,mgr,gate('reports_plus'),wrap(async(q,s)=>{const c=v=>'"'+String(v??'').replace(/"/g,'""')+'"',rows=await D.Reservation.aggregate([{$match:{hotel:OID(q.hotelId),'guest.email':{$nin:[null,'']}}},{$group:{_id:'$guest.email',name:{$last:'$guest.name'},phone:{$last:'$guest.phone'},stays:{$sum:1},spent:{$sum:'$paid'}}},{$limit:5000}]);
  await audit(q,'guests.export','Hotel',q.hotelId);s.type('text/csv').send(['email,name,phone,stays,spent'].concat(rows.map(r=>[r._id,r.name,r.phone,r.stays,r.spent].map(c).join(','))).join('\n'))}));
 // ================= enquiries and booking recovery =================
 const enq=wrap(async(q,s,n)=>{const P=await F(q);P.includes('whatsapp')||P.includes('recovery')?n():deny(s,'enquiry tracking')});
 api.get('/enquiries',auth,enq,wrap(async(q,s)=>s.json(await D.Enquiry.find({hotel:q.hotelId,...(q.query.status?{status:String(q.query.status)}:{})}).sort({createdAt:-1}).limit(100).populate('roomType','name').lean())));
 api.post('/enquiries',auth,enq,wrap(async(q,s)=>{const b=parse(z.object({name:z.string().min(2),phone:z.string().min(7),email:z.string().email().optional().or(z.literal('')),notes:z.string().max(500).optional(),consent:z.boolean().default(false)}),q.body);s.status(201).json(await D.Enquiry.create({...b,hotel:q.hotelId,branch:q.user.memberships[0].branches[0],source:'whatsapp',token:hex(12)}))}));
 api.patch('/enquiries/:id',auth,enq,wrap(async(q,s)=>{const b=parse(z.object({status:z.enum(['new','contacted','converted','lost']),notes:z.string().max(500)}).partial(),q.body);s.json(await D.Enquiry.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId},b,{new:true}))}));
 api.post('/enquiries/:id/follow-up',auth,enq,wrap(async(q,s)=>{const e=await D.Enquiry.findOne({_id:q.params.id,hotel:q.hotelId});if(!e)return s.sendStatus(404);const h=await D.Hotel.findById(q.hotelId),link=`${process.env.CLIENT_URL}/h/${h.slug}?recover=${e.token}`;let sent=false;
  if(e.email&&e.consent)sent=(await mail.send(e.email,'Finish your booking at '+h.name,mail.tpl('Still thinking about your stay?',[`Your dates may still be open at ${h.name}.`,link]),h.id))==='sent';
  await D.Enquiry.updateOne({_id:e._id},{$push:{followUps:{at:new Date(),by:q.user.id,channel:sent?'email':'whatsapp'}},...(e.status==='new'?{status:'contacted'}:{})});
  s.json({emailed:sent,whatsapp:e.phone?wa(e.phone,`Hello ${e.name}, this is ${h.name}. You can finish your booking here: ${link}`):null,note:e.email&&!e.consent?'No email was sent because the guest did not agree to follow-up emails.':undefined})}));
 // ================= approvals =================
 api.post('/payments/:id/refund',auth,fin,wrap(async(q,s)=>{if((await feat(q,'approvals'))&&q.role!=='owner'){await D.Approval.create({hotel:q.hotelId,action:'refund',payload:{payment:q.params.id,amount:+q.body.amount||0},requestedBy:q.user.id});
   await audit(q,'approval.requested','Payment',q.params.id);tellOwner(q.hotelId,'Refund needs your approval',['Open Integrations and approvals in your dashboard to decide.']);return s.status(202).json({pending:true,message:'Sent to the owner for approval'})}
  const e=await doRefund(q.hotelId,q.params.id,q.body.amount,q.user.id);e?s.status(409).json({error:e}):s.json({ok:true})}));
 api.get('/approvals',auth,need('owner'),wrap(async(q,s)=>s.json(await D.Approval.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(50).populate('requestedBy','name'))));
 api.post('/approvals/:id/:act(approve|reject)',auth,need('owner'),wrap(async(q,s)=>{const a=await D.Approval.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId,status:'pending'},{status:q.params.act==='approve'?'approved':'rejected',decidedBy:q.user.id,decidedAt:new Date()});if(!a)return s.status(409).json({error:'Already decided'});
  if(q.params.act==='approve'){const e=await doRefund(q.hotelId,a.payload.payment,a.payload.amount,q.user.id);if(e)return s.status(409).json({error:e})}await audit(q,'approval.'+q.params.act,'Approval',a.id);s.json({ok:true})}));
 // ================= API keys, public API v1, outgoing webhooks =================
 api.post('/api-keys',auth,need('owner'),gate('api'),wrap(async(q,s)=>{const key='kk_live_'+hex(24);await D.ApiKey.create({hotel:q.hotelId,name:String(q.body.name||'Key').slice(0,40),prefix:key.slice(0,12),hash:sha(key)});s.status(201).json({key,note:'Copy this now. It is shown only once.'})}));
 api.get('/api-keys',auth,need('owner'),wrap(async(q,s)=>s.json(await D.ApiKey.find({hotel:q.hotelId}).select('-hash'))));
 api.delete('/api-keys/:id',auth,need('owner'),wrap(async(q,s)=>{await D.ApiKey.updateOne({_id:q.params.id,hotel:q.hotelId},{active:false});s.json({ok:true})}));
 const keyAuth=wrap(async(q,s,n)=>{const k=String(q.get('authorization')||'').replace(/^Bearer /,'')||q.get('x-api-key'),a=k&&await D.ApiKey.findOne({hash:sha(k),active:true});if(!a)return s.status(401).json({error:'Invalid API key'});
  if(!(await bill.entitlements(a.hotel)).plan.features.includes('api'))return s.status(402).json({error:'API access is not included in this hotel\'s plan'});q.hotelId=a.hotel;D.ApiKey.updateOne({_id:a._id},{lastUsed:new Date()}).catch(()=>{});n()});
 api.get('/v1/reservations',keyAuth,wrap(async(q,s)=>{const p=Math.max(1,+q.query.page||1),f={hotel:q.hotelId};if(q.query.status)f.status=String(q.query.status);if(q.query.from)f.checkIn={$gte:new Date(q.query.from)};
  s.json({page:p,items:await D.Reservation.find(f).sort({checkIn:-1}).skip((p-1)*50).limit(50).select('reference status paymentStatus checkIn checkOut qty total paid currency source roomType branch guest.name')})}));
 api.get('/v1/availability',keyAuth,wrap(async(q,s)=>{const {checkIn,checkOut}=parse(z.object({checkIn:z.coerce.date(),checkOut:z.coerce.date()}),q.query);s.json(await Promise.all((await D.RoomType.find({hotel:q.hotelId,active:true}).limit(100)).map(async t=>({id:t.id,name:t.name,price:t.price,available:await inv.freeRooms(t._id,checkIn,checkOut)}))))}));
 const EVENTS=['reservation.created','reservation.confirmed','reservation.cancelled','reservation.checked_in','reservation.checked_out','reservation.no_show','payment.succeeded'];
 api.post('/webhooks',auth,need('owner'),gate('api'),wrap(async(q,s)=>{const b=parse(z.object({url:z.string().url(),events:z.array(z.enum(EVENTS)).min(1)}),q.body);try{await hooks.safeUrl(b.url)}catch(e){throw bad(e.message)}
  const secret='whsec_'+hex(20);await D.Webhook.create({...b,hotel:q.hotelId,secret});s.status(201).json({secret,note:'Use this secret to check the X-Keykonnec-Signature header (HMAC SHA-256 of the body). Shown only once.'})}));
 api.get('/webhooks',auth,need('owner'),wrap(async(q,s)=>s.json({endpoints:await D.Webhook.find({hotel:q.hotelId}).select('-secret'),deliveries:await D.Delivery.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(30),events:EVENTS})));
 api.delete('/webhooks/:id',auth,need('owner'),wrap(async(q,s)=>{await D.Webhook.deleteOne({_id:q.params.id,hotel:q.hotelId});s.json({ok:true})}));
 // ================= subscriptions: trial, cancel; custom domain =================
 api.post('/subscriptions/trial',auth,need('owner'),wrap(async(q,s)=>{const pl=await D.Plan.findOne({key:String(q.body.plan),active:true,trialDays:{$gt:0}});if(!pl)return s.status(400).json({error:'That plan has no free trial'});const now=new Date();
  const sub=await D.Subscription.findOneAndUpdate({hotel:q.hotelId,plan:'free',trialUsed:{$ne:true}},{plan:pl.key,status:'trialing',trialUsed:true,trialStart:now,trialEnd:new Date(+now+pl.trialDays*864e5),commissionRate:0,$push:{history:{plan:pl.key,rate:0,at:now}}},{new:true});
  if(!sub)return s.status(409).json({error:'Your free trial has already been used, or you are on a paid plan.'});bill.invalidate(q.hotelId);tellOwner(q.hotelId,`Your ${pl.name} trial has started`,[`You have ${pl.trialDays} days. No platform commission is charged during the trial.`]);s.json(sub)}));
 api.post('/subscriptions/cancel',auth,need('owner'),wrap(async(q,s)=>{const u=await D.Subscription.updateOne({hotel:q.hotelId,status:'active',plan:{$ne:'free'}},{cancelRequestedAt:new Date()});if(!u.modifiedCount)return s.status(409).json({error:'No paid plan to cancel'});
  bill.invalidate(q.hotelId);tellOwner(q.hotelId,'Cancellation noted',['Your plan stays active until the end of the paid period, then moves to Free. Your data is kept.']);s.json({ok:true})}));
 api.post('/hotel/domain',auth,need('owner'),gate('domain'),wrap(async(q,s)=>{const d=z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i).parse(String(q.body.domain||'').toLowerCase());if(await D.Hotel.exists({customDomain:d,_id:{$ne:q.hotelId}}))return s.status(409).json({error:'That domain is already in use'});
  const h=await D.Hotel.findByIdAndUpdate(q.hotelId,{customDomain:d,domainToken:hex(10),domainVerified:false},{new:true});s.json({domain:d,txtName:'_keykonnec.'+d,txtValue:'keykonnec-verify='+h.domainToken,cname:process.env.CNAME_TARGET||'(set CNAME_TARGET)'})}));
 api.post('/hotel/domain/verify',auth,need('owner'),gate('domain'),wrap(async(q,s)=>{const h=await D.Hotel.findById(q.hotelId);if(!h.customDomain)return s.status(400).json({error:'Add a domain first'});let ok=false;
  try{ok=(await dns.resolveTxt('_keykonnec.'+h.customDomain)).some(r=>r.join('')==='keykonnec-verify='+h.domainToken)}catch{}
  if(!ok)return s.status(409).json({error:'We could not find the DNS record yet. It can take a while to appear.'});h.domainVerified=true;await h.save();s.json({ok:true})}));
 // ================= platform admin extras =================
 api.get('/admin/subscriptions',...admin,wrap(async(q,s)=>s.json({cancellations:await D.Subscription.countDocuments({cancelRequestedAt:{$exists:true}}),trialing:await D.Subscription.find({status:'trialing'}).sort({trialEnd:1}).limit(50).lean(),renewing:await D.Subscription.find({status:'active',plan:{$ne:'free'},periodEnd:{$lt:new Date(Date.now()+7*864e5)}}).limit(50).lean(),payments:await D.SubPayment.find().sort({createdAt:-1}).limit(100).lean()})));
 api.get('/admin/hotels/:id',...admin,wrap(async(q,s)=>{const id=q.params.id,[branches,rooms,reservations]=await Promise.all([D.Branch.countDocuments({hotel:id}),D.Room.countDocuments({hotel:id}),D.Reservation.countDocuments({hotel:id})]);await D.Audit.create({user:q.user.id,hotel:id,action:'admin.view-hotel',entity:'Hotel',entityId:id});s.json({branches,rooms,reservations,subscription:await D.Subscription.findOne({hotel:id})})}));
};
exports.jobs=()=>{
 cron.schedule('*/5 * * * *',async()=>{const cache={};// lapsed online checkouts become 'expired'; Professional hotels also get a recovery lead
  for(const h of await D.Hold.find({status:'expired',reservation:{$ne:null},updatedAt:{$gt:new Date(Date.now()-2*864e5)}}).limit(200)){
   const r=await D.Reservation.findOneAndUpdate({_id:h.reservation,status:'pending',abandonLogged:{$ne:true}},{status:'expired',abandonLogged:true});if(!r)continue;
   const P=cache[r.hotel]||(cache[r.hotel]=(await bill.entitlements(r.hotel)).plan.features);
   if(P.includes('recovery')){await D.Enquiry.create({hotel:r.hotel,branch:r.branch,name:r.guest.name,phone:r.guest.phone,email:r.guest.email,roomType:r.roomType,checkIn:r.checkIn,checkOut:r.checkOut,source:'abandoned',consent:!!r.marketingConsent,token:hex(12)});tellOwner(r.hotel,'A guest did not finish booking',[`${r.guest.name}, ${day(r.checkIn)} to ${day(r.checkOut)}`,'See Enquiries to follow up.'])}}});
 cron.schedule('0 * * * *',async()=>{const now=new Date(),free=await D.Plan.findOne({key:'free'});
  for(const sub of await D.Subscription.find({status:'trialing',trialEnd:{$lt:now}}).limit(500)){await D.Subscription.updateOne({_id:sub._id},{plan:'free',status:'active',commissionRate:free.commissionRate,$push:{history:{plan:'free',rate:free.commissionRate,at:now}}});bill.invalidate(sub.hotel);tellOwner(sub.hotel,'Your free trial has ended',['You are now on the Free plan. Your rooms and bookings are safe. Upgrade any time from Settings.'])}
  for(const sub of await D.Subscription.find({status:'trialing',trialEnd:{$gt:now}}).limit(500)){const d=Math.floor((now-sub.trialStart)/864e5)+1;
   for(const [n,line] of [[3,'Finish setting up your rooms and publish your booking page.'],[7,'You are halfway through your trial. Check your bookings and reports.'],[12,'Your trial ends in 2 days. Choose a plan to keep your features.']])
    if(d>=n&&!sub.reminders.includes(n)){if(n!==3||!await D.RoomType.exists({hotel:sub.hotel}))tellOwner(sub.hotel,'Your keykonnec trial',[line]);await D.Subscription.updateOne({_id:sub._id},{$push:{reminders:n}})}}});
 cron.schedule('0 8 * * *',async()=>{const now=new Date();// payment due dates: remind guests about balances due within 2 days
  for(const r of await D.Reservation.find({status:'confirmed',paymentStatus:'partial',balanceReminded:{$ne:true},balanceDue:{$gte:now,$lt:new Date(+now+2*864e5)}}).limit(500)){
   if(r.guest.email){const h=await D.Hotel.findById(r.hotel),m=E.guestBalance({hotel:h,r});mail.send(r.guest.email,m.subject,m.html,r.hotel)}
   notify.guest(r,'balance',[r.guest.name,(await D.Hotel.findById(r.hotel)).name,r.reference,String(r.total-r.paid),day(r.balanceDue)]);await D.Reservation.updateOne({_id:r._id},{balanceReminded:true})}});
};
