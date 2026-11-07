/**
 * Everything that touches the page's HTML controls lives here, so the 3D code
 * never has to know about buttons.
 */

const $ = (id) => document.getElementById(id);

export function initUI({ worlds, handlers }) {
  const el = {
    name: $('world-name'),
    tagline: $('world-tagline'),
    desc: $('world-desc'),
    facts: $('world-facts'),
    note: $('world-note'),
    home: $('btn-home'),
    factBtn: $('btn-fact'),
    factBox: $('fact-box'),
    factText: $('fact-text'),
    factNext: $('btn-fact-next'),
    cardToggle: $('card-toggle'),
    cardBody: $('card-body'),
    chips: Array.from(document.querySelectorAll('.chip')),
    reset: $('btn-reset'),
    pause: $('btn-pause'),
    pauseLabel: $('pause-label'),
    stars: $('btn-stars'),
    loader: $('loader'),
    progress: $('progress'),
    fallback: $('fallback'),
  };

  el.chips.forEach((chip) => {
    chip.addEventListener('click', () => handlers.onSelect(chip.dataset.world));
  });
  el.home.addEventListener('click', () => handlers.onSelect('earth'));
  el.reset.addEventListener('click', () => handlers.onReset());
  el.pause.addEventListener('click', () => handlers.onTogglePause());
  el.stars.addEventListener('click', () => handlers.onToggleStars());

  // "Interesting fact" card: opens on tap, and cycles through a few facts per world.
  let facts = [];
  let factIndex = 0;
  const showFact = () => {
    el.factText.textContent = facts[factIndex] || '';
  };
  el.factBtn.addEventListener('click', () => {
    const open = el.factBox.hidden;
    el.factBox.hidden = !open;
    el.factBtn.setAttribute('aria-expanded', String(open));
    if (open) showFact();
  });
  el.factNext.addEventListener('click', () => {
    factIndex = (factIndex + 1) % Math.max(1, facts.length);
    showFact();
  });

  el.cardToggle.addEventListener('click', () => {
    const open = el.cardToggle.getAttribute('aria-expanded') !== 'true';
    el.cardToggle.setAttribute('aria-expanded', String(open));
    el.cardBody.hidden = !open;
  });

  /** Show a world's name, description, facts and its science-versus-art note. */
  function showWorld(id) {
    const world = worlds[id];
    if (!world) return;

    el.name.textContent = world.name;
    el.tagline.textContent = world.tagline;
    el.desc.textContent = world.description;

    el.facts.replaceChildren();
    world.facts.forEach(([label, value]) => {
      const item = document.createElement('li');
      const strong = document.createElement('b');
      strong.textContent = label;
      item.append(strong, ` ${value}`);
      el.facts.append(item);
    });

    el.note.replaceChildren();
    const lead = document.createElement('b');
    lead.textContent = 'حقیقت اور فن: ';
    el.note.append(lead, world.note);

    facts = world.funFacts || [];
    factIndex = 0;
    el.factBox.hidden = true;
    el.factBtn.setAttribute('aria-expanded', 'false');
    el.factBtn.hidden = facts.length === 0;

    el.chips.forEach((chip) => {
      chip.setAttribute('aria-pressed', String(chip.dataset.world === id));
    });
    el.home.hidden = id === 'earth';
  }

  function setPaused(paused) {
    el.pause.setAttribute('aria-pressed', String(paused));
    el.pause.setAttribute('aria-label', paused ? 'حرکت دوبارہ چلائیں' : 'حرکت روکیں');
    el.pauseLabel.textContent = paused ? 'چلائیں' : 'روکیں';
  }

  function setStars(visible) {
    el.stars.setAttribute('aria-pressed', String(visible));
    el.stars.setAttribute('aria-label', visible ? 'ستارے چھپائیں' : 'ستارے دکھائیں');
  }

  /** Thin progress line at the top while sharper textures are being generated. */
  function setProgress(value) {
    el.progress.classList.toggle('is-active', value < 1);
    el.progress.style.setProperty('--p', String(Math.max(0, Math.min(1, value))));
  }

  function hideLoader() {
    el.loader.classList.add('is-done');
  }

  function showFallback() {
    el.loader.classList.add('is-done');
    el.fallback.hidden = false;
  }

  return { showWorld, setPaused, setStars, setProgress, hideLoader, showFallback };
}
