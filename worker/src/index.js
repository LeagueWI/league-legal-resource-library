// Cloudflare Worker: authenticated access code, SQLite FTS5, private R2 documents.
// No secret, legal document, or index content is included in GitHub Pages.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (value, status=200, cors={}) => new Response(JSON.stringify(value), {status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...cors}});
const bytesHex = (buffer) => Array.from(new Uint8Array(buffer)).map(x=>x.toString(16).padStart(2,"0")).join("");
const sha256 = async (text)=>bytesHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
function timingEqual(a,b){if(typeof a!=="string"||typeof b!=="string")return false;let wrong=a.length^b.length;const count=Math.max(a.length,b.length);for(let i=0;i<count;i++)wrong|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return wrong===0;}
function b64url(bytes){let binary="";for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
function fromB64(s){const str=atob(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4));return Uint8Array.from(str,c=>c.charCodeAt(0));}
async function hmac(message,secret){const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return b64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,encoder.encode(message))));}
async function createSession(env){const expires=Date.now()+8*60*60*1000;const nonce=b64url(crypto.getRandomValues(new Uint8Array(12)));const message=`v1.${expires}.${nonce}`;return `${message}.${await hmac(message,env.SESSION_SECRET)}`;}
async function validSession(header,env){if(!header?.startsWith("Bearer "))return false;const token=header.slice(7);if(token.length>500)return false;const parts=token.split(".");if(parts.length!==4||parts[0]!=="v1")return false;const exp=Number(parts[1]);if(!Number.isFinite(exp)||exp<Date.now()||exp>Date.now()+8*60*60*1000)return false;const message=parts.slice(0,3).join(".");return timingEqual(parts[3],await hmac(message,env.SESSION_SECRET));}
function getCors(req,env){const origin=req.headers.get("Origin");return origin&&origin===env.ALLOWED_ORIGIN?{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Max-Age":"600","Vary":"Origin"}:{};}
function tokenize(query){return [...new Set((query.match(/[\p{L}\p{N}]+/gu)||[]).map(s=>s.toLowerCase()).filter(s=>s.length<=48))].slice(0,12);}
function ftsTerm(s){return `"${s.replace(/"/g,'""')}"`;}
function bestSnippet(text,tokens,chars=360){const clean=String(text||"").replace(/\s+/g," ").trim();if(!clean)return"";const low=clean.toLowerCase();let best={score:-1,start:0};for(const t of tokens){let j=low.indexOf(t),count=0;while(j>=0&&count<70){const start=Math.max(0,j-85),end=Math.min(low.length,start+chars),piece=low.slice(start,end);let matches=0;for(const w of tokens){if(piece.includes(w))matches+=12;const occurrences=piece.split(w).length-1;matches+=Math.min(occurrences,4);}if(matches>best.score)best={score:matches,start};j=low.indexOf(t,j+t.length);count++;}}if(best.score<0)return"";let {start}=best;let end=Math.min(clean.length,start+chars);if(start>0){const i=clean.indexOf(" ",start);if(i>=0&&i<start+40)start=i+1;}if(end<clean.length){const i=clean.lastIndexOf(" ",end);if(i>start+150)end=i;}return `${start>0?"…":""}${clean.slice(start,end)}${end<clean.length?"…":""}`;}
function rank(row,tokens,query){const title=row.title.toLowerCase(), body=row.body.toLowerCase(), phrase=query.toLowerCase().trim();let score=0;let coverage=0;for(const t of tokens){const hitTitle=title.includes(t),hitBody=body.includes(t);if(hitTitle||hitBody)coverage++;if(hitTitle)score+=13;if(hitBody)score+=6;}if(title.includes(phrase))score+=30;if(body.includes(phrase))score+=18;if(coverage===tokens.length)score+=24;score+=Math.max(-10,Math.min(12,-Number(row.fts_rank||0)));if(row.status==="title-only")score-=8;return score;}
function isConfigured(env){return !!(env.DB&&env.LEGAL_FILES&&env.ACCESS_CODE_HASH&&/^[a-f0-9]{64}$/i.test(env.ACCESS_CODE_HASH)&&env.SESSION_SECRET&&env.SESSION_SECRET.length>=40&&env.ALLOWED_ORIGIN&&!env.ALLOWED_ORIGIN.includes("REPLACE"));}
async function login(req,env,cors){
 if(req.headers.get("Origin")!==env.ALLOWED_ORIGIN)return json({error:"Origin not permitted."},403,cors);
 const ip=req.headers.get("CF-Connecting-IP")||"unknown";const key=await sha256(ip+"|"+env.SESSION_SECRET);const windowNumber=Math.floor(Date.now()/900000);
 const record=await env.DB.prepare("SELECT attempts FROM login_attempts WHERE ip_hash=? AND window=?").bind(key,windowNumber).first();
 if(record&&record.attempts>=8)return json({error:"Too many attempts. Try again in 15 minutes."},429,cors);
 let input;try{input=await req.json();}catch{return json({error:"Invalid request."},400,cors);}
 const code=typeof input?.code==="string"?input.code:"";if(code.length<8||code.length>120)return json({error:"Invalid code."},401,cors);
 const digest=await sha256(code);
 if(!timingEqual(digest,env.ACCESS_CODE_HASH.toLowerCase())){
  await env.DB.prepare("INSERT INTO login_attempts(ip_hash,window,attempts) VALUES (?,?,1) ON CONFLICT(ip_hash,window) DO UPDATE SET attempts=attempts+1").bind(key,windowNumber).run();
  return json({error:"Access code not recognized."},401,cors);
 }
 await env.DB.prepare("DELETE FROM login_attempts WHERE ip_hash=? AND window=?").bind(key,windowNumber).run();
 return json({token:await createSession(env),expiresHours:8},200,cors);
}
async function search(req,env,cors){
 const url=new URL(req.url),query=(url.searchParams.get("q")||"").trim().slice(0,160),ext=url.searchParams.get("ext")||"";
 const offset=Math.max(0,Math.min(500,parseInt(url.searchParams.get("offset")||"0",10)||0));
 const tokens=tokenize(query);if(!tokens)return json({results:[],total:0},200,cors);
 const format=[".pdf",".docx",".doc",".rtf",".jpg",".jpeg",".png",".tif",".tiff",".msg"].includes(ext)?ext:"";
 // First prefer all terms. If none match, fall back to partial (OR) matching.
 const base=`SELECT f.doc_id,f.page,f.title AS passage_title,f.body,d.title,d.ext,d.year,d.status,d.duplicate_group, bm25(passages_fts,0,0,0,8,1) fts_rank FROM passages_fts f JOIN documents d ON d.id=f.doc_id AND d.build_id=f.build_id WHERE passages_fts MATCH ? AND f.build_id=(SELECT value FROM meta WHERE key='live_build')`;
 const formatSql=format?" AND d.ext=?":"";
 let rows=[];
 for(const [i,match] of [tokens.map(ftsTerm).join(" AND "),tokens.map(ftsTerm).join(" OR ")].entries()){
  const params=[match];if(format)params.push(format);
  const result=await env.DB.prepare(base+formatSql+" ORDER BY fts_rank LIMIT 600").bind(...params).all();
  rows=result.results||[];if(rows.length || i===1)break;
 }
 const scored=new Map();
 for(const r of rows){const score=rank(r,tokens,query);const previous=scored.get(r.doc_id);if(!previous||previous.score<score)scored.set(r.doc_id,{row:r,score});}
 const groups=new Map();for(const value of scored.values()){const group=value.row.duplicate_group||value.row.doc_id;const prior=groups.get(group);if(!prior||value.score>prior.score)groups.set(group,{...value,alternates:1});else prior.alternates++;}
 const sorted=[...groups.values()].sort((a,b)=>b.score-a.score||a.row.title.localeCompare(b.row.title));
 // Include total duplicates in each verified group among result matches.
 const counts=new Map();for(const value of scored.values()){const id=value.row.duplicate_group||value.row.doc_id;counts.set(id,(counts.get(id)||0)+1);}
 const results=sorted.slice(offset,offset+20).map(({row,score})=>({id:row.doc_id,title:row.title,ext:row.ext,year:row.year,status:row.status,page:row.page,snippet:bestSnippet(row.body,tokens),score:Math.round(score),alternates:counts.get(row.duplicate_group||row.doc_id)||1}));
 return json({results,total:sorted.length,offset},200,cors);
}
async function getDocument(req,env,cors,id){if(!/^[a-f0-9]{64}$/.test(id))return json({error:"Not found."},404,cors);
 const row=await env.DB.prepare("SELECT object_key,ext,title FROM documents WHERE id=? AND build_id=(SELECT value FROM meta WHERE key='live_build')").bind(id).first();if(!row)return json({error:"Not found."},404,cors);
 const object=await env.LEGAL_FILES.get(row.object_key);if(!object)return json({error:"Original file unavailable."},404,cors);
 const types={".pdf":"application/pdf",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".doc":"application/msword",".rtf":"application/rtf",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".tif":"image/tiff",".tiff":"image/tiff"};
 const disposition=(row.ext===".pdf"||row.ext===".jpg"||row.ext===".png")?"inline":"attachment";
 const fileName=String(row.title||"Resource").replace(/["\\\r\n]/g,"_").slice(0,120)+row.ext;
 return new Response(object.body,{status:200,headers:{...cors,"Content-Type":types[row.ext]||"application/octet-stream","Content-Disposition":`${disposition}; filename="${fileName.replace(/[^\x20-\x7E]/g,"_")}"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}});
}
export default {async fetch(req,env){
 const cors=getCors(req,env),url=new URL(req.url);
 if(req.method==="OPTIONS")return req.headers.get("Origin")===env.ALLOWED_ORIGIN?new Response(null,{status:204,headers:cors}):new Response(null,{status:403});
 if(!url.pathname.startsWith("/api/"))return json({error:"Not found."},404,cors);
 if(!isConfigured(env))return json({error:"Server configuration incomplete."},503,cors);
 try{
  if(url.pathname==="/api/login"&&req.method==="POST")return await login(req,env,cors);
  if(!await validSession(req.headers.get("Authorization"),env))return json({error:"Access required."},401,cors);
  if(url.pathname==="/api/status"&&req.method==="GET"){
   const row=await env.DB.prepare("SELECT COUNT(*) n FROM documents WHERE build_id=(SELECT value FROM meta WHERE key='live_build')").first();
   return json({resources:row?.n||0},200,cors);
  }
  if(url.pathname==="/api/search"&&req.method==="GET")return await search(req,env,cors);
  if(url.pathname.startsWith("/api/document/")&&req.method==="GET")return await getDocument(req,env,cors,url.pathname.split("/").at(-1));
  return json({error:"Not found."},404,cors);
 }catch(err){console.error("Request failure",err?.name||"Error");return json({error:"Service error. Try again or contact the administrator."},500,cors);}
}};
export const __testing={tokenize,bestSnippet,rank,createSession,validSession};
