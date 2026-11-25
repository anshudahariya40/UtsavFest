#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const targetUrl = args.url || 'http://localhost:3000';
const concurrency = clampNumber(args.concurrency || 2000, 1, 50000);
const requestsPerWorker = clampNumber(args.requests || 1, 1, 50);
const totalRequests = concurrency * requestsPerWorker;
const timeoutMs = clampNumber(args.timeout || 15000, 1000, 60000);

const summary = {
  startedAt: Date.now(),
  completed: 0,
  success: 0,
  failed: 0,
  statusCounts: {},
  latencyMs: []
};

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : true;
    result[key] = value;
    if (value !== true && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      index += 1;
    }
  }
  return result;
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}

function normalizeStatusCode(statusCode) {
  return statusCode >= 200 && statusCode < 400 ? '2xx/3xx' : String(statusCode || 'ERR');
}

function waitForServer(url, timeoutMsValue) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > timeoutMsValue) {
        reject(new Error(`Server did not respond at ${url} within ${timeoutMsValue}ms.`));
        return;
      }

      const request = http.get(url, { timeout: 3000 }, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', () => {
        setTimeout(check, 500);
      });

      request.on('timeout', () => {
        request.destroy();
        setTimeout(check, 500);
      });
    };

    check();
  });
}

async function ensureServerIsRunning() {
  try {
    await waitForServer(targetUrl, 3000);
    return null;
  } catch (error) {
    console.log(`Server not running at ${targetUrl}. Starting it automatically...`);
    const child = spawn(process.execPath, ['Controller/server.js'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    await waitForServer(targetUrl, 60000);
    return child;
  }
}

function sendRequest() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const request = http.get(targetUrl, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });

      response.on('end', () => {
        const statusCode = response.statusCode || 0;
        summary.completed += 1;
        summary.latencyMs.push(Date.now() - startedAt);

        const statusKey = normalizeStatusCode(statusCode);
        summary.statusCounts[statusKey] = (summary.statusCounts[statusKey] || 0) + 1;

        if (statusCode >= 200 && statusCode < 400) {
          summary.success += 1;
        } else {
          summary.failed += 1;
        }

        resolve();
      });
    });

    request.on('error', (error) => {
      summary.completed += 1;
      summary.failed += 1;
      summary.statusCounts.ERR = (summary.statusCounts.ERR || 0) + 1;
      summary.latencyMs.push(Date.now() - startedAt);
      resolve();
    });

    request.on('timeout', () => {
      request.destroy(new Error('Request timed out'));
    });
  });
}

async function runLoadTest() {
  const childProcess = await ensureServerIsRunning();

  console.log(`Starting load test: ${concurrency} workers x ${requestsPerWorker} requests = ${totalRequests} total requests`);
  console.log(`Target: ${targetUrl}`);

  const workers = Array.from({ length: concurrency }, (_, index) => {
    return (async () => {
      for (let requestIndex = 0; requestIndex < requestsPerWorker; requestIndex += 1) {
        await sendRequest();
      }
    })();
  });

  await Promise.all(workers);

  const totalMs = Date.now() - summary.startedAt;
  const avgLatency = summary.latencyMs.length ? summary.latencyMs.reduce((sum, value) => sum + value, 0) / summary.latencyMs.length : 0;
  const maxLatency = summary.latencyMs.length ? Math.max(...summary.latencyMs) : 0;
  const p95 = summary.latencyMs.length ? summary.latencyMs.slice().sort((a, b) => a - b)[Math.floor(summary.latencyMs.length * 0.95)] : 0;

  console.log('\nLoad test summary');
  console.log('=================');
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Completed: ${summary.completed}`);
  console.log(`Success: ${summary.success}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Average latency: ${avgLatency.toFixed(2)} ms`);
  console.log(`P95 latency: ${p95.toFixed(2)} ms`);
  console.log(`Max latency: ${maxLatency.toFixed(2)} ms`);
  console.log(`Total runtime: ${totalMs} ms`);
  console.log('Status breakdown:');
  for (const [status, count] of Object.entries(summary.statusCounts).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${status}: ${count}`);
  }

  if (childProcess && !childProcess.killed) {
    childProcess.kill('SIGTERM');
  }
}

runLoadTest().catch((error) => {
  console.error('Load test failed:', error.message);
  process.exitCode = 1;
});
