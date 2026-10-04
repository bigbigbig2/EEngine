import assert from 'node:assert/strict';
import test from 'node:test';

// Independent bounded protocol reference. GPU weak-CAS spurious failure cannot
// be forced by the host; enumerate every CAS interleaving/outcome here, and use
// the production WGSL collision fixture for the real GPU publication boundary.
function outcomes(keys, promoteUnresolved) {
  const visited = new Set(), finals = [];
  const visit = state => {
    const identity = JSON.stringify(state);
    if (visited.has(identity)) return;
    visited.add(identity);
    if (state.requests.every(request => request.done)) {
      const writers = state.requests.flatMap((request, index) => {
        let owner = request.owner;
        if (owner === -1) {
          owner = state.table.find(candidate => candidate !== -1 && keys[candidate] === keys[index]);
          if (owner === undefined || owner === -1) owner = promoteUnresolved ? index : -1;
        }
        return owner === index ? [keys[index]] : [];
      });
      finals.push(writers);
      return;
    }
    for (let index = 0; index < keys.length; index++) {
      const request = state.requests[index];
      if (request.done) continue;
      const candidate = state.table[request.probe];
      const step = success => {
        const next = structuredClone(state), current = next.requests[index];
        if (candidate !== -1) {
          if (keys[candidate] === keys[index]) { current.owner = candidate; current.done = true; }
          else { current.probe++; current.attempt = 0; current.done = current.probe === next.table.length; }
        } else if (success) {
          next.table[current.probe] = index; current.owner = index; current.done = true;
        } else {
          current.attempt++; current.done = current.attempt === 4;
        }
        visit(next);
      };
      step(false);
      if (candidate === -1) step(true);
    }
  };
  visit({ table: [-1, -1], requests: keys.map(() => ({ probe: 0, attempt: 0, owner: -1, done: false })) });
  return finals;
}

test('every bounded CAS schedule rejects unresolved admission while preserving one writer per key', () => {
  const keys = ['a', 'a', 'b', 'c'];
  const correct = outcomes(keys, false);
  assert.ok(correct.length > 100, 'Enumerate failures and cross-request CAS schedules');
  assert.ok(correct.some(writers => writers.length === 0), 'All spurious failures reject optional admission');
  assert.ok(correct.some(writers => writers.length === 2), 'Ordinary successful admission remains available');
  for (const writers of correct) assert.equal(writers.length, new Set(writers).size);
  const original = outcomes(keys, true);
  assert.ok(original.some(writers => writers.length !== new Set(writers).size),
    'The reference must distinguish the original unresolved promotion defect');
});
