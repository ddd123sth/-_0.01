"use strict";
(() => {
  const search=document.querySelector('input');
  const select=document.querySelector('select');
  const cards=[...document.querySelectorAll('article')];
  const direction=new URLSearchParams(location.search).get('identity')||'dawn';
  document.querySelectorAll('a[href*="prototype.html"]').forEach(link=>{const url=new URL(link.href);url.searchParams.set('identity',direction);link.href=url.href;});
  function filter(){let count=0;for(const card of cards){const match=card.dataset.search.includes(search.value.trim())&&(!select.value||card.dataset.group===select.value);card.hidden=!match;if(match)count++;}document.getElementById('count').textContent=`${count} 张图稿`;}
  search.addEventListener('input',filter);select.addEventListener('change',filter);
})();
