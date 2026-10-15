import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Resolve the same CommonJS chain Expo Router uses, rather than a root dependency.
const mobileRequire = createRequire(new URL('../packages/mobile/package.json', import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve('expo-router/package.json'));
const queryString = expoRequire('query-string');
const queryRequire = createRequire(expoRequire.resolve('query-string/package.json'));
const decode = queryRequire('decode-uri-component');

test('Expo query dependencies expose callable CommonJS exports', () => {
  assert.equal(typeof decode, 'function');
  assert.equal(typeof queryString.parse, 'function');
  assert.equal(typeof queryString.stringify, 'function');
});

// Expected results were recorded on unpatched 0.2.2 before the backport.
test('ordinary decoding preserves Unicode, escaped delimiters and form spaces', () => {
  for (const [input, expected] of [
    ['', ''],
    ['plain text', 'plain text'],
    ['hello+world', 'hello world'],
    ['a%2Bb+c', 'a+b c'],
    ['%7B%22name%22%3A%22caf%C3%A9%22%7D', '{"name":"café"}'],
    ['%F0%9F%8C%BB', '🌻'],
    ['%25%26%3D%3F', '%&=?'],
  ]) {
    assert.equal(decode(input), expected, input);
  }
});

test('short incomplete escapes retain the legacy fallback behavior', () => {
  for (const [input, expected] of [
    ['%', '%'],
    ['%2', '%2'],
    ['%ZZ', '%ZZ'],
    ['%C2', '\uFFFD'],
    ['%FE%FF', '\uFFFD\uFFFD'],
    ['%FF%FE', '\uFFFD\uFFFD'],
    ['%E2%82%AC%20%C2', '€ \uFFFD'],
  ]) {
    assert.equal(decode(input), expected, input);
  }
});

test('Expo query-string preserves duplicate keys, empty values and decoding options', () => {
  const query = 'name=caf%C3%A9&space=hello+world&plus=a%2Bb&tag=one&tag=two&empty=&flag';
  assert.deepEqual(
    { ...queryString.parse(query) },
    {
      empty: '',
      flag: null,
      name: 'café',
      plus: 'a+b',
      space: 'hello world',
      tag: ['one', 'two'],
    },
  );
  assert.deepEqual(
    { ...queryString.parse('value=a%2Bb+c', { decode: false }) },
    {
      value: 'a%2Bb+c',
    },
  );
  assert.deepEqual(
    queryString.parse(queryString.stringify({ name: 'café', value: 'a+b c' })),
    queryString.parse('name=caf%C3%A9&value=a%2Bb%20c'),
  );
});

test('the decoder continues to reject non-string input', () => {
  for (const input of [undefined, null, 42, {}]) {
    assert.throws(() => decode(input), TypeError);
  }
});
