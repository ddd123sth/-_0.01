import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCloud } from './cloud-harness.mjs';

function pendingBodyRequest(port) {
  let request;
  const promise = new Promise((resolve, reject) => {
    request = http.request({ host: '127.0.0.1', port, path: '/api/logs/batch', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.write('{');
  });
  return { promise, request };
}

test('global log in-flight budget is shared across concurrent requests and released after completion', async () => {
  const cloud = await startCloud({ env: { WUJINXIA_LOG_BUDGET_GLOBAL_IN_FLIGHT: '1' } });
  try {
    const first = pendingBodyRequest(cloud.port);
    // Wait until the first partial body has reached the shared request handler.
    await new Promise(resolve => setTimeout(resolve, 30));
    const second = await cloud.call('POST', '/api/logs/batch', { body: {} });
    assert.equal(second.status, 503);
    assert.equal(second.json.code, 'LOG_QUEUE_FULL');
    assert.equal(second.headers.get('retry-after'), '5');
    first.request.end('}');
    const firstResult = await first.promise;
    assert.equal(firstResult.status, 401, 'first slot reaches normal route authentication after parsing');
    const health = await cloud.call('GET', '/api/software/health');
    assert.equal(health.status, 200, 'auth/license endpoints remain available');
    const third = await cloud.call('POST', '/api/logs/batch', { body: {} });
    assert.equal(third.status, 401, 'completed or rejected first request releases its slot');
  } finally { await cloud.close(); }
});
