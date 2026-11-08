// Окно «Как считается»: формулы и живые таблицы из текущих параметров модели + редактор параметров.
import { CONFIG, WALK, EDITABLE, getParams, paramsAreDefault } from './config.js';

import { _, locale } from './i18n.js';

const RANKS = ['—', 'service, living_street', 'residential, unclassified', 'tertiary', 'secondary', 'primary', 'trunk'];
const f1 = x => x.toLocaleString(locale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const SCALARS = [
  ['crossSpeed', 'Скорость при переходе дороги, м/с', 0.1],
  ['startUpLoss', 'Потеря времени на старт, с', 0.5],
  ['zebraYield', 'Доля водителей, уступающих на «зебре»', 0.05],
  ['markedFactor', 'Множитель ожидания на размеченном переходе', 0.05],
  ['gateDelay', 'Калитка / шлагбаум, с', 0.5],
  ['stepsFactor', 'Множитель времени на лестнице', 0.1],
];

export function methodHTML(speedKmh) {
  const p = getParams();
  const rows = [1, 2, 3, 4, 5, 6].map(r => `<tr><td>${r}</td><td>${RANKS[r]}</td>
    <td><input type="number" step="1" min="0" data-arr="signalCycle" data-i="${r}" value="${p.signalCycle[r]}"></td>
    <td><input type="number" step="1" min="0" data-arr="signalGreen" data-i="${r}" value="${p.signalGreen[r]}"></td>
    <td><b>${f1(WALK.signalWait[r])}</b></td>
    <td><input type="number" step="0.5" min="0" data-arr="roadWidth" data-i="${r}" value="${p.roadWidth[r]}"></td>
    <td><input type="number" step="10" min="0" data-arr="roadFlow" data-i="${r}" value="${p.roadFlow[r]}"></td>
    <td><b>${f1(WALK.unmarkedWait[r])}</b></td>
    <td>${f1(WALK.zebraWait[r])}</td>
    <td>${f1(WALK.unmarkedWait[r] * WALK.markedFactor)}</td></tr>`).join('');
  const scal = SCALARS.map(([k, label, step]) => `<tr><td>${_(label)}</td><td><input type="number" step="${step}" min="0" data-sc="${k}" value="${p[k]}"></td></tr>`).join('');
  const sfx = paramsAreDefault() ? '' : ` <b style="color:#946200">${_('(параметры изменены)')}</b>`;
  const v = { km: f1(speedKmh), steps: WALK.stepsFactor, seg: CONFIG.graph.maxSegmentM, minc: CONFIG.graph.minComponentNodes, snap: CONFIG.snap.originM, off: CONFIG.snap.offNetworkFactor,
    zy: WALK.zebraYield, mf: WALK.markedFactor, gate: WALK.gateDelay, best: CONFIG.index.bestMin, worst: CONFIG.index.worstMin, cell: CONFIG.gridCellM, prob: CONFIG.index.problemBelow };
  return `
<h2 id="method-title">${_('Как считается')}${sfx}</h2>
<p>${_('Данных о реальных скоростях нет, поэтому время считается моделью: <b>время = длина × коэффициент / скорость + ожидание на переходах</b>. Всё выполняется в вашем браузере по данным OpenStreetMap; ниже — формулы и текущие значения параметров. Полное обоснование — <code>docs/METHODOLOGY.md</code>.')}</p>

<h3>${_('1. Пешеходный граф')}</h3>
<p>${_('Из OSM берутся улицы и дорожки, доступные пешеходу (без автомагистралей, закрытых и частных). Рёбра дробятся на отрезки ≤ {seg} м, мелкие несвязные куски (< {minc} узлов) отбрасываются. Точки старта и объектов привязываются к ближайшему ребру (до {snap} м для старта); путь «по дворам» до сети медленнее в {off} раза.', v)}</p>

<h3>${_('2. Время ходьбы по ребру')}</h3>
<code class="formula">t = L · k(${_('покрытие, лестница, тротуар, уклон')}) / v,   v = ${v.km} ${_('км/ч')}</code>
<p>${_('Коэффициент <i>k</i> — произведение: лестница ×{steps}; покрытие (асфальт ×1, брусчатка ×1,2, грунт ×1,35, песок/снег ×1,7–1,8); состояние (smoothness); отсутствие тротуара на дороге ранга 3–6 (×1,2–1,4); уклон по формуле Тоблера (среднее по подъёму и спуску): <code>W = 6·e^(−3,5·|s + 0,05|)</code> км/ч.', v)}</p>

<h3>${_('3. Перекрёстки и переходы')}</h3>
<p>${_('Узел с ветвлением — «кольцо» концов тротуаров. Повернуть за угол на той же стороне бесплатно, <b>перейти ветку</b> — платно. Ожидание зависит от типа перехода:')}</p>
<code class="formula">${_('Светофор')}:  w = (C − g)² / (2C)                      — ${_('Вебстер (C — цикл, g — зелёная фаза пешехода)')}
${_('Без светофора')}:  w = 2 · (e^(λ·tc) − λ·tc − 1) / λ   — ${_('Адамс, дорога переходится в два этапа')}
                λ = q / 2 / 3600,  tc = (W/2)/v_c + t_${_('старт')}
${_('«Зебра»')}:  max(1, w · (1 − ${v.zy}))     ${_('Размеченный')}:  w · ${v.mf}</code>
<p>${_('Калитка/шлагбаум +{gate} с; закрытые (access/foot = no, private) непроходимы. На малых улицах (ранг ≤ 2) дорогу можно перейти посреди квартала с ожиданием как на неразмеченном переходе. Если точка привязана к крупной дороге, добавляется ¼ ожидания — объект может быть на другой стороне.', v)}</p>
<div class="tbl-wrap"><table>
<thead><tr><th>${_('Ранг')}</th><th>${_('Дорога OSM')}</th><th>${_('Цикл C, с')}</th><th>${_('Зелёная g, с')}</th><th>${_('Светофор, с')}</th><th>${_('Ширина, м')}</th><th>${_('Поток, авт/ч')}</th><th>${_('Без регул., с')}</th><th>${_('«Зебра», с')}</th><th>${_('Размечен., с')}</th></tr></thead>
<tbody>${rows}</tbody></table></div>
<table style="margin-top:10px;max-width:520px"><tbody>${scal}</tbody></table>
<div class="params-actions">
  <button type="button" class="primary-soft" id="params-apply" style="flex:none">${_('Применить и пересчитать')}</button>
  <button type="button" id="params-reset">${_('Вернуть по умолчанию')}</button>
</div>
<p class="hint">${_('Изменения сохраняются в этом браузере/приложении. Граф при этом перестраивается, данные OSM повторно не скачиваются.')}</p>

<h3>${_('4. Изохроны')}</h3>
<p>${_('Алгоритм Дейкстры по состояниям «ребро × сторона дороги» от точки старта до порога (5/10/15 мин). Достижимые узлы переносятся на растр 40 м, расширяются на 1 клетку, контур обводится и сглаживается (Chaikin ×2), дырки < 4 га закрашиваются.')}</p>

<h3>${_('5. Индекс доступности и проблемные зоны')}</h3>
<code class="formula">score(t) = 100 ${_('при')} t ≤ ${v.best} ${_('мин')};  0 ${_('при')} t ≥ ${v.worst} ${_('мин')};  ${_('линейно между')}</code>
<p>${_('Индекс ячейки ({cell} м) — среднее score по выбранным категориям, вес жителей — этажность зданий OSM (или длина улиц). <b>Проблемная зона</b> — связный (8-соседство) кластер ячеек с индексом < {prob} и значимым весом (≥ ½ медианы). Показатели района — взвешенная медиана и доли жителей в пределах 5/10/15 мин.', v)}</p>

<h3>${_('6. Ограничения')}</h3>
<ul>
<li>${_('Качество зависит от полноты OSM: переходы без тегов считаются «как придётся» по рангу дороги.')}</li>
<li>${_('Светофорные циклы и потоки — типовые значения по рангам, не измерения; их можно уточнить выше.')}</li>
<li>${_('Вес зданий — прокси, не перепись населения. Рельеф учитывается только при наличии тега incline.')}</li>
</ul>`;
}

export function readParamsFrom(root) {
  const p = getParams();
  for (const inp of root.querySelectorAll('input[data-arr]')) p[inp.dataset.arr][Number(inp.dataset.i)] = Number(inp.value);
  for (const inp of root.querySelectorAll('input[data-sc]')) p[inp.dataset.sc] = Number(inp.value);
  return p;
}
export { EDITABLE };
