/**
 * 域名分流规则匹配。
 *
 * 支持三种写法：
 *   - `example.com`   匹配 example.com 及其所有子域
 *   - `*.example.com` 同上，显式通配
 *   - `10.*`          前缀通配，用于 IP 段
 *
 * 端口可写在规则里，如 `example.com:8080`，不写则匹配任意端口。
 */

export type RouteDecision = 'direct' | 'proxy';

export interface CompiledRule {
  pattern: string;
  host: string;
  port: number | null;
  wildcard: boolean;
}

/** 把一行规则文本编译成可匹配结构；空行或纯注释返回 null */
export function compileRule(line: string): CompiledRule | null {
  const raw = line.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;

  let host = raw;
  let port: number | null = null;

  // 仅当形如 host:port 且端口部分是纯数字时才拆分，避免破坏 IPv6 字面量
  const lastColon = raw.lastIndexOf(':');
  if (lastColon > 0 && raw.indexOf(':') === lastColon) {
    const maybePort = raw.slice(lastColon + 1);
    if (/^\d{1,5}$/.test(maybePort)) {
      const parsed = Number(maybePort);
      if (parsed > 0 && parsed <= 65535) {
        host = raw.slice(0, lastColon);
        port = parsed;
      }
    }
  }

  host = host.trim().toLowerCase().replace(/^\.+/, '');
  if (!host) return null;

  const wildcard = host.includes('*');
  return { pattern: raw, host, port, wildcard };
}

/** 把多行文本解析成规则列表 */
export function parseRules(line: string): string[] {
  return line
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));
}

/** 单条规则是否命中给定主机与端口 */
export function matchRule(rule: CompiledRule, hostname: string, port: number): boolean {
  if (rule.port !== null && rule.port !== port) return false;

  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;

  if (!rule.wildcard) {
    return host === rule.host || host.endsWith('.' + rule.host);
  }

  // 通配符：转成正则，`*` 匹配任意字符（含空），`?` 匹配单个字符（含点）
  const escaped = rule.host.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexSource = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  let re: RegExp;
  try {
    re = new RegExp(regexSource);
  } catch {
    return false;
  }

  if (re.test(host)) return true;

  // `10.*` 这类前缀通配也应命中 `10.0.0.1`，上面的正则已覆盖；
  // 但 `*.example.com` 不应命中裸 `example.com`，这里额外补一条后缀匹配以符合直觉
  const suffix = rule.host.replace(/^\*\./, '');
  if (suffix !== rule.host && (host === suffix || host.endsWith('.' + suffix))) return true;

  return false;
}

/**
 * 决定某个目标应该直连还是走代理。
 * 规则优先级：proxy 白名单 > direct 黑名单 > 默认走代理。
 * 当 proxy 列表非空时进入白名单模式：只有命中的才走代理，其余直连。
 */
export function decideRoute(
  hostname: string,
  port: number,
  directRules: CompiledRule[],
  proxyRules: CompiledRule[],
): RouteDecision {
  for (const rule of proxyRules) {
    if (matchRule(rule, hostname, port)) return 'proxy';
  }

  for (const rule of directRules) {
    if (matchRule(rule, hostname, port)) return 'direct';
  }

  // 白名单模式：配置了 proxy 规则但都没命中，则直连
  if (proxyRules.length > 0) return 'direct';

  return 'proxy';
}
