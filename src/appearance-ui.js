(() => {
  'use strict';
  const presets = {
    pinghe: { name: '平和', primary: '#173f33', accent: '#8b3445', gold: '#b58d45', paper: '#f5f2e9' },
    ocean: { name: '海盐蓝', primary: '#203f60', accent: '#83546f', gold: '#ac803c', paper: '#edf3f7' },
    plum: { name: '梅子', primary: '#513449', accent: '#924b5e', gold: '#a78543', paper: '#f7f0f3' },
    forest: { name: '松林', primary: '#244b40', accent: '#885334', gold: '#aa893e', paper: '#f0f5ee' },
    graphite: { name: '石墨', primary: '#333f48', accent: '#764757', gold: '#a28a50', paper: '#f1f2f3' },
    terracotta: { name: '陶土', primary: '#643d33', accent: '#855c3c', gold: '#aa8047', paper: '#f8f0e8' },
  };
  let current = { ...presets.pinghe, preset: 'pinghe', scale: 1, fontSize: 16 };
  const hex = (value) => /^#[0-9a-f]{6}$/i.test(value || '');
  const rgb = (color) => [1, 3, 5].map((n) => parseInt(color.slice(n, n + 2), 16));
  const mix = (color, white) => '#' + rgb(color).map((n) => Math.round(n + (255 - n) * white).toString(16).padStart(2, '0')).join('');
  const luminance = (color) => rgb(color).map((v) => { const n = v / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
  function safe(input = {}) {
    const base = presets[input.preset] || presets.pinghe;
    const result = { ...base, preset: Object.hasOwn(presets, input.preset) ? input.preset : 'pinghe', scale: 1, fontSize: [14,16,18,20,22,24].includes(input.fontSize) ? input.fontSize : 16 };
    for (const name of ['primary', 'accent', 'gold', 'paper']) if (hex(input[name])) result[name] = input[name];
    if (1.05 / (luminance(result.primary) + 0.05) < 4.5) result.primary = base.primary;
    if ((luminance(result.paper) + 0.05) / (luminance('#18231e') + 0.05) < 7) result.paper = base.paper;
    if ((1.05 / (luminance(result.accent) + 0.05)) < 4.5) result.accent = base.accent;
    return result;
  }
  function apply(input) {
    current = safe(input);
    const root = document.documentElement.style;
    const mapping = { '--green-950': current.primary, '--green-900': current.primary, '--green-800': current.primary,
      '--green-700': current.primary, '--green-100': mix(current.primary, .85), '--green-50': mix(current.primary, .94),
      '--wine-700': current.accent, '--wine-100': mix(current.accent, .88), '--gold-600': current.gold,
      '--gold-500': current.gold, '--gold-100': mix(current.gold, .85), '--ivory-100': current.paper,
      '--ivory-50': mix(current.paper, .6), '--content-scale': current.scale };
    for (const [name, value] of Object.entries(mapping)) root.setProperty(name, String(value));
    root.setProperty('--sidebar-base', current.primary);
    root.fontSize = `${current.fontSize}px`;
  }
  async function save(next) {
    const normalized = safe(next);
    if (normalized.primary !== next.primary || normalized.accent !== next.accent || normalized.paper !== next.paper) {
      window.toast?.('颜色对比不足：主色和强调色请选择深色，背景请选择浅色。', 'error'); render(); return;
    }
    try {
      const data = await window.ph.data.get();
      data.settings.appearance = normalized;
      const saved = await window.ph.data.save(data);
      apply(saved.settings.appearance);
      // Share the latest settings with the existing local renderer state.
      if (typeof state !== 'undefined' && state.data) state.data.settings.appearance = saved.settings.appearance;
      render(); window.toast?.('外观已保存');
    } catch (error) { window.toast?.(`外观保存失败：${error.message}`, 'error'); render(); }
  }
  function render() {
    const host = document.getElementById('appearanceSettings'); if (!host) return;
    host.innerHTML = `<h3>外观</h3><p class="setting-intro">六套配色，或调成你喜欢的样子。字号覆盖侧栏、设置和学习页面；不会改变外部网站。</p>
      <div class="appearance-presets">${Object.entries(presets).map(([id, p]) => `<button type="button" data-appearance-preset="${id}" class="${current.preset === id ? 'selected' : ''}"><i style="background:${p.primary}"></i><span>${p.name}</span></button>`).join('')}</div>
      <div class="setting-row"><div><strong>全局字号</strong><small>默认 16 px，可随时调整</small></div><select id="appearanceScale" aria-label="全局字号">${[14,16,18,20,22,24].map((s) => `<option value="${s}"${s === current.fontSize ? ' selected' : ''}>${s} px${s === 16 ? '（默认）' : ''}</option>`).join('')}</select></div>
      <div class="appearance-colors">${[['primary','主色'],['accent','强调色'],['gold','点缀色'],['paper','纸张底色']].map(([key,label]) => `<label><input type="color" data-appearance-color="${key}" value="${current[key]}"/><span>${label}</span></label>`).join('')}</div>`;
    host.querySelectorAll('[data-appearance-preset]').forEach((button) => button.addEventListener('click', () => save({ ...presets[button.dataset.appearancePreset], preset: button.dataset.appearancePreset, fontSize: current.fontSize })));
    host.querySelector('#appearanceScale').addEventListener('change', (e) => save({ ...current, fontSize: Number(e.target.value) }));
    host.querySelectorAll('[data-appearance-color]').forEach((input) => input.addEventListener('change', () => save({ ...current, [input.dataset.appearanceColor]: input.value })));
  }
  window.appearanceUI = { apply, render };
})();
