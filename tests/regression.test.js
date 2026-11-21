import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = read('public/assets/app.js');
const server = read('server.js');
const music = read('public/assets/music.js');

function frontend() {
  const elements = new Map();
  const document = { querySelector: (selector) => elements.get(selector) || null };
  const context = vm.createContext({ document, performance: { now: () => 0 }, Date, console, window: { clearTimeout() {}, setTimeout() {} } });
  vm.runInContext(app.slice(0, app.lastIndexOf('\nsetupDecorations();')), context);
  return { context, elements, run: (code) => vm.runInContext(code, context) };
}

test('故障时长保留秒、零值及未知值，不伪造一分钟故障', () => {
  const { run } = frontend();
  assert.equal(run('formatDuration(11000)'), '11 秒');
  assert.equal(run('formatDuration(292000)'), '4 分钟 52 秒');
  assert.equal(run("incidentDuration({status:'up', durationMs:0})"), '0 秒');
  assert.equal(run("incidentDuration({status:'up', durationMs:null})"), '持续时间未记录');
  assert.equal(run("statsFor({history:[{ok:true,latency:null},{ok:false,latency:120}]}).average"), 120);
});

test('总览使用真实历史成功率，未检测的页面不显示100%', () => {
  const { run, elements } = frontend();
  const summary = { textContent: '' };
  elements.set('#summaryText', summary);
  run("renderOverall({summary:{total:1,checked:1,up:1}},[{history:[{ok:true},{ok:false}]}])");
  assert.equal(summary.textContent, '50.00%');
  run("renderOverall({summary:{total:1,checked:0}},[{history:[]}])");
  assert.equal(summary.textContent, '—');
});

test('历史故障与恢复按服务配对，未恢复的故障保留null时长', () => {
  const db = { incidents: [
    { id:'a', monitorId:'x', status:'down', createdAt:'2026-11-21T00:00:00Z', durationMs:null },
    { id:'b', monitorId:'y', status:'down', createdAt:'2026-11-21T00:00:05Z', durationMs:null },
    { id:'c', monitorId:'x', status:'up', createdAt:'2026-11-21T00:00:11Z' }
  ] };
  const context = vm.createContext({ db, Date });
  vm.runInContext(server.slice(server.indexOf('function incidentViews('), server.indexOf('function publicData(')), context);
  const result = vm.runInContext('incidentViews()', context);
  assert.equal(result[0].durationMs, 11000);
  assert.equal(result[1].durationMs, null);
  assert.equal(result[2].resolvedAt, '2026-11-21T00:00:11Z');
  assert.equal(db.incidents[0].durationMs, null, '读取历史不得修改原始数据');
});

test('空歌单兼容网易云result数组并生成可播放队列', async () => {
  const context = vm.createContext({ Date, db:{settings:{music:{queue:[],randomEnabled:true}}}, musicData:(v)=>v?.data??v,
    musicLoggedIn:()=>true, musicProvider:()=> 'netease', musicBaseUrl:()=>'',
    musicRequest:async()=>({result:[{id:1,name:'测试歌曲',song:{id:1,name:'测试歌曲',artists:[{name:'测试歌手'}]}}]}),
    saveDb:async()=>{} });
  vm.runInContext(server.slice(server.indexOf('function normalizeTrack('), server.indexOf('async function syncMusicAccount(')), context);
  const tracks = await vm.runInContext('ensureRandomMusicQueue()', context);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, '1');
  assert.equal(tracks[0].title, '测试歌曲');
  assert.equal(tracks[0].artist, '测试歌手');
});

test('指定移除仅移除目标歌曲，清空最后一首启用随机来源', async () => {
  let remove;
  const db = {settings:{music:{queue:[{id:'a'},{id:'b'}],randomEnabled:false,playlistId:'p',playlistName:'列表'}}};
  const context = vm.createContext({ db, requireAdmin:()=>{}, saveDb:async()=>{}, app:{delete:(_path,_auth,handler)=>{remove=handler;}} });
  vm.runInContext(server.slice(server.indexOf("app.delete('/api/music/queue/:id'"),server.indexOf("app.put('/api/admin/music/random'")), context);
  await remove({params:{id:'a'}}, {json(){}});
  assert.equal(db.settings.music.queue.length, 1);
  assert.equal(db.settings.music.queue[0].id, 'b');
  await remove({params:{id:'b'}}, {json(){}});
  assert.equal(db.settings.music.randomEnabled, true);
  assert.equal(db.settings.music.playlistId, '');
});

test('第一次检测即故障也创建事件，恢复后写入准确时长', async () => {
  let ok = false;
  let clock = '2026-11-21T00:00:00Z';
  const db = {monitors:[{id:'m',name:'测试',enabled:true}],results:{},incidents:[],settings:{historyDays:7}};
  const context = vm.createContext({ db, Date, now:()=>clock,id:()=>String(db.incidents.length),
    checkMonitor:async()=>({ok,latency:10}), pruneHistory:(rows=[])=>rows, saveDb:async()=>{}, sendNotification:async()=>{} });
  vm.runInContext(server.slice(server.indexOf('async function runMonitor('), server.indexOf('async function checkAll(')), context);
  await vm.runInContext("runMonitor('m')", context);
  assert.equal(db.incidents.length, 1);
  assert.equal(db.incidents[0].status, 'down');
  clock='2026-11-21T00:00:11Z'; ok=true;
  await vm.runInContext("runMonitor('m')", context);
  assert.equal(db.incidents[0].durationMs, 11000);
  assert.equal(db.incidents[1].durationMs, 11000);
});

test('轮询在执行时标记真实状态，结束后发布下一次计划；重复读取不重置计划', async () => {
  let scheduled;
  let fail = false;
  const context = vm.createContext({ db:{settings:{refreshSeconds:60}}, Date,
    setTimeout:(fn,delay)=>{scheduled={fn,delay};return 1;}, clearTimeout:()=>{},
    checkAll:async()=>{ assert.equal(vm.runInContext('schedulerRunning',context),true); if(fail) throw new Error('network'); },
    console:{error(){}} });
  vm.runInContext(server.slice(server.indexOf('let scheduler;'),server.indexOf("checkAll().catch(error => console.error('initial check failed'")),context);
  vm.runInContext('schedulerRunning=false; scheduleNextCheck()',context);
  const first=vm.runInContext('schedulerNextAt',context);
  assert.equal(scheduled.delay,60000);
  assert.equal(vm.runInContext('schedulerNextAt',context),first);
  await scheduled.fn();
  assert.equal(vm.runInContext('schedulerRunning',context),false);
  assert.ok(vm.runInContext('schedulerNextAt',context)>=first);
  fail=true;
  await scheduled.fn();
  assert.equal(vm.runInContext('schedulerRunning',context),false,'检查失败也必须离开正在检查状态');
  assert.equal(scheduled.delay,60000);
});

function player() {
  class Audio {
    constructor(){this.handlers={};this.src='';this.paused=true;this.currentTime=0;this.duration=120;}
    addEventListener(name,fn){this.handlers[name]=fn;}
    load(){}
    async play(){if(this.block){const e=new Error('blocked');e.name='NotAllowedError';throw e;}this.paused=false;this.handlers.play?.();}
    pause(){this.paused=true;this.handlers.pause?.();}
  }
  const elements=new Map();
  const element=(id)=> { if(!elements.has(id)) elements.set(id,{textContent:'',style:{},classList:{toggle(){}},setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this[name]=fn;}});return elements.get(id); };
  const root={querySelector:element,contains:()=>false,classList:{toggle(){},remove(){}}};
  const context=vm.createContext({window:{},document:{querySelector:()=>null,addEventListener(){}},Audio,AbortSignal,
    fetch:async()=>({ok:true,json:async()=>({url:'https://example.test/test.mp3'})}),console,Math});
  vm.runInContext(music.replace('const root = document.querySelector', 'window.Player = PlatformMusicPlayer; const root = document.querySelector'),context);
  context.window.Player.prototype.loadConfig=async()=>{};
  const instance=new context.window.Player(root);
  instance.config.loggedIn=true;
  instance.queue=[{id:'a',title:'A',artist:'Artist'},{id:'b',title:'B',artist:'Artist'}];
  return {instance,element};
}

test('随机按钮切换模式，暂停后可恢复；上一首返回历史歌曲', async () => {
  const {instance:p,element}=player();
  element('#musicRandom').click(); assert.equal(p.shuffle,false);
  await p.playTrack(0); assert.equal(element('#musicState').textContent,'正在播放');
  await p.togglePlayback(); assert.equal(p.isPlaying,false); assert.equal(element('#musicState').textContent,'已暂停');
  await p.togglePlayback(); assert.equal(p.isPlaying,true);
  await p.playNext(); assert.equal(p.trackIndex,1);
  await p.playPrevious(); assert.equal(p.trackIndex,0);
});

test('不循环随机模式播完停止；单曲循环仍播放同一首', async () => {
  const {instance:p,element}=player();
  p.repeatMode='off'; await p.playTrack(0); await p.handleEnded(); assert.equal(p.trackIndex,1);
  await p.handleEnded(); assert.equal(element('#musicState').textContent,'队列播放完成');
  p.repeatMode='one'; await p.handleEnded(); assert.equal(p.trackIndex,1);
});

test('自动播放受限时保留真实提示，点击播放后清除旧提示', async () => {
  const {instance:p,element}=player();
  p.audio.block=true; await p.playTrack(0);
  assert.equal(p.autoplayBlocked,true);
  assert.match(element('#musicState').textContent,/自动播放受限/);
  p.audio.block=false; await p.togglePlayback();
  assert.equal(element('#musicState').textContent,'正在播放');
  assert.equal(p.autoplayBlocked,false);
});

test('拖动进度时预览不被播放事件覆盖，松手跳转；键盘也能调整', async () => {
  const {instance:p,element}=player();
  await p.playTrack(0);
  const seek=element('#musicSeek');
  assert.equal(seek.disabled,false);
  seek.pointerdown();
  seek.value='500'; seek.input();
  p.audio.currentTime=12; p.audio.handlers.timeupdate();
  assert.equal(seek.value,'500');
  assert.equal(element('#musicTime').textContent,'01:00 / 02:00');
  seek.change();
  assert.equal(p.audio.currentTime,60);
  seek.value='750'; seek.input();
  assert.equal(p.audio.currentTime,90);
  p.seekTo(999); assert.equal(p.audio.currentTime,120);
  p.seekTo(-5); assert.equal(p.audio.currentTime,0);
  p.audio.duration=Infinity; p.renderProgress();
  assert.equal(seek.disabled,true);
  p.seekTo(15); assert.equal(p.audio.currentTime,0);
});

test('队列更新保持当前歌曲，移除正在试听的歌曲后停止且不播放错误索引', async () => {
  const {instance:p}=player();
  await p.playTrack(1);
  p.audio.currentTime=30;
  p.updateQueue([{id:'b',title:'B',artist:'Artist'},{id:'c',title:'C'}]);
  assert.equal(p.trackIndex,0);
  assert.equal(p.audio.currentTime,30);
  assert.equal(p.isPlaying,true);
  p.updateQueue([{id:'c',title:'C'}]);
  assert.equal(p.trackIndex,-1);
  assert.equal(p.isPlaying,false);
  assert.equal(p.audio.src,'');
});

test('后台自动同步保留正在编辑但尚未保存的设置', () => {
  const admin=read('public/assets/admin.js');
  const form={dataset:{dirty:'true'},elements:{siteName:{value:'尚未保存的站点名称'}}};
  const notify={dataset:{dirty:'true'},elements:{webhookUrl:{value:'https://example.test/unsaved'}}};
  const context=vm.createContext({state:{settings:{siteName:'服务器上的旧名称'}},$:(selector)=>selector==='#siteSettingsForm'?form:notify});
  vm.runInContext(admin.slice(admin.indexOf('function fillSettings('),admin.indexOf('function renderMusicAdmin(')),context);
  vm.runInContext('fillSettings()',context);
  assert.equal(form.elements.siteName.value,'尚未保存的站点名称');
  assert.equal(notify.elements.webhookUrl.value,'https://example.test/unsaved');
});

test('初次接口一直未返回时，过场也会在上限内结束且只结束一次', () => {
  const {context,elements,run}=frontend();
  const timers=[];
  const classes=new Set(['is-loading']);
  context.document.body={classList:{add:(name)=>classes.add(name),remove:(name)=>classes.delete(name)}};
  let hidden=0;
  elements.set('#pageLoader',{classList:{add:()=>hidden++},remove(){}});
  context.window.setTimeout=(fn,delay)=>{timers.push({fn,delay});return timers.length;};
  run('finishInitialLoad(new Promise(() => {}))');
  const fallback=timers.find((timer)=>timer.delay===3200);
  assert.ok(fallback);
  fallback.fn(); fallback.fn();
  assert.equal(classes.has('is-loading'),false);
  assert.equal(hidden,1);
});
