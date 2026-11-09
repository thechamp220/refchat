'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bench, booted, tick } = require('./bench');
let failed=0;
async function check(name, fn) {
  try {await fn();console.log('OK '+name);}
  catch(e) {failed++;console.error('FAIL '+name+': '+e.message);}
}
const keepAlive=setInterval(()=>{},1000);
(async()=>{
  await check('deux réglages rapides ne s écrasent pas',()=>{
    const src=fs.readFileSync(path.join(__dirname,'..','popup.js'),'utf8');
    const callbacks=[];let store={target:'message'};
    const ctx=vm.createContext({chrome:{runtime:{},storage:{sync:{
      get:(_,cb)=>{const v={...store};callbacks.push(()=>cb({csg_settings:v}));},
      set:(obj,cb)=>{store={...obj.csg_settings};if(cb)callbacks.push(cb);}
    }}},console});
    vm.runInContext(src.slice(src.indexOf('function patchSettings('),src.indexOf("$('ambiencePause').addEventListener")),ctx);
    ctx.patchSettings({enabled:false});ctx.patchSettings({ambiencePause:false});
    while(callbacks.length) callbacks.shift()();
    assert.equal(store.enabled,false);assert.equal(store.ambiencePause,false);assert.equal(store.target,'message');
  });
  await check('une protection non sauvegardée ne démute pas et signale l échec',async()=>{
    const b=bench({csg_muted:{alice:{site:'twitch',at:Date.now(),perm:true}}});
    await booted(b);for(let i=0;i<20;i++)await tick();
    b.run(`globalThis.__set=chrome.storage.local.set;
      chrome.storage.local.set=(value,cb)=>{
        if(value.csg_whitelist){chrome.runtime.lastError={message:'stockage indisponible'};
          if(cb)cb();chrome.runtime.lastError=undefined;return;}
        return __set(value,cb);
      };`);
    let answer;
    b.emit('runtime.onMessage',{type:'CSG_WHITELIST',names:['alice'],on:true},
      {url:'chrome-extension://refchat/board.html'},res=>{answer=res;});
    for(let i=0;i<30;i++)await tick();
    assert.equal(answer.ok,false);
    assert.equal(!!b.store.csg_muted.alice,true);
    assert.equal(!!b.run('whitelist.alice'),false);
  });
  process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearInterval(keepAlive));
