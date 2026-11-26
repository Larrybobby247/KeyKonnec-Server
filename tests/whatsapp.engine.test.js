// Conversation flow tests with in-memory fake tools (no database, no AI, no Meta). They prove the booking flow itself works deterministically.
const {test}=require('node:test'),assert=require('node:assert');
const engine=require('../src/whatsapp/engine'),nlu=require('../src/whatsapp/nlu');
const NOW=new Date('2026-11-25T09:00:00Z');// Wednesday
function fakeTools(o={}){
 const log=[],state={left:{exec:1,std:2},reservations:[],paid:false,bookingAllowed:true,...o};
 const types=[{id:'exec',name:'Executive Suite',capacity:2,price:45000,description:'Spacious suite',amenities:['Wi-Fi','Swimming pool'],images:['https://res.cloudinary.com/x/exec.jpg']},{id:'std',name:'Standard Room',capacity:2,price:25000,description:'Cosy',amenities:['Wi-Fi'],images:[]}];
 const nights=(a,b)=>Math.round((new Date(b)-new Date(a))/864e5);
 const t={log,state,
  bookingAllowed:async()=>state.bookingAllowed,
  hotelInfo:async()=>({id:'h1',name:'Example Hotel',address:'12 Marina, Lagos',phone:'08000000000',amenities:['Restaurant'],description:'A quiet hotel near the airport. Guests love it.',policies:{checkInTime:'2pm',checkOutTime:'11am',cancellation:'Free until 48h before'},currency:'NGN',holdMinutes:20}),
  listRoomTypes:async()=>types,
  getRoomDetails:async(id)=>types.find(x=>x.id===id),
  searchAvailableRooms:async({checkIn,checkOut,adults})=>{log.push(['search',checkIn,checkOut,adults]);const n=nights(checkIn,checkOut);const options=types.filter(x=>state.left[x.id]>0&&x.capacity>=adults).map(x=>({typeId:x.id,name:x.name,capacity:x.capacity,qty:1,left:state.left[x.id],nights:n,total:x.price*n,perNight:x.price}));return {options,restricted:[],alternatives:options.length?[]:[{checkIn:'2026-12-14',checkOut:'2026-12-17',from:50000}]}},
  calculateBookingPrice:async({typeId,checkIn,checkOut,qty})=>{const x=types.find(y=>y.id===typeId),n=nights(checkIn,checkOut);return{total:x.price*n*qty,subtotal:x.price*n*qty,nights:n,discount:0,tax:0,accommodation:x.price*n*qty,deposit:x.price*n*qty,left:state.left[typeId],currency:'NGN',hotelName:'Example Hotel',typeName:x.name}},
  getGuestBookings:async(wa,linked)=>state.reservations.filter(r=>r.phone===wa||linked.includes(r.id)).map(r=>({_id:r.id,reference:r.reference,status:r.status,guest:{phone:'+'+r.phone}})),
  getGuestProfile:async(wa)=>state.profile&&state.profile.wa===wa?state.profile:null,
  getBookingStatus:async(id)=>{const r=state.reservations.find(x=>x.id===id);return r&&{id:r.id,reference:r.reference,status:r.status,paymentStatus:r.paid?'paid':'unpaid',paid:r.paid?r.total:0,total:r.total,currency:'NGN',checkIn:'2026-12-10',checkOut:'2026-12-13',qty:1,typeName:'Executive Suite',receiptUrl:r.paid?'https://api.example.com/api/public/booking/'+r.reference+'/receipt?token=t':null,balance:0}},
  verifyByReference:async(ref,email)=>{const r=state.reservations.find(x=>x.reference===ref&&x.email===email);return r?r.id:null},
  createPendingBooking:async(d)=>{log.push(['create',d]);if(state.failCreate)throw Object.assign(new Error('Sorry, that room was just taken. Try other dates or another room.'),{status:409});const id='r'+(state.reservations.length+1),r={id,reference:'KK-AAAA000'+state.reservations.length,status:'pending',total:d.total||0,phone:d.phone,email:d.email};state.reservations.push(r);return{id,reference:r.reference,status:'pending',payUrl:'https://checkout.paystack.com/abc',payRef:'PAY-1',deposit:0,total:0}},
  verifyPayment:async(id)=>{log.push(['verify',id]);return state.paid?{confirmed:true,status:'confirmed'}:{confirmed:false,status:'pending'}},
  cancelPending:async()=>true,requestCancellation:async()=>({pendingApproval:true}),previewModification:async()=>({newTotal:90000,oldTotal:135000,diff:-45000,nights:2,currency:'NGN'}),requestModification:async()=>({pendingApproval:true}),
  claimNotice:async()=>true,
 };
 return t;
}
function chat(tools,opts={}){
 const conv={waId:'2348031234567',state:'GREETING',ctx:{},reservations:[],optedOut:false};let all=[],effects=[];
 return{conv,say:async(text,buttonId)=>{const r=await engine.handle({conv,msg:{text,buttonId},tools,settings:{timezone:'Africa/Lagos'},now:NOW,ai:opts.ai});conv.state=r.state;conv.ctx=r.ctx;for(const e of r.effects){effects.push(e);if(e.t==='link')conv.reservations.push(e.reservationId)}all.push(...r.replies);return r.replies},
  lastText:()=>all.map(x=>x.text).join('\n'),effects};
}
const flat=(rs)=>rs.map(r=>r.text||'').join('\n');

test('greeting, then a full booking flow ends with a payment link',async()=>{
 const t=fakeTools(),c=chat(t);
 assert.match(flat(await c.say('Hello')),/Welcome to Example Hotel/);
 assert.match(flat(await c.say('I want to book')),/check in/);
 assert.equal(c.conv.state,'COLLECTING_CHECK_IN');
 assert.match(flat(await c.say('10 december')),/check out/);
 assert.equal(c.conv.state,'COLLECTING_CHECK_OUT');
 assert.match(flat(await c.say('13 december')),/How many adults/);
 let out=flat(await c.say('2'));
 assert.equal(c.conv.state,'SELECTING_ROOM');assert.match(out,/Executive Suite/);assert.match(out,/₦135,000 total/);
 assert.deepEqual(t.log[0],['search','2026-12-10','2026-12-13',2]);
 out=flat(await c.say('1'));assert.equal(c.conv.state,'BOOKING_SUMMARY');assert.match(out,/Room rate: ₦45,000 per night/);assert.match(out,/Total: ₦135,000/);assert.match(out,/Duration: 3 nights/);
 assert.match(flat(await c.say('yes')),/full name/);
 assert.match(flat(await c.say('John Adebayo')),/email address/);
 assert.match(flat(await c.say('john@')),/valid email|doesn't look like/);
 assert.match(flat(await c.say('john@example.com')),/\+2348031234567/);
 assert.match(flat(await c.say('yes')),/special requests/);
 out=flat(await c.say('no'));assert.match(out,/BOOKING SUMMARY/);assert.match(out,/john@example.com/);assert.equal(c.conv.state,'BOOKING_SUMMARY');
 const rs=await c.say('Confirm','confirm');
 assert.equal(c.conv.state,'AWAITING_PAYMENT');assert.equal(rs.find(r=>r.kind==='cta').url,'https://checkout.paystack.com/abc');
 const create=t.log.find(l=>l[0]==='create')[1];assert.equal(create.name,'John Adebayo');assert.equal(create.phone,'2348031234567');assert.equal(create.checkIn,'2026-12-10');
 assert.equal(t.log.filter(l=>l[0]==='create').length,1);
 // a repeated "confirm" must not create a second reservation
 await c.say('yes');assert.equal(t.log.filter(l=>l[0]==='create').length,1);assert.equal(t.state.reservations.length,1);
});
test('a short reply is understood from the state: "Friday" becomes the check-in date',async()=>{
 const c=chat(fakeTools());await c.say('I need a room');assert.match(c.lastText(),/check in/);
 assert.match(flat(await c.say('Friday')),/check out/);assert.equal(c.conv.ctx.known.checkIn,'2026-11-27');
});
test('one message can carry everything: dates, nights and guests',async()=>{
 const t=fakeTools(),c=chat(t);const out=flat(await c.say('i need an apartment for 2 people from 10 december for 3 nights'));
 assert.equal(c.conv.state,'SELECTING_ROOM');assert.deepEqual(t.log[0],['search','2026-12-10','2026-12-13',2]);assert.match(out,/Standard Room/);
});
test('ambiguous dates are confirmed, not assumed',async()=>{
 const c=chat(fakeTools());await c.say('I want to book');
 let out=flat(await c.say('10/12/2026'));assert.match(out,/Just to confirm/);assert.match(out,/10 December 2026/);assert.ok(!c.conv.ctx.known.checkIn);
 await c.say('yes');assert.equal(c.conv.ctx.known.checkIn,'2026-12-10');
 out=flat(await c.say('this weekend'));assert.match(out,/confirm/);
});
test('past dates are refused',async()=>{const c=chat(fakeTools());await c.say('book');assert.match(flat(await c.say('20 november')),/already passed|has already passed|20 November 2027|confirm/);});
test('no availability offers alternatives and nothing is created',async()=>{
 const t=fakeTools({left:{exec:0,std:0}}),c=chat(t);const out=flat(await c.say('room for 2 from 10 december to 13 december'));
 assert.match(out,/no room available/);assert.match(out,/14 December 2026/);assert.equal(t.log.filter(l=>l[0]==='create').length,0);
});
test('room sold between summary and confirmation is caught by the recheck',async()=>{
 const t=fakeTools(),c=chat(t);for(const m of ['room for 2 from 10 december to 13 december','1','yes','John Adebayo','john@example.com','yes','no'])await c.say(m);
 t.state.left.exec=0;const out=flat(await c.say('yes'));assert.match(out,/just been taken/);assert.equal(t.log.filter(l=>l[0]==='create').length,0);
});
test('if the price changed since the summary, the guest must re-confirm',async()=>{
 const t=fakeTools(),c=chat(t);for(const m of ['room for 2 from 10 december to 13 december','1','yes','John Adebayo','john@example.com','yes','no'])await c.say(m);
 const orig=t.calculateBookingPrice;t.calculateBookingPrice=async(a)=>({...(await orig(a)),total:150000,subtotal:150000,accommodation:150000,deposit:150000});
 const out=flat(await c.say('yes'));assert.match(out,/price for these dates has changed/);assert.equal(t.log.filter(l=>l[0]==='create').length,0);
});
test('a guest saying "I have paid" is verified with Paystack, never trusted',async()=>{
 const t=fakeTools(),c=chat(t);for(const m of ['room for 2 from 10 december to 13 december','1','yes','John Adebayo','john@example.com','yes','no','yes'])await c.say(m);
 assert.equal(c.conv.state,'AWAITING_PAYMENT');
 const out=flat(await c.say('I have paid, see screenshot'));assert.match(out,/haven't received a payment confirmation/);assert.equal(c.conv.state,'AWAITING_PAYMENT');assert.ok(t.log.some(l=>l[0]==='verify'));
 t.state.paid=true;await c.say('I have paid');assert.equal(c.conv.state,'BOOKING_CONFIRMED');
});
test('returning guest is asked to confirm saved details, old dates are not reused',async()=>{
 const t=fakeTools({profile:{wa:'2348031234567',name:'Ada Okafor',email:'ada@example.com'}}),c=chat(t);
 for(const m of ['room for 2 from 10 december to 13 december','1','yes'])await c.say(m);
 assert.match(c.lastText(),/Welcome back, Ada/);assert.match(c.lastText(),/ada@example.com/);
 await c.say('yes');assert.equal(c.conv.ctx.guest.email,'ada@example.com');assert.equal(c.conv.ctx.step,'phone');
});
test('a different phone number can be given and is validated',async()=>{
 const t=fakeTools(),c=chat(t);for(const m of ['room for 2 from 10 december to 13 december','1','yes','John Adebayo','john@example.com'])await c.say(m);
 assert.match(flat(await c.say('12345')),/valid phone/);await c.say('0803 111 2222');assert.equal(c.conv.ctx.guest.phone,'2348031112222');
});
test('guest can edit the email at the final summary',async()=>{
 const c=chat(fakeTools());for(const m of ['room for 2 from 10 december to 13 december','1','yes','John Adebayo','john@example.com','yes','no'])await c.say(m);
 assert.match(flat(await c.say('edit email')),/email address/);await c.say('john.new@example.com');assert.match(c.lastText(),/john.new@example.com/);assert.equal(c.conv.state,'BOOKING_SUMMARY');
});
test('hotel information comes only from the hotel; missing facts are not invented',async()=>{
 const c=chat(fakeTools());
 assert.match(flat(await c.say('Do you have a swimming pool?')),/Swimming pool/);assert.match(flat(await c.say('Do you have a gym?')),/don't have gym details/);
 assert.match(flat(await c.say('Is breakfast included?')),/don't have breakfast details/);assert.match(flat(await c.say('what time is check in')),/from 2pm/);
 assert.match(flat(await c.say('where are you located')),/12 Marina/);assert.match(flat(await c.say('any landmarks nearby')),/near the airport/);
});
test('price question lists real prices and asks for dates',async()=>{const c=chat(fakeTools());const out=flat(await c.say('Abeg, how much is your room?'));assert.match(out,/₦45,000/);assert.match(out,/₦25,000/);assert.equal(c.conv.ctx.expect,'checkIn')});
test('asking for a person hands over and stops the flow',async()=>{const c=chat(fakeTools());await c.say('I want to speak with someone');assert.equal(c.conv.state,'HUMAN_HANDOVER');assert.deepEqual(c.effects.map(e=>e.t),['handover'])});
test('booking lookup uses the verified WhatsApp number; receipts only exist after verified payment',async()=>{
 const t=fakeTools();t.state.reservations.push({id:'r9',reference:'KK-12345678',status:'confirmed',total:135000,phone:'2348031234567',paid:true,email:'a@b.co'});
 const c=chat(t);assert.match(flat(await c.say('show my booking')),/KK-12345678/);
 const rs=await c.say('get my receipt');assert.match(rs.find(r=>r.kind==='cta').url,/receipt\?token=/);
 const other=chat(t);other.conv.waId='2349999999999';assert.match(flat(await other.say('show my booking')),/couldn't find a booking/);
});
test('a booking under another number needs reference plus its email',async()=>{
 const t=fakeTools();t.state.reservations.push({id:'r9',reference:'KK-12345678',status:'confirmed',total:1,phone:'2348000000000',paid:true,email:'owner@x.co'});
 const c=chat(t);c.conv.waId='2349999999999';assert.match(flat(await c.say('show booking KK-12345678')),/email address/);
 assert.match(flat(await c.say('wrong@x.co')),/doesn't match/);assert.match(flat(await c.say('owner@x.co')),/KK-12345678/);
});
test('cancelling a paid booking is a request for staff, not automatic',async()=>{
 const t=fakeTools();t.state.reservations.push({id:'r9',reference:'KK-12345678',status:'confirmed',total:1,phone:'2348031234567',paid:true,email:'a@b.co'});
 const c=chat(t);assert.match(flat(await c.say('cancel my reservation')),/Free until 48h/);assert.match(flat(await c.say('yes')),/request has been received/);
});
test('unclear messages get the help menu, three in a row flag staff; Groq failure changes nothing',async()=>{
 const ai=async()=>{throw new Error('down')};const c=chat(fakeTools(),{ai});
 for(let i=0;i<3;i++)assert.match(flat(await c.say('qwerty asdf zxcv')),/couldn't quite understand/);assert.ok(c.effects.some(e=>e.t==='flag'));
 assert.match(flat(await c.say('hello')),/Welcome/);
});
test('Groq can interpret a vague message, but dates it gives are confirmed and facts still come from the backend',async()=>{
 const ai=async()=>({intent:'ROOM_SEARCH',confidence:.8,entities:{adults:4,preferences:['family','space']},needsClarification:false});
 const c=chat(fakeTools(),{ai});const out=flat(await c.say("I'm looking for somewhere comfortable for my family, preferably with enough space"));
 assert.equal(c.conv.ctx.known.adults,4);assert.match(out,/check in/);
});
test('stop opts the guest out',async()=>{const c=chat(fakeTools());await c.say('STOP');assert.deepEqual(c.effects.map(e=>e.t),['optout'])});
