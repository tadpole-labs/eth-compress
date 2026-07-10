import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as u from './support/index.ts';

// compress_call must return the payload untouched (no state override) whenever the
// call isn't a safe, beneficial compression target. All checks are pure/offline.
describe('compress_call validation', () => {
  test('skips non-eth_call methods', () => {
    const payload = {
      method: 'eth_sendTransaction',
      to: u.TEST_ADDR[1],
      data: '0x' + '00'.repeat(1000),
    };
    assert.deepEqual(u.compress_call(payload, 'jit'), payload);
  });

  test('skips eth_call below minimum size', () => {
    const payload = { method: 'eth_call', to: u.TEST_ADDR[1], data: '0x' + '00'.repeat(10) };
    assert.deepEqual(u.compress_call(payload, 'jit'), payload);
  });

  test('skips when state overrides are present', () => {
    const overrides = {
      [u.TEST_ADDR[1]]: { balance: '0x1000000000000000000', code: '0x6080604052' },
      [u.TEST_ADDR[2]]: {
        nonce: '0x5',
        stateDiff: {
          '0x0000000000000000000000000000000000000000000000000000000000000001': '0xabcd',
        },
      },
    };
    const payload = u.mockEthCall({
      from: u.TEST_ADDR[0],
      to: u.TEST_ADDR[3],
      data: u.gen_call(5700),
      overrides,
    });

    const result = u.compress_call(payload, 'jit');
    assert.equal(result, payload);
    assert.deepEqual(result.params[2], overrides);
  });

  test('skips when decompressor address already has an override', () => {
    const data = u.gen_call(600);
    const compressed = u.compress_call(u.mockEthCall({ to: u.TEST_ADDR[3], data }), 'flz');
    const decompressorAddress = Object.keys(compressed.params[2])[0];

    const payload = u.mockEthCall({
      to: u.TEST_ADDR[3],
      data,
      overrides: { [decompressorAddress]: { code: '0x1234' } },
    });
    assert.equal(u.compress_call(payload, 'jit'), payload);
  });

  test('skips when the call has extra properties', () => {
    const payload = {
      method: 'eth_call',
      params: [{ to: u.TEST_ADDR[3], data: u.gen_call(600), gas: '0x100000' }, 'latest'],
    };
    assert.equal(u.compress_call(payload, 'jit'), payload);
  });

  test('skips when the target address is missing', () => {
    const payload = { method: 'eth_call', params: [{ data: u.gen_call(600) }, 'latest'] };
    assert.equal(u.compress_call(payload, 'jit'), payload);
  });
});
