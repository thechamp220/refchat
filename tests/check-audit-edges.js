'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bench, booted, tick } = require('./bench');
let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}
async function fresh(store) {
  const b = bench(store);
  await booted(b);
  for (let i = 0; i < 20; i++) await tick();
  return b;
}
const keepAlive = setInterval(() => {}, 1000);
(async () => {
  await check('le journal conserve le message complet et sa citation', async () => {
    const b = await fresh();
    const text = 'a'.repeat(350) + ' fin importante';
    const quote = 'b'.repeat(300);
    const row = b.run('buildFtRow')({text, replyQuote:quote});
    assert.equal(row.text, text);
    assert.equal(row.reply_quote, quote);
  });
  await check('un salon sans contexte ne reçoit pas celui des autres', async () => {
    const b = await fresh();
    b.run('recentChat.push({a:"alice",t:"autre salon",channel:"twitch/other"})');
    assert.equal(b.run('chatForChannel("twitch/example").length'), 0);
  });
  await check('une citation récupérée reste dans son salon', async () => {
    const b = await fresh();
    b.run('recentChat.push({a:"alice",t:"citation ailleurs",channel:"kick/other"})');
    assert.equal(b.run('lookupQuote("alice", "", "twitch/example")'), '');
  });
  await check('la réinjection charge aussi les règles regex', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    const injected = [];
    const ctx = vm.createContext({ CHAT_TAB_URLS: [], chrome: {
      tabs: {query: (_, cb) => cb([{id:1}])},
      scripting: {executeScript: opts => {injected.push(opts.files);return Promise.resolve();},
        insertCSS: () => Promise.resolve()}
    }});
    vm.runInContext(src.slice(src.indexOf('function injectIntoTwitch('), src.indexOf('function warmup(')), ctx);
    ctx.injectIntoTwitch();
    assert.ok(injected[0].includes('regex-rules.js'));
  });
  await check('les notes auteur répondent et survivent à deux écritures concurrentes', async () => {
    const b = await fresh({csg_author_notes:{old:{text:'ancienne note'}}});
    const responses = [];
    for (const [author, text] of [['alice','note A'],['bob','note B']]) {
      const result = b.emit('runtime.onMessage', {type:'CSG_AUTHOR_NOTE_SET', author, text},
        {url:'chrome-extension://refchat/board.html'}, r => responses.push(r));
      assert.ok(result.includes(true), 'message pris en charge');
    }
    for (let i = 0; i < 30; i++) await tick();
    assert.equal(responses.length, 2);
    assert.equal(responses.every(r => r.ok), true);
    assert.equal(b.store.csg_author_notes.alice.text, 'note A');
    assert.equal(b.store.csg_author_notes.bob.text, 'note B');
    assert.equal(b.store.csg_author_notes.old.text, 'ancienne note');
  });
  await check('un échec de lecture de bloc ne détruit pas son contenu archivé', async () => {
    const row = {id:'old',text:'archivé',label:'keep'};
    const b = await fresh({csg_ft_arch:{chunks:1,rows:1}, csg_ftc_0:[row]});
    b.run(`globalThis.__read = chrome.storage.local.get;
      chrome.storage.local.get = (keys, cb) => {
        if (keys && Object.hasOwn(keys, 'csg_ftc_0')) {
          chrome.runtime.lastError = {message:'lecture indisponible'}; cb({});
          chrome.runtime.lastError = undefined;
        } else return __read(keys, cb);
      };
      archiveFt([{id:'new',text:'nouveau',label:'keep'}]); flushFtArchive();`);
    for (let i = 0; i < 30; i++) await tick();
    assert.equal(b.store.csg_ftc_0[0].id, 'old');
    assert.equal(b.store.csg_ft_arch.rows, 1);
    assert.equal(b.run('ftArchQueue.length'), 1);
  });
  await check('une synchronisation expirée ne repart pas sur un callback tardif', async () => {
    const b = await fresh();
    b.run(`cloudCfg={on:true,url:'https://cloud.example',token:'offline-test'};
      globalThis.__timers=[]; globalThis.__collect=[]; globalThis.__fetches=0;
      setTimeout=(fn,ms)=>{__timers.push({fn,ms});return __timers.length;};clearTimeout=()=>{};
      collectCloudStore=cb=>__collect.push(cb);
      cloudFetch=async()=>{__fetches++;return null;};
      runCloudSync('push',true);`);
    b.run('__timers.find(t=>t.ms===45000).fn(); __collect[0]({csg_ft_log:[],csg_muted:{},csg_settings:{}});');
    for(let i=0;i<20;i++) await tick();
    assert.equal(b.run('__fetches'),0);
  });
  await check('changer la configuration annule le reste d une ancienne synchronisation', async () => {
    const b = await fresh();
    b.run(`cloudCfg={on:true,url:'https://cloud.example',token:'offline-test'};
      globalThis.__fetches=0;
      collectCloudStore=cb=>cb({csg_ft_log:[],csg_muted:{},csg_settings:{}});
      cloudFetch=async()=>{__fetches++;return await new Promise(resolve=>{globalThis.__getDone=resolve;});};
      runCloudSync('push',true);`);
    for(let i=0;i<20;i++) await tick();
    b.run(`cloudCfg={on:true,url:'https://other.example',token:'other-test'}; __getDone(null);`);
    for(let i=0;i<20;i++) await tick();
    assert.equal(b.run('__fetches'),1,'aucun PUT envoyé avec la nouvelle configuration');
    assert.equal(b.run('cloudBusy'),false);
  });
  await check('une synchronisation manuelle reste possible avec le mode automatique coupé', async () => {
    const b = await fresh();
    b.run(`cloudCfg={on:false,url:'https://cloud.example',token:'offline-test'};
      globalThis.__fetches=0;globalThis.__syncAnswer=null;
      collectCloudStore=cb=>cb({csg_ft_log:[],csg_muted:{},csg_settings:{}});
      cloudFetch=async()=>{__fetches++;return null;};
      runCloudSync('push',true,r=>{__syncAnswer=r;});`);
    for(let i=0;i<20;i++) await tick();
    assert.equal(b.run('__fetches'),2);
    assert.equal(b.run('__syncAnswer.ok'),true);
  });
  await check('une archive illisible ne déclenche pas de pardon fondé sur des preuves manquantes', async () => {
    const b = await fresh();
    b.run(`navigator={userAgent:'test-browser'};pardonDone=false;
      globalThis.__pardons=0;globalThis.__archiveReads=0;
      flushFtArchive=cb=>cb();
      readFtArchive=cb=>{__archiveReads++;cb([],{message:'lecture indisponible'});};
      pardonFalseMutes=()=>{__pardons++;return [];};
      schedulePardon();`);
    for(let i=0;i<20;i++) await tick();
    assert.equal(b.run('__archiveReads'),1);
    assert.equal(b.run('__pardons'),0);
  });
  await check('une note non sauvegardée signale l échec et libère les suivantes', async () => {
    const b = await fresh();
    b.run(`globalThis.__setNotes=chrome.storage.local.set;globalThis.__failNote=true;
      chrome.storage.local.set=(value,cb)=>{
        if(value.csg_author_notes && __failNote){__failNote=false;chrome.runtime.lastError={message:'erreur disque'};
          cb();chrome.runtime.lastError=undefined;return;}
        return __setNotes(value,cb);
      };`);
    const answers=[];
    for(const author of ['alice','bob']) b.emit('runtime.onMessage',
      {type:'CSG_AUTHOR_NOTE_SET',author,text:'note'}, {url:'chrome-extension://refchat/board.html'},r=>answers.push(r));
    for(let i=0;i<30;i++) await tick();
    assert.equal(answers[0].ok,false);assert.equal(answers[1].ok,true);
    assert.equal(b.store.csg_author_notes.alice,undefined);assert.equal(b.store.csg_author_notes.bob.text,'note');
  });
  console.log(passed + ' cas vérifiés, ' + failed + ' échecs');
  process.exitCode = failed ? 1 : 0;
})().catch(e => {console.error(e);process.exitCode=1;}).finally(() => clearInterval(keepAlive));
