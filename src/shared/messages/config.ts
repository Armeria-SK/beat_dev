import { defineMessages } from './define.ts';

// 設定の形（パターン・長さ・数の範囲・型）に合わないときの、項目ごとの文。正規表現や、形の検査の英語の文はそのまま見せない。
// 設定の保存の 400 と壊れた設定の読み込みが、場所（path）といっしょにコード（config.<キー>）と差し込みの値を返し、画面が画面の言語で書き直す。
// pattern の文は項目ごと（src/config/friendly.ts の PATTERN_MESSAGES）。足した pattern に文が無いと、tests/config-friendly.test.ts が落ちる

const en = {
  'pattern.provider_id': 'An ID uses lowercase letters, digits, _ and -, starts with a letter or digit, and is up to 40 characters',
  'pattern.model_id': 'An ID uses lowercase letters, digits, _, . and -, starts with a letter or digit, and is up to 64 characters',
  'pattern.key_env': 'Write the NAME of an environment variable here, not the key itself (start with a capital letter; capitals, digits and _ only; up to 64 characters). Enter the key in the "API key" field',
  'pattern.effort': 'A thinking-effort name uses letters, digits, _, . and -, starts with a letter or digit, and is up to 32 characters',
  'pattern.color': 'Use the form #RRGGBB (for example #61B8A5)',
  'pattern.notify_id': 'An ID uses lowercase letters, digits and -, starts with a letter, and is up to 24 characters',
  'pattern.mcp_id': 'An ID uses lowercase letters and digits, starts with a letter, and is up to 16 characters',
  'pattern.mcp_tool': 'A tool name uses letters, digits, _, . and -, and is up to 64 characters',
  'pattern.mcp_env_name': 'An environment variable name uses letters, digits and _, starts with a letter or _, and is up to 27 characters',
  'pattern.mcp_header_name': 'A header name uses letters, digits and -, starts with a letter, and is up to 27 characters',
  'pattern.browser_site': 'Write a site as a lowercase host name (for example example.com). A leading = means that host only (no subdomains). *, paths, ports and IP addresses are not allowed',
  'pattern.time': 'Use the form HH:MM (24-hour, for example 22:30), or leave it empty',
  'pattern.other': 'This is not in the required form',
  'string.required': 'Enter a value',
  'string.min_length': 'Use at least {min} characters',
  'string.max_length': 'Use up to {max} characters',
  'number.range': 'Use a number from {min} to {max}',
  'number.min': 'Use a number that is {min} or more',
  'number.max': 'Use a number that is {max} or less',
  'array.min_items': 'Add at least {min} items',
  'array.max_items': 'Use up to {max} items',
  'array.unique': 'Do not list the same item twice',
  'type.string': 'Enter text',
  'type.integer': 'Enter a whole number',
  'type.number': 'Enter a number',
  'type.boolean': 'Use on or off (true or false)',
  'type.array': 'Use a list',
  'type.object': 'Use a group of settings (an object)',
  'type.union': 'Use one of the allowed values',
  'type.choice': 'Use one of these: {values}',
  'type.literal': 'Use {value}',
  'required': 'This item is required',
  'unexpected': 'There is no setting with this name',
};

export const configText = defineMessages('config', en);
export type ConfigMessageKey = keyof typeof en;
