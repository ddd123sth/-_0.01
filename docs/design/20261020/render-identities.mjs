// Brand-direction export and layout inspection for the isolated design prototype.
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exportScreenshot} from './render-image-file.mjs';
const require=createRequire(import.meta.url);const {chromium}=require('playwright');
const root=dirname(fileURLToPath(import.meta.url));const base=pathToFileURL(join(root,'prototype.html')).href;
const directions=[
  {id:'dawn',title:'晴空花屿',caption:'绣球蓝、透白卡片与带伞花径，明亮通透的花园。',detail:'晨光花园 · 透白卡片 · 绣球蓝 · 圆润控件',colors:['#7186d4','#c5b7ea','#f4f7ff'],recommended:true},
  {id:'rain',title:'雨后花径',caption:'雨停后的水滴与花径，安静而有生气。',detail:'雨后花径 · 雨雾蓝 · 花瓣轮廓 · 轻盈留白',colors:['#719ba7','#b7c4e6','#f4f9f9']},
  {id:'moon',title:'月色花庭',caption:'浅紫月光、绣球花拱门与细小星露。',detail:'月色花庭 · 珍珠浅紫 · 花庭弧线 · 柔润表面',colors:['#9b86c4','#d0bce8','#f8f5fd']}
];
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1260,height:1170},deviceScaleFactor:2});
const page=await context.newPage();const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('requestfailed',request=>errors.push(`Asset failed: ${request.url()}`));
await mkdir(join(root,'identities'),{recursive:true});
for(const direction of directions){
  await mkdir(join(root,'identities',direction.id),{recursive:true});
  for(const view of ['login','accounts','land','art','logs','customer-detail']){
    await page.goto(`${base}?identity=${direction.id}&view=${view==='customer-detail'?'orders&panel=customer-detail':view}`);
    await page.waitForFunction(()=>document.querySelectorAll('.account-card').length===0||document.querySelector('.account-card').hasAttribute('data-entry'));
    await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));
    await page.evaluate(()=>document.activeElement?.blur());
    await exportScreenshot(page.locator('.device'),join(root,'identities',direction.id,`${view}.png`),{animations:'disabled'});
  }
}
await page.goto(`${base}?view=accounts`);const panels=await page.evaluate(()=>window.GardenDesignPreview.listPanels());
const report={kind:'brand-design-layout-inspection-only',directions:directions.map(one=>one.id),mainLayouts:[],panelLayouts:[],errors};
for(const direction of directions){
  for(const width of [320,360,390]){
    await page.setViewportSize({width,height:1100});
    for(const view of ['login','accounts','land','orders','art','logs','me']){
      await page.goto(`${base}?identity=${direction.id}&view=${view}`);
      report.mainLayouts.push(await page.evaluate(()=>({identity:document.body.dataset.identity,view:new URLSearchParams(location.search).get('view'),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1||document.querySelector('.phone').scrollWidth>document.querySelector('.phone').clientWidth+1||[...document.querySelectorAll('.scroll-area')].some(el=>el.scrollWidth>el.clientWidth+1)})));
    }
  }
  await page.setViewportSize({width:320,height:1100});
  for(const panel of panels){
    await page.goto(`${base}?identity=${direction.id}&view=accounts&panel=${panel.id}`);
    report.panelLayouts.push(await page.evaluate(()=>({identity:document.body.dataset.identity,panel:window.GardenDesignPreview.snapshot().panel,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1||[...document.querySelectorAll('.panel-scroll')].some(el=>el.scrollWidth>el.clientWidth+1)})));
  }
}
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const caption=direction=>`<div class="identity-caption"><div><span>${direction.recommended?'方案 01':'花园方案'}</span><h2>${direction.title}</h2></div><div class="identity-chips">${direction.colors.map((color,i)=>`<i class="swatch-${direction.id}-${i}"></i>`).join('')}</div></div><p class="identity-caption-copy">${direction.detail}</p>`;
const header=(title,subtitle)=>`<header class="identity-board-heading"><p>无尽夏 / ENDLESS SUMMER</p><h1>${title}</h1><div>${subtitle}</div></header>`;
const head='<link rel="icon" type="image/webp" href="assets/logo-endless-summer.webp"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\'; connect-src \'none\'; object-src \'none\'"><link rel="stylesheet" href="identity-board.css">';
const comparison=`<!doctype html><html lang="zh-CN"><head>${head}<title>无尽夏 · 三组视觉方向</title></head><body><main class="identity-board">${header('花开无尽夏。雨落有晴天','你的原图标，三个花园。晨光里的绣球、雨后的花径、月色中的花庭。')}<section class="identity-grid">${directions.map(direction=>`<article>${caption(direction)}<img class="phone-image" src="identities/${direction.id}/accounts.png" alt="${direction.title}游戏号页"><a href="prototype.html?view=accounts&identity=${direction.id}">打开 ${direction.title} 完整交互 →</a><p class="identity-caption-copy">${direction.caption}</p></article>`).join('')}</section><footer><span>7 个主页面 / 116 个面板的交互内容保留</span><span>全部状态为设计示意 · 未接入 APK</span><span>2026 / 10</span></footer></main></body></html>`;
await writeFile(join(root,'identity-comparison.html'),comparison);
await page.setViewportSize({width:1450,height:1500});await page.goto(pathToFileURL(join(root,'identity-comparison.html')).href);await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));await exportScreenshot(page.locator('.identity-board'),join(root,'identity-comparison.png'));
for(const direction of directions){
  const html=`<!doctype html><html lang="zh-CN"><head>${head}<title>${direction.title} · 三页延展</title></head><body><main class="identity-board">${header(direction.title,'花开无尽夏。雨落有晴天 · '+direction.detail)}<section class="identity-grid">${[['login','花开无尽夏 · 雨落有晴天'],['accounts','我的花园 · 游戏号'],['land','种花 · 浇水 · 收花']].map(([view,title])=>`<article><h2 class="screen-caption">${title}</h2><img class="phone-image" src="identities/${direction.id}/${view}.png" alt="${escape(title)}"></article>`).join('')}</section><footer><a href="prototype.html?view=accounts&identity=${direction.id}">打开完整交互 →</a><span>全部状态为设计示意 · 未接入 APK</span><span>2026 / 10</span></footer></main></body></html>`;
  const filename=`identity-${direction.id}.html`;await writeFile(join(root,filename),html);await page.goto(pathToFileURL(join(root,filename)).href);await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));await exportScreenshot(page.locator('.identity-board'),join(root,`identity-${direction.id}.png`));
}
await browser.close();const dir=join(root,'..','..','..','.runtime','design-20261020');await mkdir(dir,{recursive:true});await writeFile(join(dir,'identity-layout-inspection.json'),JSON.stringify(report,null,2));
const overflow=[...report.mainLayouts,...report.panelLayouts].filter(one=>one.overflow);console.log(JSON.stringify({kind:report.kind,mainLayouts:report.mainLayouts.length,panelLayouts:report.panelLayouts.length,overflow,errors},null,2));if(overflow.length||errors.length)process.exitCode=1;
