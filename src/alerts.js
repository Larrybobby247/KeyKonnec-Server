// "A booking came in": an in-app notification on the dashboard plus an email to the hotel (the owner and the website contact email).
// Every function here swallows its own errors, so a notification problem can never break a booking or a payment.
const D=require('./models'),mail=require('./mail'),E=require('./emails');
const okEmail=e=>typeof e==='string'&&/^\S+@\S+\.\S+$/.test(e);
const recipients=async hotelId=>{const [owners,h]=await Promise.all([D.User.find({'memberships.hotel':hotelId,'memberships.role':'owner',status:'active'}).select('email').lean(),D.Hotel.findById(hotelId).lean()]);
 const w=(h&&h.website)||{},site=(w.published&&w.published.contact&&w.published.contact.email)||(w.draft&&w.draft.contact&&w.draft.contact.email);
 return{hotel:h,to:[...new Set([...owners.map(o=>o.email),site].filter(okEmail).map(e=>e.toLowerCase()))]}};
exports.recipients=recipients;
const inapp=(hotel,reservation,kind,title,body,link='/dashboard/reservations')=>D.Notification.create({hotel,reservation,channel:'inapp',kind,title,subject:title,body,link,status:'delivered',read:false});
exports.inapp=inapp;
const guard=f=>async(...a)=>{try{await f(...a)}catch(e){console.error('alert failed:',e.message)}};
const stayText=(r,t)=>`${(t&&t.name)||'Room'}${r.qty>1?' × '+r.qty:''} · ${E.D(r.checkIn)} to ${E.D(r.checkOut)}`;
// mode 'paid' (online payment received, booking confirmed) or 'request' (guest asked, hotel must respond).
const notifyNew=async(r,mode,p)=>{const [{hotel:h,to},t]=await Promise.all([recipients(r.hotel),D.RoomType.findById(r.roomType).lean()]);if(!h)return;const paid=mode==='paid';
 await inapp(h._id,r._id,'booking',paid?`New paid booking from ${r.guest.name}`:`New booking request from ${r.guest.name}`,`${stayText(r,t)} · ${E.money(r.total,r.currency)}${paid?' paid online':' · awaiting your response'}`);
 const {subject,html}=E.ownerBooking({hotel:h,r,type:t,mode,payment:p});if(to.length)await mail.send(to,subject,html,h._id,{replyTo:okEmail(r.guest.email)?r.guest.email:undefined})};
// Online payment confirmed the booking: email the guest their confirmation and alert the hotel.
exports.bookingPaid=guard(async(r,p)=>{const [h,t]=await Promise.all([D.Hotel.findById(r.hotel).lean(),D.RoomType.findById(r.roomType).lean()]);
 if(r.guest&&okEmail(r.guest.email)){const {subject,html}=E.guestConfirmed({hotel:h,r,type:t,payment:p});mail.send(r.guest.email,subject,html,r.hotel,{replyTo:(await recipients(r.hotel)).to[0]})}
 await notifyNew(r,'paid',p)});
// A guest sent a request (hotel has no online payments): acknowledge to the guest and alert the hotel.
exports.bookingRequest=guard(async r=>{const [h,t]=await Promise.all([D.Hotel.findById(r.hotel).lean(),D.RoomType.findById(r.roomType).lean()]);
 if(r.guest&&okEmail(r.guest.email)){const {subject,html}=E.guestRequest({hotel:h,r,type:t});mail.send(r.guest.email,subject,html,r.hotel,{replyTo:(await recipients(r.hotel)).to[0]})}
 await notifyNew(r,'request')});
exports.balancePaid=guard(async(r,p,paid)=>{const {hotel:h,to}=await recipients(r.hotel);if(!h)return;await inapp(h._id,r._id,'payment',`Balance paid by ${r.guest.name}`,`${E.money(p.amount,r.currency)} received for ${r.reference}`);
 const {subject,html}=E.ownerBalance({hotel:h,r,payment:p,paid});to.length&&await mail.send(to,subject,html,h._id)});
