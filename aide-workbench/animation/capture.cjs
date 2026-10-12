#!/usr/bin/env node
// Run the demo's own state machine and HTML renderer in an isolated Node VM.
// The VM supplies JavaScript globals only; no browser, storage, scheduler, or API is mocked.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const sourcePath = path.resolve(__dirname, '../index.html');
const outputPath = path.join(__dirname, 'run.json');
const html = fs.readFileSync(sourcePath, 'utf8');
const sourceHash = crypto.createHash('sha256').update(html).digest('hex');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const modulePrefixes = [
  ['Aide', 'var Aide = (() => {', true],
  ['Aide data functions', 'const orders = [', false],
  ['AideKnowledge', 'var AideKnowledge = (() => {', true],
  ['Aide workflow functions', 'function get(request, id)', false],
  ['AideSidepaths', 'var AideSidepaths = (() => {', false],
];
const moduleScripts = modulePrefixes.map(([name, prefix, startsWith]) => {
  const script = scripts.find((candidate) => startsWith ? candidate.trimStart().startsWith(prefix) : candidate.includes(prefix));
  const code = name === 'AideSidepaths' && script ? script.slice(script.indexOf(prefix)) : script;
  assert.ok(code, `source module ${name} exists`);
  return { name, code, sha256: crypto.createHash('sha256').update(code).digest('hex') };
});

const context = vm.createContext({ Date, Math, structuredClone });
for (const module of moduleScripts) vm.runInContext(module.code, context, { filename: `index.html#${module.name}` });
const { Aide, AideKnowledge, AideSidepaths } = context;

const startedAt = new Date().toISOString();
const seedStart = performance.now();
const db = Aide.seed();
AideKnowledge.migrate(db);
const snapshot = AideKnowledge.ensureDemo(db);
const seedDurationMs = +(performance.now() - seedStart).toFixed(3);
const ui = { tab: 'overview', requestId: null, sidepathKind: 'operations', opsInstanceId: 'demo-daily-1011', opsTab: 'overview', sidepathCaseId: null };
let lastToast = null;
const helpers = { toast(message) { lastToast = message; } };

function decodeHtml(input) {
  return input.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
}
function visibleText(pageHtml) {
  return decodeHtml(pageHtml.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|h[1-6]|div|small|strong|li|button|span|td|th|pre|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim());
}
function phaseLabel(pageHtml) {
  const match = pageHtml.match(/<h3>Agent 诊断与操作建议 · ([^<]+)<\/h3>/);
  return match ? decodeHtml(match[1]) : null;
}
function instanceStatuses(pageHtml) {
  const result = {};
  const pattern = /<button type="button" class="ops-instance[^"]*" data-action="ops-select" data-id="([^"]+)"><strong>[^<]+<span class="ops-badge [^"]+">([^<]+)<\/span>/g;
  for (const match of pageHtml.matchAll(pattern)) result[match[1]] = match[2];
  return result;
}
function semanticLines(pageText) {
  return [...new Set(pageText.split('\n').map((line) => line.trim()).filter(Boolean))];
}
function state(pageHtml) {
  const entry = db.sidepathCases?.find((item) => item.id === ui.sidepathCaseId) || null;
  return {
    status: entry?.status || null,
    phaseLabel: phaseLabel(pageHtml),
    selectedInstanceId: ui.opsInstanceId,
    instanceStatuses: instanceStatuses(pageHtml),
    preflightChecked: entry?.preflightChecked ?? false,
    scopeOpen: entry?.scopeOpen ?? false,
    auditCount: entry?.audit?.length ?? 0,
    text: visibleText(pageHtml),
    html: pageHtml,
  };
}
function raw(value) {
  return value === undefined ? { type: 'undefined' } : { type: typeof value, value };
}
function diff(before, after) {
  const beforeLines = semanticLines(before.text);
  const afterLines = semanticLines(after.text);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  return {
    statusBefore: before.status,
    statusAfter: after.status,
    phaseBefore: before.phaseLabel,
    phaseAfter: after.phaseLabel,
    textAdded: afterLines.filter((line) => !beforeSet.has(line)),
    textRemoved: beforeLines.filter((line) => !afterSet.has(line)),
  };
}

const initialRenderStart = performance.now();
let previous = state(AideSidepaths.page(db, ui));
const initialRenderDurationMs = +(performance.now() - initialRenderStart).toFixed(3);
const events = [];
function run(id, label, action, target = null, expectedError = null) {
  lastToast = null;
  const eventStartedAt = new Date().toISOString();
  const actionStart = performance.now();
  let returned;
  let caught = null;
  try { returned = AideSidepaths.handle(action, target, db, ui, helpers); }
  catch (error) { caught = error; }
  const actionEnd = performance.now();
  if (expectedError) {
    assert.ok(caught, `${id}: expected rejection`);
    assert.match(caught.message, expectedError);
  } else if (caught) throw caught;
  else assert.equal(returned, true, `${id}: handler returned true`);
  const renderStart = performance.now();
  const after = state(AideSidepaths.page(db, ui));
  const renderEnd = performance.now();
  const event = {
    id, label, action, target,
    startedAt: eventStartedAt,
    endedAt: new Date().toISOString(),
    actionDurationMs: +(actionEnd - actionStart).toFixed(3),
    renderDurationMs: +(renderEnd - renderStart).toFixed(3),
    totalDurationMs: +(renderEnd - actionStart).toFixed(3),
    rawReturn: caught ? { type: 'throw', name: caught.name, message: caught.message } : raw(returned),
    toast: lastToast,
    before: previous,
    after,
    diff: diff(previous, after),
  };
  events.push(event);
  previous = after;
  return event;
}

run('open', '打开任务运维工作台', 'sidepath-open', 'operations');
run('select-refund', '选中失败的退款上游实例', 'ops-select', 'demo-refund-1011');
run('delay', '查看延迟分析', 'ops-tab', 'delay');
run('logs', '查看原运行日志', 'ops-tab', 'logs');
run('analyze', '检索交付依据并分析失败实例', 'ops-analyze');
run('premature-confirm', '提前确认被流程拒绝', 'ops-confirm', null, /请先核验队列/);
run('preflight', '核验队列恢复与活跃尝试', 'ops-preflight');
run('scope', '查看精确执行范围', 'ops-scope');
run('confirm', '确认并启动本地模拟重试', 'ops-confirm');
run('advance-upstream', '完成上游模拟重试并重评依赖', 'ops-advance');
run('advance-downstream', '完成日报与报表模拟执行', 'ops-advance');
run('verify', '独立复核并归档', 'ops-verify');

const entry = db.sidepathCases.find((item) => item.id === ui.sidepathCaseId);
assert.equal(entry.status, 'verified');
assert.equal(entry.instanceId, 'demo-refund-1011');
assert.equal(entry.sourceId, snapshot.id);
assert.equal(entry.audit.length, 6);
assert.deepEqual(JSON.parse(JSON.stringify(previous.instanceStatuses)), {
  'demo-refund-1011': '成功', 'demo-daily-1011': '成功', 'demo-report-1011': '成功',
  'demo-orders-1011': '成功', 'demo-catalog-1011': '运行中',
  'demo-daily-1010': '成功', 'demo-daily-1012': '等待计划时间',
});
assert.match(previous.text, /SLA 仍标为逾期/);

const output = {
  schemaVersion: 1,
  source: {
    path: '../index.html',
    sha256: sourceHash,
    modules: moduleScripts.map(({ name, sha256 }) => ({ name, sha256 })),
  },
  execution: {
    startedAt, finishedAt: new Date().toISOString(),
    environment: { runtime: `Node.js ${process.version}`, platform: process.platform, architecture: process.arch, release: os.release(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    scope: 'local VM execution of source Aide, AideKnowledge, and AideSidepaths modules with their fixed fictional demo instances',
    adapters: ['Node VM supplies Date, Math, and structuredClone globals', 'HTML text extraction strips tags and decodes basic entities; source page() supplies the unmodified HTML', 'toast callback records the text emitted by the source handler'],
    productionTimingMs: null,
    productionSchedulerCalled: false,
    timingMethod: 'performance.now() measures handle() including the source action, then page() plus HTML text/status extraction; totalDurationMs also includes local assertion and harness overhead between those measurements. All milliseconds rounded to 3 decimals.',
  },
  seed: {
    seedDurationMs, initialRenderDurationMs,
    requestCount: db.requests.length,
    deliverySnapshot: {
      id: snapshot.id, requestId: snapshot.requestId, title: snapshot.title,
      edition: snapshot.edition, provenance: snapshot.provenance,
      deliveredAt: snapshot.deliveredAt, sourceRefs: snapshot.sourceRefs,
      assets: snapshot.assets.map(({ id, name, version }) => ({ id, name, version })),
      report: { payment: snapshot.report.payment, refund: snapshot.report.refund, passedChecks: snapshot.report.checks.filter((check) => check.passed).length, totalChecks: snapshot.report.checks.length },
    },
  },
  events,
  final: {
    status: entry.status,
    selectedInstanceId: ui.opsInstanceId,
    sourceId: entry.sourceId,
    audit: entry.audit,
    confirmedBy: entry.confirmedBy,
    instanceStatuses: previous.instanceStatuses,
    sla: previous.text.match(/SLA 仍标为(逾期)/)?.[1] || null,
    assertionsPassed: true,
  },
};
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ outputPath, sourceSha256: sourceHash, eventCount: events.length, finalStatus: entry.status, actionDurationsMs: events.map((event) => event.actionDurationMs) }, null, 2));
