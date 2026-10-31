require('dotenv').config();const compression=require('compression');
const express=require('express'),mongoose=require('mongoose'),cors=require('cors'),helmet=require('helmet'),cookie=require('cookie-parser'),rate=require('express-rate-limit'),cron=require('node-cron');
const {z}=require('zod'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),crypto=require('crypto');
const D=require('./models'),inv=require('./inventory'),bill=require('./billing'),mail=require('./mail'),hooks=require('./hooks'),extra=require('./extra'),extra2=require('./extra2'),extra3=require('./extra3'),extra4=require('./extra4'),extra5=require('./extra5');
const app=express(),api=express.Router(),wrap=f=>(q,s,n)=>f(q,s,n).catch(n);
app.use(helmet());app.use(compression());app.use(require('./cors'));app.use(cookie());
// Webhook needs the raw body for signature verification.
app.post('/api/payments/webhook',express.raw({type:'application/json'}),wrap(async(q,s)=>{
 if(!bill.validSignature(q.body,q.headers['x-paystack-signature']))return s.sendStatus(401);
 const e=JSON.parse(q.body);await extra.webhook(e);s.sendStatus(200)}));
app.get('/api/whatsapp/webhook',extra3.waVerify);app.post('/api/whatsapp/webhook',express.raw({type:'application/json'}),extra3.waEvents);
app.use(express.json({limit:'100kb'}));app.use('/api',(q,s,n)=>q.method==='GET'||q.get('x-requested-with')==='keykonnec'?n():s.status(403).json({error:'Blocked request'}));app.use('/api',(q,s,n)=>{s.set('Cache-Control','private, no-cache');n()});// authenticated and tenant data is never shared-cacheable; public routes opt in below
app.use('/api',rate({windowMs:60000,limit:120}),api);
const seedPlans=require('./plans').seed;
const sign=(res,u)=>res.cookie('t',jwt.sign({id:u.id},process.env.JWT_SECRET,{expiresIn:'7d'}),{httpOnly:true,sameSite:process.env.NODE_ENV==='production'?'none':'lax',secure:process.env.NODE_ENV==='production',maxAge:6048e5});
// Auth + tenant: hotel/branch always come from the user's membership, never from the client.
const auth=wrap(async(q,s,n)=>{try{q.user=await D.User.findById(jwt.verify(q.cookies.t,process.env.JWT_SECRET).id)}catch{}
 if(!q.user||q.user.status!=='active')return s.status(401).json({error:'Unauthenticated'});const m=q.user.memberships[0];q.hotelId=m&&m.hotel;q.role=m?m.role:q.user.role;
 if(m){const h=await D.Hotel.findById(m.hotel).select('status').lean();if(!h||h.status!=='active')return s.status(403).json({error:'This hotel account is suspended. Contact keykonnec support.'})}n()});
const need=(...r)=>(q,s,n)=>r.includes(q.role)?n():s.status(403).json({error:'Forbidden'});
const admin=[auth,(q,s,n)=>q.user.role==='admin'?n():s.status(403).json({error:'Forbidden'})];
const audit=(q,action,entity,entityId,detail)=>D.Audit.create({user:q.user.id,hotel:q.hotelId,action,entity,entityId,detail});
const parse=(sch,b)=>sch.parse(b);
// ---- auth
api.post('/auth/register',wrap(async(q,s)=>{const b=parse(z.object({name:z.string().min(2),email:z.string().email(),password:z.string().min(8),hotelName:z.string().min(2),phone:z.string().min(7).max(20),address:z.string().min(5).max(200),plan:z.string().optional()}),q.body);
 if(await D.User.exists({email:b.email}))return s.status(409).json({error:'Email already registered'});
 const slug=b.hotelName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'-'+crypto.randomBytes(2).toString('hex');
 const h=await D.Hotel.create({name:b.hotelName,slug,phone:b.phone,address:b.address}),br=await D.Branch.create({hotel:h.id,name:'Main branch'}),now=new Date();
 await extra.initialSub(h.id,b.plan);
 const u=await D.User.create({name:b.name,email:b.email,passwordHash:await bcrypt.hash(b.password,12),role:'owner',emailVerified:false,memberships:[{hotel:h.id,branches:[br.id],role:'owner'}]});
 mail.send(u.email,'Welcome to keykonnec',mail.tpl('Welcome to keykonnec',[`Hi ${b.name.split(' ')[0]}, your hotel ${h.name} is set up. Here is how to start taking bookings:`,['1','Verify your email (we sent a separate message)'],['2','Add your room types, photos and individual rooms'],['3','Add your bank account in Settings so online payments reach you'],['4','Publish your website and share your booking page'],{button:['Open your dashboard',process.env.CLIENT_URL+'/dashboard']},`Your public booking page will be: ${process.env.CLIENT_URL}/h/${slug}`],{badge:['Welcome aboard','green']}),h.id);await extra.sendVerify(u);s.status(201).json({needsVerification:true})}));
api.post('/auth/login',rate({windowMs:9e5,limit:20}),wrap(async(q,s)=>{const u=await D.User.findOne({email:String(q.body.email).toLowerCase()});
 if(!u||!await bcrypt.compare(String(q.body.password),u.passwordHash))return s.status(401).json({error:'Wrong email or password'});if(u.status!=='active')return s.status(403).json({error:'This account is disabled'});if(!u.emailVerified)return s.status(403).json({error:'Please verify your email first. Check your inbox.',needsVerification:true});sign(s,u);s.json({user:{id:u.id,name:u.name,role:u.role}})}));
api.get('/auth/me',auth,(q,s)=>s.json({user:{id:q.user.id,name:q.user.name,role:q.role}}));
api.post('/auth/logout',(q,s)=>s.clearCookie('t').json({ok:true}));
// ---- hotel setup (limits enforced server-side)
api.get('/hotel',auth,wrap(async(q,s)=>{const [h,e,b]=await Promise.all([D.Hotel.findById(q.hotelId).select('-payout.subaccountCode -icalToken -website.draft -website.published'),bill.entitlements(q.hotelId),D.Branch.find({hotel:q.hotelId})]);s.json({hotel:h,subscription:e.sub,plan:e.plan,branches:b})}));

api.post('/rooms',auth,need('owner','manager'),wrap(async(q,s)=>{const b=parse(z.object({roomType:z.string(),number:z.string()}),q.body);
 const rt=await D.RoomType.findOne({_id:b.roomType,hotel:q.hotelId});if(!rt)return s.status(404).json({error:'Room type not found'});
 const {plan}=await bill.entitlements(q.hotelId);if(plan.rooms&&await D.Room.countDocuments({hotel:q.hotelId,active:true})>=plan.rooms)return s.status(402).json({error:`Your ${plan.name} plan allows ${plan.rooms} rooms. Upgrade to add more.`});
 try{s.status(201).json(await D.Room.create({hotel:q.hotelId,branch:rt.branch,roomType:rt.id,number:b.number.trim()}))}catch(e){if(e.code===11000)return s.status(409).json({error:`Room number ${b.number.trim()} already exists. Use a different number.`});throw e}}));
api.patch('/rooms/:id/status',auth,need('owner','manager','receptionist'),wrap(async(q,s)=>{const r=await D.Room.findOneAndUpdate({_id:q.params.id,hotel:q.hotelId},{status:z.enum(['vacant','occupied','cleaning','maintenance','out_of_service']).parse(q.body.status)},{new:true});
 if(!r)return s.sendStatus(404);await audit(q,'room.status','Room',r.id,{status:r.status});s.json(r)}));
// ---- reservations (dashboard)

const move=(to,from)=>[auth,wrap(async(q,s)=>{const r=await D.Reservation.findOne({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}});if(!r)return s.sendStatus(404);
 if(!from.includes(r.status))return s.status(409).json({error:`Cannot do this while ${r.status}`});if(to==='checked_in'&&r.checkIn>new Date(Date.now()+36e5))return s.status(409).json({error:`Check-in opens on the arrival date (${r.checkIn.toISOString().slice(0,10)}). Change the dates with Modify if the guest is arriving early.`});if(to==='no_show'&&r.checkIn>new Date())return s.status(409).json({error:'A no-show can be recorded once the arrival date has started'});if(to==='cancelled'&&r.paid>0&&q.role!=='owner'&&(await bill.entitlements(q.hotelId)).plan.features.includes('approvals')){await extra3.requestApproval(q,'cancel',{reservation:r.id});return s.status(202).json({pending:true,message:'Sent to the owner for approval'})}
 if(['cancelled','no_show'].includes(to)){const h=await D.Hold.findOne({reservation:r.id,status:'converted'});if(h){await inv.release(r.roomType,inv.nightsOf(r.checkIn,r.checkOut),r.qty);h.status='released';await h.save()}}
 if(to==='checked_in')r.assignedRooms=await inv.assignRooms({...r.toObject(),status:'confirmed'});if(['cancelled','no_show'].includes(to))r.assignedRooms=[];
 r.status=to;await r.save();if(to==='checked_in')await D.Room.updateMany({_id:{$in:r.assignedRooms}},{status:'occupied'});if(to==='checked_out')await D.Room.updateMany({_id:{$in:r.assignedRooms}},{status:'cleaning',housekeeping:'dirty'});if(to==='checked_out')await bill.commissionFor(r);if(to==='cancelled'&&r.guest.email){const [hh,tt]=await Promise.all([D.Hotel.findById(r.hotel).lean(),D.RoomType.findById(r.roomType).lean()]),m=require('./emails').guestCancelled({hotel:hh,r,type:tt});mail.send(r.guest.email,m.subject,m.html,r.hotel)}await audit(q,'reservation.'+to,'Reservation',r.id);hooks.emit(q.hotelId,'reservation.'+to,{reference:r.reference});s.json(r)})];
api.post('/reservations/:id/cancel',...move('cancelled',['pending','confirmed']));
api.post('/reservations/:id/check-in',...move('checked_in',['confirmed']));
api.post('/reservations/:id/check-out',...move('checked_out',['checked_in']));
api.post('/reservations/:id/no-show',...move('no_show',['confirmed']));
api.post('/reservations/:id/manual-payments',auth,need('owner','manager'),wrap(async(q,s)=>{const b=parse(z.object({amount:z.number().positive(),method:z.enum(['cash','bank_transfer','other']),note:z.string().optional()}),q.body);
 const r=await D.Reservation.findOne({_id:q.params.id,hotel:q.hotelId,branch:{$in:q.user.memberships[0].branches}});if(!r)return s.sendStatus(404);
 if(['cancelled','expired','no_show'].includes(r.status))return s.status(409).json({error:`Payments cannot be recorded on a ${r.status.replace('_',' ')} reservation`});
 const owing=Math.max(0,r.total-r.paid);if(owing<=0)return s.status(409).json({error:'This reservation is already paid in full.'});
 if(b.amount>owing)return s.status(409).json({error:`The balance is only ₦${owing.toLocaleString('en-NG')}. Enter that amount or less.`,owing});
 // The hotel recording the payment is the confirmation: it counts straight away, so no separate verify step is needed.
 const p=await D.Payment.create({hotel:r.hotel,branch:r.branch,reservation:r.id,amount:b.amount,currency:r.currency,source:'manual_external',method:b.method,note:b.note,reference:'MAN-'+crypto.randomBytes(5).toString('hex'),status:'success',verified:true,recordedBy:q.user.id});
 r.paid=r.paid+b.amount;r.paymentStatus=r.paid>=r.total?'paid':'partial';if(r.paid>=r.total)r.balanceDue=undefined;await r.save();
 await audit(q,'payment.manual','Payment',p.id,{amount:b.amount});hooks.emit(q.hotelId,'payment.succeeded',{reservation:r.reference,amount:b.amount});s.status(201).json({payment:p,reservation:{paid:r.paid,total:r.total,paymentStatus:r.paymentStatus,owing:Math.max(0,r.total-r.paid)}})}));
api.get('/reports/overview',auth,wrap(async(q,s)=>{const t=new Date();t.setUTCHours(0,0,0,0);const e=new Date(+t+864e5),h=q.hotelId;
 const [arrivals,departures,pending,paid]=await Promise.all([D.Reservation.countDocuments({hotel:h,checkIn:{$gte:t,$lt:e},status:'confirmed'}),D.Reservation.countDocuments({hotel:h,checkOut:{$gte:t,$lt:e},status:'checked_in'}),D.Reservation.countDocuments({hotel:h,paymentStatus:{$ne:'paid'},status:{$in:['pending','confirmed']}}),
 D.Payment.aggregate([{$match:{hotel:new mongoose.Types.ObjectId(h),status:'success',createdAt:{$gte:new Date(t.getUTCFullYear(),t.getUTCMonth(),1)}}},{$group:{_id:'$source',total:{$sum:'$amount'}}}])]);
 s.json({arrivals,departures,pending,monthPayments:paid})}));
// ---- public booking (no account needed)
const pub=wrap(async(q,s,n)=>{const h=await D.Hotel.findOne({slug:q.params.slug,status:'active'});if(!h)return s.sendStatus(404);q.h=h;n()});
api.get('/public/booking/:ref',wrap(async(q,s)=>{const r=await D.Reservation.findOne({reference:q.params.ref,manageToken:String(q.query.token)}).select('-manageToken -hotel');if(!r)return s.sendStatus(404);
 const p=await D.Payment.findOne({reservation:r.id,source:'platform',status:{$in:['pending','flagged','failed']},createdAt:{$gt:new Date(Date.now()-3*864e5)}}).sort({createdAt:-1});if(p){try{await bill.settle(p.reference,await bill.verify(p.reference))}catch{}}// server-side verify on return; also re-checks payments that were flagged or marked failed before the customer finished paying
 {const x=(await D.Reservation.findById(r.id).select('-manageToken')).toObject();x.hotel=await D.Hotel.findById(x.hotel).select('slug name phone address policies').lean();s.json(x)}}));
// ---- platform admin
api.get('/admin/plans',...admin,wrap(async(q,s)=>s.json(await D.Plan.find())));
api.patch('/admin/plans/:id',...admin,wrap(async(q,s)=>s.json(await D.Plan.findByIdAndUpdate(q.params.id,parse(z.object({price:z.number().min(0),commissionRate:z.number().min(0).max(1),rooms:z.number(),branches:z.number(),staff:z.number(),monthlyBookings:z.number(),trialDays:z.number().int().min(0).max(90),features:z.array(z.string())}).partial(),q.body),{new:true}))));
api.get('/admin/commissions',...admin,wrap(async(q,s)=>s.json(await D.Commission.find().sort({createdAt:-1}).limit(100))));
const ctx={api,auth,need,admin,audit,parse,wrap};extra5.mount(ctx);extra4.mount(ctx);extra3.mount(ctx);extra.mount(ctx);extra2.mount(ctx);extra.jobs();extra2.jobs();extra3.jobs();
app.use((e,q,s,n)=>{if(e.name==='ZodError')return s.status(400).json({error:'Invalid input',details:e.issues});if(e.status&&e.status<500)return s.status(e.status).json({error:e.message});console.error(e);s.status(500).json({error:'Something went wrong'})});
// ---- jobs: expire holds each minute; 
cron.schedule('* * * * *',()=>inv.expireHolds().catch(console.error));
mongoose.connect(process.env.MONGODB_URI,{maxPoolSize:+process.env.MONGO_POOL_SIZE||20,minPoolSize:2,serverSelectionTimeoutMS:8000,socketTimeoutMS:45000}).then(seedPlans).then(()=>{D.ensureIndexes()}).then(()=>app.listen(process.env.PORT||4000,()=>console.log('API ready')));
module.exports=app;
