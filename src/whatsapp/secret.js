// AES-256-GCM encryption for WhatsApp access tokens at rest. Key: WA_TOKEN_KEY (32 bytes as 64 hex chars or base64).
const crypto=require('crypto');
const key=()=>{const k=process.env.WA_TOKEN_KEY;if(!k)throw new Error('WA_TOKEN_KEY is not set');const b=/^[0-9a-f]{64}$/i.test(k)?Buffer.from(k,'hex'):Buffer.from(k,'base64');if(b.length!==32)throw new Error('WA_TOKEN_KEY must be 32 bytes (64 hex characters)');return b};
exports.encrypt=text=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),iv),enc=Buffer.concat([c.update(String(text),'utf8'),c.final()]);return['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),enc.toString('base64')].join('.')};
exports.decrypt=blob=>{const [v,iv,tag,enc]=String(blob||'').split('.');if(v!=='v1'||!enc)throw new Error('Unreadable token');const d=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64'));d.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([d.update(Buffer.from(enc,'base64')),d.final()]).toString('utf8')};
// Webhook signature (X-Hub-Signature-256) check, constant time.
exports.validMetaSignature=(raw,header,secret=process.env.WHATSAPP_APP_SECRET)=>{if(!secret||!header)return false;const a=Buffer.from(String(header).replace('sha256=','')),b=Buffer.from(crypto.createHmac('sha256',secret).update(raw).digest('hex'));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
exports.hashPhone=p=>crypto.createHash('sha256').update(String(p)).digest('hex').slice(0,16);
