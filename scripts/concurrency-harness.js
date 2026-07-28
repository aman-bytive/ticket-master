#!/usr/bin/env node
'use strict';

// Fires N parallel requests at one URL+body, tallies response status codes.
// Usage:
//   node scripts/concurrency-harness.js --url http://localhost:3004/bookings/confirm \
//     --method POST --body '{"ticketIds":["1"],"paymentMethodId":"pm_test"}' -n 50 \
//     --header "Authorization: Bearer <token>"

function parseArgs(argv) {
  const args = { method: 'GET', concurrency: 50, headers: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--url':
        args.url = argv[++i];
        break;
      case '--method':
        args.method = argv[++i].toUpperCase();
        break;
      case '--body':
        args.body = argv[++i];
        break;
      case '-n':
      case '--concurrency':
        args.concurrency = parseInt(argv[++i], 10);
        break;
      case '--header': {
        const raw = argv[++i];
        const idx = raw.indexOf(':');
        args.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
        break;
      }
      default:
        throw new Error(`unknown arg: ${flag}`);
    }
  }
  if (!args.url) throw new Error('--url is required');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error('-n/--concurrency must be a positive integer');
  }
  return args;
}

async function fireOne(url, method, body, headers) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    await res.text().catch(() => {});
    return String(res.status);
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

async function main() {
  const { url, method, body, concurrency, headers } = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const results = await Promise.all(
    Array.from({ length: concurrency }, () => fireOne(url, method, body, headers))
  );

  const tally = {};
  for (const status of results) tally[status] = (tally[status] || 0) + 1;

  console.log(JSON.stringify(tally, null, 2));
  console.error(`${concurrency} requests, ${Date.now() - started}ms wall time`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
