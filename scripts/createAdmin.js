// Usage: ADMIN_EMAIL=you@x.com ADMIN_PASSWORD=... node scripts/createAdmin.js
require('dotenv').config();const m=require('mongoose'),bcrypt=require('bcryptjs'),{User}=require('../src/models');
m.connect(process.env.MONGODB_URI).then(async()=>{await User.updateOne({email:process.env.ADMIN_EMAIL.toLowerCase()},{$set:{name:'Platform admin',role:'admin',status:'active',passwordHash:await bcrypt.hash(process.env.ADMIN_PASSWORD,12)}},{upsert:true});console.log('Admin ready');process.exit()});
