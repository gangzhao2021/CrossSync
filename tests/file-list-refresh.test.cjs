const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production list controller with a simulated API and renderer.
const source = fs.readFileSync(path.join(__dirname, '../app/static/app.js'), 'utf8');
const controller = source.slice(source.indexOf('async function refreshArea('), source.indexOf('async function deleteFiles('));
function harness(fetchJson) {
  const state = { downloads: { files: [] } };
  let renders = 0;
  const context = { areaState: state, fetchJson, renderArea: () => renders++, setTimeout };
  vm.createContext(context);
  vm.runInContext(controller, context);
  return { refresh: () => context.refreshArea('downloads'), state, renders: () => renders };
}

test('a burst of upload completions makes one list request', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; return { files: [] }; });
  await Promise.all(Array.from({ length: 20 }, () => h.refresh()));
  assert.equal(requests, 1);
  assert.equal(h.renders(), 1);
});

test('unchanged lists preserve rendered controls and verification state', async () => {
  const h = harness(async () => ({ files: [{ path: 'photo.jpg', size: 4, mtime: 1 }] }));
  await h.refresh();
  const file = h.state.downloads.files[0];
  file.verifyStatusText = 'verified';
  await h.refresh();
  assert.equal(h.renders(), 1);
  assert.equal(h.state.downloads.files[0], file);
  assert.equal(file.verifyStatusText, 'verified');
});

test('an upload completed during a list request triggers a follow-up refresh', async () => {
  let requests = 0;
  let release;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const h = harness(async () => {
    requests++;
    if (requests === 1) {
      started();
      await new Promise((resolve) => { release = resolve; });
      return { files: [] };
    }
    return { files: [{ path: 'new.jpg', size: 4, mtime: 1 }] };
  });
  const first = h.refresh();
  await firstStarted;
  const second = h.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(requests, 2);
  assert.equal(h.state.downloads.files[0].path, 'new.jpg');
});
