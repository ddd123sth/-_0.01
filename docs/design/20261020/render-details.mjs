// Exports isolated design panels. This never loads production app code or APIs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportScreenshot } from './render-image-file.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const root=dirname(fileURLToPath(import.meta.url));
const base=pathToFileURL(join(root,'prototype.html')).href;
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const viewFor=id=>/^(resident|satin|decorate|customer|palace|team|order|daily)/.test(id)?'orders':/^art/.test(id)?'art':/^plant|^water|^harvest|^settings/.test(id)?'land':/^log/.test(id)?'logs':/^auth|^register/.test(id)?'login':/license|password|sync|data-|service|battery|background|network|software|help/.test(id)?'me':'accounts';
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1150,height:1150},deviceScaleFactor:2});
const page=await context.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'||message.text().includes('Missing prototype'))errors.push(message.text());});
page.on('requestfailed',request=>errors.push(`Asset failed: ${request.url()}`));
await page.goto(`${base}?view=accounts`);
const entries=await page.evaluate(()=>window.GardenDesignPreview.listPanels());
const brokenReferences=await page.evaluate(()=>window.GardenDesignPreview.references());
const report={kind:'design-prototype-layout-and-interaction-inspection-only',panelCount:entries.length,brokenReferences,panels:[],narrowLayouts:[],localInteractions:[],errors};
await mkdir(join(root,'panels'),{recursive:true});
await mkdir(join(root,'screens','details'),{recursive:true});
async function exportPanel(id){
  await page.evaluate(()=>{const host=document.createElement('div');host.className='panel-portrait-export';host.append(document.querySelector('.v2-sheet').cloneNode(true));document.body.append(host);});
  const host=page.locator('.panel-portrait-export');
  await exportScreenshot(host,join(root,'panels',`${id}.png`),{animations:'disabled'});
  const box=await host.boundingBox();
  await host.evaluate(el=>el.remove());
  return box;
}
for(const entry of entries){
  await page.goto(`${base}?view=${viewFor(entry.id)}&panel=${entry.id}`);
  await page.locator('[role="dialog"]').waitFor();
  const box=await exportPanel(entry.id);
  const overflow=await page.locator('.panel-scroll').evaluate(el=>el.scrollWidth>el.clientWidth+1);
  report.panels.push({id:entry.id,width:box.width,height:box.height,horizontalOverflow:overflow});
}
const examples=[
  ['plant-detail','自动种花','全部种植参数与模式门限'],
  ['resident-detail','居民订单','数量上限、视频联动与现场说明'],
  ['customer-detail','顾客订单','币数档位、自动拒单与花艺依赖'],
  ['palace-detail','宫廷订单','勾选的品质不交，空选不过滤'],
  ['team-detail','组团订单','真实团单、免费接团与元宝留量'],
  ['art-detail','花艺制作','指定花艺、库存目标与自动补货'],
  ['add-account','添加游戏号','完整表单与官方登录核对流程'],
  ['log-filters','日志筛选','来源、全部分类、日期与分页'],
  ['license','软件授权','身份、资格、离线宽限与核对入口'],
  ['remove-account','移除确认','影响范围与历史记录保留'],
  ['network','统一网络出口','完整地址输入与全部账号范围'],
  ['password','修改密码','当前密码、新密码与重新登录提示']
];
for(const [id]of examples){await page.goto(`${base}?view=${viewFor(id)}&panel=${id}`);await page.evaluate(()=>document.activeElement?.blur());await exportScreenshot(page.locator('.device'),join(root,'screens','details',`${id}.png`),{animations:'disabled'});}
// Export actual presentation-only catalogue selection states by clicking the UI.
const pickerStates=[['picker-flowers','plant-mode','plant-flowers','plantMode',1],['picker-blacklist',null,'plant-blacklist'],['picker-arts','art-detail','art-arts','art.makeEnabled',null]];
const extras=[];
for(const[id,setup,target,key,index]of pickerStates){
  await page.goto(`${base}?view=${viewFor(target)}`);
  if(setup){await page.evaluate(id=>window.GardenDesignPreview.openPanel(id),setup);if(index!==null)await page.locator(`[data-panel-choice="${key}"][data-option-index="${index}"]`).check();else await page.locator(`[data-panel-toggle="${key}"]`).click();await page.locator('[data-panel-action="apply"]').click();}
  await page.evaluate(id=>window.GardenDesignPreview.openPanel(id),target);
  await page.locator('[data-picker]').first().click();
  await page.evaluate(()=>document.activeElement?.blur());
  await exportPanel(id);
  await exportScreenshot(page.locator('.device'),join(root,'screens','details',`${id}.png`),{animations:'disabled'});
  extras.push({id,title:id==='picker-flowers'?'花种多选目录':id==='picker-blacklist'?'黑名单选择':'花艺配方选择',group:'目录选择',kind:'sheet',fields:1});
  if(id==='picker-flowers'){
    await page.locator('[data-picker-search]').fill('不存在的搜索示意');
    await exportPanel('picker-search-empty');
    extras.push({id:'picker-search-empty',title:'目录搜索为空',group:'目录选择',kind:'sheet',fields:1});
    await page.locator('[data-picker-search]').fill('');
    await page.locator('[data-action="pick-visible"]').click();
    const chosen=await page.locator('[data-catalogue-value]:checked').count();
    await page.locator('[data-action="apply-picker"]').click();
    const text=await page.locator('.selected-values').first().textContent();
    report.localInteractions.push({name:'目录搜索、全选可见与确认',chosen,summaryVisible:Boolean(text)});
  }
}
// Check visible validation and unsaved navigation in the isolated design source.
await page.goto(`${base}?view=accounts&panel=register`);
await page.locator('[data-panel-action="register-preview"]').click();
report.localInteractions.push({name:'注册必填校验',fieldErrors:await page.locator('.field-error').count()});
await exportPanel('register-validation');extras.push({id:'register-validation',title:'注册表单校验',group:'校验反馈',kind:'sheet',fields:2});
await page.goto(`${base}?view=land`);await page.locator('[data-toggle="plantEnabled"]').click();await page.locator('.bottom-nav [data-view="accounts"]').click();
report.localInteractions.push({name:'未保存离开提示',panel:await page.evaluate(()=>window.GardenDesignPreview.snapshot().panel)});
await page.locator('[data-panel-action="close"]').click();
report.localInteractions.push({name:'继续编辑返回草稿',snapshot:await page.evaluate(()=>window.GardenDesignPreview.snapshot())});
await page.goto(`${base}?view=me&panel=network-clear`);await page.locator('[data-panel-action="clear-preview-network"]').click();
report.localInteractions.push({name:'清除出口反馈路径',panel:await page.evaluate(()=>window.GardenDesignPreview.snapshot().panel)});
await page.goto(`${base}?view=logs&panel=log-filters`);
await page.locator('[data-panel-choice="logCategory"][data-option-index="2"]').check();
await page.locator('[data-panel-choice="logSource"][data-option-index="0"]').check();
await page.locator('[data-panel-action="apply-preview-log-filters"]').click();
await page.evaluate(()=>window.GardenDesignPreview.openPanel('log-filters'));
report.localInteractions.push({name:'日志筛选重开保留条件',selectedCategory:await page.locator('[data-panel-choice="logCategory"]:checked').getAttribute('data-option-index'),selectedSource:await page.locator('[data-panel-choice="logSource"]:checked').getAttribute('data-option-index')});
await page.goto(`${base}?view=art`);
report.localInteractions.push({name:'制作关闭时首做开关禁用',albumDisabled:await page.locator('[data-toggle="art.firstAlbumClaim"]').isDisabled(),shareDisabled:await page.locator('[data-toggle="art.firstShareClaim"]').isDisabled()});
await page.goto(`${base}?view=orders&panel=resident-detail`);await page.locator('[data-panel-toggle="orders.resident.enabled"]').click();await page.locator('[data-panel-input="orders.resident.dailyLimit"]').fill('-1');await page.locator('[data-panel-toggle="orders.resident.enabled"]').click();await page.locator('[data-panel-action="apply"]').click();
report.localInteractions.push({name:'关闭总开关仍拦住非法数字',fieldErrors:await page.locator('.field-error').count()});
await page.goto(`${base}?view=logs&state=loading`);
report.localInteractions.push({name:'日志读取中分页禁用',previousDisabled:await page.locator('[data-action="logs-prev"]').isDisabled(),nextDisabled:await page.locator('[data-action="logs-next"]').isDisabled()});
for(const width of[320,360,390]){
  await page.setViewportSize({width,height:1100});
  for(const entry of entries){
    await page.goto(`${base}?view=${viewFor(entry.id)}&panel=${entry.id}`);
    report.narrowLayouts.push(await page.evaluate(()=>({id:window.GardenDesignPreview.snapshot().panel,width:innerWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,panelOverflow:[...document.querySelectorAll('.panel-scroll')].some(el=>el.scrollWidth>el.clientWidth+1)})));
  }
}
const all=[...entries,...extras];
await writeFile(join(root,'interaction-index.json'),JSON.stringify({kind:'design-prototype-only',pages:7,panels:all},null,2));
const gallery=`<!doctype html><html lang="zh-CN"><head><link rel="icon" type="image/webp" href="assets/logo-endless-summer.webp"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'"><title>无尽夏 · 完整交互图稿</title><link rel="stylesheet" href="gallery.css"><script src="gallery.js" defer></script></head><body><header><p>ENDLESS SUMMER / INTERACTION ATLAS</p><h1>每张卡片，展开之后。</h1><div>7 个主页面 · ${all.length} 个面板与状态图稿 · 全部为设计示意</div><a href="prototype.html?view=accounts">返回可点击原型 →</a></header><nav><input type="search" aria-label="搜索功能与弹窗" placeholder="搜索功能、参数、弹窗或状态"><select aria-label="筛选功能类别"><option value="">全部类别</option>${[...new Set(all.map(one=>one.group))].map(group=>`<option>${esc(group)}</option>`).join('')}</select><span id="count">${all.length} 张图稿</span></nav><main>${all.map(one=>`<article data-group="${esc(one.group)}" data-search="${esc(one.title+' '+one.group)}"><a class="image" href="panels/${one.id}.png"><img loading="lazy" src="panels/${one.id}.png" alt="${esc(one.title)}完整展开稿"></a><div><small>${esc(one.group)}</small><h2>${esc(one.title)}</h2><a href="panels/${one.id}.png">查看完整长图</a>${entries.some(entry=>entry.id===one.id)?`<a href="prototype.html?view=${viewFor(one.id)}&panel=${one.id}">打开交互</a>`:''}</div></article>`).join('')}</main><footer>所有账号、数量、状态与结果仅为设计示意。此图集不是 APK、官服截图或测试结果。</footer></body></html>`;
await writeFile(join(root,'interaction-gallery.html'),gallery);
await page.setViewportSize({width:1450,height:1300});
for(let index=0;index<4;index++){
  const trio=examples.slice(index*3,index*3+3);
  const html=`<!doctype html><html lang="zh-CN"><head><link rel="icon" type="image/webp" href="assets/logo-endless-summer.webp"><meta charset="utf-8"><link rel="stylesheet" href="prototype.css"><link rel="stylesheet" href="details.css"><link rel="stylesheet" href="identity.css"></head><body class="board-mode" data-identity="dawn"><section class="design-board dialog-board"><header class="board-heading"><div><p class="edition">ENDLESS SUMMER / INTERACTION DETAILS</p><h1>无尽夏<span>${['从选择，到每一片花田。','每种订单，都有自己的安排。','每一步操作，都有清楚反馈。','重要操作，说清影响范围。'][index]}</span></h1><p>完整交互原型 · 功能卡片与二级设置</p></div><div class="board-swatches"><i></i><i></i><i></i><i></i></div></header><div class="board-grid">${trio.map(([id,title,caption])=>`<div><img width="408" height="862" src="screens/details/${id}.png" alt="${esc(title)}"><div class="board-screen-caption"><div><h2>${esc(title)}</h2><p>${esc(caption)}</p></div></div></div>`).join('')}</div><footer class="board-bottom"><b>ENDLESS SUMMER / COMPLETE INTERACTION</b><span>全部数据为设计示意，非官服截图或测试结果</span><span>2026.10 / ${index+3}</span></footer></section></body></html>`;
  const filename=`details-board-${index+1}.html`;await writeFile(join(root,filename),html);await page.goto(pathToFileURL(join(root,filename)).href);await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));await exportScreenshot(page.locator('.design-board'),join(root,`prototype-details-${index+1}.png`));
}
const inspectionDir=join(root,'..','..','..','.runtime','design-20261020');await mkdir(inspectionDir,{recursive:true});await writeFile(join(inspectionDir,'details-layout-inspection.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({kind:report.kind,panels:entries.length,extraExports:extras.length,brokenReferences,overflow:report.narrowLayouts.filter(one=>one.documentOverflow||one.panelOverflow),localInteractions:report.localInteractions,errors},null,2));
await browser.close();
if(errors.length||brokenReferences.length||report.panels.some(one=>one.horizontalOverflow)||report.narrowLayouts.some(one=>one.documentOverflow||one.panelOverflow))process.exitCode=1;
