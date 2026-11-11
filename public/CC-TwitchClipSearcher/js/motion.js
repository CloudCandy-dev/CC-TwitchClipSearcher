// アニメーション（GSAP）。読み込めないときは何もしない
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const enabled = () => !!gsap;

if (gsap) {
  if (ScrollTrigger) gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ ease: 'power3.out', duration: 0.6 });
}

const CLEAR = 'transform,opacity,visibility';
let cardTriggers = [];

/** 最初の表示 */
export function intro() {
  document.documentElement.classList.remove('motion-pending');
  if (!enabled()) return;
  gsap.timeline({ defaults: { clearProps: CLEAR } })
    .from('.topbar > *', { y: -12, autoAlpha: 0, stagger: 0.08, duration: 0.5 })
    .from('.banner', { y: 24, scale: 0.98, autoAlpha: 0, duration: 0.8 }, '<0.1')
    .from('.channel-field', { y: 16, autoAlpha: 0 }, '-=0.5')
    .from('.banner-intro:not([hidden]) .intro-actions > *', { y: 12, autoAlpha: 0, stagger: 0.08 }, '-=0.4')
    .from('.controls > *:not([hidden])', { y: 12, autoAlpha: 0, stagger: 0.06 }, '-=0.45');
}

/** チャンネルが切り替わったとき */
export function channelIn() {
  if (!enabled()) return;
  gsap.timeline({ defaults: { clearProps: CLEAR } })
    .from('#channel-avatar', { scale: 0.6, autoAlpha: 0, duration: 0.7, ease: 'back.out(1.8)' })
    .from('.banner-text > *', { x: -16, autoAlpha: 0, stagger: 0.08 }, '<0.1');
}

/** バナー画像の読み込み完了 */
export function bannerImageIn(img) {
  if (!enabled()) return;
  gsap.fromTo(img, { autoAlpha: 0, scale: 1.08 }, { autoAlpha: 1, scale: 1, duration: 1.4, ease: 'power2.out', clearProps: CLEAR });
}

/** 期間グラフの棒を下から伸ばす */
export function growBars(container) {
  if (!enabled()) return;
  const bars = container.querySelectorAll('.bucket-bar');
  gsap.from(bars, {
    scaleY: 0, transformOrigin: '50% 100%', duration: 0.7,
    stagger: { amount: Math.min(0.5, bars.length * 0.03) },
    clearProps: 'transform',
  });
}

/** 件数のカウントアップ */
export function countUp(el, to, format) {
  if (!enabled() || !el || to <= 0) return;
  const n = { v: 0 };
  gsap.to(n, {
    v: to, duration: 0.9, ease: 'power2.out',
    onUpdate: () => { el.textContent = format(Math.round(n.v)); },
  });
}

/** 一覧を作り直す前に、前のカードの監視を止める */
export function resetCards() {
  cardTriggers.forEach((t) => t.kill());
  cardTriggers = [];
}

/** 追加したカードを、画面に入ったものから順に出す */
export function cardsIn(items) {
  if (!enabled() || !ScrollTrigger || !items.length) return;
  gsap.set(items, { autoAlpha: 0, y: 24 });
  cardTriggers.push(...ScrollTrigger.batch(items, {
    start: 'top 95%',
    once: true,
    onEnter: (batch) => gsap.to(batch, {
      autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.05, overwrite: true, clearProps: CLEAR,
    }),
  }));
}

/** ダイアログを開いたとき */
export function dialogIn(dialog) {
  if (!enabled()) return;
  gsap.fromTo(dialog, { y: 24, scale: 0.96, autoAlpha: 0 }, { y: 0, scale: 1, autoAlpha: 1, duration: 0.3, overwrite: true, clearProps: CLEAR });
}

/** ダイアログを閉じる（閉じ終わってから close する） */
export function dialogOut(dialog, done) {
  if (!enabled()) { done(); return; }
  gsap.to(dialog, {
    y: 16, scale: 0.97, autoAlpha: 0, duration: 0.16, ease: 'power2.in', overwrite: true,
    onComplete: () => { done(); gsap.set(dialog, { clearProps: CLEAR }); },
  });
}

/** 選択中の背景を、押したボタンへ滑らせる（role="radio" のボタン群） */
export function pill(group) {
  const el = document.createElement('span');
  el.className = 'pill';
  el.setAttribute('aria-hidden', 'true');
  group.prepend(el);
  group.classList.add('has-pill');
  let placed = false;

  const place = (vars) => {
    if (gsap) gsap.set(el, vars);
    else Object.assign(el.style, { transform: `translate(${vars.x}px, ${vars.y}px)`, width: `${vars.width}px`, height: `${vars.height}px`, opacity: vars.opacity });
  };
  const move = (animate) => {
    const b = group.querySelector('[aria-checked="true"]');
    if (!b || !b.offsetWidth) { place({ x: 0, y: 0, width: 0, height: 0, opacity: 0 }); placed = false; return; }
    const to = { x: b.offsetLeft, y: b.offsetTop, width: b.offsetWidth, height: b.offsetHeight, opacity: 1 };
    if (animate && placed && enabled()) gsap.to(el, { ...to, duration: 0.26, ease: 'power3.out', overwrite: true });
    else place(to);
    placed = true;
  };

  new MutationObserver(() => move(true)).observe(group, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
  new ResizeObserver(() => { if (!gsap?.isTweening(el)) move(false); }).observe(group);
}

/** パネルを高さごと開閉する */
export function reveal(el, show) {
  const state = show ? 'open' : 'closed';
  if ((el.dataset.reveal ?? (el.hidden ? 'closed' : 'open')) === state) return;
  el.dataset.reveal = state;
  if (!enabled()) { el.hidden = !show; return; }
  gsap.killTweensOf(el);
  const cs = getComputedStyle(el);
  const pad = { paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom };
  const closed = { height: 0, paddingTop: 0, paddingBottom: 0, autoAlpha: 0, y: -6 };
  const RESET = 'height,paddingTop,paddingBottom,overflow,transform,opacity,visibility';
  if (show) {
    el.hidden = false;
    gsap.fromTo(el, { ...closed, overflow: 'hidden' }, {
      height: 'auto', ...pad, autoAlpha: 1, y: 0, duration: 0.28, ease: 'power3.out', clearProps: RESET,
    });
  } else {
    gsap.to(el, {
      ...closed, overflow: 'hidden', duration: 0.18, ease: 'power2.in',
      onComplete: () => { el.hidden = true; gsap.set(el, { clearProps: RESET }); },
    });
  }
}

/** 横並びの要素を出し入れする */
export function slide(el, show) {
  if (el.hidden === !show) return;
  el.hidden = !show;
  if (show && enabled()) gsap.from(el, { x: -8, autoAlpha: 0, duration: 0.22, clearProps: CLEAR });
}

/** 数字が変わったときに弾ませる */
export function pop(el) {
  if (!enabled() || el.hidden) return;
  gsap.fromTo(el, { scale: 0.6 }, { scale: 1, duration: 0.35, ease: 'back.out(3)', overwrite: true, clearProps: 'transform' });
}
