'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.REFCHAT_CONTENT || path.join(__dirname, '..', 'content.js'), 'utf8');
function section(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, from);
  return source.slice(a, b);
}
let failed = 0, passed = 0;
function check(name, fn) {
  try { fn();passed++;console.log('OK ' + name); }
  catch(e) { failed++;console.error('FAIL ' + name + ': ' + e.message); }
}
class Line {
  constructor(author='alice', text='bonjour') {
    this.dataset = {};this.author=author;this.text=text;this.nodeType=1;this.isConnected=true;
    this.classList={contains:()=>false};
  }
  hasAttribute(name) {return name==='data-index';}
  getAttribute(name) {return name==='data-user' ? this.author : '';}
  querySelector() {return {textContent:this.text};}
  querySelectorAll(selector) {return selector.includes('text-fragment') ? [{textContent:this.text}] : [];}
  closest(selector) {return selector === '.chat-line__message' ? this : null;}
}
function queueContext() {
  const timers=[], sent=[];
  let dead=false, stopped=0;
  const ctx=vm.createContext({Date,Math,WeakMap,Set,HTMLElement:Line,LINE_SEL:'.chat-line__message',
    contentCleanups: [],
    pending:new Set(),settings:{enabled:true,ambiencePause:true},settingsReady:true,
    ctxDead:()=>dead,teardown:()=>{stopped++;},setTimeout:fn=>{timers.push(fn);return timers.length;},
    clearTimeout(){},flushT:null,unhideLine(){},rowLen:el=>String(el.text.length),
    isChatLine:el=>el instanceof Line,isComposer:()=>false,chatName:el=>el.author,
    extractReply:()=>({to:'',quote:''}),msgText:el=>el.text,nextId:()=> 'csg_test',
    sendBg:msg=>sent.push(msg),currentChannel:()=> 'kick/example',getWhy:()=> 'ok',
    paintHud(){},handleLine(){},document:{visibilityState:'visible'}});
  vm.runInContext(section('  function rowKey(', '  function nextId('),ctx);
  return {ctx,timers,sent,kill:()=>{dead=true;},stopped:()=>stopped};
}
check('un rescan ne retire pas la provenance directe d une ligne en attente',()=>{
  const {ctx}=queueContext(),line=new Line();
  ctx.queueLine(line,100,100);ctx.queueLine(line);
  ctx.line=line;
  assert.equal(vm.runInContext('liveLineAt.get(line)',ctx),100);
  assert.equal(vm.runInContext('ambienceLineAt.get(line)',ctx),100);
});
check('une row Kick recyclée prend son nouvel auteur',()=>{
  const {ctx}=queueContext(),line=new Line();
  line.dataset.csgName='alice';const before=ctx.rowKey(line);
  line.author='bob';assert.notEqual(ctx.rowKey(line),before);
});
check('deux messages Kick avec le même début restent distincts',()=>{
  const {ctx}=queueContext(),line=new Line('alice','a'.repeat(140)+'premier');
  const before=ctx.rowKey(line);line.text='a'.repeat(140)+'second';
  assert.notEqual(ctx.rowKey(line),before);
});
check('une row recyclée ne garde pas l ancienne citation',()=>{
  const {ctx}=queueContext(),line=new Line();
  Object.assign(line.dataset,{csg:'1',csgKey:'old',csgId:'old-id',csgReplyTo:'old-author',csgReplyQuote:'old-quote',csgReply:'0'});
  ctx.queueLine(line);
  assert.equal(line.dataset.csgReplyTo,undefined);
  assert.equal(line.dataset.csgReplyQuote,undefined);
  assert.equal(line.dataset.csgId,undefined);
});
check('un fragment ajouté à une ligne déjà présente rejoint la capture',()=>{
  const {ctx}=queueContext(),line=new Line(),fragment=new Line();
  ctx.isChatLine=el=>el===line;fragment.closest=()=>line;fragment.querySelectorAll=()=>[];
  vm.runInContext(section('  function collectLines(', '  let lastMutAt'),ctx);
  const out=[];ctx.collectLines(fragment,out);assert.equal(out.includes(line),true);
});
check('le flush cesse dès que le contexte extension est invalidé',()=>{
  const q=queueContext();q.ctx.settingsReady=false;q.kill();q.ctx.flushPending();
  assert.equal(q.timers.length,0);assert.equal(q.stopped(),1);
});
check('une capture non livrée redevient disponible pour le rescan',()=>{
  const line={dataset:{csg:'1',csgId:'csg_retry'}};let options;
  const ctx=vm.createContext({sendBg:(_,opts)=>{options=opts;return true;},lineById:()=>line});
  vm.runInContext(section('  function logCapture(', '  function capturePayload('),ctx);
  ctx.logCapture({id:'csg_retry'});
  assert.equal(typeof options.onDrop,'function');options.onDrop();
  assert.equal(line.dataset.csg,undefined);
  assert.equal(line.dataset.csgId,'csg_retry','l identifiant reste stable pour éviter un doublon');
});
check('une ancienne instance se nettoie sans arrêter sa remplaçante',()=>{
  let cleaned=0,disconnected=0;
  const ctx=vm.createContext({tornDown:false,ctxGone:false,contentCleanups:[()=>cleaned++],CSG_VER:1,
    window:{__csgVer:2,__csgObserver:{disconnect:()=>disconnected++}},clearTimeout(){},clearInterval(){}});
  vm.runInContext(section('  function teardown(', '  // Tout appel chrome.*'),ctx);
  ctx.teardown();ctx.teardown();
  assert.equal(cleaned,1);assert.equal(disconnected,0);
});
console.log(passed+' cas vérifiés, '+failed+' échecs');
process.exitCode=failed?1:0;
