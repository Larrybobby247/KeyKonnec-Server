// Branch management, per-branch room availability for a reservation, and the charts/analytics behind Overview and Reports.
// Reports grow with the plan: basic (Free, Starter) -> plus (reports_plus: Growth) -> pro (analytics: Professional).
const D=require('./models'),bill=require('./billing'),inv=require('./inventory');
const {z}=require('zod'),mongoose=require('mongoose');
const OID=x=>new mongoose.Types.ObjectId(String(x)),dk=x=>new Date(x).toISOString().slice(0,10),r0=n=>Math.round(n),r1=n=>Math.round(n*10)/10;
const pct=(a,b)=>b?r1((a-b)/b*100):null;
exports.mount=({api,auth,need,audit,parse,wrap})=>{
 const MB=q=>q.user.memberships[0].branches.map(String),scope=q=>q.query.branch&&MB(q).includes(String(q.query.branch))?[String(q.query.branch)]:MB(q),own=need('owner');
 // ---- branches (Professional)
 api.get('/branches',auth,own,wrap(async(q,s)=>{const bs=await D.Branch.find({hotel:q.hotelId}).sort({createdAt:1}).lean(),ids=bs.map(b=>b._id);
  const [types,rooms,e]=await Promise.all([D.RoomType.aggregate([{$match:{hotel:OID(q.hotelId),branch:{$in:ids}}},{$group:{_id:'$branch',n:{$sum:1}}}]),D.Room.aggregate([{$match:{hotel:OID(q.hotelId),branch:{$in:ids}}},{$group:{_id:'$branch',n:{$sum:1}}}]),bill.entitlements(q.hotelId)]);
  s.json({limit:e.plan.branches,canAdd:e.plan.features.includes('multi_branch')&&(!e.plan.branches||bs.length<e.plan.branches),items:bs.map(b=>({...b,roomTypes:(types.find(x=>String(x._id)===String(b._id))||{}).n||0,rooms:(rooms.find(x=>String(x._id)===String(b._id))||{}).n||0}))})}));
 api.patch('/branches/:id',auth,own,wrap(async(q,s)=>{const b=parse(z.object({name:z.string().min(2).max(60),address:z.string().max(200),status:z.enum(['active','inactive'])}).partial(),q.body),br=await D.Branch.findOne({_id:q.params.id,hotel:q.hotelId});if(!br)return s.sendStatus(404);
  if(b.status==='inactive'){if(await D.Branch.countDocuments({hotel:q.hotelId,status:'active',_id:{$ne:br._id}})<1)return s.status(409).json({error:'You need at least one active branch.'});
   if(await D.Reservation.exists({branch:br._id,status:{$in:['confirmed','checked_in','requested']},checkOut:{$gt:new Date()}}))return s.status(409).json({error:'This branch still has current or upcoming bookings. Move or cancel them first.'})}
  Object.assign(br,b);await br.save();await audit(q,'branch.update','Branch',br.id,b);s.json(br)}));
 // ---- which rooms can a reservation use? (free = nobody else holds it for those dates)
 api.get('/reservations/:id/rooms',auth,need('owner','manager','receptionist'),wrap(async(q,s)=>{const r=await D.Reservation.findOne({_id:q.params.id,hotel:q.hotelId,branch:{$in:MB(q)}});if(!r)return s.sendStatus(404);
  const all=await D.Room.find({roomType:r.roomType,active:true}).lean(),free=new Set((await inv.freeRoomList(r)).map(x=>String(x._id))),mine=new Set((r.assignedRooms||[]).map(String));
  s.json({qty:r.qty,rooms:all.sort((a,b)=>String(a.number).localeCompare(String(b.number),undefined,{numeric:true})).map(x=>({_id:x._id,number:x.number,status:x.status,mine:mine.has(String(x._id)),free:mine.has(String(x._id))||free.has(String(x._id)),reason:['maintenance','out_of_service'].includes(x.status)?x.status.replace('_',' '):free.has(String(x._id))||mine.has(String(x._id))?null:'booked'}))})}));
 // ---- analytics
 api.get('/reports/dashboard',auth,need('owner','manager','accountant','receptionist'),wrap(async(q,s)=>{
  const ent=await bill.entitlements(q.hotelId),F=ent.plan.features,tier=F.includes('analytics')?'pro':F.includes('reports_plus')?'plus':'basic',days=[7,14,30,90].includes(+q.query.days)?+q.query.days:30;
  const ids=scope(q),br=ids.map(OID),H=OID(q.hotelId),now=new Date(),today=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())),from=new Date(+today-(days-1)*864e5),to=new Date(+today+864e5),prevFrom=new Date(+from-days*864e5);
  const [branches,types,rooms]=await Promise.all([D.Branch.find({hotel:q.hotelId,_id:{$in:ids}}).select('name').lean(),D.RoomType.find({hotel:q.hotelId,branch:{$in:ids}}).select('name branch').lean(),D.Room.find({hotel:q.hotelId,branch:{$in:ids},active:true}).select('branch roomType status').lean()]);
  const typeIds=types.map(t=>t._id),tn=id=>(types.find(t=>String(t._id)===String(id))||{}).name||'Removed room type',bn=id=>(branches.find(b=>String(b._id)===String(id))||{}).name||'Branch';
  const payMatch={hotel:H,branch:{$in:br},status:'success',createdAt:{$gte:prevFrom,$lt:to},$or:[{source:'platform'},{verified:true}]};
  const occFrom=new Date(+today-(Math.min(days,30)-1)*864e5),occTo=new Date(+today+14*864e5),monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
  const [pays,resv,nights,snap,flagged]=await Promise.all([
   D.Payment.aggregate([{$match:payMatch},{$group:{_id:{d:{$dateToString:{format:'%Y-%m-%d',date:'$createdAt'}},m:'$source',b:'$branch'},v:{$sum:{$subtract:['$amount',{$ifNull:['$refundedAmount',0]}]}},n:{$sum:1}}}]),
   D.Reservation.find({hotel:q.hotelId,branch:{$in:ids},createdAt:{$gte:prevFrom,$lt:to}}).select('status source roomType branch createdAt checkIn checkOut total paid qty accommodation guest.email guest.name adults').limit(20000).lean(),
   D.Night.aggregate([{$match:{roomType:{$in:typeIds},date:{$gte:occFrom,$lt:occTo}}},{$group:{_id:{d:'$date',t:'$roomType'},used:{$sum:'$used'}}}]),
   Promise.all([D.Reservation.countDocuments({hotel:H,branch:{$in:br},status:'confirmed',checkIn:{$gte:today,$lt:to}}),D.Reservation.countDocuments({hotel:H,branch:{$in:br},status:'checked_in',checkOut:{$gte:today,$lt:to}}),D.Reservation.countDocuments({hotel:H,branch:{$in:br},status:'checked_in'}),D.Reservation.countDocuments({hotel:H,branch:{$in:br},paymentStatus:{$ne:'paid'},status:{$in:['pending','confirmed']}}),D.Reservation.countDocuments({hotel:H,branch:{$in:br},status:'requested'}),
    D.Payment.aggregate([{$match:{hotel:H,branch:{$in:br},status:'success',createdAt:{$gte:monthStart},$or:[{source:'platform'},{verified:true}]}},{$group:{_id:null,v:{$sum:{$subtract:['$amount',{$ifNull:['$refundedAmount',0]}]}}}}])]),
   D.Payment.countDocuments({hotel:H,branch:{$in:br},status:{$in:['flagged','needs_refund']}})]);
  // time series
  const dayList=n=>Array.from({length:n},(_,i)=>dk(+from+i*864e5)),dl=dayList(days);
  const rev={},revPrev={};let revenue=0,revenuePrev=0;const methods={},revByBranch={};
  for(const p of pays){const d=p._id.d;if(d>=dk(from)){rev[d]=(rev[d]||0)+p.v;revenue+=p.v;methods[p._id.m]=(methods[p._id.m]||0)+p.v;revByBranch[p._id.b]=(revByBranch[p._id.b]||0)+p.v}else{revPrev[d]=(revPrev[d]||0)+p.v;revenuePrev+=p.v}}
  const good=r=>!['cancelled','expired','pending'].includes(r.status),cur=resv.filter(r=>r.createdAt>=from),prev=resv.filter(r=>r.createdAt<from),okc=cur.filter(good),okp=prev.filter(good);
  const bk={};okc.forEach(r=>{const d=dk(r.createdAt);bk[d]=(bk[d]||0)+1});
  const nightsOf=r=>Math.max(1,Math.round((new Date(r.checkOut)-new Date(r.checkIn))/864e5));
  // occupancy
  const capByType={};rooms.filter(r=>!['maintenance','out_of_service'].includes(r.status)).forEach(r=>{capByType[r.roomType]=(capByType[r.roomType]||0)+1});const cap=Object.values(capByType).reduce((a,b)=>a+b,0);
  const usedByDay={},usedByDayBranch={};for(const n of nights){const d=dk(n._id.d);usedByDay[d]=(usedByDay[d]||0)+n.used;const b=String((types.find(t=>String(t._id)===String(n._id.t))||{}).branch);(usedByDayBranch[b]=usedByDayBranch[b]||{})[d]=(usedByDayBranch[b][d]||0)+n.used}
  const occ=[];for(let t=+occFrom;t<+occTo;t+=864e5){const d=dk(t),u=usedByDay[d]||0;occ.push({d,used:Math.min(u,cap||u),rooms:cap,pct:cap?r0(Math.min(100,u/cap*100)):0,future:t>+today})}
  const next14=occ.filter(o=>o.d>=dk(today)),avgOcc=next14.length?r0(next14.reduce((a,o)=>a+o.pct,0)/next14.length):0;
  const todayOcc=(occ.find(o=>o.d===dk(today))||{}).pct||0;const stat={};cur.forEach(r=>{stat[r.status]=(stat[r.status]||0)+1});
  const out={tier,days,generatedAt:new Date(),scope:{all:ids.length===MB(q).length&&MB(q).length>1,branches:branches.map(b=>({id:b._id,name:b.name})),rooms:rooms.length},
   today:{arrivals:snap[0],departures:snap[1],inHouse:snap[2],unpaid:snap[3],requests:snap[4],monthRevenue:(snap[5][0]||{}).v||0,needsAttention:flagged,occupancyToday:todayOcc},
   kpis:{revenue:r0(revenue),revenueChange:pct(revenue,revenuePrev),bookings:okc.length,bookingsChange:pct(okc.length,okp.length),occupancyAvg:avgOcc,cancelled:cur.filter(r=>r.status==='cancelled').length},
   series:{revenue:dl.map(d=>({d,v:r0(rev[d]||0)})),bookings:dl.map(d=>({d,v:bk[d]||0}))},occupancy:occ,status:Object.entries(stat).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v),locked:[]};
  const byType={};okc.forEach(r=>{const o=byType[r.roomType]||(byType[r.roomType]={id:r.roomType,name:tn(r.roomType),bookings:0,nights:0,revenue:0});o.bookings++;o.nights+=nightsOf(r)*(r.qty||1);o.revenue+=r.paid||0});
  const typeRows=Object.values(byType).sort((a,b)=>b.revenue-a.revenue||b.bookings-a.bookings);
  if(tier==='basic'){out.locked=['Best room types','Booking sources','Busiest days','Average stay and booking value','Cancellation rate','Payment methods']}
  else{const nv=okc.length;out.kpis.avgValue=nv?r0(okc.reduce((a,r)=>a+(r.total||0),0)/nv):0;out.kpis.avgStay=nv?r1(okc.reduce((a,r)=>a+nightsOf(r),0)/nv):0;out.kpis.cancelRate=cur.length?r1(out.kpis.cancelled/cur.length*100):0;
   out.byRoomType=typeRows;out.best=typeRows[0]||null;const src={};okc.forEach(r=>{src[r.source]=(src[r.source]||0)+1});out.bySource=Object.entries(src).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v);
   const wd=Array(7).fill(0);okc.forEach(r=>{wd[new Date(r.checkIn).getUTCDay()]++});out.weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((l,i)=>({l,v:wd[i]}));
   out.methods=Object.entries(methods).map(([k,v])=>({k:k==='platform'?'Online (Paystack)':'Recorded by hotel',v:r0(v)}));
   if(tier==='plus')out.locked=['ADR and revenue per room','Branch comparison','Booking lead time','Repeat guests and top guests','Revenue forecast','No-show rate']}
  if(tier==='pro'){const nightsSold=okc.reduce((a,r)=>a+nightsOf(r)*(r.qty||1),0),acc=okc.reduce((a,r)=>a+(r.accommodation||0),0);out.adr=nightsSold?r0(acc/nightsSold):0;out.revpar=cap?r0(acc/(cap*days)):0;
   const lead=okc.map(r=>(new Date(r.checkIn)-new Date(r.createdAt))/864e5).filter(x=>x>=0);out.leadTime=lead.length?r1(lead.reduce((a,b)=>a+b,0)/lead.length):0;out.noShowRate=cur.length?r1(cur.filter(r=>r.status==='no_show').length/cur.length*100):0;
   const g={};okc.forEach(r=>{const e=(r.guest&&r.guest.email||'').toLowerCase();if(!e)return;const o=g[e]||(g[e]={name:r.guest.name,email:e,stays:0,spent:0});o.stays++;o.spent+=r.paid||0});const gl=Object.values(g);out.repeatGuests=gl.filter(x=>x.stays>1).length;out.topGuests=gl.sort((a,b)=>b.spent-a.spent).slice(0,5);
   const fut=await D.Reservation.find({hotel:q.hotelId,branch:{$in:ids},status:{$in:['confirmed','checked_in']},checkIn:{$gte:today,$lt:new Date(+today+30*864e5)}}).select('total paid').lean();out.forecast={bookings:fut.length,value:r0(fut.reduce((a,r)=>a+(r.total||0),0)),collected:r0(fut.reduce((a,r)=>a+(r.paid||0),0))};
   if(ids.length>1){out.byBranch=ids.map(id=>{const rs=okc.filter(r=>String(r.branch)===id),bt=Object.values(rs.reduce((m,r)=>{(m[r.roomType]=m[r.roomType]||{n:tn(r.roomType),c:0}).c++;return m},{})).sort((a,b)=>b.c-a.c)[0],bc=rooms.filter(r=>String(r.branch)===id&&!['maintenance','out_of_service'].includes(r.status)).length,ub=usedByDayBranch[id]||{},nx=next14.map(o=>ub[o.d]||0);
     return{id,name:bn(id),revenue:r0(revByBranch[id]||0),bookings:rs.length,rooms:bc,occupancy:bc&&nx.length?r0(nx.reduce((a,b)=>a+b,0)/nx.length/bc*100):0,bestRoomType:bt?bt.n:null}}).sort((a,b)=>b.revenue-a.revenue)}}
  s.json(out)}));
};
