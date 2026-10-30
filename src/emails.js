// Detailed, branded email builders. Each returns {subject, html}. Guest emails carry the hotel's name and logo; hotel emails carry keykonnec's.
const mail=require('./mail');
const money=(v,cur)=>(!cur||cur==='NGN'?'₦':cur+' ')+Number(v||0).toLocaleString('en-NG');
const D=x=>x?new Date(x).toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}):'';
const nightsOf=(a,b)=>Math.max(1,Math.round((new Date(b)-new Date(a))/864e5));
const first=n=>String(n||'there').trim().split(/\s+/)[0];
const app=()=>String(process.env.CLIENT_URL||'').replace(/\/+$/,'');
const manageUrl=r=>`${app()}/booking/${r.reference}?token=${r.manageToken}`;
const brand=h=>({brand:h.name,logo:h.logo&&/^https:/.test(h.logo)?h.logo:undefined});
const roomName=(r,t)=>(t&&t.name?t.name:'Room')+(r.qty>1?` × ${r.qty}`:'');
const stay=(r,t,h)=>{const n=nightsOf(r.checkIn,r.checkOut),p=h.policies||{};return[['Booking reference',r.reference],['Room',roomName(r,t)],['Check-in',D(r.checkIn)+(p.checkInTime?` · from ${p.checkInTime}`:'')],['Check-out',D(r.checkOut)+(p.checkOutTime?` · by ${p.checkOutTime}`:'')],['Length of stay',`${n} night${n>1?'s':''}`],['Guests',`${r.adults||1} adult${(r.adults||1)>1?'s':''}`]]};
const cost=(r,paidNow)=>{const c=r.currency,paid=paidNow==null?r.paid:paidNow,bal=Math.max(0,r.total-paid);return[['Accommodation',money((r.accommodation||0)+(r.discount||0),c)],...(r.discount>0?[[`Discount${r.promoCode?' ('+r.promoCode+')':''}`,'−'+money(r.discount,c)]]:[]),...(r.tax>0?[['Taxes and fees',money(r.tax,c)]]:[]),['Total',money(r.total,c)],['Paid so far',money(paid,c)],[bal>0?'Balance remaining':'Balance',bal>0?money(bal,c):'Nothing to pay','strong']]};
const where=h=>[h.address&&['Address',h.address],h.phone&&['Phone',h.phone]].filter(Boolean);
exports.money=money;exports.D=D;
// Guest: payment received, booking confirmed.
exports.guestConfirmed=({hotel:h,r,type:t,payment:p,paid})=>{const bal=Math.max(0,r.total-(paid==null?r.paid:paid));
 return{subject:`Booking confirmed at ${h.name} · ${r.reference}`,html:mail.tpl('Your booking is confirmed',[`Hi ${first(r.guest.name)},`,`Thank you for booking with ${h.name}. We have received your payment${p?` of ${money(p.amount,r.currency)}`:''} and your room is reserved.`,
  {heading:'Your stay'},...stay(r,t,h),{heading:'Payment summary'},...cost(r,paid),
  bal>0&&{note:`A balance of ${money(bal,r.currency)} is due ${r.balanceDue?'by '+D(r.balanceDue):'on arrival'}. You can pay it online any time from your booking page.`},
  {button:['View or manage your booking',manageUrl(r)]},
  {heading:'Hotel details'},...where(h),h.policies&&h.policies.cancellation&&['Cancellation',h.policies.cancellation],
  'Please show your booking reference at check-in. If your plans change, reply to this email or contact the hotel directly.'].filter(Boolean),{...brand(h),badge:['Confirmed','green'],preheader:`${roomName(r,t)} · ${D(r.checkIn)} to ${D(r.checkOut)}`})}};
// Guest: a request was sent (no online payment taken yet).
exports.guestRequest=({hotel:h,r,type:t})=>({subject:`We received your booking request · ${r.reference}`,html:mail.tpl('We have your booking request',[`Hi ${first(r.guest.name)},`,`Thank you for choosing ${h.name}. Your request has been sent and the hotel will contact you shortly with confirmation and payment instructions. No payment has been taken.`,
 {heading:'Your request'},...stay(r,t,h),['Estimated total',money(r.total,r.currency),'strong'],{button:['View your request',manageUrl(r)]},{heading:'Hotel details'},...where(h)],{...brand(h),badge:['Request received','amber'],preheader:`Reference ${r.reference}`})});
// Guest: confirmed by the hotel (request approved).
exports.guestApproved=({hotel:h,r,type:t})=>({subject:`Booking confirmed at ${h.name} · ${r.reference}`,html:mail.tpl('Your booking is confirmed',[`Hi ${first(r.guest.name)},`,`${h.name} has confirmed your booking.`,{heading:'Your stay'},...stay(r,t,h),{heading:'Payment summary'},...cost(r),{button:['View or manage your booking',manageUrl(r)]},{heading:'Hotel details'},...where(h)],{...brand(h),badge:['Confirmed','green']})});
exports.guestCancelled=({hotel:h,r,type:t})=>({subject:`Booking cancelled · ${r.reference}`,html:mail.tpl('Your booking was cancelled',[`Hi ${first(r.guest.name)},`,`Your booking at ${h.name} has been cancelled.`,{heading:'Cancelled booking'},...stay(r,t,h),
 r.paid>0?{note:`You paid ${money(r.paid,r.currency)} online. Please contact the hotel about your refund${h.phone?' on '+h.phone:''}.`}:'No payment was taken for this booking.',...where(h)],{...brand(h),badge:['Cancelled','red']})});
exports.guestModified=({hotel:h,r,type:t,refunded})=>({subject:`Booking updated · ${r.reference}`,html:mail.tpl('Your booking was changed',[`Hi ${first(r.guest.name)},`,`The hotel updated your booking at ${h.name}. Here are the new details.`,{heading:'Updated stay'},...stay(r,t,h),{heading:'Payment summary'},...cost(r),
 r.total>r.paid&&{button:['Pay the balance online',manageUrl(r)],accent:true},refunded>0&&{note:`A refund of ${money(refunded,r.currency)} has been started. It can take a few days to reach your account.`}].filter(Boolean),{...brand(h),badge:['Updated','blue']})});
exports.guestReminder=({hotel:h,r,type:t})=>({subject:`See you tomorrow at ${h.name} · ${r.reference}`,html:mail.tpl('Your stay starts tomorrow',[`Hi ${first(r.guest.name)},`,`We are looking forward to welcoming you to ${h.name} tomorrow.`,{heading:'Your stay'},...stay(r,t,h),r.total>r.paid&&['Balance to pay',money(r.total-r.paid,r.currency),'strong'],{button:['View your booking',manageUrl(r)]},{heading:'Getting here'},...where(h)].filter(Boolean),{...brand(h),badge:['Tomorrow','blue']})});
exports.guestBalance=({hotel:h,r})=>({subject:`Balance due for ${r.reference}`,html:mail.tpl('Your balance is due soon',[`Hi ${first(r.guest.name)},`,`A balance for your stay at ${h.name} is due ${r.balanceDue?'on '+D(r.balanceDue):'soon'}.`,...cost(r),{button:['Pay your balance',manageUrl(r)],accent:true}],{...brand(h),badge:['Payment due','amber']})});
exports.guestRefund=({hotel:h,r,amount})=>({subject:`Refund processed · ${r.reference}`,html:mail.tpl('Your refund was processed',[`Hi ${first(r.guest.name)},`,`${h.name} has refunded part or all of your payment.`,['Booking reference',r.reference],['Refund amount',money(amount,r.currency),'strong'],{note:'Refunds can take a few days to reach your bank account.'}],{...brand(h),badge:['Refunded','blue']})});
// Hotel: a booking came in.
exports.ownerBooking=({hotel:h,r,type:t,mode,payment:p,paid})=>{const paidAmt=paid==null?r.paid:paid,bal=Math.max(0,r.total-paidAmt),isPaid=mode==='paid';
 return{subject:`${isPaid?'New paid booking':'New booking request'} · ${r.guest.name} · ${D(r.checkIn)}`,html:mail.tpl(isPaid?'You have a new booking':'You have a new booking request',[isPaid?`${r.guest.name} just booked ${roomName(r,t)} and paid online. The room is now confirmed.`:`${r.guest.name} sent a booking request. Contact the guest to confirm and collect payment, then confirm it in your dashboard.`,
  {heading:'Guest'},['Name',r.guest.name],['Phone',r.guest.phone||'-'],['Email',r.guest.email||'-'],{heading:'Stay'},...stay(r,t,h),{heading:'Money'},['Booking total',money(r.total,r.currency)],isPaid&&p&&['Received now',money(p.amount,r.currency)],['Balance still to collect',money(bal,r.currency),'strong'],
  {button:['Open in your dashboard',`${app()}/dashboard/reservations`]}].filter(Boolean),{badge:isPaid?['Paid online','green']:['Needs your response','amber'],preheader:`${r.guest.name} · ${roomName(r,t)} · ${D(r.checkIn)}`})}};
exports.ownerBalance=({hotel:h,r,payment:p,paid})=>({subject:`Balance paid · ${r.reference}`,html:mail.tpl('A guest paid their balance',[`${r.guest.name} paid ${money(p.amount,r.currency)} towards booking ${r.reference}.`,...cost(r,paid),{button:['Open in your dashboard',`${app()}/dashboard/reservations`]}],{badge:['Payment received','green']})});
