// 配信者のチャットの色をアクセントカラーにする
const STYLE_ID = 'channel-theme';
const LIGHT_BG = '#fafafa';   // css/app.css の --bg と揃える
const DARK_BG = '#141415';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const rgba = (hex, alpha) => `rgba(${hexToRgb(hex).join(', ')}, ${alpha})`;

/** 背景 bg に対して ratio 以上のコントラストになるまで明るさを動かす */
function fitLightness(h, s, l, bg, ratio, dir) {
  let hex = hslToHex(h, s, l);
  for (let i = 0; i < 60 && contrast(hex, bg) < ratio; i++) {
    l = clamp(l + dir * 0.01, 0, 1);
    hex = hslToHex(h, s, l);
  }
  return { hex, l };
}

function themeVars(color) {
  let [h, s, l] = rgbToHsl(hexToRgb(color));
  s = Math.max(s, 0.25);   // ほぼ灰色の色でも少しは色味を残す

  const lightA = fitLightness(h, s, Math.min(l, 0.55), LIGHT_BG, 3.6, -1);
  // 白に近い色でも色味が残るように
  const darkA = fitLightness(h, s, clamp(l, 0.6, 0.74), DARK_BG, 5, +1);

  const light = {
    '--accent': lightA.hex,
    '--accent-strong': hslToHex(h, s, lightA.l - 0.1),
    '--accent-soft': rgba(lightA.hex, 0.10),
    '--accent-ink': '#ffffff',
  };
  const dark = {
    '--accent': darkA.hex,
    '--accent-strong': hslToHex(h, s, darkA.l + 0.08),
    '--accent-soft': rgba(darkA.hex, 0.14),
    '--accent-ink': '#141415',
  };
  // バナーは白文字なので暗めに
  const banner = {
    '--banner-1': hslToHex(h, s, 0.22),
    '--banner-2': hslToHex(h, s, 0.38),
    '--banner-3': hslToHex(h, s, 0.48),
    '--banner-glow-1': hslToHex(h + 40, s, 0.5),
    '--banner-glow-2': hslToHex(h - 40, s, 0.45),
  };
  return { light, dark, banner };
}

const block = (vars) => Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');

/** color（"#RRGGBB"）で画面の色を変える。null なら既定の紫に戻す */
export function applyChannelTheme(color) {
  document.getElementById(STYLE_ID)?.remove();
  if (!color) return;
  const { light, dark, banner } = themeVars(color);
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
:root {
${block(light)}
${block(banner)}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${block(dark)}
  }
}
:root[data-theme="dark"] {
${block(dark)}
}`;
  document.head.append(style);
}
