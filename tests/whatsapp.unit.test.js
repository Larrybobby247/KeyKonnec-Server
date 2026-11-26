// Pure unit tests (no database): npm test runs these with the rest.
const {test}=require('node:test'),assert=require('node:assert');
const nlu=require('../src/whatsapp/nlu'),groq=require('../src/whatsapp/groq'),secret=require('../src/whatsapp/secret');
const today=nlu.utc(2026,11,25);// Wednesday
const read=(t,c={})=>nlu.read(t,{today,...c}),d=x=>x&&nlu.iso(x.date);

test('greetings, rooms, price, booking and staff are recognised',()=>{
 for(const t of ['Hello','Hi','good morning'])assert.equal(read(t).intent,'GREETING');
 for(const t of ['Do you have available rooms?','Show me your available rooms.'])assert.equal(read(t).intent,'ROOMS');
 for(const t of ['How much is your room?','Abeg, how much is your room?','How much for one night?'])assert.equal(read(t).intent,'PRICE');
 for(const t of ['I want to book','I need a room','I want to book the executive room'])assert.equal(read(t).intent,'BOOK');
 assert.equal(read('I want to speak with someone').intent,'HUMAN');
 assert.equal(read('I want to pay').intent,'PAY');assert.equal(read('Show my booking').intent,'MY_BOOKING');assert.equal(read('Cancel my reservation').intent,'CANCEL');
 assert.equal(read('get my receipt').intent,'RECEIPT');assert.equal(read('i have paid').intent,'PAID_CLAIM');
});
test('hotel information topics',()=>{assert.deepEqual(read('Do you have a swimming pool?').topics,['pool']);assert.equal(read('Do you have a swimming pool?').intent,'INFO');assert.deepEqual(read('Is breakfast included?').topics,['breakfast'])});
test('dates use the hotel calendar day and understand tomorrow, weekdays and ranges',()=>{
 let r=read('I want to check in tomorrow and leave on Monday');assert.equal(d(r.dates.checkIn),'2026-11-26');assert.equal(d(r.dates.checkOut),'2026-11-30');
 r=read('I will check out on Sunday');assert.equal(d(r.dates.checkOut),'2026-11-29');
 r=read('from 10 december to 13 december');assert.equal(d(r.dates.checkIn),'2026-12-10');assert.equal(d(r.dates.checkOut),'2026-12-13');
 r=read('10-13 dec for 2 people');assert.equal(d(r.dates.checkIn),'2026-12-10');assert.equal(d(r.dates.checkOut),'2026-12-13');assert.equal(r.counts.adults,2);
 r=read('I need a place for two nights');assert.equal(r.dates.nights,2);
 r=read('tomorrow for 3 nights');assert.equal(d(r.dates.checkOut),'2026-11-29');
 assert.equal(nlu.iso(nlu.todayIn('Africa/Lagos',new Date('2026-11-25T23:30:00Z'))),'2026-11-26');// already tomorrow in Lagos
});
test('a short reply is read using what we just asked',()=>{
 assert.equal(d(read('Friday',{expectDate:'checkIn'}).dates.checkIn),'2026-11-27');
 const r=read('Monday',{expectDate:'checkOut',known:{checkIn:nlu.utc(2026,11,26)}});assert.equal(d(r.dates.checkOut),'2026-11-30');assert.ok(!r.dates.checkIn);
 assert.equal(read('2',{expectCount:'guests'}).counts.adults,2);const g=read('2 and 1 child',{expectCount:'guests'});assert.equal(g.counts.adults,2);assert.equal(g.counts.children,1);
});
test('ambiguous dates are flagged, never silently assumed',()=>{
 assert.equal(read('check in 10/12/2026').dates.checkIn.ambiguous,true);
 assert.equal(read('check in 25/12/2026').dates.checkIn.ambiguous,false);
 assert.equal(read('this weekend').dates.checkIn.ambiguous,true);
 assert.equal(read('next week').dates.needsExact,'next week');
 const w=read('friday',{today:nlu.utc(2026,11,27)});assert.equal(w.dates.checkIn.ambiguous,true);// said on a Friday: today or next week?
 assert.equal(read('31 february').dates.checkIn,undefined);
});
test('counts: people, rooms, children, pidgin',()=>{
 assert.equal(read('I need an apartment for five people').counts.adults,5);
 const c=read('i need 2 rooms for 4 people and 2 kids').counts;assert.deepEqual([c.rooms,c.adults,c.children],[2,4,2]);
 assert.equal(read('i wan book room tomorrow for 2 people').counts.adults,2);
 assert.equal(read('just me').counts.adults,1);
});
test('email and phone validation',()=>{
 assert.equal(nlu.readEmail('its john@example.com thanks').value,'john@example.com');
 for(const bad of ['john@example','john@@x.com','john@.com','a b@x.com','john@x.c'])assert.equal(nlu.validEmail(bad),false,bad);
 assert.equal(nlu.validEmail('john.a+b@mail.example.co.uk'),true);
 assert.equal(nlu.readPhone('call me on 0803 123 4567'),'2348031234567');assert.equal(nlu.normPhone('+2348031234567'),'2348031234567');assert.equal(nlu.normPhone('12345'),null);
});
test('names: the profile name is never assumed, one word is not a full name',()=>{
 assert.deepEqual(nlu.readName('my name is john adebayo'),{value:'John Adebayo',full:true});assert.equal(nlu.readName('yes'),null);assert.equal(nlu.readName('John').full,false);assert.equal(nlu.readName('call me 08031234567'),null);
});
test('room selection by name, position and category',()=>{
 const t=[{id:1,name:'Executive Suite'},{id:2,name:'Standard Room'},{id:3,name:'One-Bedroom Apartment'}];
 assert.equal(nlu.matchRoomType('I want to book the executive room',t).type.id,1);assert.equal(nlu.matchRoomType('2',t,[1,2,3]).type.id,2);assert.equal(nlu.matchRoomType('the last one',t,[1,2,3]).type.id,3);assert.equal(nlu.matchRoomType('deluxe',t).type,null);
});
test('token encryption round-trips and detects tampering',()=>{
 process.env.WA_TOKEN_KEY='a'.repeat(64);const e=secret.encrypt('EAAB-token');assert.notEqual(e,'EAAB-token');assert.equal(secret.decrypt(e),'EAAB-token');
 const parts=e.split('.');parts[3]=Buffer.from('x'.repeat(12)).toString('base64');assert.throws(()=>secret.decrypt(parts.join('.')));
 const body=Buffer.from('{"a":1}'),sig='sha256='+require('crypto').createHmac('sha256','s').update(body).digest('hex');assert.equal(secret.validMetaSignature(body,sig,'s'),true);assert.equal(secret.validMetaSignature(body,sig,'t'),false);
});
// ---- Groq: output validation, PII scrubbing, circuit breaker
const ok=(o)=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({choices:[{message:{content:JSON.stringify(o)}}],usage:{total_tokens:50}})});
const fail=(status,text='',h={})=>({ok:false,status,headers:{get:k=>h[k]??null},text:async()=>text});
const setup=(f)=>{Object.assign(process.env,{GROQ_ENABLED:'true',GROQ_API_KEY:'k',GROQ_MODEL:'m'});groq.reset();groq._test.breaker.consecutive=0;groq._test.setFetch(f);let now=1e12;groq._test.setClock(()=>now);return {advance:ms=>{now+=ms}}};
test('groq output is validated down to safe fields',async()=>{
 setup(async()=>ok({intent:'book',confidence:2,entities:{checkIn:'2026-12-10',adults:'3',rooms:99,roomTypeName:'Suite',preferences:['family','drop table'],sql:'x'},needsClarification:false}));
 const r=await groq.interpret({message:'hi',today:'2026-11-25'});assert.equal(r.intent,'BOOK');assert.equal(r.confidence,1);assert.equal(r.entities.adults,3);assert.equal(r.entities.rooms,undefined);assert.deepEqual(r.entities.preferences,['family']);assert.equal(r.entities.sql,undefined);
 assert.throws(()=>groq.validate({intent:'DELETE_EVERYTHING'}),/Unknown intent/);assert.throws(()=>groq.validate('no json here'));
 assert.equal(groq.validate({intent:'BOOK',entities:{checkIn:'2020-01-01'}},{today:nlu.utc(2026,11,25)}).entities.checkIn,undefined);
});
test('groq never receives emails or phone numbers',()=>{const s=groq.scrub('mail me at john@example.com or 0803 123 4567 about KK-ABCDEF12');assert.ok(!/john|0803|ABCDEF/.test(s))});
test('a daily quota stops all calls until the quota resets, with no retries',async()=>{
 let calls=0;const c=setup(async()=>{calls++;return fail(429,'Rate limit reached for model on tokens per day (TPD)')});
 await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'rate_limited'});assert.equal(calls,1);
 for(let i=0;i<5;i++)await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}));assert.equal(calls,1);assert.equal(groq.status().state,'open');assert.equal(groq.status().reason,'daily_quota');
});
test('a per-minute limit reopens soon; transient failures retry once then trip after three',async()=>{
 let calls=0;let c=setup(async()=>{calls++;return fail(429,'requests per minute',{'retry-after':'7'})});
 await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}));assert.equal(groq.status().reason,'rate_limited');c.advance(8000);calls=0;groq._test.setFetch(async()=>{calls++;return ok({intent:'GREETING',confidence:.9,entities:{}})});
 assert.equal((await groq.interpret({message:'hi',today:'2026-11-25'})).intent,'GREETING');assert.equal(groq.status().state,'closed');
 calls=0;c=setup(async()=>{calls++;throw Object.assign(new Error('socket hang up'),{})});
 for(let i=0;i<3;i++)await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'network_error'});assert.equal(calls,6);assert.equal(groq.status().state,'open');
 await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'network_error'});assert.equal(calls,6);// breaker open: no new request
});
test('bad credentials, unsupported model and malformed output are handled',async()=>{
 setup(async()=>fail(401,'invalid api key'));await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'invalid_credentials'});assert.equal(groq.status().reason,'invalid_credentials');
 setup(async()=>fail(404,'model not found'));await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'unsupported_model'});
 setup(async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:'sure! here you go'}}]})}));await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'malformed'});
});
test('disabled or unconfigured Groq is never called',async()=>{let calls=0;setup(async()=>{calls++;return ok({intent:'BOOK',confidence:1,entities:{}})});process.env.GROQ_ENABLED='false';await assert.rejects(groq.interpret({message:'x',today:'2026-11-25'}),{code:'disabled'});assert.equal(calls,0);process.env.GROQ_ENABLED='true'});
