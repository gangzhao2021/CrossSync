const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load only the DOM-free helpers block from the production script.
const source = fs.readFileSync(path.join(__dirname, '../app/static/js/core.js'), 'utf8');
const start = source.indexOf('// --- Pure helpers');
const end = source.indexOf('// --- End of pure helpers ---');
assert.ok(start >= 0 && end > start, 'helper markers must exist in core.js');
const context = { performance: { now: () => 0 } };
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}
this.RateMeter = RateMeter; this.isNetworkError = isNetworkError;
this.describeError = describeError; this.formatFileTime = formatFileTime;`, context);
const { RateMeter, isNetworkError, describeError, formatFileTime } = context;

test('speed stays steady between bursty chunk completions', () => {
  const meter = new RateMeter(8000);
  // 16 MB lands every 2 s: 8 MB/s on average.
  for (let second = 0; second <= 10; second += 2) meter.add(second * 8e6, second * 1000);
  assert.equal(Math.round(meter.rate(10000) / 1e6), 8);
  // A render one second later with no new bytes must not report 0 B/s.
  meter.add(80e6, 11000);
  assert.ok(meter.rate(11000) > 6e6);
});

test('speed decays to zero after the transfer stalls', () => {
  const meter = new RateMeter(4000);
  meter.add(0, 0);
  meter.add(40e6, 4000);
  for (let t = 5000; t <= 12000; t += 1000) meter.add(40e6, t);
  assert.equal(meter.rate(12000), 0);
});

test('a shrinking total (retried or cleared task) restarts measurement', () => {
  const meter = new RateMeter();
  meter.add(50e6, 0);
  meter.add(60e6, 1000);
  meter.add(10e6, 2000);
  assert.equal(meter.rate(2000), 0);
});

test('network failures are recognised across browsers', () => {
  for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'The network connection was lost.']) {
    assert.ok(isNetworkError(new TypeError(message)), message);
  }
  assert.ok(!isNetworkError(new Error('not enough free disk space for upload and temporary files')));
});

test('errors are described in plain Chinese', () => {
  assert.equal(describeError(new TypeError('Failed to fetch')), '与电脑的连接已断开');
  assert.equal(describeError(new Error('not enough free disk space for upload and temporary files')), '电脑磁盘空间不足');
  assert.equal(describeError(new Error('自定义提示')), '自定义提示');
});

test('file times use Chinese relative dates', () => {
  const now = new Date(2026, 9, 8, 12, 0);
  const at = (...parts) => new Date(...parts).getTime() / 1000;
  assert.equal(formatFileTime(at(2026, 9, 8, 11, 53), now), '今天 11:53');
  assert.equal(formatFileTime(at(2026, 9, 7, 9, 5), now), '昨天 09:05');
  assert.equal(formatFileTime(at(2026, 2, 1, 18, 30), now), '3月1日 18:30');
  assert.equal(formatFileTime(at(2025, 11, 31, 8, 0), now), '2025年12月31日');
});
