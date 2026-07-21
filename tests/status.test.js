import test from 'node:test';
import assert from 'node:assert/strict';
import { combineStates, evaluateBaseState, evaluateQuotaState } from '../src/status.js';

test('base state honors disabled and invalid credentials', () => {
  assert.equal(evaluateBaseState({ disabled: true }), 'disabled');
  assert.equal(
    evaluateBaseState({ cpaStatus: 'error', statusMessage: 'token expired', recentRequests: [] }),
    'auth_invalid'
  );
});

test('recent failure ratio creates a warning', () => {
  assert.equal(
    evaluateBaseState({
      cpaStatus: 'ready',
      recentRequests: [{ success: 1, failed: 3 }],
    }),
    'warning'
  );
});

test('quota state and base state combine by severity', () => {
  const result = {
    supported: true,
    ok: true,
    windows: [{ usedPercent: 100 }],
  };
  assert.equal(evaluateQuotaState(result, 80), 'quota_exhausted');
  assert.equal(combineStates('healthy', 'quota_exhausted'), 'quota_exhausted');
  assert.equal(combineStates('auth_invalid', 'healthy'), 'auth_invalid');
});

