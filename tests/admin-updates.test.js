import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { test } from 'node:test';
import { appearanceDefaults, validateAppearance } from '../src/appearance.js';
import { mergeCookies, cookieValue, normalizeQr, qrStatus } from '../src/music-auth.js';
import { changelogSection, chooseVersionedRelease, compareVersions, normalizeVersion } from '../src/update-check.js';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('背景参数保留零值，拒绝危险地址和无效数值', () => {
  assert.deepEqual(validateAppearance({backgroundBlur:0,backgroundOpacity:0,surfaceOpacity:.35}),{backgroundBlur:0,backgroundOpacity:0,surfaceOpacity:.35});
  for (const input of [{randomBackgroundUrl:'javascript:alert(1)'},{fixedBackgroundUrl:'https://user:pass@example.com/a.jpg'},{surfaceOpacity:.1},{backgroundBlur:31},{backgroundOpacity:'NaN'},{backgroundMode:'other'}]) assert.throws(() => validateAppearance(input));
  assert.equal(appearanceDefaults.backgroundMode,'random');
});

test('扫码 Cookie 合并保留等号和已有字段，读取完整 MUSIC_U', () => {
  const cookie = mergeCookies('device=one; MUSIC_U=old', ['MUSIC_U=new==; Path=/; HttpOnly','sessionid=abc=; Secure']);
  assert.equal(cookieValue(cookie,'MUSIC_U'),'new==');
  assert.equal(cookieValue(cookie,'sessionid'),'abc=');
  assert.equal(cookieValue(cookie,'device'),'one');
});

test('汽水二维码优先原始图片与链接，并报告平台实际错误', () => {
  const qr = normalizeQr({message:'success',data:{token:'test',qrcode:'data:image/png;base64,abc',qrcode_index_url:'https://qishui.com/login',expire_time:1800000000}});
  assert.equal(qr.token,'test');
  assert.equal(qr.image,'data:image/png;base64,abc');
  assert.equal(qr.expiresAt,1800000000000);
  assert.throws(()=>normalizeQr({message:'error',data:{error_code:3,description:'缺少参数'}}),/错误（3）/);
});

test('扫码状态兼容原生与适配器，不混淆汽水等待、扫描和过期', () => {
  assert.equal(qrStatus('netease',{code:803,cookie:'MUSIC_U=test'}).status,'confirmed');
  assert.equal(qrStatus('netease',{code:200,data:{code:803,cookie:'MUSIC_U=test'}}).status,'confirmed');
  assert.equal(qrStatus('netease',{code:200,data:{code:802}}).status,'scanned');
  assert.equal(qrStatus('qishui',{data:{status:'new',error_code:0}}).status,'pending');
  assert.equal(qrStatus('qishui',{data:{status:'scanned'}}).status,'scanned');
  assert.equal(qrStatus('qishui',{data:{status:'confirmed',redirect_url:'https://api.qishui.com/finish'}}).status,'confirmed');
  assert.equal(qrStatus('qishui',{data:{status:1}},true).status,'pending');
  assert.equal(qrStatus('qishui',{data:{status:2}}).status,'scanned');
  assert.equal(qrStatus('qishui',{data:{status:3}},true).status,'confirmed');
  assert.equal(qrStatus('qishui',{data:{status:4}}).status,'expired');
  assert.equal(qrStatus('qishui',{code:0,data:{data:{status:'confirmed'},auth:{sessionid:'fixture-session'}}}).sessionId,'fixture-session');
});

test('版本比较兼容 v、release 前缀，并选择最高稳定标签', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('release-1.10.0'), '1.10.0');
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(normalizeVersion('2026-preview'), '');
  assert.equal(normalizeVersion('v2.0.0-beta.1'), '');
  assert.equal(chooseVersionedRelease([{tag_name:'v9.0.0',prerelease:true},{tag_name:'v8.0.0',draft:true},{name:'v1.2.0'}]).version,'1.2.0');
  assert.equal(chooseVersionedRelease([{tag_name:'v1.0.0'}, {name:'v1.2.0'}, {name:'preview'}]).version, '1.2.0');
});

test('版本公告可以从 CHANGELOG 对应版本提取更新内容', () => {
  const markdown = '# 更新记录\n\n## [1.0.1] - 2026-11-21\n\n- 修复扫码登录\n- 增加分类长按排序\n\n## [1.0.0] - 2026-11-21\n\n- 初次发布';
  assert.match(changelogSection(markdown, 'v1.0.1'), /修复扫码登录/);
  assert.doesNotMatch(changelogSection(markdown, '1.0.1'), /初次发布/);
  assert.match(changelogSection(markdown.replaceAll('\n','\r\n'), '1.0.0'), /初次发布/);
  assert.equal(changelogSection(markdown,'1.0.10'),'');
  assert.doesNotMatch(changelogSection(read('CHANGELOG.md'),'1.0.1'), /\[1\.0\.1\]:/);
});

function qrBackend(payload, provider='netease') {
  const source=read('server.js');
  let saved=0;
  const db={settings:{music:{provider,cookie:'',sessionId:'',account:null}}};
  const context=vm.createContext({db,musicAuthGeneration:0,musicBaseUrl:()=> 'https://adapter.test',musicProvider:()=>provider,
    musicRequest:async()=>payload,qrStatus,mergeCookies,cookieValue,saveDb:async()=>{saved++;},exchangeQishuiRedirect:async()=>{}});
  vm.runInContext(source.slice(source.indexOf('async function checkMusicQr('),source.indexOf("app.get('/api/music/login/qr/status'")),context);
  const flow={provider,generation:0,cookie:'',upstreamToken:'test'};
  context.flow=flow;
  return {context,db,flow,run:()=>vm.runInContext('checkMusicQr(flow)',context),saved:()=>saved};
}

test('网易云确认后先持久化登录，再返回；资料查询不阻塞且重复状态可重读', async () => {
  const fixture=qrBackend({code:803,cookie:'MUSIC_U=credential==; __csrf=test'});
  assert.equal((await fixture.run()).status,'confirmed');
  assert.equal(fixture.db.settings.music.cookie,'MUSIC_U=credential==; __csrf=test');
  assert.equal(fixture.saved(),1);
  assert.equal((await fixture.run()).loggedIn,true);
  assert.equal(fixture.saved(),1);
});

test('内层扫码确认及汽水会话凭据都能完成登录保存', async () => {
  const netease = qrBackend({code:200,data:{code:803,cookie:'MUSIC_U=credential'}});
  assert.equal((await netease.run()).loggedIn,true);
  assert.equal(netease.saved(),1);
  const qishui = qrBackend({data:{status:3,session_id:'fixture-session'}},'qishui');
  assert.equal((await qishui.run()).loggedIn,true);
  assert.equal(qishui.db.settings.music.sessionId,'fixture-session');
  assert.equal(qishui.saved(),1);
});

test('未取得凭据不冒充登录；退出后的旧扫码响应不能重新登录', async () => {
  const incomplete=qrBackend({code:803});
  assert.equal((await incomplete.run()).status,'authorizing');
  assert.equal(incomplete.saved(),0);
  const stale=qrBackend({code:803,cookie:'MUSIC_U=credential'});
  stale.context.musicAuthGeneration=1;
  assert.equal((await stale.run()).status,'expired');
  assert.equal(stale.db.settings.music.cookie,'');
});

test('后台账号接口可以修改当前用户名并拒绝重复账号', async () => {
  const source = read('server.js'); let handler;
  const db = { users: [{id:'a', username:'admin'}, {id:'b', username:'other'}] };
  const context = vm.createContext({ db, requireAdmin(){}, saveDb:async()=>{}, app:{put:(path,_auth,fn)=>{if(path === '/api/admin/account') handler=fn;}} });
  vm.runInContext(source.slice(source.indexOf("app.put('/api/admin/account'"), source.indexOf("app.post('/api/admin/categories'")), context);
  const response = () => ({ status(code){this.code=code;return this;}, json(data){this.data=data;} });
  const req = { user: {userId:'a', username:'admin'}, body:{username:'new-admin'} };
  const first = response(); await handler(req, first);
  assert.deepEqual(JSON.parse(JSON.stringify(first.data)), {ok:true, username:'new-admin'});
  assert.equal(db.users[0].username, 'new-admin');
  assert.equal(req.user.username, 'new-admin');
  const duplicate = response(); await handler({user:{userId:'a',username:'new-admin'}, body:{username:'other'}}, duplicate);
  assert.equal(duplicate.code, 409);
});

test('后台分类和监控排序接口只接受完整的当前列表', async () => {
  const source = read('server.js'); const handlers = {};
  const db = { categories:[{id:'a',sort:0},{id:'b',sort:1}], monitors:[{id:'m1',categoryId:'a',sort:0},{id:'m2',categoryId:'a',sort:1},{id:'m3',categoryId:'b',sort:0}] };
  const context = vm.createContext({ db, requireAdmin(){}, saveDb:async()=>{}, app:{put:(path,_auth,fn)=>{handlers[path]=fn;}} });
  vm.runInContext(source.slice(source.indexOf("app.put('/api/admin/categories/order'"), source.indexOf("app.post('/api/admin/monitors'")), context);
  const response = () => ({ status(code){this.code=code;return this;}, json(data){this.data=data;} });
  let res = response(); await handlers['/api/admin/categories/order']({body:{categoryIds:['b','a']}}, res);
  assert.equal(db.categories[0].sort, 1); assert.equal(db.categories[1].sort, 0);
  res = response(); await handlers['/api/admin/monitors/order']({body:{categoryId:'a',monitorIds:['m2','m1']}}, res);
  assert.equal(db.monitors[0].sort, 1); assert.equal(db.monitors[1].sort, 0);
  res = response(); await handlers['/api/admin/monitors/order']({body:{categoryId:'a',monitorIds:['m2']}}, res);
  assert.equal(res.code, 400);
});

test('真实路由访问分类排序不会被编辑分类接口拦截', async () => {
  const source=read('server.js');
  const app=express(); app.use(express.json());
  let saved=0;
  const db={categories:[{id:'a',name:'A',sort:0},{id:'b',name:'B',sort:1}],monitors:[]};
  const context=vm.createContext({app,db,requireAdmin:(_req,_res,next)=>next(),saveDb:async()=>saved++});
  vm.runInContext(source.slice(source.indexOf("app.post('/api/admin/categories'"),source.indexOf("app.post('/api/admin/monitors'")),context);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const response=await fetch(origin+'/api/admin/categories/order',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({categoryIds:['b','a']})});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).categoryIds,['b','a']);
    assert.equal(db.categories[0].sort,1); assert.equal(saved,1);
    const invalid=await fetch(origin+'/api/admin/categories/order',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({categoryIds:['a','a']})});
    assert.equal(invalid.status,400); assert.equal(saved,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('只有新标签时也显示更新内容，旧 Release 和预览版本不遮挡它', async () => {
  const source=read('server.js');
  const context=vm.createContext({appVersion:'1.0.0',githubProjectUrl:'https://github.com/futao-awa/Status-Girl',now:()=>new Date().toISOString(),compareVersions,chooseVersionedRelease,changelogSection,
    githubJson:async(path)=>path.startsWith('releases')?[{tag_name:'v1.0.0',html_url:'https://github.com/futao-awa/Status-Girl/releases/tag/v1.0.0'},{tag_name:'v3.0.0',prerelease:true}]:[{name:'v1.0.1'}],
    githubText:async()=>read('CHANGELOG.md')});
  vm.runInContext(source.slice(source.indexOf('async function checkGitHubUpdate('),source.indexOf("app.get('/api/health'")),context);
  const update=await vm.runInContext('checkGitHubUpdate()',context);
  assert.equal(update.updateAvailable,true); assert.equal(update.latestVersion,'1.0.1');
  assert.match(update.body,/长按/); assert.match(update.tagUrl,/v1.0.1$/);
  context.githubJson=async()=>{throw Error('offline');};
  const offline=await vm.runInContext('checkGitHubUpdate()',context);
  assert.equal(offline.unavailable,true); assert.equal(offline.updateAvailable,false);
});

test('分类长按后才开始拖动，松手保存，滑动或取消不误保存', async () => {
  const source=read('public/assets/admin.js');
  const handlers={}; const timers=new Map(); let timerId=0; let saved=0;
  const container={children:[],querySelectorAll(){return this.children;},append(row){this.children=this.children.filter(item=>item!==row);this.children.push(row);},insertBefore(row,before){this.children=this.children.filter(item=>item!==row);this.children.splice(this.children.indexOf(before),0,row);}};
  const rows=['a','b','c'].map(id=>({dataset:{categoryId:id},parentElement:container,classList:{values:new Set(),add(value){this.values.add(value);},remove(...values){values.forEach(value=>this.values.delete(value));},contains(value){return this.values.has(value);}},getBoundingClientRect(){return {top:container.children.indexOf(this)*50,height:50};}}));
  container.children=rows.slice();
  const target=(row,button=false)=>({closest(selector){if(selector==='button, a')return button?{}:null; if(selector.startsWith('#categoryList'))return row; return null;}});
  const context=vm.createContext({touchDragKind:'',touchDragPointerId:null,touchDragTimer:0,touchDragStartX:0,touchDragStartY:0,touchDragRow:null,touchDragOrder:[],sortSaving:false,
    document:{addEventListener:(name,fn)=>handlers[name]=fn,querySelectorAll:()=>rows},
    window:{setTimeout(fn){timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)},navigator:{vibrate(){}},
    saveCategoryOrder:async()=>saved++,saveMonitorOrder:async()=>assert.fail('unexpected monitor sort')});
  vm.runInContext(source.slice(source.indexOf('function moveSortableRow('),source.indexOf('function renderDomains(')),context);
  vm.runInContext(source.slice(source.indexOf("document.addEventListener('touchstart'"),source.indexOf("document.addEventListener('click'")),context);
  const touch=(y=0)=>({identifier:1,clientX:10,clientY:y});
  const event=(row,y=0,button=false)=>({target:target(row,button),touches:[touch(y)],changedTouches:[touch(y)],preventDefault(){this.prevented=true;}});
  const start=event(rows[0]);handlers.touchstart(start);
  assert.equal(rows[0].classList.contains('dragging'),false);
  const timer=[...timers.values()][0];timer();
  assert.equal(rows[0].classList.contains('dragging'),true);
  const move=event(rows[0],149);handlers.touchmove(move);
  assert.equal(move.prevented,true);assert.deepEqual(container.children.map(row=>row.dataset.categoryId),['b','c','a']);
  await handlers.touchend(move);assert.equal(saved,1);
  handlers.touchstart(event(rows[1]));handlers.touchmove(event(rows[1],30));
  assert.equal(context.touchDragKind,''); await handlers.touchend(event(rows[1],30));assert.equal(saved,1);
  handlers.touchstart(event(rows[1],0,true));assert.equal(context.touchDragKind,'');
  handlers.touchstart(event(rows[1]));[...timers.values()][0]();handlers.touchmove(event(rows[1],200));handlers.touchcancel();
  assert.deepEqual(container.children.map(row=>row.dataset.categoryId),['b','c','a']);assert.equal(saved,1);
});

test('背景保存验证失败不部分覆盖设置，成功响应不暴露敏感配置', async () => {
  const source=read('server.js'); let handler; let response;
  const db={settings:{...appearanceDefaults,smtp:{pass:'private'},music:{cookie:'private'}}};
  const context=vm.createContext({db,validateAppearance,requireAdmin(){},saveDb:async()=>{},restartScheduler(){},pruneAllHistories(){},app:{put:(p,a,fn)=>{handler=fn;}}});
  vm.runInContext(source.slice(source.indexOf("app.put('/api/admin/settings'"),source.indexOf("app.put('/api/admin/password'")),context);
  const res={status(code){this.code=code;return this;},json(data){response=data;}};
  await handler({body:{siteName:'覆盖',backgroundBlur:100}},res);
  assert.equal(res.code,400); assert.equal(db.settings.siteName,undefined);
  await handler({body:{backgroundBlur:12,backgroundOpacity:0,backgroundMode:'fixed',fixedBackgroundUrl:'https://example.com/image.jpg'}},res);
  assert.equal(db.settings.backgroundBlur,12);assert.equal(db.settings.backgroundOpacity,0);
  assert.deepEqual(JSON.parse(JSON.stringify(response)),{ok:true});
});

test('前端扫码轮询串行重试，确认后立即更新状态且不等待资料', async () => {
  const source=read('public/assets/admin.js');
  const elements=Object.fromEntries(['musicQrButton','musicQrBox','musicQrImage','musicQrHint','musicProvider'].map(id=>['#'+id,{hidden:true,value:id==='musicProvider'?'netease':''}]));
  const timers=[];let calls=0,renders=0,reloads=0;
  const state={settings:{music:{}}};
  const context=vm.createContext({state,musicQrGeneration:0,musicQrTimer:0,Date,
    window:{clearTimeout(){},setTimeout(fn){timers.push(fn);return timers.length;}},$:(selector)=>elements[selector],
    api:async(url)=>url.endsWith('/qr')?{token:'test',qrCode:'data:image/png;base64,test',expiresAt:new Date(Date.now()+180000).toISOString()}:(++calls===1?Promise.reject(Error('暂时离线')):{status:'confirmed',loggedIn:true,account:null}),
    renderMusicAdmin(){renders++;},toast(){},reload(){reloads++;return new Promise(()=>{});},loadMusicPlaylists(){}
  });
  vm.runInContext(source.slice(source.indexOf('function stopMusicQr('),source.indexOf('async function loadMusicPlaylists(')),context);
  await vm.runInContext('startMusicQr()',context);
  await timers.shift()();
  assert.match(elements['#musicQrHint'].textContent,/正在重试/);
  assert.equal(timers.length,1);
  await timers.shift()();
  assert.equal(state.settings.music.loggedIn,true);
  assert.equal(elements['#musicQrBox'].hidden,true);
  assert.equal(renders,1);assert.equal(reloads,1);assert.equal(timers.length,0);
});


test('OpenAPI 声明覆盖实际只读接口，路径参数与鉴权保持一致', () => {
  const spec=JSON.parse(read('public/openapi.json'));
  const server=read('server.js');
  assert.equal(spec.openapi,'3.0.3');
  assert.equal(Object.keys(spec.paths).length,5);
  for (const [path,item] of Object.entries(spec.paths)) {
    const route=path.replace('{id}',':id');
    assert.ok(server.includes("app.get('"+route+"'"),route);
    assert.deepEqual(Object.keys(item),['get']);
    assert.ok(item.get.responses['200']);
  }
  assert.deepEqual(spec.paths['/api/v1/health'].get.security,[]);
  assert.equal(spec.paths['/api/v1/status/{id}'].get.parameters[0].required,true);
  const refs=JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g);
  for (const [,name] of refs) assert.ok(spec.components.schemas[name],name);
  assert.equal(spec.components.schemas.Incident.properties.durationMs.nullable,true);
  assert.equal(spec.components.securitySchemes.ApiKeyAuth.name,'X-API-Key');
});


test('接口示例使用可执行换行，JavaScript 语法有效且公开接口不添加密钥', () => {
  const source=read('public/assets/api-docs.js');
  const context=vm.createContext({language:'powershell',active:'status',requestUrl:()=> 'https://example.com/api/v1/status'});
  vm.runInContext(source.slice(source.indexOf('  function requestCode()'),source.indexOf('  function renderCode()')),context);
  const ps=vm.runInContext('requestCode()',context);
  assert.equal(ps.split('\n').length,3);
  assert.ok(!ps.includes('\\n'));
  context.language='javascript';
  const js=vm.runInContext('requestCode()',context);
  assert.doesNotThrow(()=>new vm.Script('(async () => {'+js+'})'));
  context.language='curl';
  assert.match(vm.runInContext('requestCode()',context),/curl -sS -H "Authorization: Bearer/);
  context.active='health';
  assert.ok(!vm.runInContext('requestCode()',context).includes('Authorization'));
});
