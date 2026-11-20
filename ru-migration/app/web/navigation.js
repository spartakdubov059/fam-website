const VIEWS = new Set(['board', 'afisha', 'messages', 'profile']);

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
      if (view === 'afisha') {
        document.getElementById('ruBoardCategoryAfisha')?.click?.();
        target = document.getElementById('publicListings');
      }
      if (view === 'messages') {
        document.getElementById('ruOpenMessages')?.click?.();
        target = document.getElementById('ruMessages');
      }
      if (view === 'profile') {
        const history = document.getElementById('ruIdeaHistory');
        target = history && !history.hidden ? history : document.getElementById('ruProfileSettings')
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
