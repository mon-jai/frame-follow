import test from 'node:test';
import assert from 'node:assert/strict';
import { cropDimensions } from '../src/cropDimensions.js';

test('default portrait crop fits a landscape source without upscaling', () => {
  assert.deepEqual(cropDimensions(1920, 1080), { w: 594, h: 1056 });
});
test('landscape, square and custom crops use the largest fitting rectangle', () => {
  assert.deepEqual(cropDimensions(1920, 1080, 16, 9), { w: 1920, h: 1080 });
  assert.deepEqual(cropDimensions(1920, 1080, 1, 1), { w: 1080, h: 1080 });
  assert.deepEqual(cropDimensions(1000, 1000, 4, 5), { w: 800, h: 1000 });
});
test('zoom scales the fitted crop, and odd source sizes remain bounded and even', () => {
  assert.deepEqual(cropDimensions(1921, 1081, 1, 1, 2), { w: 540, h: 540 });
  const result = cropDimensions(101, 103, 16, 9);
  assert.ok(result.w <= 101 && result.h <= 103 && result.w % 2 === 0 && result.h % 2 === 0);
});
test('invalid or unrepresentable crop inputs are rejected', () => {
  for (const args of [[0, 1080], [100, 100, 0, 9], [100, 100, Infinity, 9], [100, 100, 9, 16, 0.5], [100, 100, 1, 1000]]) {
    assert.equal(cropDimensions(...args), null);
  }
});
