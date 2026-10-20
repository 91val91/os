/**
 * Panneau tiré depuis le haut de l'écran (volet de notifications, centre de
 * contrôle). La progression `--p` (0 → 1) pilote l'animation CSS.
 */
import { drag } from '../lib/gesture.js';

export class PullPanel {
  constructor(ui, el, { travel = 420 } = {}) {
    this.ui = ui;
    this.el = el;
    this.travel = travel;
    this.isOpen = false;
    this.el.style.setProperty('--p', '0');
    this.el.addEventListener('transitionend', (e) => {
      if (e.target === this.el && !this.isOpen) this.el.classList.remove('visible');
    });
  }

  /** Fermeture par glissement vers le haut sur `handle`. */
  enableSwipeToClose(handle, { filter } = {}) {
    drag(handle, {
      axis: 'y',
      filter: (e) => this.isOpen && (!filter || filter(e)),
      onStart: () => this.el.classList.add('dragging'),
      onMove: ({ dy }) => this.#set(1 + Math.min(0, dy) / this.travel),
      onEnd: ({ dy, vy }) => {
        this.el.classList.remove('dragging');
        if (dy < -this.travel * 0.2 || vy < -0.4) this.close();
        else this.open();
      },
    });
  }

  #set(p) {
    this.el.style.setProperty('--p', String(Math.min(1, Math.max(0, p))));
  }

  dragStart() {
    this.ui.closeOverlays({ except: this });
    this.onBeforeOpen?.();
    this.el.classList.add('visible', 'dragging');
  }

  dragMove(dy) {
    this.#set(dy / this.travel);
  }

  dragEnd(dy, vy) {
    this.el.classList.remove('dragging');
    if (dy > this.travel * 0.25 || vy > 0.35) this.open();
    else this.close();
  }

  open() {
    if (!this.isOpen) {
      this.ui.closeOverlays({ except: this });
      this.onBeforeOpen?.();
    }
    this.isOpen = true;
    this.el.classList.add('visible');
    void this.el.offsetWidth;
    this.el.classList.remove('dragging');
    this.#set(1);
    this.el.classList.add('open');
    this.ui.statusbar.refreshStyle();
    this.onOpen?.();
  }

  close() {
    const wasOpen = this.isOpen || this.el.classList.contains('visible');
    this.isOpen = false;
    this.el.classList.remove('open', 'dragging');
    this.#set(0);
    if (this.ui.animScale === 0) this.el.classList.remove('visible');
    if (wasOpen) this.ui.statusbar.refreshStyle();
    this.onClose?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
}
