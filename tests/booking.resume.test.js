// Cancellation gives rooms back immediately; an unpaid guest can come back and pay later. (Paystack and room inventory are stubbed.)
const {test,before,after}=require('node:test'),assert=require('node:assert'),mongoose=require('mongoose'),{MongoMemoryServer}=require('mongodb-memory-server');
const D=require('../src/models'),inv=require('../src/inventory'),bill=require('../src/billing'),svc=require('../src/bookingService');
let mongo,released=[],reserved=[],soldOut=false;const oid=()=>new mongoose.Types.ObjectId();
before(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
 inv.release=async(...a)=>{released.push(a)};inv.reserve=async(...a)=>{if(soldOut)throw new Error('SOLD_OUT');reserved.push(a)};
 bill.entitlements=async()=>({plan:{features:['online_payments']}});bill.initialize=async()=>({authorization_url:'https://checkout.paystack.com/new'})});
after(async()=>{await mongoose.disconnect();await mongo.stop()});
const soon=n=>new Date(Date.now()+n*864e5);
async function mk(status='pending',holdStatus='active',extra={}){const hotel=await D.Hotel.create({name:'H',slug:'h'+oid(),currency:'NGN',holdMinutes:20,payout:{subaccountCode:'ACCT_x'}});
 const rt=oid(),r=await D.Reservation.create({hotel:hotel._id,roomType:rt,guest:{name:'Ada O',email:'ada@example.com',phone:'0803'},checkIn:soon(10),checkOut:soon(12),qty:1,adults:2,accommodation:100,total:100,deposit:100,paid:0,status,reference:'KK-'+oid().toString().slice(-8).toUpperCase(),manageToken:'tok',...extra});
 const h=await D.Hold.create({hotel:hotel._id,roomType:rt,checkIn:r.checkIn,checkOut:r.checkOut,qty:1,reservation:r._id,expiresAt:new Date(Date.now()+(holdStatus==='active'?6e5:-6e5)),status:holdStatus});return{hotel,r,h}}
test('cancelling gives the rooms back once, for unpaid and paid bookings alike',async()=>{
 for(const hs of['active','converted']){const {r}=await mk(hs==='active'?'pending':'confirmed',hs);released.length=0;
  assert.equal(await svc.releaseHold(r),true);assert.equal(released.length,1);assert.equal(await svc.releaseHold(r),false);assert.equal(released.length,1);// the timeout job cannot release it a second time
 }});
test('the timeout job leaves a cancelled booking alone',async()=>{const {r,h}=await mk();await svc.releaseHold(r);assert.equal((await D.Hold.findById(h._id)).status,'released');released.length=0;await inv.expireHolds();assert.equal(released.length,0)});
test('a lapsed booking can be paid later: rooms are taken again, same price, new Paystack link',async()=>{
 const {r}=await mk('expired','expired',{abandonLogged:true});reserved.length=0;
 const out=await svc.resumePayment({reference:r.reference,token:'tok'});
 assert.equal(out.checkoutUrl,'https://checkout.paystack.com/new');assert.equal(reserved.length,1);
 const x=await D.Reservation.findById(r._id);assert.equal(x.status,'pending');assert.equal(x.total,100);assert.ok(!x.resumeLock);
 assert.equal(await D.Hold.countDocuments({reservation:r._id,status:'active'}),1);assert.equal(await D.Payment.countDocuments({reservation:r._id,amount:100,status:'pending'}),1);
});
test('a still-active hold is extended instead of taking rooms twice',async()=>{const {r}=await mk();reserved.length=0;await svc.resumePayment({reference:r.reference,token:'tok'});assert.equal(reserved.length,0);assert.equal(await D.Hold.countDocuments({reservation:r._id,status:'active'}),1)});
test('if someone else took the room meanwhile, the guest is told and nothing is changed',async()=>{
 const {r}=await mk('expired','expired');soldOut=true;await assert.rejects(svc.resumePayment({reference:r.reference,token:'tok'}),{status:409,message:/taken in the meantime/});soldOut=false;
 const x=await D.Reservation.findById(r._id);assert.equal(x.status,'expired');assert.ok(!x.resumeLock);assert.equal(await D.Payment.countDocuments({reservation:r._id}),0);
});
test('cannot resume a booking the hotel cancelled, a paid one, past dates, or with the wrong token',async()=>{
 const a=await mk('cancelled','released');await assert.rejects(svc.resumePayment({reference:a.r.reference,token:'tok'}),{status:409,message:/cancelled/});
 const b=await mk('pending','active',{paid:50});await assert.rejects(svc.resumePayment({reference:b.r.reference,token:'tok'}),{status:409});
 const c=await mk('expired','expired',{checkIn:soon(-5),checkOut:soon(-3)});await assert.rejects(svc.resumePayment({reference:c.r.reference,token:'tok'}),{status:409,message:/passed/});
 const d=await mk();await assert.rejects(svc.resumePayment({reference:d.r.reference,token:'nope'}),{status:404});
 assert.equal(await svc.canResume(await D.Reservation.findById(a.r._id)),false);assert.equal(await svc.canResume(await D.Reservation.findById(d.r._id)),true);
});
