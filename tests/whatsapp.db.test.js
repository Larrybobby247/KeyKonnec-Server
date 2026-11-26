// Database-backed WhatsApp tests (npm test downloads an in-memory MongoDB on first run). Meta is stubbed; nothing leaves the machine.
const {test,before,after}=require('node:test'),assert=require('node:assert'),mongoose=require('mongoose'),{MongoMemoryServer}=require('mongodb-memory-server');
process.env.WA_TOKEN_KEY='b'.repeat(64);process.env.API_URL='https://api.example.test';process.env.WHATSAPP_APP_SECRET='s';
const D=require('../src/models'),W=require('../src/whatsapp/models'),credits=require('../src/whatsapp/credits'),send=require('../src/whatsapp/send'),meta=require('../src/whatsapp/meta'),secret=require('../src/whatsapp/secret'),notify=require('../src/whatsapp/notify'),tools=require('../src/whatsapp/tools'),routes=require('../src/whatsapp/routes');
let mongo,sent=[];const oid=()=>new mongoose.Types.ObjectId();
before(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await Promise.all(Object.values(W).filter(x=>x.init).map(x=>x.init()));await Promise.all([D.Payment.init(),D.Reservation.init()]);
 let n=0;meta._test.setFetch(async(url,o)=>{const body=JSON.parse(o.body||'{}');sent.push({url,body});return{ok:true,status:200,json:async()=>({messages:[{id:'wamid.'+(++n)}]})}})});
after(async()=>{await mongoose.disconnect();await mongo.stop()});
const mkHotel=async(phone='1111')=>{const hotel=oid(),account=await W.WaAccount.create({hotel,phoneNumberId:phone,wabaId:'w'+phone,tokenEnc:secret.encrypt('tok'),status:'connected'});
 await W.WaWallet.create({hotel,periodKey:credits.periodKey(),allowance:5,granted:5});return{hotel,account}};
const mkConv=(h,waId='2348031234567',open=true)=>W.WaConversation.create({hotel:h.hotel,account:h.account._id,waId,lastInboundAt:open?new Date():new Date(Date.now()-48*36e5)});

test('credits: reserve, settle and release are each applied once',async()=>{
 const h=await mkHotel('c1'),c=await mkConv(h);const r1=await send.sendOne(h.account,c,{kind:'text',text:'hi'},{by:'bot'});assert.ok(r1.ok);
 let w=await W.WaWallet.findOne({hotel:h.hotel});assert.equal(w.reserved,1);assert.equal(credits.available(w),4);
 const st={id:r1.waId,status:'delivered'};await Promise.all([send.onStatus(st),send.onStatus(st),send.onStatus({id:r1.waId,status:'read'})]);
 w=await W.WaWallet.findOne({hotel:h.hotel});assert.equal(w.reserved,0);assert.equal(w.allowance,4);assert.equal(w.used,1);
 const r2=await send.sendOne(h.account,c,{kind:'text',text:'again'},{by:'bot'});await send.onStatus({id:r2.waId,status:'failed',errors:[{code:131026,title:'Undeliverable'}]});await send.onStatus({id:r2.waId,status:'failed'});
 w=await W.WaWallet.findOne({hotel:h.hotel});assert.equal(w.reserved,0);assert.equal(w.allowance,4);// released, not charged
});
test('credits: incoming messages never cost credits and the last credit cannot be taken twice',async()=>{
 const h=await mkHotel('c2');await W.WaWallet.updateOne({hotel:h.hotel},{allowance:1});const c=await mkConv(h);
 const rs=await Promise.all([send.sendOne(h.account,c,{kind:'text',text:'a'},{by:'bot'}),send.sendOne(h.account,c,{kind:'text',text:'b'},{by:'bot'})]);
 assert.equal(rs.filter(r=>r.ok).length,1);assert.ok(rs.some(r=>r.reason==='no_credits'));
 const staff=await send.sendOne(h.account,c,{kind:'text',text:'manual'},{by:'staff'});assert.ok(staff.ok);// staff replies still work with no credits
});
test('outside the 24h window only an approved template can go out',async()=>{
 const h=await mkHotel('c3'),c=await mkConv(h,'2348031234568',false);
 assert.equal((await send.sendOne(h.account,c,{kind:'text',text:'x'},{by:'bot'})).ok,false);
 assert.equal((await send.sendOne(h.account,c,{kind:'text',text:'x'},{by:'system',notice:'reminder',params:['a','b','c','d']})).reason,'no_template');
 await W.WaAccount.updateOne({_id:h.account._id},{templates:[{name:'kk_checkin_reminder',status:'APPROVED',language:'en'}]});const acc=await W.WaAccount.findById(h.account._id);
 sent.length=0;assert.ok((await send.sendOne(acc,c,{kind:'text',text:'x'},{by:'system',notice:'reminder',params:['a','b','c','d']})).ok);assert.equal(sent[0].body.type,'template');
});
const paid=async(h,phone='+2348031234567')=>{const branch=oid(),t=await D.RoomType.create({hotel:h.hotel,branch,name:'Suite',capacity:2,price:100});
 const r=await D.Reservation.create({hotel:h.hotel,branch,roomType:t.id,guest:{name:'John A',email:'john@example.com',phone},checkIn:new Date('2026-12-10'),checkOut:new Date('2026-12-13'),adults:2,qty:1,accommodation:300,total:300,paid:300,paymentStatus:'paid',status:'confirmed',currency:'NGN',reference:'KK-'+Math.random().toString(16).slice(2,10).toUpperCase(),manageToken:'tok123',channel:'whatsapp_auto'});
 await D.Hotel.create({_id:h.hotel,name:'Hotel '+h.hotel,slug:'h'+h.hotel,currency:'NGN'}).catch(()=>{});return r};
test('payment confirmed: one WhatsApp confirmation with the existing receipt link, even if the event fires repeatedly',async()=>{
 const h=await mkHotel('n1');await mkConv(h);const r=await paid(h);
 sent.length=0;await Promise.all([1,2,3].map(()=>notify._onEvent(h.hotel,'reservation.confirmed',{reference:r.reference})));
 assert.equal(sent.length,0,'no verified payment yet, so nothing is sent');
 await D.Payment.create({hotel:h.hotel,branch:r.branch,reservation:r._id,amount:300,currency:'NGN',source:'platform',method:'paystack',status:'success',verified:true,reference:'PAY-'+oid()});
 await Promise.all([1,2,3].map(()=>notify._onEvent(h.hotel,'reservation.confirmed',{reference:r.reference})));
 const out=sent.filter(s=>s.body.type==='interactive'||s.body.type==='text');assert.equal(out.length,1);
 assert.match(JSON.stringify(out[0].body),new RegExp(`${r.reference}`));assert.match(JSON.stringify(out[0].body),/api\.example\.test\/api\/public\/booking\/KK-[0-9A-F]+\/receipt\?token=tok123/);
 assert.equal(await W.WaNotice.countDocuments({reservation:r._id,kind:'confirmed'}),1);assert.equal((await D.Reservation.findById(r._id)).status,'confirmed');
});
test('a WhatsApp or email failure never touches the paid reservation',async()=>{
 const h=await mkHotel('n2');await mkConv(h,'2348031234567');const r=await paid(h);await D.Payment.create({hotel:h.hotel,branch:r.branch,reservation:r._id,amount:300,currency:'NGN',source:'platform',method:'paystack',status:'success',verified:true,reference:'PAY-'+oid()});
 await W.WaAccount.updateOne({_id:h.account._id},{status:'disconnected'});await notify._onEvent(h.hotel,'reservation.confirmed',{reference:r.reference});
 const x=await D.Reservation.findById(r._id);assert.equal(x.status,'confirmed');assert.equal(x.paid,300);
});
test('opted-out guests and disabled notification settings send nothing',async()=>{
 const h=await mkHotel('n3');const c=await mkConv(h);await W.WaConversation.updateOne({_id:c._id},{optedOut:true});const r=await paid(h);
 await D.Payment.create({hotel:h.hotel,branch:r.branch,reservation:r._id,amount:300,currency:'NGN',source:'platform',method:'paystack',status:'success',verified:true,reference:'PAY-'+oid()});
 sent.length=0;await notify._onEvent(h.hotel,'reservation.confirmed',{reference:r.reference});assert.equal(sent.filter(s=>s.body.messaging_product).length,0);
});
test('tenant isolation: one hotel can never read another hotel\'s guests or bookings',async()=>{
 const a=await mkHotel('t1'),b=await mkHotel('t2');const rb=await paid(b,'+2348031234567');
 const ta=tools.make(a.account);assert.deepEqual(await ta.getGuestBookings('2348031234567'),[]);assert.equal(await ta.getBookingStatus(rb._id),null);
 assert.equal(await ta.verifyByReference(rb.reference,'john@example.com'),null);assert.equal(await ta.getGuestProfile('2348031234567'),null);
 assert.equal((await tools.make(b.account).getGuestBookings('2348031234567')).length,1);assert.equal((await tools.make(b.account).getGuestBookings('2348039999999')).length,0);
});
test('a guest claiming payment does not confirm: verifyPayment trusts only Paystack',async()=>{
 const h=await mkHotel('p1'),r=await paid(h);await D.Reservation.updateOne({_id:r._id},{status:'pending',paid:0,paymentStatus:'unpaid'});
 const bill=require('../src/billing'),orig=bill.verify;bill.verify=async()=>{throw new Error('no such transaction')};
 await D.Payment.create({hotel:h.hotel,branch:r.branch,reservation:r._id,amount:300,currency:'NGN',source:'platform',reference:'PAY-X1'});
 const v=await tools.make(h.account).verifyPayment(r._id);bill.verify=orig;assert.equal(v.confirmed,false);assert.equal((await D.Reservation.findById(r._id)).status,'pending');
});
test('duplicate inbound webhooks store one message; staff takeover keeps automation silent',async()=>{
 const h=await mkHotel('w1');const change={field:'messages',value:{metadata:{phone_number_id:'w1'},contacts:[{wa_id:'2348031234567',profile:{name:'John'}}],messages:[{id:'wamid.IN1',from:'2348031234567',type:'text',text:{body:'Hello'}}]}};
 sent.length=0;await routes._test.handleChange(change,{id:'x'});await routes._test.handleChange(change,{id:'x'});
 assert.equal(await W.WaMessage.countDocuments({hotel:h.hotel,direction:'in'}),1);
 const c=await W.WaConversation.findOne({hotel:h.hotel});await W.WaConversation.updateOne({_id:c._id},{mode:'human'});sent.length=0;
 await routes._test.handleChange({...change,value:{...change.value,messages:[{id:'wamid.IN2',from:'2348031234567',type:'text',text:{body:'Hi?'}}]}},{id:'x'});
 assert.equal(sent.filter(s=>s.body.messaging_product).length,0);assert.equal(await W.WaMessage.countDocuments({hotel:h.hotel,direction:'in'}),2);
});
test('a message to an unknown number is ignored and never lands on any hotel',async()=>{
 const before=await W.WaMessage.countDocuments();await routes._test.handleChange({field:'messages',value:{metadata:{phone_number_id:'nope'},messages:[{id:'wamid.ZZ',from:'1',type:'text',text:{body:'x'}}]}},{id:'x'});assert.equal(await W.WaMessage.countDocuments(),before);
});
test('Meta access tokens are stored encrypted',async()=>{const a=await W.WaAccount.findOne({phoneNumberId:'c1'}).lean();assert.ok(!/tok/.test(a.tokenEnc.replace(/^v1\./,'')) || a.tokenEnc.startsWith('v1.'));assert.equal(secret.decrypt(a.tokenEnc),'tok')});
