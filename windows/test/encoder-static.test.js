import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('Encoder.cs is part of the Windows host build and stays free of unsafe code', () => {
  assert.match(read('../host/build.ps1'), /\$here\\Encoder\.cs \$here\\EncoderSettings\.cs \$here\\EncoderAsync\.cs/);
  const source = read('../host/Encoder.cs');
  assert.doesNotMatch(source, /\bunsafe\b/);
  assert.match(source, /6ca50344-051a-4ded-9779-a43305165e35/);
  assert.match(source, /398c1b98-8353-475a-9ef2-8f265d260345/);
  assert.doesNotMatch(source, /\bNotSupportedException/);
});

test('EncoderAsync.cs has the hardware enumeration, unlock, session cap and no pump thread', () => {
  const source = read('../host/EncoderAsync.cs');
  assert.doesNotMatch(source, /\bunsafe\b/);
  assert.doesNotMatch(source, /new Thread\(/);
  for (const needle of ['f79eac7d-e545-4387-bdee-d647d7bde42a', 'e5666d6b-3422-4eb6-a421-da7db1f8e207', '0xC00D6D76', 'MaxHardwareSessions = 12', 'timeEndPeriod', '0x10000003'])
    assert.ok(source.includes(needle), needle);
});

test('the desk test script builds EncoderAsync.cs', () => {
  assert.match(read('./run-encoder-test.ps1'), /EncoderAsync\.cs/);
});
