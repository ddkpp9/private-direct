const CACHE_KEY = 'weather-widget:last-good-v1';

const COLORS = {
  white: '#FFFFFF',
  secondary: '#FFFFFFCC',
  tertiary: '#FFFFFF99',
  card: '#FFFFFF1F',
  adaptivePrimary: { light: '#111111', dark: '#FFFFFF' },
  adaptiveSecondary: { light: '#555555', dark: '#FFFFFFB3' },
};

const ICONS = {
  'clear-day': 'sun.max.fill',
  'clear-night': 'moon.stars.fill',
  'partly-cloudy-day': 'cloud.sun.fill',
  'partly-cloudy-night': 'cloud.moon.fill',
  cloudy: 'cloud.fill',
  fog: 'cloud.fog.fill',
  haze: 'sun.haze.fill',
  drizzle: 'cloud.drizzle.fill',
  rain: 'cloud.rain.fill',
  'heavy-rain': 'cloud.heavyrain.fill',
  thunderstorm: 'cloud.bolt.rain.fill',
  sleet: 'cloud.sleet.fill',
  snow: 'snowflake',
  'heavy-snow': 'snowflake',
  wind: 'wind',
};

const GRADIENTS = {
  'clear-day': ['#3977EA', '#72C4FF'],
  'clear-night': ['#111A3A', '#354A78'],
  'partly-cloudy-day': ['#4776A8', '#83B7D9'],
  'partly-cloudy-night': ['#17233F', '#4E638A'],
  cloudy: ['#536976', '#8AA0AC'],
  fog: ['#667A86', '#A5B5BD'],
  haze: ['#8A7452', '#C5AB78'],
  drizzle: ['#315B79', '#7195AC'],
  rain: ['#263D5C', '#587D9D'],
  'heavy-rain': ['#172A46', '#3E617D'],
  thunderstorm: ['#171A33', '#4B476E'],
  sleet: ['#38566D', '#7995A7'],
  snow: ['#7697AD', '#B9D1DE'],
  'heavy-snow': ['#5D7F96', '#A8C6D7'],
  wind: ['#466D72', '#85A9A8'],
  default: ['#3D5A80', '#6D98BA'],
};

export default async function(ctx) {
  const env = ctx.env || {};
  const family = ctx.widgetFamily || 'systemSmall';
  const refreshMinutes = clampInteger(env.REFRESH_MINUTES, 30, 15, 360);
  const timeout = clampInteger(env.TIMEOUT_MS, 10000, 1000, 30000);
  const unit = env.UNIT === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  const cityFallback = cleanText(env.CITY, '天气', 30);
  const tapUrl = cleanText(env.TAP_URL, '', 500);
  const refreshAfter = new Date(Date.now() + refreshMinutes * 60 * 1000).toISOString();

  let weather = null;
  let isCached = false;
  let errorMessage = '';

  try {
    const apiUrl = cleanText(env.API_URL, '', 2000);
    if (!apiUrl) throw new Error('缺少 API_URL');

    const response = await ctx.http.get(apiUrl, { timeout });
    if (response.status < 200 || response.status >= 300) {
      throw new Error('天气接口返回 HTTP ' + response.status);
    }

    const raw = await response.json();
    const fetchedAt = new Date().toISOString();
    weather = normalizeWeather(raw, cityFallback, fetchedAt);
    try {
      ctx.storage.setJSON(CACHE_KEY, {
        savedAt: fetchedAt,
        weather,
      });
    } catch (_) {
      // 缓存失败不影响本次实时数据的展示。
    }
  } catch (error) {
    errorMessage = error && error.message ? String(error.message) : '天气数据加载失败';
    try {
      const cached = ctx.storage.getJSON(CACHE_KEY);
      if (cached && cached.weather) {
        weather = normalizeWeather(
          cached.weather,
          cityFallback,
          cached.savedAt || new Date().toISOString()
        );
        isCached = true;
      }
    } catch (_) {
      weather = null;
    }
  }

  if (!weather) {
    return renderError(family, errorMessage, refreshAfter, tapUrl);
  }

  return renderWeather(family, weather, unit, isCached, refreshAfter, tapUrl);
}

function normalizeWeather(raw, cityFallback, fetchedAt) {
  if (!raw || typeof raw !== 'object') throw new Error('天气接口没有返回 JSON 对象');

  const temperature = finiteNumber(raw.temperature);
  if (temperature === null) throw new Error('天气数据缺少 temperature');

  const forecast = Array.isArray(raw.forecast)
    ? raw.forecast
        .map(function(item) {
          if (!item || typeof item !== 'object') return null;
          const high = finiteNumber(item.high);
          const low = finiteNumber(item.low);
          if (high === null && low === null) return null;
          return {
            day: cleanText(item.day, '', 12),
            condition: cleanText(item.condition, '', 20),
            weatherCode: cleanText(item.weatherCode, 'default', 40),
            high,
            low,
          };
        })
        .filter(function(item) { return item !== null; })
    : [];

  return {
    city: cleanText(raw.city || raw.location, cityFallback, 30),
    condition: cleanText(raw.condition, '天气', 30),
    weatherCode: cleanText(raw.weatherCode, 'default', 40),
    temperature,
    feelsLike: finiteNumber(raw.feelsLike),
    high: finiteNumber(raw.high),
    low: finiteNumber(raw.low),
    humidity: finiteNumber(raw.humidity),
    wind: cleanText(raw.wind, '', 40),
    updatedAt: validIsoDate(raw.updatedAt) || validIsoDate(fetchedAt) || new Date().toISOString(),
    forecast,
  };
}

function renderWeather(family, weather, unit, isCached, refreshAfter, tapUrl) {
  if (family === 'accessoryInline') {
    return widgetRoot(
      [{
        type: 'text',
        text: weather.city + '  ' + formatTemperature(weather.temperature, unit) + '  ' + weather.condition,
        maxLines: 1,
        minScale: 0.7,
      }],
      { refreshAfter, tapUrl }
    );
  }

  if (family === 'accessoryCircular') {
    return widgetRoot(
      [{
        type: 'stack',
        direction: 'column',
        alignItems: 'center',
        gap: 1,
        children: [
          weatherIcon(weather.weatherCode, 19, COLORS.adaptivePrimary),
          {
            type: 'text',
            text: formatTemperature(weather.temperature, unit),
            font: { size: 'headline', weight: 'bold' },
            textColor: COLORS.adaptivePrimary,
            maxLines: 1,
            minScale: 0.7,
          },
        ],
      }],
      { padding: 3, refreshAfter, tapUrl }
    );
  }

  if (family === 'accessoryRectangular') {
    const detail = highLowText(weather, unit);
    return widgetRoot(
      [{
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 8,
        children: [
          weatherIcon(weather.weatherCode, 28, COLORS.adaptivePrimary),
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 1,
            flex: 1,
            children: [
              {
                type: 'text',
                text: weather.city + '  ' + formatTemperature(weather.temperature, unit),
                font: { size: 'headline', weight: 'semibold' },
                textColor: COLORS.adaptivePrimary,
                maxLines: 1,
                minScale: 0.65,
              },
              {
                type: 'text',
                text: weather.condition + (detail ? ' · ' + detail : ''),
                font: { size: 'caption1' },
                textColor: COLORS.adaptiveSecondary,
                maxLines: 1,
                minScale: 0.65,
              },
            ],
          },
        ],
      }],
      { padding: [4, 8], refreshAfter, tapUrl }
    );
  }

  if (family === 'systemMedium') {
    return renderMedium(weather, unit, isCached, refreshAfter, tapUrl);
  }

  if (family === 'systemLarge' || family === 'systemExtraLarge') {
    return renderLarge(
      weather,
      unit,
      isCached,
      refreshAfter,
      tapUrl,
      family === 'systemExtraLarge' ? 5 : 4
    );
  }

  return renderSmall(weather, unit, isCached, refreshAfter, tapUrl);
}

function renderSmall(weather, unit, isCached, refreshAfter, tapUrl) {
  return widgetRoot(
    [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        children: [
          {
            type: 'text',
            text: weather.city,
            font: { size: 'headline', weight: 'semibold' },
            textColor: COLORS.white,
            maxLines: 1,
            minScale: 0.65,
            flex: 1,
          },
          weatherIcon(weather.weatherCode, 25, COLORS.white),
        ],
      },
      { type: 'spacer' },
      {
        type: 'text',
        text: formatTemperature(weather.temperature, unit),
        font: { size: 38, weight: 'light' },
        textColor: COLORS.white,
        maxLines: 1,
        minScale: 0.7,
      },
      {
        type: 'text',
        text: weather.condition,
        font: { size: 'subheadline', weight: 'semibold' },
        textColor: COLORS.secondary,
        maxLines: 1,
        minScale: 0.7,
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          {
            type: 'text',
            text: highLowText(weather, unit) || unitLabel(unit),
            font: { size: 'caption2' },
            textColor: COLORS.tertiary,
            maxLines: 1,
            minScale: 0.65,
            flex: 1,
          },
          isCached
            ? {
                type: 'text',
                text: '缓存',
                font: { size: 'caption2', weight: 'medium' },
                textColor: '#FFE29A',
              }
            : { type: 'spacer', length: 0 },
        ],
      },
    ],
    {
      padding: 14,
      gap: 3,
      gradient: gradientFor(weather.weatherCode),
      refreshAfter,
      tapUrl,
    }
  );
}

function renderMedium(weather, unit, isCached, refreshAfter, tapUrl) {
  const metrics = buildMetrics(weather, unit).slice(0, 3);

  return widgetRoot(
    [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 14,
        flex: 1,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 4,
            flex: 1,
            children: [
              {
                type: 'text',
                text: weather.city,
                font: { size: 'headline', weight: 'semibold' },
                textColor: COLORS.white,
                maxLines: 1,
                minScale: 0.65,
              },
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'center',
                gap: 8,
                children: [
                  weatherIcon(weather.weatherCode, 36, COLORS.white),
                  {
                    type: 'text',
                    text: formatTemperature(weather.temperature, unit),
                    font: { size: 34, weight: 'light' },
                    textColor: COLORS.white,
                    maxLines: 1,
                    minScale: 0.7,
                  },
                ],
              },
              {
                type: 'text',
                text: weather.condition,
                font: { size: 'subheadline', weight: 'medium' },
                textColor: COLORS.secondary,
                maxLines: 1,
                minScale: 0.7,
              },
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 7,
            flex: 1,
            children: metrics.length ? metrics.map(metricRow) : [emptyDetail()],
          },
        ],
      },
      updateRow(weather.updatedAt, isCached),
    ],
    {
      padding: 14,
      gap: 6,
      gradient: gradientFor(weather.weatherCode),
      refreshAfter,
      tapUrl,
    }
  );
}

function renderLarge(weather, unit, isCached, refreshAfter, tapUrl, forecastLimit) {
  const metrics = buildMetrics(weather, unit).slice(0, 3);
  const forecast = weather.forecast.slice(0, forecastLimit);

  return widgetRoot(
    [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 12,
        children: [
          weatherIcon(weather.weatherCode, 48, COLORS.white),
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 2,
            flex: 1,
            children: [
              {
                type: 'text',
                text: weather.city,
                font: { size: 'title3', weight: 'bold' },
                textColor: COLORS.white,
                maxLines: 1,
                minScale: 0.65,
              },
              {
                type: 'text',
                text: weather.condition,
                font: { size: 'subheadline', weight: 'medium' },
                textColor: COLORS.secondary,
                maxLines: 1,
                minScale: 0.7,
              },
            ],
          },
          {
            type: 'text',
            text: formatTemperature(weather.temperature, unit),
            font: { size: 42, weight: 'light' },
            textColor: COLORS.white,
            maxLines: 1,
            minScale: 0.7,
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 8,
        children: metrics.length
          ? metrics.map(function(metric) { return metricCard(metric); })
          : [emptyDetail()],
      },
      {
        type: 'text',
        text: '未来天气',
        font: { size: 'subheadline', weight: 'semibold' },
        textColor: COLORS.secondary,
      },
      forecast.length
        ? {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 7,
            flex: 1,
            children: forecast.map(function(item) { return forecastCard(item, unit); }),
          }
        : {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            flex: 1,
            padding: 12,
            backgroundColor: COLORS.card,
            borderRadius: 12,
            children: [
              {
                type: 'text',
                text: '接口未提供 forecast 预报数组',
                font: { size: 'caption1' },
                textColor: COLORS.secondary,
                textAlign: 'center',
              },
            ],
          },
      updateRow(weather.updatedAt, isCached),
    ],
    {
      padding: 16,
      gap: 9,
      gradient: gradientFor(weather.weatherCode),
      refreshAfter,
      tapUrl,
    }
  );
}

function renderError(family, message, refreshAfter, tapUrl) {
  if (family === 'accessoryInline') {
    return widgetRoot(
      [{ type: 'text', text: '天气暂不可用', maxLines: 1 }],
      { refreshAfter, tapUrl }
    );
  }

  const accessory = family === 'accessoryCircular' || family === 'accessoryRectangular';
  const color = accessory ? COLORS.adaptivePrimary : COLORS.white;
  const secondary = accessory ? COLORS.adaptiveSecondary : COLORS.secondary;

  return widgetRoot(
    [{
      type: 'stack',
      direction: accessory && family === 'accessoryRectangular' ? 'row' : 'column',
      alignItems: 'center',
      gap: 7,
      flex: 1,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:exclamationmark.triangle.fill',
          width: accessory ? 20 : 28,
          height: accessory ? 20 : 28,
          color,
        },
        {
          type: 'stack',
          direction: 'column',
          alignItems: accessory && family === 'accessoryRectangular' ? 'start' : 'center',
          gap: 2,
          flex: 1,
          children: [
            {
              type: 'text',
              text: '天气暂不可用',
              font: { size: accessory ? 'headline' : 'body', weight: 'semibold' },
              textColor: color,
              textAlign: 'center',
              maxLines: 1,
              minScale: 0.7,
            },
            {
              type: 'text',
              text: message || '请检查 API_URL',
              font: { size: 'caption2' },
              textColor: secondary,
              textAlign: 'center',
              maxLines: accessory ? 1 : 2,
              minScale: 0.65,
            },
          ],
        },
      ],
    }],
    {
      padding: accessory ? [4, 8] : 14,
      gap: 6,
      gradient: accessory ? null : GRADIENTS.default,
      refreshAfter,
      tapUrl,
    }
  );
}

function widgetRoot(children, options) {
  const root = {
    type: 'widget',
    children,
    refreshAfter: options.refreshAfter,
  };
  if (options.padding !== undefined) root.padding = options.padding;
  if (options.gap !== undefined) root.gap = options.gap;
  if (options.gradient) {
    root.backgroundGradient = {
      type: 'linear',
      colors: options.gradient,
      stops: [0, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    };
  }
  if (options.tapUrl) root.url = options.tapUrl;
  return root;
}

function buildMetrics(weather, unit) {
  const items = [];
  if (weather.feelsLike !== null) {
    items.push({ icon: 'thermometer.medium', label: '体感', value: formatTemperature(weather.feelsLike, unit) });
  }
  if (weather.humidity !== null) {
    items.push({ icon: 'humidity.fill', label: '湿度', value: Math.round(weather.humidity) + '%' });
  }
  if (weather.wind) {
    items.push({ icon: 'wind', label: '风力', value: weather.wind });
  }
  if (weather.high !== null || weather.low !== null) {
    items.push({ icon: 'thermometer.sun.fill', label: '高低温', value: highLowText(weather, unit) });
  }
  return items;
}

function metricRow(metric) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 6,
    children: [
      { type: 'image', src: 'sf-symbol:' + metric.icon, width: 14, height: 14, color: COLORS.secondary },
      { type: 'text', text: metric.label, font: { size: 'caption1' }, textColor: COLORS.tertiary },
      { type: 'spacer' },
      {
        type: 'text',
        text: metric.value,
        font: { size: 'caption1', weight: 'semibold' },
        textColor: COLORS.white,
        maxLines: 1,
        minScale: 0.65,
      },
    ],
  };
}

function metricCard(metric) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 3,
    padding: 9,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    flex: 1,
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        children: [
          { type: 'image', src: 'sf-symbol:' + metric.icon, width: 12, height: 12, color: COLORS.secondary },
          { type: 'text', text: metric.label, font: { size: 'caption2' }, textColor: COLORS.tertiary },
        ],
      },
      {
        type: 'text',
        text: metric.value,
        font: { size: 'subheadline', weight: 'semibold' },
        textColor: COLORS.white,
        maxLines: 1,
        minScale: 0.55,
      },
    ],
  };
}

function forecastCard(item, unit) {
  const range = [
    item.high === null ? '--' : formatTemperature(item.high, unit),
    item.low === null ? '--' : formatTemperature(item.low, unit),
  ].join(' / ');

  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'center',
    gap: 5,
    padding: 8,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    flex: 1,
    children: [
      {
        type: 'text',
        text: item.day || item.condition || '预报',
        font: { size: 'caption1', weight: 'semibold' },
        textColor: COLORS.secondary,
        textAlign: 'center',
        maxLines: 1,
        minScale: 0.6,
      },
      weatherIcon(item.weatherCode, 23, COLORS.white),
      {
        type: 'text',
        text: range,
        font: { size: 'caption2', weight: 'medium' },
        textColor: COLORS.white,
        textAlign: 'center',
        maxLines: 1,
        minScale: 0.55,
      },
    ],
  };
}

function updateRow(updatedAt, isCached) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 4,
    children: [
      {
        type: 'text',
        text: isCached ? '缓存数据 · 更新于' : '更新于',
        font: { size: 'caption2' },
        textColor: isCached ? '#FFE29A' : COLORS.tertiary,
      },
      {
        type: 'date',
        date: updatedAt,
        format: 'relative',
        font: { size: 'caption2' },
        textColor: isCached ? '#FFE29A' : COLORS.tertiary,
        maxLines: 1,
      },
    ],
  };
}

function emptyDetail() {
  return {
    type: 'text',
    text: '暂无更多天气详情',
    font: { size: 'caption1' },
    textColor: COLORS.secondary,
  };
}

function weatherIcon(code, size, color) {
  return {
    type: 'image',
    src: 'sf-symbol:' + (ICONS[code] || 'cloud.sun.fill'),
    width: size,
    height: size,
    color,
  };
}

function gradientFor(code) {
  return GRADIENTS[code] || GRADIENTS.default;
}

function formatTemperature(value, unit) {
  if (value === null) return '--°';
  const converted = unit === 'fahrenheit' ? value * 9 / 5 + 32 : value;
  return Math.round(converted) + '°';
}

function highLowText(weather, unit) {
  const parts = [];
  if (weather.high !== null) parts.push('H ' + formatTemperature(weather.high, unit));
  if (weather.low !== null) parts.push('L ' + formatTemperature(weather.low, unit));
  return parts.join('  ');
}

function unitLabel(unit) {
  return unit === 'fahrenheit' ? '华氏温度' : '摄氏温度';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanText(value, fallback, maxLength) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function validIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
