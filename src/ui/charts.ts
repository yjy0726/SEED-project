import {
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  LogarithmicScale,
  PointElement,
  ScatterController,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';

Chart.register(ScatterController, LineController, PointElement, LineElement, LinearScale, LogarithmicScale, Tooltip, Legend);
Chart.defaults.font.family = "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";
Chart.defaults.font.size = 13;
Chart.defaults.color = '#8b919d';
Chart.defaults.animation = false;
Chart.defaults.maintainAspectRatio = false;

/** 검증된 차트 색 (파랑·주황·청록) */
export const C = {
  blue: '#2F55B8',
  blueFaint: 'rgba(47,85,184,0.30)',
  orange: '#E0701E',
  teal: '#13A3A0',
  grid: '#f0f1f4',
  axis: '#e2e4e9',
};

export function axis(title: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'linear' as const,
    title: { display: true, text: title, color: '#4d5462', font: { weight: 600 as const, size: 12 } },
    grid: { color: C.grid },
    border: { color: C.axis },
    ...extra,
  };
}

export function makeChart(canvas: HTMLCanvasElement, config: ChartConfiguration): Chart {
  const old = Chart.getChart(canvas);
  old?.destroy();
  return new Chart(canvas, config);
}

export { Chart };
