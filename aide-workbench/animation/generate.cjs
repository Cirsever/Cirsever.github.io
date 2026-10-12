#!/usr/bin/env node
// Render the captured local run into two self-contained SVGs.
const fs = require('node:fs');
const path = require('node:path');

const directory = __dirname;
const sourcePath = path.resolve(process.argv[2] || path.join(directory, 'run.json'));
const run = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

if (!Array.isArray(run.events) || run.events.length === 0) {
  throw new Error('run.json must contain at least one captured event');
}

const escapeXml = (input) => String(input ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);
const characters = (input) => Array.from(String(input ?? ''));
const excerpt = (input, limit) => {
  const units = characters(input).map((char) => char === '\n' || char === '\r' || char === '\t' ? ' ' : char);
  return units.length > limit ? `${units.slice(0, limit - 1).join('')}…` : units.join('');
};
const displayWidth = (char) => /[\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60]/u.test(char) ? 2 : 1;
const fit = (input, maxUnits) => {
  let used = 0;
  let output = '';
  const normalized = String(input ?? '').replace(/[\r\n\t]+/g, ' ');
  for (const char of characters(normalized)) {
    const width = displayWidth(char);
    if (used + width > maxUnits) return `${output}…`;
    output += char;
    used += width;
  }
  return output;
};
const numberMs = (value, context) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a measured nonnegative number`);
  }
  return `${value.toFixed(3)} ms`;
};
const rawString = (rawReturn) => {
  if (rawReturn === null || rawReturn === undefined) return 'null';
  if (typeof rawReturn !== 'object') return String(rawReturn);
  const value = Object.hasOwn(rawReturn, 'value') ? rawReturn.value : rawReturn;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

// A linear common-prefix/suffix diff keeps the actual changed span even when
// the captured page text is much larger than the space available in the SVG.
function changedSpan(before, after) {
  const left = characters(before);
  const right = characters(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
  return {
    old: left.slice(prefix, left.length - suffix).join(''),
    next: right.slice(prefix, right.length - suffix).join(''),
    prefix: left.slice(Math.max(0, prefix - 14), prefix).join(''),
    suffix: suffix ? right.slice(right.length - suffix, Math.min(right.length, right.length - suffix + 14)).join('') : '',
    oldLength: left.length - prefix - suffix,
    newLength: right.length - prefix - suffix,
  };
}

const events = run.events.map((event, index) => {
  if (!event || typeof event !== 'object') throw new Error(`events[${index}] is invalid`);
  for (const field of ['actionDurationMs', 'renderDurationMs', 'totalDurationMs']) {
    numberMs(event[field], `events[${index}].${field}`);
  }
  if (!event.label || !event.id || !event.before || !event.after || !Object.hasOwn(event, 'rawReturn')) {
    throw new Error(`events[${index}] lacks captured label, id, state, or rawReturn`);
  }
  return { ...event, span: changedSpan(event.before.phaseLabel || '', event.after.phaseLabel || '') };
});

const changed = events.filter((event) => event.span.oldLength + event.span.newLength > 0);
const featured = changed[changed.length - 1];
if (!featured) throw new Error('No before/after text difference found in capture');

const rowHeight = Math.min(57, Math.max(43, Math.floor((636 - Math.max(0, events.length - 11) * 5) / events.length)));
const rowsTop = 161;
const diffTop = rowsTop + events.length * rowHeight + 17;
const height = Math.min(1000, diffTop + 184);
if (diffTop + 184 > 1000) throw new Error('Capture has too many events for the 1000px SVG layout');
const animationDuration = 18;
const revealStart = 6;
const revealEnd = 72;
const phasePercent = (index) => revealStart + (index / Math.max(1, events.length - 1)) * (revealEnd - revealStart);

function themeSvg(theme) {
  const dark = theme === 'dark';
  const colors = dark ? {
    bg: '#0d0b14', panel: '#15121e', panelAlt: '#1b1725', border: '#302940',
    ink: '#f1eafa', muted: '#9b91a9', faint: '#756c83', accent: '#ad80ff',
    accentSoft: '#2b2042', raw: '#c9bfda', good: '#9bd5bd', bad: '#f5a6ae',
  } : {
    bg: '#f7f5fb', panel: '#ffffff', panelAlt: '#faf8fd', border: '#e7e0ee',
    ink: '#21192e', muted: '#736b80', faint: '#8e8699', accent: '#7144cf',
    accentSoft: '#eee7fc', raw: '#40364d', good: '#286f51', bad: '#b54d62',
  };
  const keyframes = events.map((_, index) => {
    const at = phasePercent(index);
    return `.event-${index}{animation:reveal-${index} ${animationDuration}s linear infinite}
      @keyframes reveal-${index}{0%,${(at - .2).toFixed(2)}%{opacity:0}${at.toFixed(2)}%,100%{opacity:1}}`;
  }).join('\n');
  const rawRows = events.map((event, index) => {
    const y = rowsTop + index * rowHeight;
    const raw = event.rawReturn.type === 'throw'
      ? `${event.rawReturn.name || 'Error'}: ${event.rawReturn.message || ''}`
      : rawString(event.rawReturn);
    const addition = Array.isArray(event.diff?.textAdded)
      ? event.diff.textAdded.find((line) => String(line).trim()) : null;
    const rawLine = `返回 ${raw}${addition ? `  ·  页面新增 ${addition}` : ''}`;
    const statusBefore = String(event.before.status ?? '未记录');
    const statusAfter = String(event.after.status ?? '未记录');
    const aside = statusBefore === '未记录' && statusAfter === '未记录'
      ? '尚未生成操作建议'
      : statusBefore === statusAfter ? `状态保持 ${statusAfter}` : `${statusBefore} → ${statusAfter}`;
    const timing = numberMs(event.totalDurationMs, `events[${index}].totalDurationMs`);
    const num = String(index + 1).padStart(2, '0');
    return `<g class="event event-${index}">
      <line x1="38" x2="962" y1="${y + rowHeight - 2}" y2="${y + rowHeight - 2}" class="rule"/>
      <text x="48" y="${y + 16}" class="index">${num}</text>
      <text x="88" y="${y + 16}" class="prompt">›</text>
      <text x="109" y="${y + 16}" class="action">${escapeXml(fit(event.label, 46))}</text>
      <text x="616" y="${y + 16}" text-anchor="end" class="time">${timing}</text>
      <text x="110" y="${y + 36}" class="raw">↳ ${escapeXml(fit(rawLine, 70))}</text>
      <text x="667" y="${y + 16}" class="aside">${escapeXml(fit(aside, 42))}</text>
      <text x="667" y="${y + 36}" class="aside subtle">${escapeXml(fit(event.toast ? `提示 ${event.toast}` : `操作 ${numberMs(event.actionDurationMs, 'action')} · 渲染 ${numberMs(event.renderDurationMs, 'render')}`, 50))}</text>
    </g>`;
  }).join('\n');
  const diff = featured.span;
  const oldExcerpt = fit(featured.before.phaseLabel || '∅', 55);
  const newExcerpt = fit(featured.after.phaseLabel || '∅', 55);
  const context = fit(`${diff.prefix} ┊ ${diff.suffix}`, 75);
  const sourceFile = excerpt(run.source?.path || path.relative(directory, sourcePath), 68);
  const hash = String(run.source?.sha256 || '未记录').slice(0, 12);
  const localRuntime = events.reduce((sum, event) => sum + event.totalDurationMs, 0);
  const production = run.execution?.productionTimingMs === null || run.execution?.productionTimingMs === undefined
    ? '生产耗时 未采集' : `生产耗时 ${numberMs(run.execution.productionTimingMs, 'productionTimingMs')}`;
  const first = run.execution?.startedAt ? String(run.execution.startedAt) : '未记录';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img" aria-labelledby="title desc" width="1000" height="${height}" viewBox="0 0 1000 ${height}">
  <title id="title">Aide 工作台：本地实测操作时间线（${dark ? '深色' : '浅色'}）</title>
  <desc id="desc">${escapeXml(events.length)} 个真实本地模拟操作事件、逐步返回摘录、状态旁白和前后文本差异。动画在 18 秒内完成；减少动态效果时完整显示。</desc>
  <style><![CDATA[
    :root{color-scheme:${dark ? 'dark' : 'light'}}
    .shell{fill:${colors.bg}} .panel{fill:${colors.panel};stroke:${colors.border};stroke-width:1}
    .top{fill:${colors.panelAlt}} .rule{stroke:${colors.border};stroke-width:1}
    text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans Mono CJK SC","PingFang SC","Microsoft YaHei",monospace;font-variant-numeric:tabular-nums}
    .title{font-size:27px;font-weight:700;fill:${colors.ink};letter-spacing:-.7px}
    .subtitle{font-size:12.8px;fill:${colors.muted}}
    .pill{font-size:12px;font-weight:700;fill:${colors.accent}}
    .header{font-size:11px;font-weight:700;fill:${colors.faint};letter-spacing:1.2px}
    .index{font-size:12px;fill:${colors.faint}}
    .prompt{font-size:18px;font-weight:700;fill:${colors.accent}}
    .action{font-size:13.7px;font-weight:650;fill:${colors.ink}}
    .time{font-size:12px;fill:${colors.accent}}
    .raw{font-size:11.2px;fill:${colors.raw}}
    .aside{font-size:11.6px;fill:${colors.muted}}
    .subtle{font-size:10px;fill:${colors.faint}}
    .diffTitle{font-size:14px;font-weight:700;fill:${colors.ink}}
    .diffMeta{font-size:10.6px;fill:${colors.faint}}
    .minus{font-size:13px;fill:${colors.bad};text-decoration:line-through}
    .plus{font-size:13px;fill:${colors.good}}
    .footer{font-size:10.6px;fill:${colors.faint}}
    .event{opacity:0}
    ${keyframes}
    .oldText{animation:oldFade ${animationDuration}s linear infinite}
    .newText{animation:newAppear ${animationDuration}s linear infinite}
    @keyframes oldFade{0%,75%{opacity:1}81%,100%{opacity:.35}}
    @keyframes newAppear{0%,80%{opacity:0}86%,100%{opacity:1}}
    @media(prefers-reduced-motion:reduce){.event,.oldText,.newText{animation:none;opacity:1}}
  ]]></style>
  <rect class="shell" width="1000" height="${height}" rx="18"/>
  <rect class="panel" x="18" y="18" width="964" height="${height - 36}" rx="15"/>
  <path class="top" d="M33 19h934a14 14 0 0 1 14 14v96H19V33a14 14 0 0 1 14-14z"/>
  <line class="rule" x1="19" x2="981" y1="129" y2="129"/>
  <circle cx="47" cy="44" r="5" fill="#e17783"/><circle cx="65" cy="44" r="5" fill="#e7b463"/><circle cx="83" cy="44" r="5" fill="#78c9a2"/>
  <text x="111" y="49" class="pill">AIDE / LOCAL CAPTURE</text>
  <text x="47" y="88" class="title">一次数据工作台操作，逐步可见</text>
  <text x="48" y="113" class="subtitle">${escapeXml(events.length)} 个采集事件 · 本地逐步耗时合计（含采集开销）${numberMs(localRuntime, 'localRuntime')} · ${escapeXml(production)}</text>
  <text x="48" y="149" class="header">事件 / 捕获返回</text>
  <text x="667" y="149" class="header">灰色旁白 / 状态变化</text>
  ${rawRows}
  <rect x="37" y="${diffTop}" width="926" height="121" rx="10" fill="${colors.accentSoft}"/>
  <text x="54" y="${diffTop + 23}" class="diffTitle">状态文字变化 · ${escapeXml(fit(featured.label, 35))}</text>
  <text x="947" y="${diffTop + 23}" text-anchor="end" class="diffMeta">基于 before.phaseLabel / after.phaseLabel 计算</text>
  <text x="55" y="${diffTop + 48}" class="diffMeta">字符差异：移除 ${diff.oldLength} · 新增 ${diff.newLength} · 共同上下文 ${escapeXml(context)}</text>
  <g class="oldText"><text x="55" y="${diffTop + 75}" class="minus">− ${escapeXml(oldExcerpt)}</text></g>
  <g class="newText"><text x="55" y="${diffTop + 102}" class="plus">+ ${escapeXml(newExcerpt)}</text></g>
  <text x="48" y="${height - 48}" class="footer">来源 ${escapeXml(sourceFile)} · SHA-256 ${escapeXml(hash)}… · ${escapeXml(first)}</text>
  <text x="48" y="${height - 29}" class="footer">返回内容为采集摘录；旁白为状态摘要。播放 18 秒循环，末尾保留完整时间线。</text>
</svg>\n`;
}

for (const theme of ['light', 'dark']) {
  const output = path.join(directory, `demo-${theme}.svg`);
  fs.writeFileSync(output, themeSvg(theme), 'utf8');
  process.stdout.write(`${output}\n`);
}
