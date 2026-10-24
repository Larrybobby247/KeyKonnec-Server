const D=require('./models'),inv=require('./inventory');
const bad=m=>Object.assign(new Error(m),{status:400}),r2=n=>Math.round(n*100)/100,day=x=>new Date(x).toISOString().slice(0,10);
// The only place prices are calculated: seasonal rules, discount codes, tax, deposit and balance due date.
exports.quote=async({hotel,plan,type,checkIn,checkOut,qty=1,promo,manual=false})=>{
 const nights=inv.nightsOf(checkIn,checkOut);if(!nights.length)throw bad('Check-out must be after check-in');
 const adv=plan.features.includes('pricing');
 if(adv&&!manual){const n=nights.length,ahead=(new Date(checkIn)-Date.now())/864e5;
  if(type.minStay&&n<type.minStay)throw bad(`Minimum stay is ${type.minStay} night${type.minStay>1?'s':''}`);
  if(type.maxStay&&n>type.maxStay)throw bad(`Maximum stay is ${type.maxStay} nights`);
  if(hotel.maxAdvanceDays&&ahead>hotel.maxAdvanceDays)throw bad(`Bookings open ${hotel.maxAdvanceDays} days ahead`);
  if(hotel.cutoffHour!=null&&day(checkIn)===day(new Date())&&(new Date().getUTCHours()+1)%24>=hotel.cutoffHour)throw bad('Same-day booking is closed for today')}
 let rules=[];if(adv)rules=await D.PriceRule.find({hotel:hotel._id,from:{$lte:nights[nights.length-1]},to:{$gte:nights[0]},$or:[{roomType:type._id},{roomType:null}]}).lean();
 const priceOn=d=>{const c=rules.filter(r=>r.from<=d&&r.to>=d).sort((a,b)=>(a.roomType?0:1)-(b.roomType?0:1)||(a.to-a.from)-(b.to-b.from)||b.createdAt-a.createdAt)[0];return c?c.price:type.price};
 const subtotal=r2(nights.reduce((t,d)=>t+priceOn(d),0)*qty);let discount=0,promoId,promoCode;
 if(promo&&String(promo).trim()){if(!adv)throw bad('Discount codes are not available at this hotel');
  const p=await D.Promo.findOne({hotel:hotel._id,code:String(promo).trim().toUpperCase(),active:true}),t=new Date();
  if(!p||(p.validFrom&&p.validFrom>t)||(p.validTo&&p.validTo<t)||(p.maxUses&&p.used>=p.maxUses)||(p.minNights&&nights.length<p.minNights))throw bad('That discount code is not valid for this stay');
  discount=r2(p.type==='percent'?subtotal*Math.min(p.value,100)/100:Math.min(p.value,subtotal));promoId=p._id;promoCode=p.code}
 const accommodation=r2(subtotal-discount),tax=r2(accommodation*(hotel.taxPercent||0)/100),total=r2(accommodation+tax);
 const pct=plan.features.includes('deposits')?Math.min(100,Math.max(1,hotel.depositPercent||100)):100,deposit=pct>=100?total:Math.ceil(total*pct/100),balance=r2(total-deposit);
 let dueDate;if(balance>0){dueDate=new Date(new Date(checkIn)-(hotel.balanceDueDays||0)*864e5);if(dueDate<new Date())dueDate=new Date(checkIn)}
 return{nights:nights.length,subtotal,discount,accommodation,tax,total,deposit,balance,dueDate,promoId,promoCode}};
