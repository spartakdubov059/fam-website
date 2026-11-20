function node(document, label, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hero-dot';
  button.setAttribute('aria-label', `Показать баннер ${index + 1}: ${label}`);
  button.setAttribute('aria-pressed', String(index === 0));
  return button;
}

export function initializeHeroCarousel({ document = globalThis.document } = {}) {
  const track = document?.getElementById?.('ruHeroTrack');
  const dots = document?.getElementById?.('ruHeroDots');
  if (!track || !dots || !Array.isArray(track.children) && typeof track.children?.[Symbol.iterator] !== 'function') return;
  let slides = [...track.children];
  if (!slides.length) return;
  let active = 0;
  const dotButtons = slides.map((slide, index) => {
    const image = slide.querySelector?.('img');
    const button = node(document, image?.alt || 'Баннер FAM', index);
    button.addEventListener('click', () => goTo(index));
    dots.append(button);
    return button;
  });
  const update = () => {
    if (!slides.length) return;
    const measured = slides.map(slide => Math.abs((Number(slide.offsetLeft) || 0) - (Number(track.scrollLeft) || 0)));
    active = measured.indexOf(Math.min(...measured));
    dotButtons.forEach((button, index) => {
      button.classList?.toggle?.('active', index === active);
      button.setAttribute('aria-pressed', String(index === active));
    });
  };
  const goTo = index => {
    if (!slides.length) return;
    const next = (index + slides.length) % slides.length;
    const left = Number(slides[next].offsetLeft) || 0;
    if (typeof track.scrollTo === 'function') track.scrollTo({ left, behavior: 'smooth' });
    else track.scrollLeft = left;
    update();
  };
  document.getElementById('ruHeroPrevious')?.addEventListener('click', () => goTo(active - 1));
  document.getElementById('ruHeroNext')?.addEventListener('click', () => goTo(active + 1));
  track.addEventListener?.('scroll', update, { passive: true });
  for (const slide of slides) {
    const image = slide.querySelector?.('img');
    image?.addEventListener?.('error', () => {
      slide.remove?.();
      slides = [...track.children];
      if (!slides.length) dots.replaceChildren?.();
      update();
    }, { once: true });
  }
  update();
}

if (globalThis.document) initializeHeroCarousel();
