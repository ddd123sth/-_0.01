/* Retires the legacy stylesheets on screens the moon layer owns, without touching the fallback path.

   Why: the migrated markup reuses the prototype's class names, and ui/styles.css / ui/theme-moon.css still
   carry rules for several of those names from the previous implementation. That is the duplicate visual
   source the rebuild plan requires removing (R2), and it is why a component can look right in isolation but
   measure a few px off.

   How: every selector in the legacy sheets gets prefixed with `body:not([data-moon])`. The app marks the
   document with body[data-moon] only while the moon layer renders, so:
     - migrated screens see exactly one visual source (ui/moon/moon.css + generated metrics);
     - the fallback path (module failed to load) and the not-yet-migrated auth/loading shells keep the old look.
   Custom property declarations on :root/html/body are kept global: they are tokens, not geometry.

   2026-10-22 追加第三、四份产物（*.dialog.css）：月色接管后，弹层仍由正式层生成
   （添加账号、切换账号、确认层、日志筛选…），而门控版本在 body[data-moon] 下整体不生效，
   实测表现为图标退回 300×150 黑色实心块、表单标签与输入框挤成一行。
   这两份把「组件选择器」重新挂到 `body[data-moon] #dialog-host` 下，
   页面级选择器（body/html/#main/.app-shell/.tabbar/.save-dock）直接跳过，
   避免生成永不匹配的死规则。加载顺序放在 moon.css 之前，月色自己的弹层规则仍然优先。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/* 门控保持 data-moon。曾经试过改成 data-identity（理由：登录页没有 data-moon、只有 data-identity，
   于是正式层旧样式在登录页整套回来，把 .auth-help-link 从 10px 撑到 16px）。
   但实测那样更糟：登录页的图标尺寸、输入框盒模型本来就靠正式层那几张表撑着，moon.css 对登录页的接管
   并不完整 —— 门控一收紧，图标直接撑成黑块、输入框变成 302px 高的大卡片。
   结论：登录页是"外壳 + 正式层表单 + 月色装饰"的混合体，那 31px 差异用 moon.css 里的高特异性规则局部覆盖，
   不要动全局门控。 */
const GUARD = 'body:not([data-moon])';
const GLOBAL_ONLY = /^(:root|html|body)(?![\w-])/;
const TOKEN_DECLARATIONS = /(^|;)\s*--[\w-]+\s*:/;
/* 弹层版本要排除的页面级选择器：这些只可能出现在 #dialog-host 之外。 */
const PAGE_LEVEL = /(^|[\s,>+~])(?:body|html)(?![\w-])|#main\b|\.app-shell\b|\.tabbar\b|\.save-dock\b|\.main\b|\.screen\b|\.connection\b|\.brand\b/;

function scopeSelectorList(selector) {
  return selector.split(',').map(part => {
    const one = part.trim();
    if (!one) return one;
    if (GLOBAL_ONLY.test(one) || one === '*' || one.startsWith('* ')) return one;
    /* A rule that already starts with body must become body:not(...), not body:not(...) body,
       otherwise the selector can never match anywhere - including the fallback screens it guards. */
    if (/^body(?![\w-])/.test(one)) return one.replace(/^body/, 'body:not([data-moon])');
    /* keyframe percentages and other non-element selectors stay as written */
    if (/^[0-9.]+%$/.test(one)) return one;
    return `${GUARD} ${one}`;
  }).join(',');
}

/* 把组件选择器重新挂到月色接管后的 #dialog-host 下；返回空串表示这条规则不适用。 */
function dialogSelectorList(selector) {
  const mapped = selector.split(',').map(part => {
    let one = part.trim();
    if (!one) return null;
    if (/^(:root|html|\*)/.test(one)) return null;
    if (/^[0-9.]+%$/.test(one)) return null;
    if (PAGE_LEVEL.test(one)) return null;
    /* body[data-view="x"] .foo 这种写法去掉 body 段后是否还有意义，取决于剩余部分；去掉后为空则跳过。 */
    one = one.replace(/^body(?:\[[^\]]*\])?/, '').trim();
    if (!one) return null;
    return `body[data-moon] #dialog-host ${one}`;
  }).filter(Boolean);
  return mapped.join(',');
}

function transform(css, mapSelector) {
  let out = '';
  let i = 0;
  let selectors = 0;
  let scoped = 0;
  while (i < css.length) {
    /* 跳过空白必须放在最前：旧版没有这一步，于是两条规则之间的换行/空格会被当成下一条规则的
       选择器开头，`@media` 与 `/* 注释 *​/` 都被拼进选择器，生成出
       `body:not([data-moon]) @media(...)`、`body:not([data-moon]) /* … *​/{...}` 这类非法规则。
       浏览器遇到非法选择器会整条丢弃，并可能连带跳过后面一段 —— 实测 styles.dialog.css 里
       277 条规则只有 139 条进了 CSSOM，`.field{display:block}` 就这样没了。
       现有两个 scoped 产物也早带着 10 条同样的坏规则，属于同一处历史缺陷。 */
    if (/\s/.test(css[i])) { out += css[i]; i += 1; continue; }
    if (css[i] === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); const stop = end < 0 ? css.length : end + 2; out += css.slice(i, stop); i = stop; continue; }
    if (css[i] === '@') {
      const brace = css.indexOf('{', i);
      const params = css.slice(i, brace).trim();
      let depth = 0, j = brace;
      for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (!depth) break; } }
      const inner = css.slice(brace + 1, j);
      if (/^@(media|supports)/.test(params)) { const nested = transform(inner, mapSelector); out += `${params}{${nested.css}}`; selectors += nested.selectors; scoped += nested.scoped; }
      else out += `${params}{${inner}}`;
      i = j + 1;
      continue;
    }
    const brace = css.indexOf('{', i);
    if (brace < 0) { out += css.slice(i); break; }
    const selector = css.slice(i, brace).trim();
    let j = brace + 1, depth = 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(brace + 1, j - 1).trim();
    if (selector) {
      selectors++;
      /* mapSelector 返回空串表示"这条规则不该出现在这份产物里"（dialog 版本的页面级规则）；
         返回原选择器表示保留原样（:root / html 令牌）；返回改写后的选择器表示已重挂。 */
      const next = mapSelector(selector, body);
      if (next) {
        if (next !== selector) scoped++;
        out += `${next}{${body}}\n`;
      }
    }
    i = j;
  }
  return { css: out, selectors, scoped };
}

const legacyMap = (selector, body) => {
  /* html/:root rules are document-level quantities (height, tokens); gating them would break the
     shell itself. Only body-scoped and component selectors get the fallback guard. */
  const keepGlobal = /^(:root|html)(?![\w-])/.test(selector) || (GLOBAL_ONLY.test(selector) && TOKEN_DECLARATIONS.test(body));
  return keepGlobal ? selector : scopeSelectorList(selector);
};

const files = [['ui/styles.css', 'ui/styles.scoped.css', 'ui/styles.dialog.css'],
  ['ui/theme-moon.css', 'ui/theme-moon.scoped.css', 'ui/theme-moon.dialog.css']];
const report = [];
for (const [from, scopedTo, dialogTo] of files) {
  const source = readFileSync(from, 'utf8');

  const result = transform(source, legacyMap);
  const header = `/* Generated from ${from} by tools/moon-legacy-scope.mjs - do not hand-edit.
   Every selector is gated behind \`${GUARD}\` so the legacy sheets stay in charge only on screens the moon
   presentation layer has not taken over (fallback path, auth/loading shells). ${result.scoped}/${result.selectors}
   selectors gated; :root/html tokens and custom-property declarations stay global. */\n`;
  writeFileSync(scopedTo, header + result.css);

  const dialog = transform(source, selector => dialogSelectorList(selector));
  const dialogHeader = `/* Generated from ${from} by tools/moon-legacy-scope.mjs - do not hand-edit.
   Dialog-only view of the same sheet: component selectors re-rooted under \`body[data-identity] #dialog-host\`,
   because the moon layer still lets the formal layer render its own dialogs and forms.
   Page-level selectors (body/html/#main/.app-shell/.tabbar/.save-dock) are skipped on purpose.
   ${dialog.scoped}/${dialog.selectors} selectors carried over. Loaded BEFORE ui/moon/moon.css so the
   moon sheet keeps the last word on dialog shell geometry. */\n`;
  writeFileSync(dialogTo, dialogHeader + dialog.css);

  const lost = (source.match(/\{/g) || []).length !== (result.css.match(/\{/g) || []).length;
  report.push({ from, scopedTo, selectors: result.selectors, scoped: result.scoped, braceCountChanged: lost,
    dialogTo, dialogSelectors: dialog.scoped,
    sha256: createHash('sha256').update(result.css).digest('hex').slice(0, 16) });
}

const problems = report.filter(one => one.braceCountChanged || one.scoped === 0 || one.dialogSelectors === 0);
console.log(JSON.stringify({ ok: problems.length === 0, problems, report }, null, 1));
process.exitCode = problems.length ? 1 : 0;
