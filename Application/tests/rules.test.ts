/**
 * 分流规则与协议编解码的单元测试。
 * 运行：npm test（会先把 src 编译到 dist，再跑 node --test）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule, decideRoute, matchRule, parseRules, type CompiledRule } from '../src/core/rules';

/** 把若干行规则文本编译成规则数组，测试里用的都是合法规则 */
function rules(...lines: string[]): CompiledRule[] {
  return lines.map((line) => {
    const rule = compileRule(line);
    assert.ok(rule, `规则 ${line} 应当编译成功`);
    return rule;
  });
}

test('空行与注释会被忽略', () => {
  assert.equal(compileRule(''), null);
  assert.equal(compileRule('   '), null);
  assert.equal(compileRule('# 注释'), null);
  assert.equal(compileRule('// 注释'), null);
  assert.deepEqual(parseRules('a.com\n\n#x\nb.com'), ['a.com', 'b.com']);
});

test('裸域名匹配自身与子域，不匹配形近域名', () => {
  const rule = compileRule('example.com');
  assert.ok(rule);
  assert.equal(matchRule(rule, 'example.com', 443), true);
  assert.equal(matchRule(rule, 'www.example.com', 443), true);
  assert.equal(matchRule(rule, 'a.b.example.com', 80), true);
  assert.equal(matchRule(rule, 'notexample.com', 443), false);
  assert.equal(matchRule(rule, 'example.com.evil.net', 443), false);
});

test('显式通配与前缀通配', () => {
  const wildcard = compileRule('*.example.com');
  assert.ok(wildcard);
  assert.equal(matchRule(wildcard, 'www.example.com', 443), true);
  assert.equal(matchRule(wildcard, 'example.com', 443), true);

  const prefix = compileRule('192.168.*');
  assert.ok(prefix);
  assert.equal(matchRule(prefix, '192.168.1.1', 80), true);
  assert.equal(matchRule(prefix, '192.169.1.1', 80), false);
});

test('端口限定只在端口相同时命中', () => {
  const rule = compileRule('example.com:8080');
  assert.ok(rule);
  assert.equal(matchRule(rule, 'example.com', 8080), true);
  assert.equal(matchRule(rule, 'example.com', 443), false);
});

test('大小写与首点归一化', () => {
  const rule = compileRule('.Example.COM');
  assert.ok(rule);
  assert.equal(matchRule(rule, 'WWW.example.com', 443), true);
});

test('优先级：代理名单 > 直连名单 > 默认走代理', () => {
  const direct = rules('localhost', '192.168.*');
  const proxy = rules('*.google.com');

  // 命中最具体的代理规则
  assert.equal(decideRoute('www.google.com', 443, direct, proxy), 'proxy');
  // 未命中代理名单：白名单模式下直连
  assert.equal(decideRoute('www.baidu.com', 443, direct, proxy), 'direct');

  // 代理名单为空 = 黑名单模式，默认走代理
  assert.equal(decideRoute('www.baidu.com', 443, direct, []), 'proxy');
  assert.equal(decideRoute('localhost', 80, direct, []), 'direct');
});

test('代理名单优先级高于直连名单', () => {
  const direct = rules('example.com');
  const proxy = rules('example.com');
  assert.equal(decideRoute('example.com', 443, direct, proxy), 'proxy');
});
