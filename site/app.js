"use strict";
(() => {
  const config = window.LEGAL_LIBRARY_CONFIG || {};
  const base = String(config.apiBase || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const state = {token:sessionStorage.getItem("legal_library_token") || "",query:"",ext:"",page:0,total:0,pageSize:20};
  const showNotice=(message)=>{const el=$("notice");el.textContent=message;el.classList.toggle("show",!!message);};
  const configured = /^https:\/\//.test(base) && !base.includes("REPLACE-");
  async function api(path, options={}) {
    if(!configured) throw new Error("The Cloudflare API address has not been configured. See the setup guide.");
    const headers=new Headers(options.headers || {});
    if(state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if(options.body && typeof options.body === "string") headers.set("Content-Type", "application/json");
    const r=await fetch(base+path,{...options,headers,cache:"no-store"});
    if(r.status===401 && path!=="/api/login"){signOut(false);throw new Error("The session has expired. Enter the access code again.");}
    if(!r.ok){let message=`Request failed (${r.status}).`;try{const j=await r.json();message=j.error||message;}catch{}throw new Error(message);}
    return r;
  }
  function signOut(clear=true){state.token="";sessionStorage.removeItem("legal_library_token");$("librarySection").hidden=true;$("loginSection").hidden=false;if(clear)showNotice("");}
  function signedIn(){ $("loginSection").hidden=true;$("librarySection").hidden=false;showNotice("");$("search").focus(); }
  function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
  function highlight(host,excerpt,words){const terms=[...new Set(words.map(x=>x.toLowerCase()))].filter(Boolean);if(!terms.length){host.textContent=excerpt;return;}let i=0;const lower=excerpt.toLowerCase();while(i<excerpt.length){let pos=-1,term="";for(const word of terms){let j=lower.indexOf(word,i);if(j>=0&&(pos<0||j<pos)){pos=j;term=word;}}if(pos<0){host.append(document.createTextNode(excerpt.slice(i)));break;}host.append(document.createTextNode(excerpt.slice(i,pos)));const m=element("mark", "", excerpt.slice(pos,pos+term.length));host.append(m);i=pos+term.length;}}
  async function openDoc(doc){
    // Open a new tab during the user click, before the asynchronous fetch.
    const tab=window.open("","_blank");if(tab){tab.document.title="Opening legal resource";tab.document.body.textContent="Opening resource...";}
    try{
      const r=await api(`/api/document/${encodeURIComponent(doc.id)}`);
      const blob=await r.blob();const url=URL.createObjectURL(blob);
      const target=url+(doc.ext===".pdf" && doc.page>0?`#page=${doc.page}`:"");
      if(tab){tab.location.replace(target);setTimeout(()=>URL.revokeObjectURL(url),120000);}else{const a=document.createElement("a");a.href=target;a.download=doc.title+doc.ext;a.click();setTimeout(()=>URL.revokeObjectURL(url),120000);}
    }catch(e){if(tab)tab.close();showNotice(e.message);}
  }
  function renderItem(doc,words){
    const card=element("article","result");
    const meta=[doc.ext.replace(".","").toUpperCase(),doc.year?`Collection year ${doc.year}`:"",doc.page>0?`Matched page ${doc.page}`:"",doc.status==="title-only"?"Title only":""].filter(Boolean).join(" · ");
    card.append(element("div","meta",meta));card.append(element("h2","",doc.title));
    if(doc.snippet){const text=element("p","snippet");highlight(text,doc.snippet,words);card.append(text);}else card.append(element("p","subtle","Match based on title or available metadata. Full text may not be searchable."));
    const actions=element("div","actions");const btn=element("button","openButton","Open original resource");btn.addEventListener("click",()=>openDoc(doc));actions.append(btn);
    if(doc.alternates>1)actions.append(element("span","subtle",`${doc.alternates} verified duplicate formats grouped`));card.append(actions);return card;
  }
  async function search(){state.query=$("search").value.trim();state.ext=$("typeFilter").value;const container=$("results");container.replaceChildren();$("paging").hidden=true;showNotice("");if(!state.query){container.append(element("div","empty","Enter a term or phrase to search the legal library."));$("resultsSummary").textContent="";return;}
    container.append(element("p","subtle","Searching..."));
    try{const qs=new URLSearchParams({q:state.query,ext:state.ext,offset:String(state.page*state.pageSize)});const r=await api("/api/search?"+qs.toString());const data=await r.json();container.replaceChildren();state.total=data.total;$("resultsSummary").textContent=`${data.total} matching resource${data.total===1?"":"s"}`;
    if(!data.results.length){container.append(element("div","empty","No matches. Try fewer words or a different legal term."));return;}
    const words=state.query.match(/[\p{L}\p{N}]+/gu)||[];for(const doc of data.results)container.append(renderItem(doc,words));$("paging").hidden=data.total<=state.pageSize;$("pageLabel").textContent=`Page ${state.page+1} of ${Math.ceil(data.total/state.pageSize)}`;$("prevPage").disabled=state.page===0;$("nextPage").disabled=(state.page+1)*state.pageSize>=data.total;
    }catch(e){container.replaceChildren();showNotice(e.message);}}
  $("loginForm").addEventListener("submit",async(e)=>{e.preventDefault();const btn=$("loginButton");btn.disabled=true;showNotice("");try{const r=await api("/api/login",{method:"POST",body:JSON.stringify({code:$("code").value})});const j=await r.json();state.token=j.token;sessionStorage.setItem("legal_library_token",state.token);$("code").value="";signedIn();const status=await api("/api/status");const info=await status.json();$("countLabel").textContent=`${info.resources} indexed resources`;}catch(err){showNotice(err.message);}finally{btn.disabled=false;}});
  $("logoutButton").addEventListener("click",()=>signOut());$("searchForm").addEventListener("submit",e=>{e.preventDefault();state.page=0;search();});$("typeFilter").addEventListener("change",()=>{state.page=0;search();});$("prevPage").addEventListener("click",()=>{state.page--;search();});$("nextPage").addEventListener("click",()=>{state.page++;search();});
  if(state.token)api("/api/status").then(r=>r.json()).then(data=>{signedIn();$("countLabel").textContent=`${data.resources} indexed resources`;}).catch(e=>showNotice(e.message));
  if(!configured)showNotice("Setup required: set the Cloudflare Worker address in site/config.js before publishing.");
})();
