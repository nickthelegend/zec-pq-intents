// Real Chrome, every L/E/T row in AUDIT.md. No request interception or substituted data.
// Run while e2e/stack.sh holds heavy-slot yaksok-audit-final.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const oct = read('deployments/testnet.json'), p2 = read('deployments/testnet-pass2.json'), p3 = read('deployments/testnet-pass3.json');
const intents = {...oct.intents, D:p2.intent, E:p3.intent}, log = p3.log;
const txBase = 'https://testnet.zecblock.com/tx/';
const repo = 'https://github.com/nickthelegend/zec-pq-intents';
const records = JSON.stringify([oct,p2,p3]);
const zat = n => Number(n).toLocaleString('en-US');
const short = (s,n=8) => s.slice(0,n)+'…';
const out = path.join(root,'audit/browser');
fs.mkdirSync(path.join(out,'screenshots'),{recursive:true}); fs.mkdirSync(path.join(out,'logs'),{recursive:true});
const ids = fs.readFileSync(path.join(root,'AUDIT.md'),'utf8').split('\n').filter(l=>/^\| [LET]-/.test(l)).map(l=>l.split('|')[1].trim()).filter(id=>!process.env.AUDIT_FILTER || id.includes(process.env.AUDIT_FILTER));
const browser = await chromium.launch({channel:'chrome',headless:true});
const results=[];
async function within(locator) { await expect.poll(()=>locator.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=-2 && r.bottom<=innerHeight+2;})).toBe(true); }
async function widths(page, heading) {
 const dims = await page.evaluate(()=>({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth}));
 expect(dims.sw).toBeLessThanOrEqual(dims.cw);
 const nav = await page.locator('header.top, header.bar').first().boundingBox();
 const h = await page.locator(heading).first().boundingBox();
 expect(nav.y+nav.height).toBeLessThanOrEqual(h.y+2);
 return JSON.stringify(dims);
}
async function verifyTape(page,type) {
 if(type==='E') { await expect(page.locator('#verify-state')).toHaveText('verified in this tab'); await expect(page.locator('#verify-count')).toHaveText('15/15'); await expect(page.locator('#tape [data-check="ok"]')).toHaveCount(15); await expect(page.locator('#tape .sigcell')).toHaveText(Array(15).fill('sig ok')); }
 else { await expect(page.locator('#tape-h + .meta')).toHaveText('15/15 signatures verify'); await expect(page.locator('.tape li[data-check="ok"]')).toHaveCount(15); await expect(page.locator('.tape .sig')).toHaveText(Array(15).fill('sig ok')); }
}
async function txLinks(page) {
 const hrefs=await page.locator('a[href]').evaluateAll(as=>as.map(a=>a.getAttribute('href')));
 const txs=hrefs.filter(h=>h.startsWith(txBase)); expect(txs.length).toBeGreaterThan(0);
 for(const h of txs) { expect(h.slice(txBase.length)).toMatch(/^[a-f0-9]{64}$/); expect(records.includes(h.slice(txBase.length))).toBe(true); }
 for(const h of hrefs.filter(h=>h.startsWith('#'))) expect(await page.locator(h).count()).toBe(1);
 return `${txs.length} explorer hrefs match full recorded txids`;
}
async function ticker(page,type) {
 const toggle=page.locator('.ticker-toggle');
 await toggle.click(); await expect(page.locator('.ticker-track')).toHaveCSS('animation-play-state','paused');
 if(type==='T') await expect(toggle).toHaveAttribute('data-paused','true');
 // Activate Play through the keyboard as well as testing click/touch above.
 await toggle.focus(); await page.keyboard.press('Enter'); await toggle.evaluate(el=>el.blur()); await page.mouse.move(374,750);
 await expect(page.locator('.ticker-track')).toHaveCSS('animation-play-state','running');
 if(type==='T') await expect(toggle).toHaveAttribute('data-paused','false');
 return 'Pause pauses; keyboard Play resumes after pointer and focus leave';
}
async function inspect(page,e,type) {
 if(type==='T') await page.locator('.tape li button').nth(e.seq).click();
 else await page.locator(`.ref-open[data-entry="${e.seq}"]`).click();
 await expect(page.locator('#ins-h')).toHaveText(`Entry #${e.seq}`);
 await expect(page.locator('#inspector .st')).toHaveText(e.status);
 const ins=page.locator('#inspector');
 await expect(ins).toContainText('ML-DSA-65 verifies');
 await expect(ins).toContainText(zat(e.at_height));
 if(e.reason) await expect(ins).toContainText(e.reason);
 for(const value of [e.hash,e.prev]) await expect(ins.locator(`[title="${value}"]`).first()).toBeVisible();
 for(const [k,v] of Object.entries(e.refs)) if(k.endsWith('_txid')) await expect(ins.locator(`a[href="${txBase+v}"]`)).toBeVisible();
 if(type==='T') { await expect(page.locator('.tape li button').nth(e.seq)).toHaveAttribute('aria-pressed','true'); await within(ins); }
 return `#${e.seq} ${e.status} ${e.reason??''}`;
}
async function check(page,type,suffix,url,live) {
 if(type==='L') {
  if(suffix==='headline') { await expect(page.locator('h1')).toHaveText('Sign with post-quantum keys. Settle in shielded ZEC.'); for(const [label,href] of [['Open the terminal','terminal/'],['Watch the tape verify','evidence.html#tape']]) {const a=page.locator('.hero').getByRole('link',{name:label});await expect(a).toBeVisible();await expect(a).toHaveAttribute('href',href);} return 'Exact headline and both primary hrefs match'; }
  if(suffix==='ticket') {const t=page.locator('.ticket');for(const text of ['Intent E','40,000','20,000','25,000','Settled','#13','f5af85c4']) await expect(t).toContainText(text);await expect(t.locator(`[title="${p3.intent.hash}"]`)).toBeVisible();return (await t.innerText()).replace(/\s+/g,' ');}
  if(suffix==='facts') {await expect(page.locator('.facts > div')).toHaveText([/15\s*Decisions/,/7\s*Refusals/,/102\s*Tests/]);expect(log.length).toBe(15);expect(log.filter(e=>e.status==='REJECTED').length).toBe(7);expect(read('packages/landing/tests.json')).toMatchObject({protocol:17,node:67,mcp:9,total:'102 + doc'});return '15 Decisions, 7 Refusals, 102 Tests; recorded counts match';}
  if(suffix==='steps') {const steps=page.locator('.steps li');await expect(steps).toHaveCount(3);await expect(steps.nth(0)).toContainText('ML-DSA-65');await expect(steps.nth(0)).toContainText('ML-KEM-768');await expect(steps.nth(1)).toContainText('liquidity');await expect(steps.nth(2)).toContainText('verifier releases or refunds');return (await steps.allInnerTexts()).join('; ');}
  if(suffix==='reduced-motion') {for(const sel of ['h1','.ticket','.ctas']) await expect(page.locator(sel).first()).toBeVisible();await expect(page.locator('#stages li.on')).toHaveCount(3);await expect(page.locator('#stages li .v').first()).toHaveCSS('transition-duration','0s');return '3 stages immediately lit; transition 0s';}
  if(suffix==='no-js') {const t=page.locator('.ticket');for(const v of ['40,000','20,000','Settled'])await expect(t).toContainText(v);await expect(page.locator('h1')).toBeVisible();for(const h of ['terminal/','evidence.html#tape'])await expect(page.locator(`.hero a[href="${h}"]`)).toBeVisible();return 'No-JS ticket, headline and primary links readable';}
  if(suffix==='375') {await expect(page.locator('.ticket')).toBeVisible();await expect(page.locator('.hero .ctas a').first()).toBeVisible();return widths(page,'h1');}
  if(suffix==='setup-copy') {const s=page.locator('.strip');for(const t of ['Live','read-only desk over three recorded testnet runs','Setup required','Submitting intents needs a live desk','Testnet only, not audited'])await expect(s).toContainText(t);return (await s.innerText()).replace(/\s+/g,' ');}
  if(suffix==='navigation') {await page.locator('.hero').getByRole('link',{name:'Open the terminal'}).click();await expect(page).toHaveTitle(/Yaksok terminal/);expect(page.url()).toBe(new URL('terminal/',url).href);await page.goto(url);await page.locator('.hero').getByRole('link',{name:'Watch the tape verify'}).click();await verifyTape(page,'E');expect(page.url()).toBe(new URL('evidence.html#tape',url).href);return 'Both primary links clicked; terminal 200 and evidence 15/15';}
 }
 if(type==='E') {
  if(suffix==='tape') {await verifyTape(page,type);return '15/15 verified in this tab; all 15 sig ok';}
  if(suffix==='refusals') {await verifyTape(page,type);const notes=[];for(const e of log.filter(e=>e.status==='REJECTED'))notes.push(await inspect(page,e,type));return notes.join('; ');}
  if(suffix==='anchors') {await expect(page.locator('#anchor-check')).toHaveAttribute('data-state','ok');await expect(page.locator('#anchor-check')).toContainText('#8 and #11 and #13 match');await expect(page.locator('dt:has-text("After the anchor") + dd')).toContainText('1 entry (#14');for(const e of log.filter(e=>e.status==='ANCHORED'))await expect(page.locator(`aside a[href="${txBase+e.refs.anchor_txid}"]`)).toBeVisible();return 'Recomputed heads #8/#11/#13 match; recorded links #11 names #8, #13 names #11; #14 remains after last head';}
  if(suffix==='book') {const rows=page.locator('table.book tbody tr');await expect(rows).toHaveCount(5);for(const [i,[k,it]] of Object.entries(intents).entries()){const fin=log.find(e=>e.intent_hash===it.hash&&['SETTLED','REFUNDED'].includes(e.status));const row=rows.nth(i);for(const t of [k,short(it.hash),zat(it.signed.intent.pay_zat),zat(it.signed.intent.min_out_zat)])await expect(row).toContainText(t);await expect(row.locator('.st')).toHaveText(fin.status.toLowerCase());await expect(row.locator('a.tx')).toHaveAttribute('href',txBase+(fin.refs.release_txid??fin.refs.refund_txid));}await expect(page.locator('.book-note')).toContainText('25,000');return '5 recorded intents A–E, correct amounts, states and full payout hrefs';}
  if(suffix==='375') {await expect(page.locator('table.book')).toBeVisible();return widths(page,'h1');}
  if(suffix==='no-js') {await expect(page.locator('table.book tbody tr')).toHaveCount(5);await expect(page.locator('#tape [data-seq]')).toHaveCount(15);await expect(page.locator('#verify-state')).toHaveText('waiting for JavaScript');await expect(page.locator('#tape .sigcell')).toHaveText(Array(15).fill('not checked'));await expect(page.locator('.ticker-toggle')).toBeHidden();await expect(page.locator('.ref-open:visible')).toHaveCount(0);return 'Static 5-row book and 15 not-checked entries; Pause and JS inspector controls hidden';}
  if(suffix==='crash-panel') {const c=page.locator('#crash');for(const t of ['Killed mid-release, reconciled, paid once','pass 2','SIGKILL','#11','c0557316','The escrow sent 1 transaction with that memo'])await expect(c).toContainText(t);return (await c.innerText()).replace(/\s+/g,' ');}
  if(suffix==='agent-panel') {const a=page.locator('#agent');for(const t of ['pass 3','quote','submit_intent','SIGKILL','sent once','6b63f403','15 entries, 3 anchors','exit 0'])await expect(a).toContainText(t);return (await a.innerText()).replace(/\s+/g,' ');}
  if(suffix==='links') {const msg=await txLinks(page);await page.getByRole('link',{name:'Terminal',exact:true}).click();await expect(page).toHaveTitle(/Yaksok terminal/);await page.goto(url);await page.getByRole('link',{name:'Overview',exact:true}).click();await expect(page.locator('h1')).toHaveText('Sign with post-quantum keys. Settle in shielded ZEC.');return msg+'; terminal and Overview navigated';}
  if(suffix==='limits') {const text=await page.locator('section:has(#lim-h),section:has(#pq-h)').allInnerTexts();const all=text.join(' ');for(const re of [/verifier holds the escrow/,/solver and the verifier read the plaintext/,/elliptic|Zcash spends and note encryption/,/every payout.*recipient and amount/s,/A–D/,/key id and nonce/,/Anchors are periodic/,/3 confirmations/])expect(all).toMatch(re);return 'Custody, plaintext, ECC, viewing key payouts, A–D linkage, user/nonce linkage, periodic anchors, 3 confirmations disclosed';}
 }
 if(type==='T') {
  if(suffix==='tape') {await verifyTape(page,type);return '15/15 signatures verify; each entry sig ok';}
  if(suffix==='book'||suffix==='tx-links') {const rs=page.getByRole('radiogroup',{name:'Intents'}).getByRole('radio');await expect(rs).toHaveCount(5);for(const [i,[k,it]]of Object.entries(intents).entries()){await rs.nth(i).click();const fin=log.find(e=>e.intent_hash===it.hash&&['SETTLED','REFUNDED'].includes(e.status));await expect(rs.nth(i).locator('.st')).toHaveText(fin.status.toLowerCase());const steps=page.locator('.steps');for(const t of [zat(it.signed.intent.pay_zat),zat(it.signed.intent.min_out_zat)])await expect(rs.nth(i)).toContainText(t);for(const t of [zat(it.signed.intent.pay_zat),zat(fin.refs.released_zat??fin.refs.refunded_zat)])await expect(steps).toContainText(t);await expect(steps.locator(`a[href="${txBase+(fin.refs.release_txid??fin.refs.refund_txid)}"]`)).toBeVisible();await txLinks(page);}if(suffix==='tx-links')for(const e of log){await inspect(page,e,type);await txLinks(page);}return 'Each of A–E selected; exact escrow/delivery/payout amounts, stages and recorded full txid hrefs match';}
  if(['tamper','other-tamper-fields','wrong-key','original'].includes(suffix)) {const con=page.locator('section:has(#con-h)');const outputs=[];const fields=suffix==='tamper'?['min_out_zat']:suffix==='other-tamper-fields'?['pay_zat','receive_ua','deadline_height','nonce','pay_zat','receive_ua','deadline_height','nonce','min_out_zat']:[];for(const f of fields){await con.getByRole('combobox').selectOption(f);await con.getByRole('button',{name:'Change and verify'}).click();const line=con.locator('ol.out li').first();await expect(line).toContainText(`A with ${f} changed → BAD_SIGNATURE`);await expect(line).toContainText('≠ 48a440a6…');outputs.push(await line.innerText());}if(suffix==='other-tamper-fields')await expect(con.locator('ol.out li')).toHaveCount(8);if(!fields.length){await con.getByRole('button',{name:suffix==='original'?'Original':"Attacker's key",exact:true}).click();const line=con.locator('ol.out li').first();await expect(line).toContainText(suffix==='original'?'A as signed → verifies · hash 48a440a6…':'attacker intent → WRONG_KEY');await expect(line.locator('[data-state]')).toHaveText(suffix==='original'?'OK':'REF');outputs.push(await line.innerText());}return outputs.join('; ');}
  if(['replay-row','expired-row','refusals'].includes(suffix)) {const chosen=suffix==='replay-row'?[log[4]]:suffix==='expired-row'?[log[7]]:log.filter(e=>e.status==='REJECTED');const notes=[];for(const e of chosen){await page.locator('.refusals button.ref').filter({has:page.locator('code',{hasText:e.reason})}).click();await expect(page.locator('#ins-h')).toHaveText(`Entry #${e.seq}`);await expect(page.locator('#inspector code.no')).toHaveText(e.reason);await expect(page.locator('.tape li button').nth(e.seq)).toHaveAttribute('aria-pressed','true');await within(page.locator('#inspector'));notes.push(`#${e.seq} ${e.reason}`);}return notes.join('; ');}
  if(suffix==='inspector') {const notes=[];for(const e of log)notes.push(await inspect(page,e,type));return notes.join('; ');}
  if(suffix==='keys') {const rs=page.getByRole('radiogroup',{name:'Intents'}).getByRole('radio');await rs.nth(0).focus();for(const [key,i]of [['ArrowDown',1],['ArrowUp',0],['ArrowRight',1],['ArrowLeft',0],['End',4],['ArrowDown',0],['ArrowUp',4],['Home',0]]){await page.keyboard.press(key);await expect(rs.nth(i)).toBeFocused();await expect(rs.nth(i)).toHaveAttribute('aria-checked','true');await expect(page.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);}return 'All arrow directions, End/Home, wrap, focus and exactly one tab stop verified';}
  if(suffix==='crash-panel'||suffix==='agent-panel') {const crash=suffix==='crash-panel';const section=page.locator(crash?'#crash':'#agent');for(const text of (crash?['Killed mid-release, reconciled, paid once','SIGKILL','c0557316','sent 1 transaction with that memo']:['quote','submit_intent','SIGKILL','sent once','6b63f403','15 entries, 3 anchors']))await expect(section).toContainText(text);await section.getByRole('button',{name:crash?/log #11/:/log #13/}).click();await expect(page.locator('#ins-h')).toHaveText(crash?'Entry #11':'Entry #13');await expect(page.locator('#inspector .st')).toHaveText('SETTLED');return 'Recorded '+(crash?'pass-2 release':'pass-3 MCP')+' interruption panel; settlement inspector opened';}
  if(suffix==='375') {await expect(page.getByRole('radiogroup',{name:'Intents'})).toBeVisible();return widths(page,'#book-h');}
  if(suffix==='anchor-chain') {const anc=page.locator('section:has(#anc-h)');await expect(anc.locator('.chain dd').first()).toContainText('not checked yet');await anc.getByRole('button',{name:'Check the anchor chain',exact:true}).click();await expect(anc.locator('.chain dd').first()).toHaveText('one chain, 3 anchors, no fork: #8 → #11 → #13 · 15/15 signatures verify');await expect(anc.getByRole('button',{name:'Check the anchor chain again'})).toBeVisible();for(const e of log.filter(e=>e.status==='ANCHORED'))await expect(anc.locator(`a[href="${txBase+e.refs.anchor_txid}"]`).first()).toBeVisible();return await anc.locator('.chain dd').first().innerText();}
  if(suffix==='navigation') {const landing=page.getByRole('link',{name:'Landing',exact:true});if(url.includes('/terminal/')){await expect(landing).toBeVisible();await landing.click();expect(page.url()).toBe('http://127.0.0.1:4183/');await page.goto(url);}else await expect(landing).toHaveCount(0);await expect(page.getByRole('link',{name:'GitHub',exact:true})).toHaveAttribute('href',repo);await expect(page.getByRole('link',{name:'Docs',exact:true})).toHaveAttribute('href',repo+'/blob/main/packages/docs/README.md');await page.keyboard.press('Tab');const skip=page.getByRole('link',{name:'Skip to content'});await skip.focus();await skip.press('Enter');expect(page.url()).toContain('#main');return 'Correct Landing visibility/return, GitHub/Docs hrefs and keyboard skip to #main';}
 }
 if(suffix==='pause')return ticker(page,type);
 if(suffix==='reduced-motion') {await expect(page.locator('.ticker-track')).toHaveCSS('animation-name','none');await expect(page.locator('.ticker-track ul[aria-hidden]')).toBeHidden();await verifyTape(page,type);const sel=type==='E'?'#tape [data-seq]':'.tape li[data-check]';await expect(page.locator(sel).first()).toHaveCSS('transition-duration','0s');return 'Reduced motion: ticker none, duplicate hidden, tape transition 0s, 15/15';}
 if(suffix==='console') {await page.mouse.wheel(0,600);await page.waitForTimeout(400);return 'Console, page errors, request failures and all response statuses captured';}
 throw Error('Missing check for '+suffix);
}
try {
 for(const id of ids) {
  const [type,scope,...parts]=id.split('-'), suffix=parts.join('-'), live=scope==='live';
  const urls=type==='L'?[live?'https://yaksok-landing.vercel.app/':'http://127.0.0.1:4183/']:type==='E'?[live?'https://yaksok-landing.vercel.app/evidence.html':'http://127.0.0.1:4183/evidence.html']:live?['https://yaksok-terminal.vercel.app/']:['http://127.0.0.1:5181/','http://127.0.0.1:4183/terminal/'];
  let status='PASS';const observed=[],evidence=[];
  for(const [index,url]of urls.entries()) {
   const mobile=suffix==='375';const context=await browser.newContext({viewport:mobile?{width:375,height:812}:{width:1280,height:800},deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile,javaScriptEnabled:suffix!=='no-js',reducedMotion:suffix==='reduced-motion'?'reduce':'no-preference'});
   const page=await context.newPage();page.setDefaultTimeout(12000);const events=[],errors=[];
   page.on('console',m=>{events.push({event:'console',type:m.type(),text:m.text()});if(m.type()==='error')errors.push(m.text());});
   page.on('pageerror',e=>{events.push({event:'pageerror',text:e.message});errors.push(e.message);});
   page.on('requestfailed',r=>{const msg=r.url()+' '+r.failure()?.errorText;events.push({event:'requestfailed',text:msg});errors.push(msg);});
   page.on('response',r=>{events.push({event:'response',status:r.status(),url:r.url()});if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});
   const basename=id+(urls.length>1?`-${index===0?'vite':'static'}`:'');
   try {const response=await page.goto(url,{waitUntil:'load'});expect(response.status()).toBe(200);if(type==='T'||(type==='E'&&suffix!=='no-js'))await verifyTape(page,type);const note=await check(page,type,suffix,url,live);observed.push(url+': '+note);}catch(e){status='FAIL';observed.push(url+': '+e.message.split('\n').filter(l=>!l.includes('\u001b')).slice(0,9).join(' '));}
   // Capture late requests before evaluating health; no domain is exempt.
   await page.waitForTimeout(150);
   if(errors.length){status='FAIL';observed.push('console/network: '+errors.join('; '));}
   try{let jpeg=await page.screenshot({type:'jpeg',quality:65});if(jpeg.length>200000)jpeg=await page.screenshot({type:'jpeg',quality:40});expect(jpeg.length).toBeLessThanOrEqual(200000);fs.writeFileSync(path.join(out,'screenshots',basename+'.jpg'),jpeg);evidence.push(`audit/browser/screenshots/${basename}.jpg`);}catch(e){status='FAIL';observed.push('Screenshot: '+e.message);}
   events.push({event:'health',consoleOrNetworkErrors:errors.length,viewport:mobile?'375x812':'1280x800',url});
   fs.writeFileSync(path.join(out,'logs',basename+'.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');evidence.push(`audit/browser/logs/${basename}.jsonl`);await context.close();
  }
  const row={id,status,observed:observed.join(' || '),evidence:evidence.join('; ')};results.push(row);fs.writeFileSync(path.join(out,'rows.json'),JSON.stringify(results,null,2));console.log(`${status} ${id} ${row.observed.slice(0,150)}`);
 }
}finally{await browser.close();}
const escape=s=>s.replace(/\|/g,'&#124;').replace(/\n/g,' ');
fs.writeFileSync(path.join(out,'results.md'),'| ID | status | exact observed result | evidence path |\n| --- | --- | --- | --- |\n'+results.map(r=>`| ${r.id} | ${r.status} | ${escape(r.observed)} | ${r.evidence} |`).join('\n')+'\n');
console.log(JSON.stringify(results.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{})));
