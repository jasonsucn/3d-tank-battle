// assemble.mjs — 把 build/ 分片装配成单文件 battle-city-3d.html
// 用法: node build/assemble.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const templatePath = join(here, 'template.html');
const cssPath = join(here, 'parts', 'ui.css');
const bodyPath = join(here, 'parts', 'ui.html');
const outPath = join(root, 'battle-city-3d.html');

const read = (p) => readFileSync(p, 'utf8');
const fail = (msg) => { console.error('[assemble] ERROR: ' + msg); process.exit(1); };

const template = read(templatePath);
const css = read(cssPath);
const body = read(bodyPath);

const jsFiles = readdirSync(join(here, 'parts'))
  .filter((f) => /^\d\d-.*\.js$/.test(f))
  .sort();
if (!jsFiles.length) fail('no parts found');

const chunks = jsFiles.map((f) => {
  const p = join(here, 'parts', f);
  const src = read(p);
  if (!src.trim()) fail('empty part: ' + f);
  return '\n// ===== ' + f + ' =====\n' + src.trimEnd() + '\n';
});
const script = chunks.join('\n');

if (/\b(import|export)\b/.test(script.slice(script.indexOf('01-config.js')))) {
  // imports 只允许出现在 00-imports.js
  const rest = script.split('// ===== 01-config.js =====')[1] || '';
  if (/^\s*(import|export)\s/m.test(rest)) fail('import/export outside 00-imports.js');
}

let html = template
  .replace('__CSS__', () => css.trim())
  .replace('__BODY__', () => body.trim())
  .replace('__SCRIPT__', () => script);

// 交付前硬性检查
const forbidden = ['TODO', 'FIXME', '待实现', '占位符', '简化版本', '这里可以添加', '建议添加', '供后续扩展', '暂时省略'];
const hits = forbidden.filter((w) => html.includes(w));
if (hits.length) fail('forbidden strings: ' + hits.join(', '));

if (!html.includes('<!DOCTYPE html>')) fail('missing doctype');
if (!html.includes('charset="utf-8"')) fail('missing charset');
if (!html.includes('viewport')) fail('missing viewport');
if (html.includes('__CSS__') || html.includes('__BODY__') || html.includes('__SCRIPT__')) fail('unreplaced placeholder');

writeFileSync(outPath, html, 'utf8');
const kb = (statSync(outPath).size / 1024).toFixed(1);
console.log(`[assemble] ok -> ${outPath} (${kb} KB, ${html.split('\n').length} lines)`);
console.log('[assemble] parts: ' + jsFiles.join(', '));
