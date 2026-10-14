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
const context = { performance: { now: () => 0 }, BASE_TITLE: 'CrossSync · 本地传输' };
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}
this.RateMeter = RateMeter; this.isNetworkError = isNetworkError;
this.describeError = describeError; this.formatFileTime = formatFileTime;
this.countUnseen = countUnseen; this.transferTitle = transferTitle; this.arrivalSummary = arrivalSummary;
this.photoMimeType = photoMimeType; this.Sha256 = Sha256; this.sha256Hex = sha256Hex;`, context);
const { RateMeter, isNetworkError, describeError, formatFileTime, countUnseen, transferTitle, arrivalSummary, photoMimeType, Sha256, sha256Hex } = context;

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

test('the phone counts share-box files newer than the last look', () => {
  const files = [{ mtime: 100 }, { mtime: 200 }, { mtime: 300 }];
  assert.equal(countUnseen(files, 0), 3);
  assert.equal(countUnseen(files, 200), 1);
  assert.equal(countUnseen([], 0), 0);
});

test('the tab title shows progress first, then unread arrivals', () => {
  assert.equal(transferTitle({ active: 2, percent: 45.8, unread: 3 }), '45% 传输中 · CrossSync');
  assert.equal(transferTitle({ active: 0, percent: 100, unread: 3 }), '(3) 收到新文件 · CrossSync');
  assert.equal(transferTitle({ active: 0, percent: 0, unread: 0 }), 'CrossSync · 本地传输');
});

test('arrival notifications name the first files and mention skipped duplicates', () => {
  assert.equal(arrivalSummary([{ path: 'a/IMG_1.HEIC' }]), '收到 IMG_1.HEIC');
  assert.equal(
    arrivalSummary([{ path: 'IMG_1.HEIC' }, { path: 'IMG_2.HEIC' }, { path: 'IMG_3.HEIC' }, { path: 'IMG_4.HEIC', duplicate: true }]),
    '收到 IMG_1.HEIC、IMG_2.HEIC 等 3 个文件（另有 1 个已存在）',
  );
  assert.equal(arrivalSummary([{ path: 'x.jpg', duplicate: true }]), '1 个文件电脑上已有，没有重复保存');
});

test('only photos and videos are offered for the Photos app', () => {
  assert.equal(photoMimeType('trip/IMG_0001.HEIC'), 'image/heic');
  assert.equal(photoMimeType('a.JPG'), 'image/jpeg');
  assert.equal(photoMimeType('clip.MOV'), 'video/quicktime');
  assert.equal(photoMimeType('报价单.pdf'), '');
  assert.equal(photoMimeType('archive.zip'), '');
  assert.equal(photoMimeType('README'), '');
});

test('the built-in SHA-256 matches Node at every padding boundary', () => {
  const crypto = require('node:crypto');
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 70000]) {
    const data = crypto.randomBytes(length);
    assert.equal(sha256Hex(new Uint8Array(data)), crypto.createHash('sha256').update(data).digest('hex'), `length ${length}`);
  }
});

test('hashing in uneven slices gives the same result as all at once', () => {
  const crypto = require('node:crypto');
  const data = crypto.randomBytes(300000);
  const hash = new Sha256();
  for (let offset = 0, step = 1; offset < data.length; offset += step, step = (step * 7) % 9973 + 1) {
    hash.update(new Uint8Array(data.subarray(offset, offset + step)));
  }
  assert.equal(hash.hex(), crypto.createHash('sha256').update(data).digest('hex'));
});
