/**
 * Fournisseur de contacts partagé (Téléphone, Messages, Contacts…).
 * Données stockées dans /data/providers/contacts.json.
 */
export const CONTACTS_FILE = '/data/providers/contacts.json';

const PALETTE = ['#ff6b6b', '#f59f00', '#37b24d', '#1c7ed6', '#7048e8', '#e64980', '#0ca678', '#f76707', '#4263eb'];

/**
 * Contacts de démonstration des premières versions d'Orion, retirés au
 * démarrage. Identifiés par leur id d'usine ET leur numéro : un contact créé
 * par l'utilisateur (id horodaté) n'est jamais concerné.
 */
export const DEMO_CONTACTS = [
  { id: 'c1', phone: '+33 6 12 34 56 78' },
  { id: 'c2', phone: '+33 6 23 45 67 89' },
  { id: 'c3', phone: '+33 7 34 56 78 90' },
  { id: 'c4', phone: '+33 6 45 67 89 01' },
  { id: 'c5', phone: '+33 6 56 78 90 12' },
  { id: 'c6', phone: '+33 7 67 89 01 23' },
  { id: 'c7', phone: '+33 6 78 90 12 34' },
  { id: 'c8', phone: '+33 6 89 01 23 45' },
];

/** Normalise un numéro pour comparaison (9 derniers chiffres). */
export function phoneKey(number) {
  const digits = String(number ?? '').replace(/\D/g, '');
  return digits.slice(-9);
}

export function displayName(contact) {
  if (!contact) return '';
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.company || contact.phone || 'Sans nom';
}

export class ContactsProvider {
  #contacts = [];

  constructor({ fs, events = null }) {
    this.fs = fs;
    this.events = events;
  }

  load() {
    const stored = this.fs.exists(CONTACTS_FILE) ? this.fs.readJSON(CONTACTS_FILE, []) : null;
    this.#contacts = (stored ?? []).filter((c) => !DEMO_CONTACTS.some((demo) => demo.id === c.id && phoneKey(demo.phone) === phoneKey(c.phone)));
    if (!stored || this.#contacts.length !== stored.length) this.#persist();
    return this;
  }

  #persist() {
    this.fs.writeJSON(CONTACTS_FILE, this.#contacts, { system: true });
    this.events?.emit('contacts:change', {});
  }

  list() {
    return [...this.#contacts].sort((a, b) => displayName(a).localeCompare(displayName(b), 'fr'));
  }

  get(id) {
    return this.#contacts.find((c) => c.id === id) ?? null;
  }

  findByPhone(number) {
    const key = phoneKey(number);
    if (!key) return null;
    return this.#contacts.find((c) => phoneKey(c.phone) === key) ?? null;
  }

  search(query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return this.list();
    const digits = q.replace(/\D/g, '');
    return this.list().filter(
      (c) =>
        displayName(c).toLowerCase().includes(q) ||
        (c.company ?? '').toLowerCase().includes(q) ||
        (digits.length >= 2 && String(c.phone ?? '').replace(/\D/g, '').includes(digits)),
    );
  }

  add(data) {
    const contact = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      firstName: '',
      lastName: '',
      phone: '',
      email: '',
      company: '',
      notes: '',
      favorite: false,
      color: PALETTE[this.#contacts.length % PALETTE.length],
      ...data,
    };
    this.#contacts.push(contact);
    this.#persist();
    return contact;
  }

  update(id, patch) {
    const contact = this.get(id);
    if (!contact) return null;
    Object.assign(contact, patch, { id });
    this.#persist();
    return contact;
  }

  remove(id) {
    const before = this.#contacts.length;
    this.#contacts = this.#contacts.filter((c) => c.id !== id);
    if (before !== this.#contacts.length) this.#persist();
    return before !== this.#contacts.length;
  }

  nameFor(number) {
    return displayName(this.findByPhone(number)) || number;
  }
}
