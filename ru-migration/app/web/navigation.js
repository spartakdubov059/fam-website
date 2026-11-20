const VIEWS = new Set(['board', 'afisha', 'favorites', 'messages', 'profile']);

export function initializeNavigation({ document = globalThis.document } = {}) {
  const navigation = document?.getElementById?.('ruTabbar');
  if (!navigation || typeof navigation.querySelectorAll !== 'function') return;
  const buttons = [...navigation.querySelectorAll('button[data-ru-view]')];
  for (const button of buttons) {
    const view = button.getAttribute('data-ru-view');
    if (!VIEWS.has(view)) continue;
    button.addEventListener('click', () => {
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
      let target = null;
      if (view === 'board') target = document.getElementById('publicListings');
      if (view === 'favorites') {
        const listings = document.getElementById('publicListings');
        listings?.setAttribute?.('data-ru-board-view', 'favorites');
        document.querySelector?.('#publicListings .ru-board-views button[data-view="favorites"]')?.click?.();
        target = listings;
      }
      if (view === 'afisha') {
        document.getElementById('ruBoardCategoryAfisha')?.click?.();
        target = document.getElementById('ruAfishaFeed') || document.getElementById('ruPulse') || document.getElementById('publicListings');
      }
      if (view === 'messages') {
        document.getElementById('ruOpenMessages')?.click?.();
        target = document.getElementById('ruMessages');
      }
      if (view === 'profile') {
        const history = document.getElementById('ruIdeaHistory');
        const ownListings = document.getElementById('ruOwnListings');
        target = history && !history.hidden ? history : ownListings && !ownListings.hidden ? ownListings : document.getElementById('ruProfileSettings')
          || document.getElementById('ruAvatarWorkflow')
          || document.getElementById('ruAccountWorkflow')
          || document.getElementById('ruListingForm')
          || document.getElementById('ruSubmitStatus');
      }
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  }
}

if (globalThis.document) initializeNavigation();
