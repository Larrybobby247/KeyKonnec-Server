const D=require('./models');
const F0=['online_payments','website'],F1=[...F0,'staff'],F2=[...F1,'deposits','widget','reports_plus','exports','pricing','whatsapp','domain'],F3=[...F2,'multi_branch','housekeeping','analytics','recovery','approvals','api','room_ops','channels'];
exports.PLANS=[['free','Free',0,.05,5,1,1,10,F0],['starter','Starter',7500,.04,20,1,2,0,F1],['growth','Growth',20000,.025,50,1,5,0,F2],['professional','Professional',45000,0,0,0,15,0,F3]];// 0 = unlimited
const TRIAL={starter:14,growth:14},VERSION=4;
// Runs at startup. New plans are created in full. Existing plans only gain features introduced since their featureVersion, so an admin's edits are not undone on every restart.
exports.seed=async()=>{for(const [key,name,price,commissionRate,rooms,branches,staff,monthlyBookings,features] of exports.PLANS){
 await D.Plan.updateOne({key},{$setOnInsert:{key,name,price,trialDays:TRIAL[key]||0,commissionRate,rooms,branches,staff,monthlyBookings,features,featureVersion:VERSION}},{upsert:true});
 await D.Plan.updateOne({key,trialDays:{$exists:false}},{$set:{trialDays:TRIAL[key]||0}});
 await D.Plan.updateOne({key,$or:[{featureVersion:{$exists:false}},{featureVersion:{$lt:VERSION}}]},{$addToSet:{features:{$each:features}},$set:{featureVersion:VERSION}})}};
// Admin button: add any default feature a plan is missing (never removes anything).
exports.reseed=async()=>{for(const [key,,,,,,,,features] of exports.PLANS)await D.Plan.updateOne({key},{$addToSet:{features:{$each:features}}})};
