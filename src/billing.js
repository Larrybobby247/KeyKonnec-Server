const axios=require('axios'),crypto=require('crypto');
const {Plan,Subscription,Payment,Reservation,Hold,Commission,Hotel,User}=require('./models'),mail=require('./mail'),hooks=require('./hooks'),notify=require('./notify'),inv=require('./inventory');
const ps=()=>axios.create({baseURL:'https://api.paystack.co',headers:{Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`}});
// With a subaccount, Paystack credits the hotel's bank account and keeps `charge` (our commission) on the platform account. The hotel bears Paystack's fee so the commission is not eroded.
exports.initialize=async(email,amount,reference,callback,opts={})=>(await ps().post('/transaction/initialize',{email,amount:Math.round(amount*100),currency:'NGN',reference,callback_url:callback,...(opts.subaccount?{subaccount:opts.subaccount,bearer:'subaccount',...(opts.charge>0?{transaction_charge:Math.round(opts.charge*100)}:{})}:{})})).data.data;
exports.banks=async()=>(await ps().get('/bank',{params:{country:'nigeria',perPage:200,currency:'NGN'}})).data.data;
exports.resolveAccount=async(number,code)=>(await ps().get('/bank/resolve',{params:{account_number:number,bank_code:code}})).data.data;
exports.createSubaccount=async b=>(await ps().post('/subaccount',b)).data.data;
exports.updateSubaccount=async(code,b)=>(await ps().put('/subaccount/'+encodeURIComponent(code),b)).data.data;
// Commission is taken at payment time by the split, so record what was collected and keep it traceable to the booking.
const recordCommission=async(r,p)=>{if(!(p.commission>0))return;const share=r.total?r.accommodation*p.amount/r.total:0;await Commission.updateOne({reservation:r._id},{$setOnInsert:{hotel:r.hotel,rate:r.commissionRate},$set:{status:'collected'},$inc:{base:+share.toFixed(2),amount:p.commission}},{upsert:true})};
exports.refund=async(ref,amount)=>(await ps().post('/refund',{transaction:ref,amount:Math.round(amount*100)})).data;
exports.verify=async ref=>(await ps().get('/transaction/verify/'+encodeURIComponent(ref))).data.data;
exports.validSignature=(raw,sig)=>!!sig&&crypto.createHmac('sha512',process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex')===sig;
// Plan limits and features always come from the stored subscription.
// Plan and subscription are read on almost every request, so keep them for 5 seconds. Plan changes call invalidate(); the backend stays authoritative.
const EMEMO=new Map();exports.invalidate=h=>h?EMEMO.delete(String(h)):EMEMO.clear();
exports.entitlements=async hotel=>{const k=String(hotel),c=EMEMO.get(k);if(c&&Date.now()-c.t<5000)return c.v;
 const s=await Subscription.findOne({hotel}).lean(),key=s.status==='trialing'&&s.trialEnd<new Date()?'free':s.plan,v={sub:s,plan:await Plan.findOne({key}).lean()};EMEMO.set(k,{t:Date.now(),v});if(EMEMO.size>2000)EMEMO.clear();return v};
// Idempotent: only one caller can move pending->processing, so duplicate webhooks do nothing.
exports.settle=async(ref,d)=>{const p=await Payment.findOneAndUpdate({reference:ref,status:'pending'},{status:'processing'});if(!p)return;
 if(d.status!=='success'){await Payment.updateOne({_id:p._id},{status:'failed'});return}
 if(d.amount!==Math.round(p.amount*100)||d.currency!==p.currency){await Payment.updateOne({_id:p._id},{status:'flagged'});return}
 const r=await Reservation.findById(p.reservation);
 if(p.kind==='balance'){const paid=r.paid+p.amount;await Reservation.updateOne({_id:r._id},{paid,paymentStatus:paid>=r.total?'paid':'partial'});await Payment.updateOne({_id:p._id},{status:'success',verified:true});await recordCommission(r,p);hooks.emit(r.hotel,'payment.succeeded',{reservation:r.reference,amount:p.amount});return}
 const h=await Hold.findOne({_id:{$exists:true},reservation:r._id});
 if(h.status!=='active'){try{await inv.reserve(r.roomType,r.checkIn,r.checkOut,r.qty)}catch{await Payment.updateOne({_id:p._id},{status:'needs_refund'});return}}
 await Hold.updateOne({_id:h._id},{status:'converted'});
 await Payment.updateOne({_id:p._id},{status:'success',verified:true});await recordCommission(r,p);
 const paid=r.paid+p.amount;await Reservation.updateOne({_id:r._id},{paid,status:'confirmed',paymentStatus:paid>=r.total?'paid':'partial'});
 try{const hh=await Hotel.findById(r.hotel),day=x=>x.toISOString().slice(0,10);
  mail.send(r.guest.email,'Booking confirmed '+r.reference,mail.tpl('Your booking is confirmed',['Reference: '+r.reference,hh.name+(hh.address?', '+hh.address:''),`Check-in ${day(r.checkIn)}, check-out ${day(r.checkOut)}`,`Paid ${p.amount} ${p.currency}`,...(paid<r.total?[`Balance of ${r.total-paid} is due ${r.balanceDue?day(r.balanceDue):'at arrival'}.`]:[])]),r.hotel);
  const o=await User.findOne({'memberships.hotel':r.hotel,'memberships.role':'owner'});notify.guest(r,'confirm',[r.guest.name,hh.name,r.reference,day(r.checkIn),day(r.checkOut)]);hooks.emit(r.hotel,'payment.succeeded',{reservation:r.reference,amount:p.amount});hooks.emit(r.hotel,'reservation.confirmed',{reference:r.reference});o&&mail.send(o.email,'New paid booking '+r.reference,mail.tpl('New paid booking',[`${r.guest.name}, ${day(r.checkIn)}`]),r.hotel)}catch{}};
exports.commissionFor=async r=>{if(!r.commissionRate||r.source!=='online'||r.status!=='checked_out')return;
 const base=Math.min(r.accommodation,r.paid);await Commission.updateOne({reservation:r._id},{$setOnInsert:{hotel:r.hotel,rate:r.commissionRate,base,amount:+(base*r.commissionRate).toFixed(2)}},{upsert:true})};
