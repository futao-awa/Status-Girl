import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { appearanceDefaults, validateAppearance } from '../src/appearance.js';
import { mergeCookies, cookieValue, normalizeQr, qrStatus } from '../src/music-auth.js';
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
  assert.throws(()=>normalizeQr({message:'error',data:{error_code:3,description:'缺少参数'}}),/缺少参数/);
});

test('扫码状态兼容原生与适配器，不混淆汽水等待、扫描和过期', () => {
  assert.equal(qrStatus('netease',{code:803,cookie:'MUSIC_U=test'}).status,'confirmed');
  assert.equal(qrStatus('qishui',{data:{status:'new',error_code:0}}).status,'pending');
  assert.equal(qrStatus('qishui',{data:{status:'scanned'}}).status,'scanned');
  assert.equal(qrStatus('qishui',{data:{status:'confirmed',redirect_url:'https://api.qishui.com/finish'}}).status,'confirmed');
  assert.equal(qrStatus('qishui',{data:{status:2}},true).status,'confirmed');
  assert.equal(qrStatus('qishui',{data:{status:3}},true).status,'expired');
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

test('未取得凭据不冒充登录；退出后的旧扫码响应不能重新登录', async () => {
  const incomplete=qrBackend({code:803});
  assert.equal((await incomplete.run()).status,'scanned');
  assert.equal(incomplete.saved(),0);
  const stale=qrBackend({code:803,cookie:'MUSIC_U=credential'});
  stale.context.musicAuthGeneration=1;
  assert.equal((await stale.run()).status,'expired');
  assert.equal(stale.db.settings.music.cookie,'');
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
    api:async(url)=>url.endsWith('/qr')?{token:'test',qrCode:'data:image/png;base64,test',expiresAt:new Date(Date.now()+180000).toISOString()}:(++calls===1?Promise.reject(Error('暂时离线')):{status:'confirmed',account:null}),
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
