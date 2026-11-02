/* Isolated garden studies. The supplied brand icon is used unchanged. */
"use strict";
(() => {
  const directions={
    dawn:{name:'晴空花屿',note:'晨光 · 蓝紫绣球 · 透亮花园',art:'assets/garden-dawn.png',accountArt:'assets/garden-rain.png'},
    rain:{name:'雨后花径',note:'晴雨 · 水润花叶 · 雨后小径',art:'assets/garden-rain.png'},
    moon:{name:'月色花庭',note:'月光 · 浅紫花庭 · 星露微光',art:'assets/garden-moon.png'}
  };
  const query=new URLSearchParams(location.search);
  let selected=Object.hasOwn(directions,query.get('identity'))?query.get('identity'):'dawn';
  function decorate(){
    const direction=directions[selected];
    document.body.dataset.identity=selected;
    document.querySelectorAll('.account-card').forEach((card,index)=>card.dataset.entry=String(index+1).padStart(2,'0'));
    document.querySelectorAll('.garden-banner h2,.login-content h2').forEach(el=>el.textContent='花开无尽夏');
    document.querySelectorAll('.login-content .intro,.banner-slogan').forEach(el=>el.textContent='雨落有晴天');
    document.querySelectorAll('.garden-banner .eyebrow').forEach(el=>el.textContent='ENDLESS SUMMER');
    const accountArt=direction.accountArt||direction.art;
    document.querySelectorAll('.garden-banner>img').forEach(el=>{if(el.getAttribute('src')!==accountArt)el.src=accountArt;});
    document.querySelectorAll('.art-cover>img').forEach(el=>{if(el.getAttribute('src')!==direction.art)el.src=direction.art;});
    document.querySelectorAll('[data-identity-choice]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.identityChoice===selected)));
    document.querySelectorAll('.save-dock [data-action="save-config"]').forEach(el=>{el.dataset.clean=String(el.textContent.includes('已保存'));for(const node of el.childNodes)if(node.nodeType===Node.TEXT_NODE&&node.textContent.includes('保存设置'))node.textContent=node.textContent.replace('保存设置','保存更改');});
    const footer=document.querySelector('.studio-footer p');if(footer)footer.textContent=`花开无尽夏。雨落有晴天 · ${direction.name}`;
    const link=document.querySelector('.diagram-link');if(link)link.href=`interaction-gallery.html?identity=${selected}`;
  }
  function choose(value){if(!directions[value])return;selected=value;const url=new URL(location.href);url.searchParams.set('identity',value);history.replaceState(null,'',url);decorate();}
  const toolbar=document.createElement('div');toolbar.className='identity-toolbar';
  toolbar.innerHTML=`<span>三版花园原型</span>${Object.entries(directions).map(([id,direction],index)=>`<button type="button" data-identity-choice="${id}" aria-pressed="${id===selected}"><span>0${index+1}</span>${direction.name}</button>`).join('')}<small>原图标 · 花开无尽夏 · 雨落有晴天 <a href="identity-comparison.html">查看三版原型图 →</a></small>`;
  if(!query.has('board'))document.querySelector('.studio-header').after(toolbar);
  document.addEventListener('click',event=>{const button=event.target.closest('[data-identity-choice]');if(button)choose(button.dataset.identityChoice);});
  const observer=new MutationObserver(decorate);observer.observe(document.getElementById('stage'),{childList:true});
  window.GardenDesignIdentity={choose,selected:()=>selected,directions};
  decorate();
})();
