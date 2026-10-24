const {Night,Room,Hold}=require('./models');
const nightsOf=(a,b)=>{const r=[];for(let d=new Date(a);d<new Date(b);d.setUTCDate(d.getUTCDate()+1))r.push(new Date(d));return r};
const capacity=rt=>Room.countDocuments({roomType:rt,active:true,status:{$nin:['maintenance','out_of_service']}});
const release=(rt,dates,qty)=>Night.updateMany({roomType:rt,date:{$in:dates}},{$inc:{used:-qty}});
// Atomic per-night allocation: the unique (roomType,date) index makes a failed conditional upsert throw E11000, so the last room is never sold twice.
async function reserve(rt,a,b,qty){const cap=await capacity(rt);if(qty>cap)throw new Error('SOLD_OUT');const done=[];
 try{for(const d of nightsOf(a,b)){try{await Night.findOneAndUpdate({roomType:rt,date:d,used:{$lte:cap-qty}},{$inc:{used:qty}},{upsert:true})}catch(e){throw e.code===11000?new Error('SOLD_OUT'):e}done.push(d)}}
 catch(e){await release(rt,done,qty);throw e}}
async function freeRooms(rt,a,b){const cap=await capacity(rt);const [x]=await Night.aggregate([{$match:{roomType:rt,date:{$gte:new Date(a),$lt:new Date(b)}}},{$group:{_id:null,max:{$max:'$used'}}}]);return cap-(x?x.max:0)}
async function expireHolds(){const hs=await Hold.find({status:'active',expiresAt:{$lt:new Date()}}).limit(200);
 for(const h of hs){const u=await Hold.updateOne({_id:h._id,status:'active'},{status:'expired'});if(u.modifiedCount)await release(h.roomType,nightsOf(h.checkIn,h.checkOut),h.qty)}}
module.exports={nightsOf,reserve,release,freeRooms,expireHolds,capacity};
