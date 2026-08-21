// Egern Network Exit Widget
// Shows DIRECT and current-policy public IPv4/IPv6 plus the active interface.

const C = {
  bg1: '#0d1117',
  bg2: '#161b22',
  card: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  dim: '#484f58',
  direct: '#3fb950',
  proxy: '#58a6ff',
  ipv6: '#a371f7',
  local: '#f778ba',
  warn: '#d29922',
  error: '#ff7b72',
};

const BG = {
  type: 'linear',
  colors: [C.bg1, C.bg2],
  startPoint: { x: 0, y: 0 },
  endPoint: { x: 0.35, y: 1 },
};

const IP_ENDPOINTS = {
  4: [
    'https://api-ipv4.ip.sb/ip',
    'https://api4.ipify.org',
  ],
  6: [
    'https://api-ipv6.ip.sb/ip',
    'https://api6.ipify.org',
  ],
};

const COUNTRY_NAMES = {
  AU: '澳大利亚', CA: '加拿大', CN: '中国', DE: '德国', FR: '法国',
  GB: '英国', HK: '中国香港', JP: '日本', KR: '韩国', MO: '中国澳门',
  NL: '荷兰', RU: '俄罗斯', SG: '新加坡', TW: '中国台湾', US: '美国',
};

const GEO_CACHE_KEY = 'network-ip-widget:geo-cache-v1';
const GEO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const REQUEST_HEADERS = {
  'User-Agent': 'Egern-Network-IP-Widget/1.0',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
};

export default async function (ctx) {
  const env = ctx.env || {};
  const proxyPolicy = clean(env.proxyPolicy || env.PROXY_POLICY || env.POLICY);
  const refreshMinutes = boundedInt(
    env.refreshMinutes || env.REFRESH_MINUTES,
    10,
    5,
    120,
  );

  const [direct4, direct6, proxy4, proxy6] = await Promise.all([
    probePublicIp(ctx, 4, 'DIRECT'),
    probePublicIp(ctx, 6, 'DIRECT'),
    probePublicIp(ctx, 4, proxyPolicy),
    probePublicIp(ctx, 6, proxyPolicy),
  ]);

  const probes = [direct4, direct6, proxy4, proxy6];
  const geoByIp = await loadGeoData(
    ctx,
    [...new Set(probes.filter(item => item.ok).map(item => item.ip))],
  );

  const withGeo = probe => ({
    ...probe,
    geo: probe.ok ? geoByIp[probe.ip] || fallbackGeo(ctx, probe.ip) : null,
  });

  const model = {
    direct: {
      kind: 'direct',
      title: '直连',
      subtitle: 'DIRECT',
      color: C.direct,
      v4: withGeo(direct4),
      v6: withGeo(direct6),
    },
    proxy: {
      kind: 'proxy',
      title: '代理',
      subtitle: proxyPolicy || '当前策略',
      color: C.proxy,
      v4: withGeo(proxy4),
      v6: withGeo(proxy6),
    },
    network: readNetwork(ctx),
    refreshAfter: new Date(Date.now() + refreshMinutes * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  switch (ctx.widgetFamily) {
    case 'accessoryInline':
      return renderInline(model);
    case 'accessoryCircular':
      return renderCircular(model);
    case 'accessoryRectangular':
      return renderRectangular(model);
    case 'systemSmall':
      return renderSmall(model);
    case 'systemLarge':
    case 'systemExtraLarge':
      return renderLarge(model);
    case 'systemMedium':
    default:
      return renderMedium(model);
  }
}

async function probePublicIp(ctx, family, policy) {
  const startedAt = Date.now();
  let lastError = '';

  for (const endpoint of IP_ENDPOINTS[family]) {
    try {
      const separator = endpoint.includes('?') ? '&' : '?';
      const options = {
        timeout: 4500,
        credentials: 'omit',
        headers: REQUEST_HEADERS,
      };
      if (policy) options.policy = policy;

      const response = await ctx.http.get(
        `${endpoint}${separator}_=${Date.now()}-${family}`,
        options,
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }

      const ip = extractIp(await response.text(), family);
      if (!ip) throw new Error(`未返回 IPv${family}`);

      return {
        ok: true,
        ip,
        family,
        latency: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = String(error && (error.message || error) || '请求失败');
    }
  }

  return {
    ok: false,
    ip: '',
    family,
    latency: Date.now() - startedAt,
    error: lastError || `IPv${family} 不可用`,
  };
}

async function loadGeoData(ctx, ips) {
  const now = Date.now();
  const cache = readGeoCache(ctx);
  const result = {};
  const missing = [];

  for (const ip of ips) {
    const hit = cache[ip];
    if (hit && hit.data && now - Number(hit.at || 0) < GEO_CACHE_TTL) {
      result[ip] = hit.data;
    } else {
      missing.push(ip);
    }
  }

  const fresh = await Promise.all(
    missing.map(async ip => ({ ip, data: await fetchGeo(ctx, ip) })),
  );

  let changed = false;
  for (const item of fresh) {
    const data = item.data || fallbackGeo(ctx, item.ip);
    result[item.ip] = data;
    if (data) {
      cache[item.ip] = { at: now, data };
      changed = true;
    }
  }

  if (changed) writeGeoCache(ctx, cache);
  return result;
}

async function fetchGeo(ctx, ip) {
  // probePublicIp has already validated the address, so the raw IPv6 colons are
  // safe here and match both providers' documented path format.
  const address = normalizeIp(ip);
  const providers = [
    {
      url: `https://ipwho.is/${address}?lang=zh-CN&fields=success,message,ip,country,country_code,region,city,connection`,
      parse(data) {
        if (!data || data.success === false) return null;
        return normalizeGeo({
          countryCode: data.country_code,
          country: data.country,
          region: data.region,
          city: data.city,
          asn: data.connection && data.connection.asn,
          isp: data.connection && (data.connection.isp || data.connection.org),
        });
      },
    },
    {
      url: `https://api.ip.sb/geoip/${address}`,
      parse(data) {
        if (!data || !data.ip) return null;
        return normalizeGeo({
          countryCode: data.country_code,
          country: data.country,
          region: data.region,
          city: data.city,
          asn: data.asn,
          isp: data.isp || data.organization || data.asn_organization,
        });
      },
    },
  ];

  for (const provider of providers) {
    try {
      const response = await ctx.http.get(provider.url, {
        policy: 'DIRECT',
        timeout: 4500,
        credentials: 'omit',
        headers: REQUEST_HEADERS,
      });
      if (response.status < 200 || response.status >= 300) continue;
      const data = provider.parse(await response.json());
      if (data) return data;
    } catch (_) {
      // Try the next provider, then fall back to Egern's local IP database.
    }
  }

  return fallbackGeo(ctx, ip);
}

function fallbackGeo(ctx, ip) {
  try {
    const info = typeof ctx.lookupIP === 'function' ? ctx.lookupIP(ip) : null;
    if (!info) return null;
    const code = clean(info.country).toUpperCase();
    return normalizeGeo({
      countryCode: code,
      country: COUNTRY_NAMES[code] || code,
      asn: info.asn,
      isp: info.organization,
    });
  } catch (_) {
    return null;
  }
}

function normalizeGeo(value) {
  if (!value) return null;
  return {
    countryCode: clean(value.countryCode).toUpperCase(),
    country: clean(value.country),
    region: clean(value.region),
    city: clean(value.city),
    asn: clean(value.asn),
    isp: clean(value.isp),
  };
}

function readGeoCache(ctx) {
  try {
    const value = ctx.storage && ctx.storage.getJSON(GEO_CACHE_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function writeGeoCache(ctx, cache) {
  try {
    const trimmed = Object.fromEntries(
      Object.entries(cache)
        .sort((a, b) => Number(b[1] && b[1].at || 0) - Number(a[1] && a[1].at || 0))
        .slice(0, 24),
    );
    if (ctx.storage) ctx.storage.setJSON(GEO_CACHE_KEY, trimmed);
  } catch (_) {
    // Caching is optional; the widget can still render without storage.
  }
}

function readNetwork(ctx) {
  const device = ctx.device || {};
  const wifi = device.wifi || {};
  const cellular = device.cellular || {};
  const ipv4 = device.ipv4 || {};
  const ipv6 = device.ipv6 || {};

  const ssid = clean(wifi.ssid);
  const carrier = clean(cellular.carrier);
  const radio = clean(cellular.radio);
  const interfaceName = clean(ipv4.interface || ipv6.interface);

  let kind = 'network';
  if (ssid || /^en\d+$/i.test(interfaceName)) kind = 'wifi';
  else if (carrier || /^pdp_ip\d+$/i.test(interfaceName)) kind = 'cellular';

  const title = kind === 'wifi'
    ? ['Wi-Fi', ssid].filter(Boolean).join(' · ')
    : kind === 'cellular'
      ? ['蜂窝网络', carrier, formatRadio(radio)].filter(Boolean).join(' · ')
      : ['网络接口', interfaceName].filter(Boolean).join(' · ');

  return {
    kind,
    title: title || '网络接口',
    icon: kind === 'wifi'
      ? 'wifi'
      : kind === 'cellular'
        ? 'antenna.radiowaves.left.and.right'
        : 'network',
    ipv4: clean(ipv4.address),
    ipv6: clean(ipv6.address),
    interfaceName,
  };
}

function renderSmall(model) {
  return root(model, {
    padding: 10,
    gap: 5,
    children: [
      compactHeader(model, 12),
      smallExitCard(model.direct),
      smallExitCard(model.proxy),
      localFooter(model.network, 9),
    ],
  });
}

function renderMedium(model) {
  return root(model, {
    padding: [9, 11, 9, 11],
    gap: 5,
    children: [
      compactHeader(model, 13),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'start',
        gap: 7,
        flex: 1,
        children: [
          mediumExitCard(model.direct),
          mediumExitCard(model.proxy),
        ],
      },
      localFooter(model.network, 10),
    ],
  });
}

function renderLarge(model) {
  return root(model, {
    padding: 14,
    gap: 9,
    children: [
      compactHeader(model, 15),
      networkCard(model.network),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'start',
        gap: 10,
        flex: 1,
        children: [
          largeExitCard(model.direct),
          largeExitCard(model.proxy),
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        children: [
          tx('IP 归属地为数据库估算', 9, 'regular', C.dim, 1),
          { type: 'spacer' },
          {
            type: 'date',
            date: model.updatedAt,
            format: 'relative',
            font: { size: 9 },
            textColor: C.dim,
          },
        ],
      },
    ],
  });
}

function renderInline(model) {
  const directFlag = exitFlag(model.direct);
  const proxyFlag = exitFlag(model.proxy);
  const v6 = model.proxy.v6.ok ? ' · 代理v6' : '';
  return {
    type: 'widget',
    refreshAfter: model.refreshAfter,
    children: [
      tx(`${networkGlyph(model.network)} ${directFlag} → ${proxyFlag}${v6}`, 'caption1', 'semibold'),
    ],
  };
}

function renderCircular(model) {
  const versions = [model.proxy.v4.ok ? '4' : '', model.proxy.v6.ok ? '6' : '']
    .filter(Boolean)
    .join('+') || '×';
  return {
    type: 'widget',
    refreshAfter: model.refreshAfter,
    padding: 4,
    children: [
      { type: 'spacer' },
      tx(exitFlag(model.proxy), 19, 'bold', undefined, 1, 0.8, 'center'),
      tx(`P ${versions}`, 10, 'semibold', undefined, 1, 0.8, 'center'),
      { type: 'spacer' },
    ],
  };
}

function renderRectangular(model) {
  return {
    type: 'widget',
    refreshAfter: model.refreshAfter,
    gap: 2,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          { type: 'image', src: `sf-symbol:${model.network.icon}`, width: 11, height: 11 },
          { ...tx(shortNetworkTitle(model.network), 11, 'semibold', undefined, 1, 0.55), flex: 1 },
          tx(model.network.ipv4 || '无内网 IPv4', 9, 'regular', undefined, 1, 0.5, 'right', true),
        ],
      },
      accessoryExitRow('D4', model.direct.v4, model.direct.color),
      accessoryExitRow(
        model.proxy.v6.ok ? 'P4+6' : 'P4',
        model.proxy.v4,
        model.proxy.color,
      ),
    ],
  };
}

function root(model, props) {
  return {
    type: 'widget',
    url: 'egern:/connections',
    refreshAfter: model.refreshAfter,
    backgroundGradient: BG,
    ...props,
  };
}

function compactHeader(model, size) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    children: [
      { type: 'image', src: `sf-symbol:${model.network.icon}`, color: C.local, width: size, height: size },
      { ...tx(shortNetworkTitle(model.network), size, 'bold', C.text, 1, 0.58), flex: 1 },
      {
        type: 'date',
        date: model.updatedAt,
        format: 'time',
        font: { size: 9, weight: 'medium' },
        textColor: C.muted,
      },
    ],
  };
}

function smallExitCard(exit) {
  const preferred = firstAvailable(exit);
  const rows = [];
  if (exit.v4.ok) rows.push(compactIpRow('4', exit.v4, exit.color));
  else rows.push(errorIpRow('4', exit.kind === 'proxy' ? '策略探测失败' : '不可用'));
  if (exit.v6.ok) rows.push(compactIpRow('6', exit.v6, C.ipv6));

  return {
    type: 'stack',
    direction: 'column',
    gap: 2,
    padding: [5, 7, 5, 7],
    backgroundColor: C.card,
    borderRadius: 9,
    borderWidth: 0.5,
    borderColor: C.border,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          tx(exit.title, 10, 'bold', exit.color, 1),
          { type: 'spacer' },
          tx(
            preferred ? `${countryFlag(preferred.geo && preferred.geo.countryCode)} ${formatLocation(preferred.geo)}` : '获取失败',
            8,
            'medium',
            preferred ? C.muted : C.error,
            1,
            0.45,
            'right',
          ),
        ],
      },
      ...rows,
    ],
  };
}

function mediumExitCard(exit) {
  const children = [exitCardHeader(exit, 11)];
  if (exit.v4.ok) children.push(mediumEndpoint('IPv4', exit.v4, exit.color));
  else children.push(endpointFailure('IPv4', exit.kind === 'proxy' ? '检查代理策略' : '直连不可用'));
  if (exit.v6.ok) children.push(mediumEndpoint('IPv6', exit.v6, C.ipv6));

  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 4,
    padding: [7, 8, 7, 8],
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 10,
    borderWidth: 0.5,
    borderColor: C.border,
    children,
  };
}

function largeExitCard(exit) {
  const children = [exitCardHeader(exit, 13)];
  if (exit.v4.ok) children.push(largeEndpoint('IPv4', exit.v4, exit.color));
  else children.push(endpointFailure('IPv4', exit.kind === 'proxy' ? '请检查代理策略组名称或网络' : '直连 IPv4 不可用'));
  if (exit.v6.ok) children.push(largeEndpoint('IPv6', exit.v6, C.ipv6));

  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 8,
    padding: 12,
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 13,
    borderWidth: 0.5,
    borderColor: C.border,
    children,
  };
}

function exitCardHeader(exit, size) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    children: [
      { type: 'stack', width: 5, height: 5, borderRadius: 3, backgroundColor: exit.color, children: [] },
      tx(exit.title, size, 'bold', C.text, 1),
      { type: 'spacer' },
      tx(exit.subtitle, size - 2, 'medium', C.muted, 1, 0.5, 'right'),
    ],
  };
}

function compactIpRow(label, endpoint, color) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      tx(label, 8, 'bold', color, 1),
      { ...tx(endpoint.ip, 9, 'medium', C.text, 1, 0.38, 'left', true), flex: 1 },
    ],
  };
}

function errorIpRow(label, message) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      tx(label, 8, 'bold', C.error, 1),
      tx(message, 9, 'medium', C.error, 1, 0.55),
    ],
  };
}

function mediumEndpoint(label, endpoint, color) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 1,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          tx(label, 8, 'bold', color, 1),
          { ...tx(endpoint.ip, 9, 'medium', C.text, 1, 0.4, 'left', true), flex: 1 },
        ],
      },
      tx(
        `${countryFlag(endpoint.geo && endpoint.geo.countryCode)} ${formatLocation(endpoint.geo)}`,
        8,
        'regular',
        C.muted,
        1,
        0.48,
      ),
    ],
  };
}

function largeEndpoint(label, endpoint, color) {
  const network = formatNetwork(endpoint.geo);
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 3,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        children: [
          tx(label, 10, 'bold', color, 1),
          { type: 'spacer' },
          tx(`${endpoint.latency} ms`, 9, 'medium', C.muted, 1),
        ],
      },
      tx(endpoint.ip, 12, 'semibold', C.text, 1, 0.45, 'left', true),
      tx(
        `${countryFlag(endpoint.geo && endpoint.geo.countryCode)} ${formatLocation(endpoint.geo)}`,
        10,
        'medium',
        C.text,
        1,
        0.55,
      ),
      ...(network ? [tx(network, 9, 'regular', C.muted, 1, 0.5)] : []),
    ],
  };
}

function endpointFailure(label, message) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 2,
    children: [
      tx(label, 9, 'bold', C.error, 1),
      tx(message, 9, 'medium', C.error, 2, 0.6),
    ],
  };
}

function networkCard(network) {
  const rows = [];
  if (network.ipv4) rows.push(networkAddressRow('内网 IPv4', network.ipv4, C.local));
  if (network.ipv6) rows.push(networkAddressRow('接口 IPv6', network.ipv6, C.ipv6));
  if (!rows.length) rows.push(tx('未读取到当前接口地址', 10, 'medium', C.error, 1));

  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 9,
    padding: [8, 10, 8, 10],
    backgroundColor: C.card,
    borderRadius: 11,
    borderWidth: 0.5,
    borderColor: C.border,
    children: [
      { type: 'image', src: `sf-symbol:${network.icon}`, color: C.local, width: 18, height: 18 },
      {
        type: 'stack',
        direction: 'column',
        alignItems: 'start',
        gap: 2,
        flex: 1,
        children: [
          tx(network.title, 11, 'bold', C.text, 1, 0.55),
          tx(network.interfaceName || '当前活动接口', 9, 'regular', C.muted, 1),
        ],
      },
      {
        type: 'stack',
        direction: 'column',
        alignItems: 'end',
        gap: 2,
        flex: 1.5,
        children: rows,
      },
    ],
  };
}

function networkAddressRow(label, address, color) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    children: [
      tx(label, 8, 'semibold', color, 1),
      tx(address, 9, 'medium', C.text, 1, 0.42, 'right', true),
    ],
  };
}

function localFooter(network, size) {
  const addresses = [network.ipv4, network.ipv6].filter(Boolean).join(' · ');
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      { type: 'image', src: 'sf-symbol:network', color: C.local, width: size, height: size },
      tx('内网', size, 'semibold', C.muted, 1),
      { ...tx(addresses || '未获取', size, 'medium', addresses ? C.text : C.error, 1, 0.38, 'left', true), flex: 1 },
      ...(network.interfaceName ? [tx(network.interfaceName, size - 1, 'regular', C.dim, 1)] : []),
    ],
  };
}

function accessoryExitRow(label, endpoint) {
  const geo = endpoint.ok ? endpoint.geo : null;
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      tx(label, 9, 'bold', undefined, 1),
      { ...tx(endpoint.ok ? endpoint.ip : '不可用', 10, 'medium', undefined, 1, 0.5, 'left', true), flex: 1 },
      tx(endpoint.ok ? countryFlag(geo && geo.countryCode) : '⚠️', 10, 'regular', undefined, 1),
    ],
  };
}

function firstAvailable(exit) {
  if (exit.v4.ok) return exit.v4;
  if (exit.v6.ok) return exit.v6;
  return null;
}

function exitFlag(exit) {
  const endpoint = firstAvailable(exit);
  return endpoint ? countryFlag(endpoint.geo && endpoint.geo.countryCode) : '⚠️';
}

function formatLocation(geo) {
  if (!geo) return '位置未知';
  const code = clean(geo.countryCode).toUpperCase();
  const country = clean(geo.country) || COUNTRY_NAMES[code] || code;
  const values = [country, geo.region, geo.city].map(clean).filter(Boolean);
  const unique = [];
  for (const value of values) {
    const normalized = value.replace(/[\s·・,，省市自治区特别行政区]/g, '').toLowerCase();
    if (!unique.some(item => item.normalized === normalized)) {
      unique.push({ value, normalized });
    }
  }
  return unique.map(item => item.value).join(' · ') || '位置未知';
}

function formatNetwork(geo) {
  if (!geo) return '';
  const asn = geo.asn ? (/^AS/i.test(geo.asn) ? geo.asn : `AS${geo.asn}`) : '';
  return [asn, geo.isp].filter(Boolean).join(' · ');
}

function countryFlag(code) {
  const value = clean(code).toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '🌐';
  return String.fromCodePoint(...[...value].map(letter => 127397 + letter.charCodeAt(0)));
}

function shortNetworkTitle(network) {
  const value = clean(network.title);
  return value.length > 22 ? `${value.slice(0, 21)}…` : value;
}

function networkGlyph(network) {
  if (network.kind === 'wifi') return 'Wi-Fi';
  if (network.kind === 'cellular') return '蜂窝';
  return '网络';
}

function formatRadio(value) {
  const radio = clean(value);
  const upper = radio.toUpperCase();
  if (upper.includes('NR')) return '5G';
  if (upper.includes('LTE')) return '4G';
  if (/WCDMA|HSPA|UMTS/.test(upper)) return '3G';
  if (/EDGE|GPRS/.test(upper)) return '2G';
  return radio;
}

function extractIp(body, family) {
  const raw = clean(body);
  if (!raw) return '';

  try {
    const json = JSON.parse(raw);
    const candidate = clean(json && (json.ip || json.query || json.address));
    if (isIpFamily(candidate, family)) return normalizeIp(candidate);
  } catch (_) {
    // Plain-text IP endpoints are expected to reach this path.
  }

  const tokens = raw.match(/[0-9a-fA-F:.%]+/g) || [];
  const candidate = tokens.find(value => isIpFamily(value, family));
  return candidate ? normalizeIp(candidate) : '';
}

function isIpFamily(value, family) {
  return family === 4 ? isIPv4(value) : isIPv6(value);
}

function isIPv4(value) {
  const parts = clean(value).split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIPv6(value) {
  const ip = normalizeIp(value);
  if (!ip.includes(':') || ip.length > 45 || !/^[0-9a-f:]+$/i.test(ip)) return false;
  const colonCount = (ip.match(/:/g) || []).length;
  if (colonCount < 2 || colonCount > 7) return false;
  if ((ip.match(/::/g) || []).length > 1) return false;
  const groups = ip.split(':').filter(Boolean);
  return groups.length <= 8 && groups.every(group => /^[0-9a-f]{1,4}$/i.test(group));
}

function normalizeIp(value) {
  return clean(value).split('%')[0].replace(/^\[|\]$/g, '');
}

function boundedInt(value, fallback, min, max) {
  const number = Number.parseInt(clean(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function tx(value, size, weight, color, maxLines, minScale, textAlign, monospaced) {
  return {
    type: 'text',
    text: clean(value),
    font: {
      size,
      ...(weight ? { weight } : {}),
      ...(monospaced ? { family: 'Menlo' } : {}),
    },
    ...(color ? { textColor: color } : {}),
    ...(maxLines ? { maxLines } : {}),
    ...(minScale ? { minScale } : {}),
    ...(textAlign ? { textAlign } : {}),
  };
}
