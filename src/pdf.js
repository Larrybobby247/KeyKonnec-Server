const PDF=require('pdfkit'),day=x=>new Date(x).toISOString().slice(0,10),n=v=>'NGN '+Number(v||0).toLocaleString('en-NG');
const start=(res,name)=>{const d=new PDF({margin:50});res.type('pdf');res.setHeader('Content-Disposition',`attachment; filename="${name}"`);d.pipe(res);return d};
// ---- Customer receipt: one A4 page, hotel header, stay and payment details, keykonnec watermark.
const INK='#202B2A',MUTED='#74817E',PRIMARY='#0D2B2A',TEAL='#1C5D57',GOLD='#D9A441',MIST='#EEF4F2',LINE='#DCE5E2',nice=x=>new Date(x).toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'});
const watermark=(d,W,H)=>{d.save();d.opacity(0.07).fillColor(PRIMARY).font('Helvetica-Bold').fontSize(104);d.rotate(-32,{origin:[W/2,H/2]});d.text('keykonnec',0,H/2-52,{width:W,align:'center',lineBreak:false});d.restore();d.opacity(1)};
const label=(d,t,x,y,w)=>d.font('Helvetica-Bold').fontSize(7.5).fillColor(TEAL).text(t.toUpperCase(),x,y,{width:w,characterSpacing:1.2,lineBreak:false});
const kv=(d,k,v,x,y,w,o={})=>{d.font('Helvetica').fontSize(9).fillColor(MUTED).text(k,x,y,{width:w*.42,lineBreak:false});d.font(o.bold?'Helvetica-Bold':'Helvetica').fontSize(o.big?11:9.5).fillColor(o.color||INK).text(String(v==null||v===''?'-':v),x+w*.42,y,{width:w*.58,align:'right',lineBreak:true,height:o.h||24,ellipsis:true})};
exports.receipt=(res,{hotel,r,p,type,rooms=[],payments=[]})=>{const d=new PDF({margin:0,size:'A4',info:{Title:'Payment receipt '+p.reference,Author:hotel.name,Producer:'keykonnec'}});res.type('pdf');res.setHeader('Content-Disposition',`attachment; filename="receipt-${p.reference}.pdf"`);d.pipe(res);
 const W=595.28,H=841.89,M=42,CW=W-M*2,nights=Math.max(1,Math.round((new Date(r.checkOut)-new Date(r.checkIn))/864e5)),paid=Math.min(r.total,r.paid)||r.paid,bal=Math.max(0,r.total-r.paid),full=bal<=0,pol=hotel.policies||{};
 // header band
 d.rect(0,0,W,118).fill(PRIMARY);d.rect(0,118,W,4).fill(GOLD);
 d.font('Helvetica-Bold').fontSize(22).fillColor('#fff').text(hotel.name,M,32,{width:CW*.62,lineBreak:false,ellipsis:true});
 d.font('Helvetica').fontSize(9).fillColor('#BFD6D0').text([hotel.address,hotel.phone].filter(Boolean).join('   |   ')||' ',M,62,{width:CW*.62,height:24,ellipsis:true});
 d.font('Helvetica-Bold').fontSize(11).fillColor(GOLD).text('PAYMENT RECEIPT',M+CW*.55,34,{width:CW*.45,align:'right',characterSpacing:1.5,lineBreak:false});
 d.font('Helvetica-Bold').fontSize(13).fillColor('#fff').text('# '+p.reference.slice(-12).toUpperCase(),M+CW*.55,52,{width:CW*.45,align:'right',lineBreak:false});
 d.font('Helvetica').fontSize(9).fillColor('#BFD6D0').text('Issued '+nice(p.createdAt||new Date()),M+CW*.55,74,{width:CW*.45,align:'right',lineBreak:false});
 // paid stamp
 d.save();d.rotate(-8,{origin:[W-M-60,152]});d.roundedRect(W-M-120,138,120,34,6).lineWidth(2).strokeColor(full?'#176B47':'#B7791F').stroke();d.font('Helvetica-Bold').fontSize(15).fillColor(full?'#176B47':'#B7791F').text(full?'PAID IN FULL':'PART PAYMENT',W-M-120,148,{width:120,align:'center',lineBreak:false});d.restore();
 // billed to / receipt details
 let y=146;const half=(CW-20)/2;label(d,'Billed to',M,y,half);d.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(r.guest.name,M,y+14,{width:half,lineBreak:false,ellipsis:true});
 d.font('Helvetica').fontSize(9.5).fillColor(MUTED).text([r.guest.email,r.guest.phone].filter(Boolean).join('\n')||' ',M,y+33,{width:half,height:28});
 y=212;
 // stay card
 const card=(x,yy,w,h,title)=>{d.roundedRect(x,yy,w,h,8).fillAndStroke('#ffffffD9'.slice(0,7),LINE);label(d,title,x+16,yy+14,w-32)};
 card(M,y,CW,190,'Your booking');let ky=y+34;const colW=(CW-32-24)/2,x1=M+16,x2=M+16+colW+24;
 kv(d,'Booking reference',r.reference,x1,ky,colW,{bold:true});kv(d,'Check-in',nice(r.checkIn),x2,ky,colW);ky+=30;
 kv(d,'Room type',type&&type.name||'Room',x1,ky,colW,{bold:true});kv(d,'Check-out',nice(r.checkOut),x2,ky,colW);ky+=30;
 kv(d,rooms.length>1?'Room numbers':'Room number',rooms.length?rooms.map(x=>x.number).join(', '):'Assigned on arrival',x1,ky,colW,{bold:true,color:rooms.length?TEAL:MUTED});kv(d,'Length of stay',`${nights} night${nights>1?'s':''}`,x2,ky,colW);ky+=30;
 kv(d,'Rooms booked',r.qty||1,x1,ky,colW);kv(d,'Guests',`${r.adults||1} adult${(r.adults||1)>1?'s':''}`,x2,ky,colW);ky+=30;
 kv(d,'Bed',type&&type.bedType?`${type.beds||1} ${type.bedType}`+(type.category?' · '+type.category:''):type&&type.category||'-',x1,ky,colW);kv(d,'Check-in / out time',[pol.checkInTime&&'from '+pol.checkInTime,pol.checkOutTime&&'by '+pol.checkOutTime].filter(Boolean).join('  ·  ')||'Ask the hotel',x2,ky,colW);
 // charges
 y=y+190+16;card(M,y,CW,196,'Charges and payment');let cy=y+36;const cw=CW-32,cx=M+16;
 const line=(k,v,o={})=>{if(o.rule)d.moveTo(cx,cy-4).lineTo(cx+cw,cy-4).lineWidth(.6).strokeColor(LINE).stroke();kv(d,k,v,cx,cy,cw,o);cy+=o.big?26:21};
 line(`Accommodation (${nights} night${nights>1?'s':''} x ${r.qty||1} room${(r.qty||1)>1?'s':''})`,n((r.accommodation||0)+(r.discount||0)));
 if(r.discount>0)line('Discount'+(r.promoCode?' ('+r.promoCode+')':''),'- '+n(r.discount));if(r.tax>0)line('Taxes and fees',n(r.tax));
 line('Booking total',n(r.total),{bold:true,rule:true});
 d.roundedRect(cx-6,cy-5,cw+12,26,5).fill(MIST);kv(d,'Amount received on this receipt',n(p.amount),cx,cy,cw,{bold:true,big:true,color:TEAL});cy+=30;
 line('Total paid to date',n(r.paid));line(bal>0?'Balance still to pay':'Balance',bal>0?n(bal):'NGN 0',{bold:true,color:bal>0?'#A12B20':'#176B47'});
 // payment details
 y=y+196+16;card(M,y,CW,86,'Payment details');
 kv(d,'Method',p.source==='platform'?'Online payment (Paystack)':'Recorded by the hotel ('+(p.method||'cash').replace('_',' ')+')',x1,y+34,colW);kv(d,'Date',nice(p.createdAt||new Date()),x2,y+34,colW);
 kv(d,'Payment reference',p.reference,x1,y+56,colW,{h:12});kv(d,'Status',p.source==='manual_external'&&!p.verified?'Recorded, not verified':'Successful',x2,y+56,colW,{bold:true,color:p.source==='manual_external'&&!p.verified?'#A12B20':'#176B47'});
 // notes
 y+=86+14;d.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(['Please show your booking reference at check-in.',pol.cancellation&&'Cancellation: '+pol.cancellation,'This receipt confirms the payment shown above. Keep it for your records.'].filter(Boolean).join('\n'),M,y,{width:CW,height:46,ellipsis:true});
 // footer
 d.rect(0,H-44,W,44).fill(PRIMARY);d.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text('key',M,H-28,{continued:true,lineBreak:false}).fillColor(GOLD).text('konnec',{lineBreak:false});
 d.font('Helvetica').fontSize(8).fillColor('#BFD6D0').text('Hotel booking made simple  ·  Receipt generated automatically',M+CW*.3,H-27,{width:CW*.7,align:'right',lineBreak:false});
 watermark(d,W,H);d.end()};
exports.statement=(res,{hotel,month,rows})=>{const d=start(res,`statement-${month}.pdf`),tot=rows.reduce((t,r)=>t+r.amount,0);
 d.fontSize(20).text('keykonnec commission statement');d.fontSize(11).moveDown().text(`Hotel: ${hotel.name}`).text(`Period: ${month}`).text('Basis: accommodation amount of completed online stays, after refunds.').moveDown();
 d.font('Helvetica-Bold').text('Booking          Date         Base            Rate     Commission   Status');d.font('Helvetica');
 rows.forEach(r=>d.text(`${r.ref.padEnd(16)} ${r.date}   ${n(r.base).padEnd(14)}  ${(r.rate*100).toFixed(1)}%   ${n(r.amount).padEnd(12)} ${r.status}`));
 d.moveDown().font('Helvetica-Bold').text(`Total commission: ${n(tot)}`);d.font('Helvetica');
 if(!rows.length)d.moveDown().text('No completed online stays in this period.');else if(tot===0)d.moveDown().text('No platform commission applies to these bookings. Paystack transaction fees are separate.');d.end()};
exports.subReceipt=(res,{hotel,sp,plan})=>{const d=start(res,`receipt-${sp.reference}.pdf`);watermark(d,595.28,841.89);
 d.fontSize(20).text('keykonnec');d.fontSize(10).fillColor('#555').text('Subscription payment receipt').fillColor('#000').moveDown();
 d.fontSize(11).text(`Receipt: ${sp.receiptNo||sp.reference}`).text(`Reference: ${sp.reference}`).text(`Hotel: ${hotel.name}`).text(`Date: ${day(sp.paidAt||sp.createdAt)}`).text(`Description: ${sp.description||plan.name}`).text(`Method: ${sp.method||'Paystack'}`).moveDown().text(`Amount paid: ${n(sp.amount)}`).text('Status: Paid and verified with Paystack');d.end()};
