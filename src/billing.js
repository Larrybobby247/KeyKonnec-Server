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
// Does what Paystack says was paid match what we asked for? Paystack's `amount` is what the customer was charged: when the Paystack account
// passes its fees on to the customer, that figure includes the fee, so the amount we originally asked for (`requested_amount`) is checked too.
exports.amountMatches=(d,expected)=>{const want=Math.round(expected*100),amount=Number(d.amount),asked=d.requested_amount==null?NaN:Number(d.requested_amount),fees=Number(d.fees)||0;
 return amount===want||asked===want||(fees>0&&amount-fees===want)};
exports.currencyMatches=(d,cur)=>String(d.currency||'NGN').toUpperCase()===String(cur||'NGN').toUpperCase();
exports.mismatchReason=(d,expected,cur)=>{const f=n=>(Number(n)/100).toLocaleString('en-NG');return `Paystack reported ${f(d.amount)} ${d.currency||''}${d.requested_amount!=null?` (requested ${f(d.requested_amount)})`:''}, but ${Number(expected).toLocaleString('en-NG')} ${cur||'NGN'} was expected.`};
// Only a result Paystack calls "failed" or "reversed" is a failure. "abandoned", "ongoing" or "pending" just means the customer has not finished paying yet, so the payment stays open and can still succeed later.
exports.isFailure=d=>['failed','reversed'].includes(String(d.status));
// Idempotent: only one caller can move pending->processing, so duplicate webhooks do nothing. Flagged and failed payments can be re-checked (a customer may retry on the same reference).
exports.settle=async(ref,d)=>{const p=await Payment.findOneAndUpdate({reference:ref,status:{$in:['pending','flagged','failed']}},{status:'processing'});if(!p)return;
 try{await settleOne(p,d)}catch(e){await Payment.updateOne({_id:p._id,status:'processing'},{status:p.status});throw e}};
async function settleOne(p,d){
 if(d.status!=='success'){await Payment.updateOne({_id:p._id},{status:exports.isFailure(d)?'failed':p.status==='failed'?'failed':'pending'});return}
 if(!exports.amountMatches(d,p.amount)||!exports.currencyMatches(d,p.currency)){await Payment.updateOne({_id:p._id},{status:'flagged',flagReason:exports.mismatchReason(d,p.amount,p.currency)});return}
 const r=await Reservation.findById(p.reservation);
 if(p.kind==='balance'){const paid=r.paid+p.amount;await Reservation.updateOne({_id:r._id},{paid,paymentStatus:paid>=r.total?'paid':'partial'});await Payment.updateOne({_id:p._id},{status:'success',verified:true,flagReason:null});await recordCommission(r,p);hooks.emit(r.hotel,'payment.succeeded',{reservation:r.reference,amount:p.amount});require('./alerts').balancePaid(r,p,paid);return}
 let h=await Hold.findOne({reservation:r._id});
 if(!h||h.status!=='active'){try{await inv.reserve(r.roomType,r.checkIn,r.checkOut,r.qty)}catch{await Payment.updateOne({_id:p._id},{status:'needs_refund'});return}
  if(!h)h=await Hold.create({hotel:r.hotel,branch:r.branch,roomType:r.roomType,checkIn:r.checkIn,checkOut:r.checkOut,qty:r.qty,expiresAt:new Date('2999-01-01'),status:'converted',reservation:r._id})}
 await Hold.updateOne({_id:h._id},{status:'converted'});
 await Payment.updateOne({_id:p._id},{status:'success',verified:true,flagReason:null});await recordCommission(r,p);
 const paid=r.paid+p.amount;await Reservation.updateOne({_id:r._id},{paid,status:'confirmed',paymentStatus:paid>=r.total?'paid':'partial'});
 try{const fresh=await Reservation.findById(r._id);hooks.emit(r.hotel,'payment.succeeded',{reservation:r.reference,amount:p.amount});hooks.emit(r.hotel,'reservation.confirmed',{reference:r.reference});
  notify.guest(r,'confirm',[r.guest.name,(await Hotel.findById(r.hotel)).name,r.reference,r.checkIn.toISOString().slice(0,10),r.checkOut.toISOString().slice(0,10)]);
  await require('./alerts').bookingPaid(fresh,p)}catch(e){console.error('booking alerts:',e.message)}}
exports.commissionFor=async r=>{if(!r.commissionRate||r.source!=='online'||r.status!=='checked_out')return;
 const base=Math.min(r.accommodation,r.paid);await Commission.updateOne({reservation:r._id},{$setOnInsert:{hotel:r.hotel,rate:r.commissionRate,base,amount:+(base*r.commissionRate).toFixed(2)}},{upsert:true})};
