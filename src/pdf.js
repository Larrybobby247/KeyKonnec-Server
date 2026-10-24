const PDF=require('pdfkit'),day=x=>new Date(x).toISOString().slice(0,10),n=v=>'NGN '+Number(v||0).toLocaleString('en-NG');
const start=(res,name)=>{const d=new PDF({margin:50});res.type('pdf');res.setHeader('Content-Disposition',`attachment; filename="${name}"`);d.pipe(res);return d};
exports.receipt=(res,{hotel,r,p})=>{const d=start(res,`receipt-${p.reference}.pdf`);
 d.fontSize(20).text(hotel.name);d.fontSize(10).fillColor('#555').text([hotel.address,hotel.phone].filter(Boolean).join(' | '));d.moveDown().fillColor('#000').fontSize(16).text('Payment receipt');
 d.fontSize(11).moveDown().text(`Receipt: ${p.reference}`).text(`Booking: ${r.reference}`).text(`Guest: ${r.guest.name}`).text(`Stay: ${day(r.checkIn)} to ${day(r.checkOut)}`).text(`Date: ${day(p.createdAt)}`)
  .text(`Method: ${p.source==='platform'?'Online payment (Paystack)':'Recorded by the hotel ('+p.method+')'}`).moveDown().text(`Amount received: ${n(p.amount)}`).text(`Booking total: ${n(r.total)}`).text(`Paid so far: ${n(r.paid)}`).text(`Balance: ${n(Math.max(0,r.total-r.paid))}`);
 if(p.source==='manual_external'&&!p.verified)d.moveDown().fillColor('#b00').text('Recorded by the hotel and not yet verified.');d.end()};
exports.statement=(res,{hotel,month,rows})=>{const d=start(res,`statement-${month}.pdf`),tot=rows.reduce((t,r)=>t+r.amount,0);
 d.fontSize(20).text('keykonnec commission statement');d.fontSize(11).moveDown().text(`Hotel: ${hotel.name}`).text(`Period: ${month}`).text('Basis: accommodation amount of completed online stays, after refunds.').moveDown();
 d.font('Helvetica-Bold').text('Booking          Date         Base            Rate     Commission   Status');d.font('Helvetica');
 rows.forEach(r=>d.text(`${r.ref.padEnd(16)} ${r.date}   ${n(r.base).padEnd(14)}  ${(r.rate*100).toFixed(1)}%   ${n(r.amount).padEnd(12)} ${r.status}`));
 d.moveDown().font('Helvetica-Bold').text(`Total commission: ${n(tot)}`);d.font('Helvetica');
 if(!rows.length)d.moveDown().text('No completed online stays in this period.');else if(tot===0)d.moveDown().text('No platform commission applies to these bookings. Paystack transaction fees are separate.');d.end()};
exports.subReceipt=(res,{hotel,sp,plan})=>{const d=start(res,`receipt-${sp.reference}.pdf`);
 d.fontSize(20).text('keykonnec');d.fontSize(10).fillColor('#555').text('Subscription payment receipt').fillColor('#000').moveDown();
 d.fontSize(11).text(`Receipt: ${sp.receiptNo||sp.reference}`).text(`Reference: ${sp.reference}`).text(`Hotel: ${hotel.name}`).text(`Date: ${day(sp.paidAt||sp.createdAt)}`).text(`Description: ${sp.description||plan.name}`).text(`Method: ${sp.method||'Paystack'}`).moveDown().text(`Amount paid: ${n(sp.amount)}`).text('Status: Paid and verified with Paystack');d.end()};
