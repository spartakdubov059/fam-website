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
  let dotButtons = [];
  const rebuildDots = () => {
    dotButtons = slides.map((slide, index) => {
      const image = slide.querySelector?.('img');
      const heading = slide.querySelector?.('h3');
      const button = node(document, image?.alt || heading?.textContent || 'Баннер FAM', index);
      button.addEventListener('click', () => goTo(index));
      return button;
    });
    dots.replaceChildren(...dotButtons);
  };
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
  rebuildDots();
  track.addEventListener?.('famru:hero-slides-changed', () => {
    const previous = slides[active];
    slides = [...track.children];
    rebuildDots();
    const preserved = previous ? slides.indexOf(previous) : -1;
    if (slides.length) goTo(preserved >= 0 ? preserved : Math.min(active, slides.length - 1));
    else dots.replaceChildren?.();
  });
  document.getElementById('ruHeroPrevious')?.addEventListener('click', () => goTo(active - 1));
  document.getElementById('ruHeroNext')?.addEventListener('click', () => goTo(active + 1));
  track.addEventListener?.('scroll', update, { passive: true });
  for (const slide of slides) {
    const image = slide.querySelector?.('img');
    image?.addEventListener?.('error', () => {
      slide.remove?.();
      slides = [...track.children];
      rebuildDots();
      if (slides.length) update(); else dots.replaceChildren?.();
    }, { once: true });
  }
  update();
}

if (globalThis.document) initializeHeroCarousel();
