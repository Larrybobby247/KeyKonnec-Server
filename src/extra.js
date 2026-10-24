const notify=require('./notify'),pricing=require('./pricing'),D=require('./models'),inv=require('./inventory'),bill=require('./billing'),mail=require('./mail');
const {z}=require('zod'),bcrypt=require('bcryptjs'),crypto=require('crypto'),mongoose=require('mongoose'),cron=require('node-cron'),rate=require('express-rate-limit');
const OID=x=>new mongoose.Types.ObjectId(String(x)),day=x=>new Date(x).toISOString().slice(0,10);
const ownerOf=h=>D.User.findOne({'memberships.hotel':h,'memberships.role':'owner'});
const tellOwner=async(h,subject,lines)=>{const u=await ownerOf(h);u&&mail.send(u.email,subject,mail.tpl(subject,lines),h)};
async function sendReset(u){const t=crypto.randomBytes(24).toString('hex');u.resetHash=crypto.createHash('sha256').update(t).digest('hex');u.resetExp=new Date(Date.now()+36e5);await u.save();
 mail.send(u.email,'Set your keykonnec password',mail.tpl('Set your password',['Use this link within one hour:',`${process.env.CLIENT_URL}/reset?token=${t}`]))}
const payStatus=r=>r.paid>=r.total?'paid':r.paid>0?'partial':'unpaid';
// Subscription payment: activates only after verified success with the exact plan price.
async function settleSub(ref,d){const sp=await D.SubPayment.findOneAndUpdate({reference:ref,status:'pending'},{status:'processing'});if(!sp)return;
 if(d.status!=='success'||d.amount!==Math.round(sp.amount*100)||d.currency!=='NGN'){await D.SubPayment.updateOne({_id:sp._id},{status:d.status==='success'?'flagged':'failed'});tellOwner(sp.hotel,'Subscription payment failed',['Your plan was not changed. Try again from Settings.']);return}
 const pl=await D.Plan.findOne({key:sp.plan}),now=new Date(),end=new Date(+now+({monthly:30,quarterly:90,yearly:365})[pl.interval||'monthly']*864e5);
 await D.Subscription.updateOne({hotel:sp.hotel},{$set:{plan:sp.plan,status:'active',periodEnd:end,commissionRate:pl.commissionRate,reminders:[],pendingPlan:null,cancelRequestedAt:null},$push:{history:{plan:sp.plan,rate:pl.commissionRate,at:now}}});
 await D.SubPayment.updateOne({_id:sp._id},{status:'success',method:d.channel,paidAt:d.paid_at?new Date(d.paid_at):now,gatewayId:String(d.id||''),receiptNo:'KKR-'+sp.reference.slice(4,12).toUpperCase()});bill.invalidate(sp.hotel);tellOwner(sp.hotel,'Subscription active',[`Your ${pl.name} plan is active until ${day(end)}.`])}
async function applyRefund(p,amt){await D.Payment.updateOne({_id:p._id},{$inc:{refundedAmount:amt}});
 if(p.status!=='success')return;const r=await D.Reservation.findById(p.reservation);if(!r)return;r.paid=Math.max(0,r.paid-amt);r.paymentStatus=payStatus(r);await r.save();
 await D.Commission.updateOne({reservation:r.id},{$push:{adjustments:{amount:-+(amt*(r.commissionRate||0)).toFixed(2),reason:'refund',at:new Date()}}})}
async function sendVerify(u){const t=crypto.randomBytes(24).toString('hex');u.verifyHash=crypto.createHash('sha256').update(t).digest('hex');u.verifyExp=new Date(Date.now()+2*864e5);await u.save();
 mail.send(u.email,'Verify your keykonnec email',mail.tpl('Verify your email',['Confirm your email to finish setting up your account:',`${process.env.CLIENT_URL}/verify?token=${t}`]))}
// Starter and Growth can start a free trial (length set per plan by the admin); everyone else starts on Free.
exports.initialSub=async(hotel,key)=>{const now=new Date(),f=await D.Plan.findOne({key:'free'}),pl=key&&key!=='free'?await D.Plan.findOne({key,active:true,trialDays:{$gt:0}}):null;
 if(pl)return D.Subscription.create({hotel,plan:pl.key,status:'trialing',trialUsed:true,trialStart:now,trialEnd:new Date(+now+pl.trialDays*864e5),commissionRate:0,history:[{plan:pl.key,rate:0,at:now}]});
 const pp=key&&key!=='free'?await D.Plan.findOne({key,active:true,price:{$gt:0}}):null;// a paid plan without a trial: the dashboard asks for payment straight away
 return D.Subscription.create({hotel,plan:'free',status:'active',pendingPlan:pp?pp.key:undefined,commissionRate:f.commissionRate,history:[{plan:'free',rate:f.commissionRate,at:now}]})};
exports.applyRefund=applyRefund;exports.sendVerify=sendVerify;
exports.webhook=async e=>{const d=e.data||{};
 if(e.event==='charge.success')return String(d.reference).startsWith('SUB-')?settleSub(d.reference,d):bill.settle(d.reference,d);
 if(e.event==='refund.processed'){const p=await D.Payment.findOneAndUpdate({reference:d.transaction_reference,refundStatus:'pending'},{refundStatus:'refunded'});if(p){await applyRefund(p,d.amount/100);const r=await D.Reservation.findById(p.reservation);r&&r.guest.email&&mail.send(r.guest.email,'Refund processed '+r.reference,mail.tpl('Your refund was processed',['Amount: '+d.amount/100,'It can take a few days to reach your account.']),r.hotel)}}
 if(e.event==='refund.failed')await D.Payment.updateOne({reference:d.transaction_reference,refundStatus:'pending'},{refundStatus:'failed'})};
exports.mount=({api,auth,need,admin,audit,parse,wrap})=>{
 const mb=q=>q.user.memberships[0].branches.map(String),can=(q,b)=>mb(q).includes(String(b)),feat=async(q,f)=>(await bill.entitlements(q.hotelId)).plan.features.includes(f);
 const deny=(s,f)=>s.status(402).json({error:`This is not included in your plan (${f}). Upgrade to use it.`});
 // ---- public
 api.get('/plans',wrap(async(q,s)=>{s.set('Cache-Control','public, max-age=300, stale-while-revalidate=600');s.json(await D.Plan.find({active:true}).select('-_id -__v').sort({price:1}).lean())}));
 api.post('/contact',rate({windowMs:36e5,limit:5}),wrap(async(q,s)=>{const b=parse(z.object({name:z.string().min(2),email:z.string().email(),message:z.string().min(10).max(2000)}),q.body);
  const st=await mail.send(process.env.CONTACT_TO,'keykonnec enquiry from '+b.name,mail.tpl('New enquiry',[`${b.name} <${b.email}>`,b.message]));
  st==='sent'?s.json({ok:true}):s.status(502).json({error:'Your message could not be sent. Please email us directly.'})}));

 api.post('/auth/verify',wrap(async(q,s)=>{const u=await D.User.findOne({verifyHash:crypto.createHash('sha256').update(String(q.body.token)).digest('hex'),verifyExp:{$gt:new Date()}});if(!u)return s.status(400).json({error:'This link has expired. Ask for a new one.'});
  u.emailVerified=true;u.verifyHash=undefined;u.verifyExp=undefined;await u.save();s.json({ok:true})}));
 api.post('/auth/resend-verification',rate({windowMs:36e5,limit:10}),wrap(async(q,s)=>{const u=await D.User.findOne({email:String(q.body.email||'').toLowerCase(),emailVerified:false});if(u)await sendVerify(u);s.json({ok:true})}));
 // ---- password reset
 api.post('/auth/forgot',rate({windowMs:36e5,limit:10}),wrap(async(q,s)=>{const u=await D.User.findOne({email:String(q.body.email||'').toLowerCase()});if(u&&u.status==='active')await sendReset(u);s.json({ok:true})}));
 api.post('/auth/reset',wrap(async(q,s)=>{const b=parse(z.object({token:z.string(),password:z.string().min(8)}),q.body);
  const u=await D.User.findOne({resetHash:crypto.createHash('sha256').update(b.token).digest('hex'),resetExp:{$gt:new Date()}});if(!u)return s.status(400).json({error:'This link has expired. Request a new one.'});
  u.passwordHash=await bcrypt.hash(b.password,12);u.resetHash=undefined;u.resetExp=undefined;u.emailVerified=true;await u.save();s.json({ok:true})}));
 // ---- hotel, branches, inventory
 api.post('/branches',auth,need('owner'),wrap(async(q,s)=>{const b=parse(z.object({name:z.string().min(2),address:z.string().optional()}),q.body);const {plan}=await bill.entitlements(q.hotelId);
  if(!plan.features.includes('multi_branch')||(plan.branches&&await D.Branch.countDocuments({hotel:q.hotelId})>=plan.branches))return deny(s,'more branches');
  const br=await D.Branch.create({...b,hotel:q.hotelId});await D.User.updateOne({_id:q.user.id,'memberships.hotel':q.hotelId},{$push:{'memberships.$.branches':br.id}});await audit(q,'branch.create','Branch',br.id);s.status(201).json(br)}));
 api.get('/inventory',auth,wrap(async(q,s)=>{const f={hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}};if(q.query.branch&&can(q,q.query.branch))f.branch=q.query.branch;
  const [types,rooms]=await Promise.all([D.RoomType.find(f).limit(200).lean(),D.Room.find(f).sort({number:1}).limit(500).lean()]);s.json({types,rooms})}));
 api.patch('/room-types/:id',auth,need('owner','manager'),wrap(async(q,s)=>{const b=parse(z.object({name:z.string(),price:z.number().min(0),capacity:z.number().int().min(1),amenities:z.array(z.string()),active:z.boolean(),minStay:z.number().int().min(0),maxStay:z.number().int().min(0),featured:z.boolean(),description:z.string().max(1000),addImage:z.string().url()}).partial(),q.body);
  const {addImage,...set}=b;const t=await D.RoomType.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}},{$set:set,...(addImage?{$push:{images:addImage}}:{})},{new:true});if(!t)return s.sendStatus(404);await audit(q,'roomtype.update','RoomType',t.id,set);s.json(t)}));
 api.get('/uploads/sign',auth,need('owner','manager'),(q,s)=>{const p={folder:'hotels/'+q.hotelId,timestamp:Math.floor(Date.now()/1e3)},c=process.env;
  s.json({...p,cloudName:c.CLOUDINARY_CLOUD_NAME,apiKey:c.CLOUDINARY_API_KEY,signature:crypto.createHash('sha1').update(`folder=${p.folder}&timestamp=${p.timestamp}${c.CLOUDINARY_API_SECRET}`).digest('hex')})});
 // ---- reservations: manual entry, confirm, modify
 api.post('/reservations',auth,wrap(async(q,s)=>{const b=parse(z.object({roomType:z.string(),checkIn:z.coerce.date(),checkOut:z.coerce.date(),adults:z.number().int().min(1),qty:z.number().int().min(1).max(10).default(1),source:z.enum(['phone','walk_in','whatsapp']),notes:z.string().optional(),guest:z.object({name:z.string().min(2),phone:z.string().min(7),email:z.string().email().optional().or(z.literal(''))})}),q.body);
  const t=await D.RoomType.findOne({_id:b.roomType,hotel:q.hotelId});if(!t||!can(q,t.branch)||b.checkOut<=b.checkIn)return s.status(400).json({error:'Invalid request'});
  const {plan}=await bill.entitlements(q.hotelId);if(plan.monthlyBookings){const m=new Date();m.setUTCDate(1);m.setUTCHours(0,0,0,0);if(await D.Reservation.countDocuments({hotel:q.hotelId,createdAt:{$gte:m}})>=plan.monthlyBookings)return deny(s,`${plan.monthlyBookings} bookings a month`)}
  try{await inv.reserve(t._id,b.checkIn,b.checkOut,b.qty)}catch(e){return e.message==='SOLD_OUT'?s.status(409).json({error:'No rooms left for those dates.'}):Promise.reject(e)}
  const h=await D.Hotel.findById(q.hotelId),k=await pricing.quote({hotel:h,plan,type:t,checkIn:b.checkIn,checkOut:b.checkOut,qty:b.qty,manual:true});
  const r=await D.Reservation.create({hotel:q.hotelId,branch:t.branch,roomType:t.id,guest:b.guest,checkIn:b.checkIn,checkOut:b.checkOut,adults:b.adults,qty:b.qty,accommodation:k.accommodation,tax:k.tax,total:k.total,currency:h.currency,source:b.source,notes:b.notes,status:'confirmed',reference:'KK-'+crypto.randomBytes(4).toString('hex').toUpperCase(),manageToken:crypto.randomBytes(24).toString('hex'),commissionRate:0});// externally booked: no platform commission
  await D.Hold.create({hotel:q.hotelId,branch:t.branch,roomType:t.id,checkIn:b.checkIn,checkOut:b.checkOut,qty:b.qty,expiresAt:new Date('2999-01-01'),status:'converted',reservation:r.id});await audit(q,'reservation.manual','Reservation',r.id);s.status(201).json(r)}));
 api.post('/reservations/:id/confirm',auth,wrap(async(q,s)=>{const r=await D.Reservation.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches},status:'requested'},{status:'confirmed'},{new:true});if(!r)return s.status(409).json({error:'Only booking requests can be confirmed'});
  await audit(q,'reservation.confirm','Reservation',r.id);r.guest.email&&mail.send(r.guest.email,'Booking confirmed '+r.reference,mail.tpl('Your booking is confirmed',['Reference: '+r.reference,`Check-in ${day(r.checkIn)}, check-out ${day(r.checkOut)}`]),r.hotel);s.json(r)}));
 // ---- payments, refunds
 const fin=need('owner','manager','accountant');
 api.get('/payments',auth,fin,wrap(async(q,s)=>{const p=Math.max(1,+q.query.page||1),f={hotel:q.hotelId};s.json({items:await D.Payment.find(f).sort({createdAt:-1}).skip((p-1)*30).limit(30).populate('reservation','reference guest.name').lean(),total:await D.Payment.countDocuments(f)})}));
 api.post('/payments/:id/verify',auth,fin,wrap(async(q,s)=>{const p=await D.Payment.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId,source:'manual_external',verified:false,status:'success'},{verified:true});if(!p)return s.status(409).json({error:'Nothing to verify'});
  const r=await D.Reservation.findById(p.reservation);r.paid+=p.amount;r.paymentStatus=payStatus(r);await r.save();await audit(q,'payment.verify','Payment',p.id);s.json({ok:true})}));
 
 // ---- staff (limits and branch scope enforced here)
 const ROLES=['manager','receptionist','accountant'];
 api.get('/staff',auth,need('owner'),wrap(async(q,s)=>s.json(await D.User.find({'memberships.hotel':q.hotelId}).select('name email status memberships').limit(50).lean())));
 api.post('/staff',auth,need('owner'),wrap(async(q,s)=>{const b=parse(z.object({name:z.string().min(2),email:z.string().email(),role:z.enum(ROLES),branches:z.array(z.string()).min(1)}),q.body);const {plan}=await bill.entitlements(q.hotelId);
  if(await D.User.countDocuments({'memberships.hotel':q.hotelId})>=plan.staff)return deny(s,`${plan.staff} staff accounts including the owner`);
  if(!b.branches.every(x=>can(q,x)))return s.status(403).json({error:'No access to that branch'});if(await D.User.exists({email:b.email.toLowerCase()}))return s.status(409).json({error:'That email already has an account'});
  const u=await D.User.create({name:b.name,email:b.email,passwordHash:await bcrypt.hash(crypto.randomBytes(16).toString('hex'),12),role:'staff',memberships:[{hotel:q.hotelId,branches:b.branches,role:b.role}]});await sendReset(u);await audit(q,'staff.create','User',u.id,{role:b.role});s.status(201).json({id:u.id})}));
 api.patch('/staff/:id',auth,need('owner'),wrap(async(q,s)=>{const b=parse(z.object({status:z.enum(['active','disabled']),role:z.enum(ROLES),branches:z.array(z.string()).min(1)}).partial(),q.body);const u=await D.User.findOne({_id:q.params.id,'memberships.hotel':q.hotelId,role:'staff'});if(!u)return s.sendStatus(404);
  if(b.status)u.status=b.status;if(b.role)u.memberships[0].role=b.role;if(b.branches){if(!b.branches.every(x=>can(q,x)))return s.sendStatus(403);u.memberships[0].branches=b.branches}await u.save();await audit(q,'staff.update','User',u.id,b);s.json({ok:true})}));
 api.get('/guests',auth,need('owner','manager','receptionist'),wrap(async(q,s)=>{const m={hotel:OID(q.hotelId),branch:{$in:q.user.memberships[0].branches},'guest.email':{$nin:[null,'']}};
  if(q.query.q)m['guest.name']=new RegExp(String(q.query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  s.json(await D.Reservation.aggregate([{$match:m},{$group:{_id:'$guest.email',name:{$last:'$guest.name'},phone:{$last:'$guest.phone'},stays:{$sum:1},spent:{$sum:'$paid'},last:{$max:'$checkIn'}}},{$sort:{last:-1}},{$limit:50}]))}));
 // ---- housekeeping and maintenance (Professional)
 api.get('/tasks',auth,wrap(async(q,s)=>{if(!await feat(q,'housekeeping'))return deny(s,'housekeeping');s.json(await D.Task.find({hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches},status:{$ne:'done'}}).sort({createdAt:-1}).limit(100).populate('room','number').lean())}));
 api.post('/tasks',auth,need('owner','manager','receptionist'),wrap(async(q,s)=>{if(!await feat(q,'housekeeping'))return deny(s,'housekeeping');const b=parse(z.object({room:z.string(),type:z.enum(['cleaning','maintenance']),note:z.string().optional()}),q.body);
  const r=await D.Room.findOne({_id:b.room,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}});if(!r)return s.sendStatus(404);
  await D.Room.updateOne({_id:r._id},{status:b.type==='cleaning'?'cleaning':'maintenance'});// maintenance removes the room from bookable inventory
  s.status(201).json(await D.Task.create({hotel:q.hotelId,branch:r.branch,room:r.id,...b}))}));
 api.patch('/tasks/:id',auth,wrap(async(q,s)=>{const st=z.enum(['open','in_progress','done']).parse(q.body.status),t=await D.Task.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}},{status:st},{new:true});if(!t)return s.sendStatus(404);
  if(st==='done')await D.Room.updateOne({_id:t.room},{status:'vacant'});await audit(q,'task.'+st,'Task',t.id);s.json(t)}));
 // ---- reports
 api.get('/reports/finance',auth,fin,wrap(async(q,s)=>{const H=OID(q.hotelId);const [pay,out,com]=await Promise.all([
  D.Payment.aggregate([{$match:{hotel:H,status:'success'}},{$group:{_id:{source:'$source',verified:'$verified'},total:{$sum:'$amount'},refunded:{$sum:'$refundedAmount'}}}]),
  D.Reservation.aggregate([{$match:{hotel:H,status:{$in:['pending','requested','confirmed','checked_in']}}},{$group:{_id:null,t:{$sum:{$subtract:['$total','$paid']}}}}]),
  D.Commission.aggregate([{$match:{hotel:H}},{$group:{_id:'$status',amount:{$sum:'$amount'}}}])]);s.json({payments:pay,outstanding:out[0]?.t||0,commissions:com})}));
 api.get('/reports/occupancy',auth,wrap(async(q,s)=>{const from=q.query.from?new Date(q.query.from):new Date();from.setUTCHours(0,0,0,0);const to=new Date(+from+14*864e5);
  const ids=(await D.RoomType.find({hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}}).select('_id')).map(t=>t._id),rooms=await D.Room.countDocuments({roomType:{$in:ids},active:true});
  s.json({rooms,rows:await D.Night.aggregate([{$match:{roomType:{$in:ids},date:{$gte:from,$lt:to}}},{$group:{_id:'$date',used:{$sum:'$used'}}},{$sort:{_id:1}}])})}));
 api.get('/reports/analytics',auth,need('owner','manager','accountant'),wrap(async(q,s)=>{if(!await feat(q,'reports_plus'))return deny(s,'enhanced reports');
  const [x]=await D.Reservation.aggregate([{$match:{hotel:OID(q.hotelId)}},{$facet:{
   byType:[{$match:{status:{$ne:'cancelled'}}},{$group:{_id:'$roomType',revenue:{$sum:'$paid'},bookings:{$sum:1}}}],
   bySource:[{$group:{_id:'$source',bookings:{$sum:1},revenue:{$sum:'$paid'}}}],
   byBranch:[{$group:{_id:'$branch',bookings:{$sum:1},revenue:{$sum:'$paid'}}}],
   totals:[{$group:{_id:null,n:{$sum:1},cancelled:{$sum:{$cond:[{$eq:['$status','cancelled']},1,0]}},value:{$sum:'$total'},nights:{$sum:{$divide:[{$subtract:['$checkOut','$checkIn']},864e5]}}}}]}}]);
  const [ts,bs]=await Promise.all([D.RoomType.find({hotel:q.hotelId}),D.Branch.find({hotel:q.hotelId})]),nm=(l,id)=>(l.find(a=>String(a._id)===String(id))||{}).name||'Unknown',t=x.totals[0]||{n:0,cancelled:0,value:0,nights:0};
  s.json({byType:x.byType.map(a=>({...a,name:nm(ts,a._id)})),bySource:x.bySource,byBranch:x.byBranch.map(a=>({...a,name:nm(bs,a._id)})),cancelRate:t.n?t.cancelled/t.n:0,avgValue:t.n?t.value/t.n:0,avgStay:t.n?t.nights/t.n:0})}));
 api.get('/reports/export.csv',auth,fin,wrap(async(q,s)=>{if(!await feat(q,'exports'))return deny(s,'exports');const rows=await D.Reservation.find({hotel:q.hotelId}).sort({createdAt:-1}).limit(5000).lean();
  const c=v=>'"'+String(v??'').replace(/"/g,'""')+'"';s.type('text/csv').send(['reference,guest,check_in,check_out,status,source,total,paid'].concat(rows.map(r=>[r.reference,r.guest.name,day(r.checkIn),day(r.checkOut),r.status,r.source,r.total,r.paid].map(c).join(','))).join('\n'))}));
 // ---- subscriptions
 api.get('/subscriptions/current',auth,wrap(async(q,s)=>{const e=await bill.entitlements(q.hotelId);s.json({subscription:e.sub,plan:e.plan})}));
 api.post('/subscriptions/checkout',auth,need('owner'),wrap(async(q,s)=>{const pl=await D.Plan.findOne({key:String(q.body.plan),active:true});if(!pl||!pl.price)return s.status(400).json({error:'Choose a paid plan'});
  const ref='SUB-'+crypto.randomBytes(8).toString('hex');await D.SubPayment.create({hotel:q.hotelId,plan:pl.key,amount:pl.price,reference:ref});
  const init=await bill.initialize(q.user.email,pl.price,ref,`${process.env.CLIENT_URL}/billing/return?reference=${ref}`);s.json({checkoutUrl:init.authorization_url})}));
 api.get('/subscriptions/verify/:ref',auth,need('owner'),wrap(async(q,s)=>{const sp=await D.SubPayment.findOne({reference:q.params.ref,hotel:q.hotelId});if(!sp)return s.sendStatus(404);
  if(sp.status==='pending')await settleSub(sp.reference,await bill.verify(sp.reference));s.json(await D.SubPayment.findById(sp.id))}));// never trust the browser redirect: verify with Paystack
 // ---- platform admin
 api.get('/admin/overview',...admin,wrap(async(q,s)=>{const [hotels,subs,rev,com,res,bad]=await Promise.all([D.Hotel.countDocuments(),D.Subscription.aggregate([{$group:{_id:{plan:'$plan',status:'$status'},n:{$sum:1}}}]),D.SubPayment.aggregate([{$match:{status:'success'}},{$group:{_id:null,t:{$sum:'$amount'}}}]),D.Commission.aggregate([{$group:{_id:'$status',t:{$sum:'$amount'}}}]),D.Reservation.countDocuments(),D.Payment.countDocuments({status:{$in:['failed','flagged','needs_refund']}})]);
  s.json({hotels,subs,subscriptionRevenue:rev[0]?.t||0,commission:com,reservations:res,paymentProblems:bad})}));
 api.get('/admin/hotels',...admin,wrap(async(q,s)=>{const f=q.query.q?{name:new RegExp(String(q.query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i')}:{};const hs=await D.Hotel.find(f).sort({createdAt:-1}).limit(50).lean(),subs=await D.Subscription.find({hotel:{$in:hs.map(h=>h._id)}}).lean();
  s.json(hs.map(h=>({...h,sub:subs.find(x=>String(x.hotel)===String(h._id))})))}));
 api.post('/admin/hotels/:id/:act(suspend|restore)',...admin,wrap(async(q,s)=>{const h=await D.Hotel.findByIdAndUpdate(q.params.id,{status:q.params.act==='suspend'?'suspended':'active'},{new:true});if(!h)return s.sendStatus(404);await D.Audit.create({user:q.user.id,hotel:h.id,action:'admin.'+q.params.act,entity:'Hotel',entityId:h.id});s.json(h)}));
 api.patch('/admin/commissions/:id',...admin,wrap(async(q,s)=>{const b=parse(z.object({status:z.enum(['due','settled','waived']).optional(),adjustment:z.object({amount:z.number(),reason:z.string().min(3)}).optional()}),q.body);
  const c=await D.Commission.findByIdAndUpdate(q.params.id,{...(b.status?{status:b.status}:{}),...(b.adjustment?{$push:{adjustments:{...b.adjustment,at:new Date()}}}:{})},{new:true});await D.Audit.create({user:q.user.id,hotel:c.hotel,action:'admin.commission',entity:'Commission',entityId:c.id,detail:b});s.json(c)}));
 api.get('/admin/payments',...admin,wrap(async(q,s)=>s.json(await D.Payment.find().sort({createdAt:-1}).limit(100).populate('reservation','reference'))));
};
exports.jobs=()=>{
 cron.schedule('0 * * * *',async()=>{const now=new Date();
  for(const sub of await D.Subscription.find({status:'active',plan:{$ne:'free'},periodEnd:{$lt:new Date(+now+3*864e5)}}).limit(500)){
   if(sub.periodEnd<now){const f=await D.Plan.findOne({key:'free'});await D.Subscription.updateOne({_id:sub._id},{plan:'free',commissionRate:f.commissionRate,$push:{history:{plan:'free',rate:f.commissionRate,at:now}}});bill.invalidate(sub.hotel);tellOwner(sub.hotel,'Subscription ended',['Your plan was not renewed, so you are on Free. Your data is kept. Renew from Settings.'])}
   else if(!sub.reminders.includes(99)&&!sub.cancelRequestedAt){tellOwner(sub.hotel,'Subscription renews soon',['Your plan ends on '+day(sub.periodEnd)+'. Renew from Settings to keep your features.']);await D.Subscription.updateOne({_id:sub._id},{$push:{reminders:99}})}}});
 cron.schedule('0 7 * * *',async()=>{const t=new Date();t.setUTCHours(0,0,0,0);
  for(const r of await D.Reservation.find({status:'confirmed',reminded:{$ne:true},checkIn:{$gte:new Date(+t+864e5),$lt:new Date(+t+2*864e5)}}).limit(500)){
   if(r.guest.email){const h=await D.Hotel.findById(r.hotel);mail.send(r.guest.email,'See you tomorrow, '+r.reference,mail.tpl('Your stay starts tomorrow',[h.name+(h.address?', '+h.address:''),'Reference: '+r.reference,'Contact the hotel: '+(h.phone||'see booking page')]),r.hotel)}
   notify.guest(r,'reminder',[r.guest.name,(await D.Hotel.findById(r.hotel)).name,day(r.checkIn),r.reference]);await D.Reservation.updateOne({_id:r._id},{reminded:true})}});
};
