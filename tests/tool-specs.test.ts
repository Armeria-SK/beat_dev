import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

// モデルに渡す組み込みの道具の仕様（組み立てた後）の説明が英語だけであることを見る。english-only.test.ts と重なるが、こちらは仕様の形で見る
const JAPANESE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|[\u{3000}-\u{303F}\u{30FB}\u{FF00}-\u{FFEF}]/u; // tests/english-only.test.ts の JAPANESE と同じ範囲

function descriptions(value: unknown, path: string, out: Array<{ path: string; text: string }>): Array<{ path: string; text: string }> {
  if (Array.isArray(value)) value.forEach((item, i) => descriptions(item, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'description' && typeof item === 'string') out.push({ path: `${path}.${key}`, text: item });
      else descriptions(item, `${path}.${key}`, out);
    }
  }
  return out;
}

test('組み込みの道具の仕様: 説明（道具と引数）に日本語の文字が無い', () => {
  const specs = ToolRegistry.specs(builtinTools());
  assert.ok(specs.length > 30, `${specs.length} 個しか無い`);
  const all = specs.flatMap(spec => descriptions(spec, spec.name, []));
  assert.ok(all.length > specs.length, '引数の説明も拾えている');
  assert.deepEqual(all.filter(d => JAPANESE.test(d.text)), []);
});

test('組み込みの道具の仕様: どの道具にも説明があり、文の配列を空白なしでつないだ跡（"approval.Destructive"）が無い', () => {
  for (const spec of ToolRegistry.specs(builtinTools())) {
    assert.ok(spec.description.trim().length > 20, spec.name);
    assert.doesNotMatch(spec.description, /[a-z)]\.[A-Z]/u, spec.name);
  }
});
