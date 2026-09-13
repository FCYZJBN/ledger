// 图表封装：基于 ECharts（CDN 引入，离线时由 Service Worker 缓存）
// 所有函数都做降级：图表库未加载时显示占位提示，不报错

function ensureChart(el) {
  if (typeof echarts === 'undefined') {
    el.innerHTML = '<div class="chart-empty">图表库未加载（需联网一次）</div>';
    return null;
  }
  return echarts.getInstanceByDom(el) || echarts.init(el);
}

function fmtYuan(v) {
  return '¥' + Number(v).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// 分类占比环形图。items: [{ name, value(分), color }]
export function renderCategoryPie(el, items) {
  const chart = ensureChart(el);
  if (!chart) return;
  const data = items.map((i) => ({
    name: i.name,
    value: +(i.value / 100).toFixed(2),
    itemStyle: { color: i.color },
  }));
  chart.setOption({
    tooltip: {
      trigger: 'item',
      formatter: (p) => `${p.name}<br/>${fmtYuan(p.value)}（${p.percent}%）`,
    },
    legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '44%'],
        itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
        data,
      },
    ],
  });
}

// 趋势柱状图。labels: string[], values: number[]（分）
export function renderTrend(el, labels, values, color) {
  const chart = ensureChart(el);
  if (!chart) return;
  const yuan = values.map((v) => +(v / 100).toFixed(2));
  chart.setOption({
    tooltip: { trigger: 'axis', valueFormatter: (v) => fmtYuan(v) },
    grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 10, interval: 'auto' },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { fontSize: 10, formatter: (v) => v },
      splitLine: { lineStyle: { color: '#eee' } },
    },
    series: [
      {
        type: 'bar',
        data: yuan,
        itemStyle: { color: color || '#4F6EF7', borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 22,
      },
    ],
  });
}
