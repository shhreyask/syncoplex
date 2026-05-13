// ── worker.js ────────────────────────────────────────────────────
//
// Drift checker — runs in a Web Worker, isolated from the main thread.
// Browsers throttle setInterval on backgrounded tabs in the main thread,
// which is exactly the scenario we need to detect. Running in a Worker
// keeps the timer more reliable under background throttling.
//
// Cannot be concatenated with sync.js — Workers must be separate files
// loaded via new Worker('/js/worker.js').
//
// Messages sent TO this worker:
//   { type: 'check' } → trigger an immediate tick (used on tab focus)
//
// Messages sent FROM this worker:
//   { type: 'tick' }  → sync.js drift guard runs its check

self.setInterval(() => self.postMessage({ type: 'tick' }), 5000)

self.addEventListener('message', (e) => {
  if (e.data.type === 'check') self.postMessage({ type: 'tick' })
})