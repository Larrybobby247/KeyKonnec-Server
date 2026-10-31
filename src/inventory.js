const {Night,Room,Hold,Reservation}=require('./models');
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
// Physical rooms of the booked type that nobody else holds for these dates (not in maintenance, not assigned to an overlapping confirmed or checked-in stay).
const byNumber=(a,b)=>String(a.number).localeCompare(String(b.number),undefined,{numeric:true});
async function freeRoomList(r){const busy=await Reservation.find({roomType:r.roomType,_id:{$ne:r._id},status:{$in:['confirmed','checked_in']},checkIn:{$lt:r.checkOut},checkOut:{$gt:r.checkIn}}).select('assignedRooms').lean(),
 taken=new Set(busy.flatMap(x=>(x.assignedRooms||[]).map(String)));
 return(await Room.find({roomType:r.roomType,active:true,status:{$nin:['maintenance','out_of_service']}}).lean()).filter(x=>!taken.has(String(x._id))).sort(byNumber)}
// Gives a reservation its rooms automatically: keeps rooms it already holds (if still free) and fills the rest with the first free rooms of the type. Saves and returns the room ids.
async function assignRooms(r){if(!['confirmed','checked_in'].includes(r.status))return r.assignedRooms||[];const free=await freeRoomList(r),ok=new Set(free.map(x=>String(x._id)));
 const keep=(r.assignedRooms||[]).filter(x=>ok.has(String(x))).slice(0,r.qty),have=new Set(keep.map(String)),add=free.filter(x=>!have.has(String(x._id))).slice(0,Math.max(0,r.qty-keep.length)).map(x=>x._id),ids=[...keep,...add];
 await Reservation.updateOne({_id:r._id},{assignedRooms:ids});r.assignedRooms=ids;return ids}
module.exports={nightsOf,reserve,release,freeRooms,expireHolds,capacity,freeRoomList,assignRooms};
