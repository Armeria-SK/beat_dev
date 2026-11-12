import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../web/src/api.ts';
import { autoLabel, hasDocLanguage, LANGUAGES, languageName, languagePatch, languagePick, OTHER } from '../web/src/ui/doc-language.ts';

// 製品の設定の "Documents language" の行（beat 3-1b-u）。画面を持たない決まり（web/src/ui/doc-language.ts）。

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1aaaa', name: 'App', root: 'C:\\work\\app', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
  doc_language: null, doc_language_pinned: false, ...over,
});

test('ui/doc-language: 言語の欄を持たない古いサーバーでは行を出さない', () => {
  const { doc_language: _a, doc_language_pinned: _b, ...old } = project();
  assert.equal(hasDocLanguage(old as Project), false);
  assert.equal(hasDocLanguage(project()), true);
});

test('ui/doc-language: 自動のときは Auto を選び、検出した印を出す。持ち主が選んだ印はその印を選ぶ', () => {
  assert.deepEqual(languagePick(project()), { pick: '', other: '' });
  assert.deepEqual(languagePick(project({ doc_language: 'ja' })), { pick: '', other: '' }, '検出しただけなら Auto');
  assert.deepEqual(languagePick(project({ doc_language: 'ja', doc_language_pinned: true })), { pick: 'ja', other: '' });
  assert.deepEqual(languagePick(project({ doc_language: 'sw', doc_language_pinned: true })), { pick: OTHER, other: 'sw' }, '主な一覧に無い印は欄に入れる');
  assert.equal(autoLabel(project({ doc_language: 'ja' })), 'Auto (detected: ja)');
  assert.equal(autoLabel(project()), 'Auto (not detected yet)');
  assert.equal(autoLabel(project({ doc_language: 'en', doc_language_pinned: true })), 'Auto', '選んでいるときは検出した印が分からない');
});

test('ui/doc-language: 送る形。変わっていなければ送らない、Auto は null、読めない印は送らない', () => {
  assert.equal(languagePatch(project(), '', ''), null);
  assert.equal(languagePatch(project({ doc_language: 'ja' }), '', ''), null);
  assert.deepEqual(languagePatch(project({ doc_language: 'ja' }), 'ja', ''), { docLanguage: 'ja' }, '検出した印を選び直すと pinned になる');
  assert.deepEqual(languagePatch(project({ doc_language: 'ja', doc_language_pinned: true }), '', ''), { docLanguage: null });
  assert.equal(languagePatch(project({ doc_language: 'ja', doc_language_pinned: true }), 'ja', ''), null);
  assert.deepEqual(languagePatch(project(), OTHER, ' pt-BR '), { docLanguage: 'pt-BR' });
  assert.deepEqual(languagePatch(project(), OTHER, 'zh-Hant'), { docLanguage: 'zh-Hant' });
  for (const bad of ['', 'japanese', 'JA', 'e', 'ja_JP', 'ja-', 'ja-x', 'ja-abcdefghi']) assert.equal(languagePatch(project(), OTHER, bad), 'invalid', bad);
});

test('ui/doc-language: 主な言語の一覧は形に合う印だけで、名前は英語で読める', () => {
  for (const tag of LANGUAGES) assert.match(tag, /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);
  assert.ok(LANGUAGES.includes('ja') && LANGUAGES.includes('en'));
  assert.equal(languageName('ja'), 'Japanese (ja)');
  assert.equal(languageName('qqq'), 'qqq', '名前の分からない印はそのまま');
});
