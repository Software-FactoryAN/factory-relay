import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('Encoder.cs is part of the Windows host build and stays free of unsafe code', () => {
  assert.match(read('../host/build.ps1'), /\$here\\Encoder\.cs \$here\\EncoderSettings\.cs/);
  const source = read('../host/Encoder.cs');
  assert.doesNotMatch(source, /\bunsafe\b/);
  assert.match(source, /6ca50344-051a-4ded-9779-a43305165e35/);
  assert.match(source, /398c1b98-8353-475a-9ef2-8f265d260345/);
});
