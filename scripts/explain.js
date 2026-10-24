// Usage: node scripts/explain.js  (reads MONGODB_URI from .env). Shows whether the hottest queries use an index and how many documents they scan.
require('dotenv').config();const m=require('mongoose'),D=require('../src/models');
m.connect(process.env.MONGODB_URI).then(async()=>{const h=await D.Hotel.findOne().lean();if(!h){console.log('No hotels yet: create some data first.');process.exit()}
 const rt=await D.RoomType.findOne({hotel:h._id}).lean(),now=new Date(),Q=[
  ['reservations list (status filter, newest arrival first)',D.Reservation.find({hotel:h._id,status:'confirmed'}).sort({checkIn:-1}).limit(20)],
  ['reservations list (default)',D.Reservation.find({hotel:h._id}).sort({checkIn:-1}).limit(20)],
  ['monthly booking count',D.Reservation.find({hotel:h._id,createdAt:{$gte:new Date(now.getFullYear(),now.getMonth(),1)}})],
  ['guest lookup by email',D.Reservation.find({hotel:h._id,'guest.email':'a@b.com'})],
  ['payments list',D.Payment.find({hotel:h._id}).sort({createdAt:-1}).limit(30)],
  ['bookable room count (every availability check)',rt?D.Room.find({roomType:rt._id,active:true,status:{$nin:['maintenance','out_of_service']}}):null],
  ['night inventory for a stay',rt?D.Night.find({roomType:rt._id,date:{$gte:now,$lt:new Date(+now+7*864e5)}}):null],
  ['hold expiry job',D.Hold.find({status:'active',expiresAt:{$lt:now}}).limit(200)],
  ['audit log page',D.Audit.find({hotel:h._id}).sort({createdAt:-1}).limit(50)]];
 for(const [n,q] of Q){if(!q)continue;const e=await q.explain('executionStats'),x=e.executionStats,st=JSON.stringify(e.queryPlanner.winningPlan);console.log(`${n}\n  ${x.executionTimeMillis} ms, returned ${x.nReturned}, examined ${x.totalDocsExamined} docs / ${x.totalKeysExamined} keys, ${/IXSCAN/.test(st)?'uses an index':'COLLECTION SCAN'}`)}
 process.exit()});
