/**
 * Console développeur du Store : inscription au programme (payée avec le
 * solde de test), tableau de bord (revenus, ventes, installations, notes),
 * édition d'une app (fiche, icône, prix, code), essai isolé, examen
 * automatique, publication, mises à jour et retrait de la vente.
 */
import { h, render as fill } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { page, appBar, listGroup, listItem, button, field, toggle, emptyState } from '../../lib/ui.js';
import { appIcon } from '../../system/app-icon.js';
import { runApp, hostFromContext } from '../../system/app-runtime.js';
import { CATEGORIES, COMMISSION, DEVELOPER_FEE, GLYPHS, PALETTES, PRICES, STARTER_CODE, formatMoney, formatPrice } from '../../kernel/store.js';

const STATUS = { draft: 'Brouillon', published: 'En vente', unlisted: 'Retirée de la vente' };

/**
 * Modèles de code proposés dans l'éditeur. Un exemple peut aussi compléter la
 * fiche du Store (seulement les champs que le développeur n'a pas remplis).
 */
const TEMPLATES = [
  { label: 'Modèle de départ (compteur)', code: async () => STARTER_CODE },
  {
    label: 'Exemple : Courrier (e-mail)',
    code: async () => {
      const response = await fetch(new URL('./examples/courrier.html', import.meta.url));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    listing: {
      subtitle: 'Vos e-mails, simples et rangés',
      description: 'Courrier relève et envoie vos e-mails avec les comptes de l\'appareil (Orion installé, autorisation « E-mails ») : dossiers, recherche, drapeaux, archive, corbeille, réponses et transferts, brouillons enregistrés pendant la saisie. Sans compte, il fonctionne en démonstration sur l\'appareil.',
      category: 'Productivité',
      icon: 'mail',
    },
    permissions: ['mail'],
  },
  {
    label: 'Exemple : Agora (réseau social)',
    code: async () => {
      const response = await fetch(new URL('./examples/agora.html', import.meta.url));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    listing: {
      subtitle: 'Publiez, suivez, échangez',
      description: 'Agora est un réseau social complet : fil d\'actualité, publications avec mots-dièse, mentions, fond coloré, sondage ou citation, j\'aime, partages, commentaires, profils, abonnements, recherche, tendances, notifications et messages privés. Avec l\'autorisation « Internet », Agora se connecte à Mastodon et au fédivers (n\'importe quelle instance) : vous y retrouvez les vraies personnes. Sinon, tout reste sur l\'appareil, avec une communauté de démonstration qui réagit à vos publications.',
      category: 'Divertissement',
      icon: 'heart',
    },
    permissions: ['internet'],
  },
];
/** Autorisations qu'une app du Store peut déclarer (l'utilisateur les accorde au premier usage). */
const PERMISSION_TOGGLES = [
  { perm: 'location', title: 'Utilise la position', subtitle: 'L\'utilisateur devra l\'autoriser' },
  { perm: 'mail', title: 'Accède aux e-mails', subtitle: 'Comptes des Réglages ; l\'utilisateur devra l\'autoriser' },
  { perm: 'internet', title: 'Accède à Internet', subtitle: 'Par orion.net (jamais au réseau local) ; l\'utilisateur devra l\'autoriser' },
];

/** Valeurs d'une app qui vient d'être créée (store.createApp) : un exemple peut les remplacer. */
const UNSET = { subtitle: '', description: '', category: 'Utilitaires', icon: GLYPHS[0] };

const TERMS = [
  'Vous publiez des apps dont vous détenez les droits, sans contenu illégal, trompeur ou dangereux.',
  'Chaque version est examinée automatiquement avant sa publication ; une app qui tente de sortir de son environnement isolé, de miner de la cryptomonnaie ou de voler des identifiants est refusée.',
  'Les apps s\'exécutent isolées, sans accès aux données des autres apps ; elles n\'accèdent à Internet que par Orion, avec l\'autorisation de l\'utilisateur.',
  `Le Store retient ${Math.round(COMMISSION * 100)} % du prix de chaque vente ; le reste est versé sur votre solde. Les clients peuvent être remboursés pendant 2 heures après l'achat.`,
  `L'inscription coûte ${formatMoney(DEVELOPER_FEE)}, payés une fois. Pendant la version alpha d'Orion, tous les paiements sont fictifs (solde de test).`,
];

export function developerConsole({ ctx, nav, store, verify, topUp, openListing }) {
  const back = (label = 'Retour') => ({ label, onClick: () => nav.pop() });

  function open({ app = null } = {}) {
    if (!store.developer()) return registerPage();
    dashboardPage();
    if (app && store.app(app)) editorPage(app);
  }

  // ───────────── Inscription ─────────────

  function registerPage() {
    const name = field({ label: 'Nom public du développeur', placeholder: 'Par exemple : Studio Camille' });
    const email = field({ label: 'E-mail de contact', type: 'email', placeholder: 'contact@exemple.fr' });
    const website = field({ label: 'Site web (facultatif)', type: 'url', placeholder: 'https://' });
    const accept = toggle(false, null, { label: 'Accepter le contrat de distribution' });
    const error = h('p.dev-error');
    const content = h(
      'div.devc',
      h('div.devc-hero', h('div.devc-hero-icon', icon('code', { size: 34 })), h('h2', 'Programme développeur'), h('p', 'Publiez vos apps sur le Store d\'Orion, gratuites ou payantes, et suivez vos ventes.')),
      listGroup({
        items: [
          listItem({ icon: 'edit', iconColor: '#0a84ff', title: 'Écrivez votre app', subtitle: 'Un fichier HTML, CSS et JavaScript, avec le SDK orion' }),
          listItem({ icon: 'shield', iconColor: '#30d158', title: 'Examen automatique', subtitle: 'Fiche, version et analyse de sécurité avant chaque publication' }),
          listItem({ icon: 'bag', iconColor: '#ff9f0a', title: 'Vendez-la', subtitle: `Gratuite ou de ${formatPrice(PRICES[1])} à ${formatPrice(PRICES.at(-1))} · ${Math.round((1 - COMMISSION) * 100)} % pour vous` }),
        ],
      }),
      listGroup({ header: 'Votre profil de développeur', items: [h('div.list-item.devc-form', name, email, website)] }),
      listGroup({
        items: [
          listItem({ title: 'J\'accepte le contrat de distribution', trailing: accept }),
          listItem({ title: 'Lire le contrat', chevron: true, onClick: () => ctx.ui.alert({ title: 'Contrat de distribution', content: h('ol.devc-terms', TERMS.map((t) => h('li', t))) }) }),
        ],
        footer: `Inscription : ${formatMoney(DEVELOPER_FEE)}, payés une fois avec votre solde de test (${formatMoney(store.wallet().balance)} disponibles). Paiement fictif : aucun argent réel.`,
      }),
      error,
      button(`S'inscrire · ${formatMoney(DEVELOPER_FEE)}`, {
        block: true,
        onClick: async () => {
          error.textContent = '';
          if (store.wallet().balance < DEVELOPER_FEE) {
            const go = await ctx.ui.confirm({ title: 'Solde de test insuffisant', message: `L'inscription coûte ${formatMoney(DEVELOPER_FEE)}. Ajoutez des fonds de test (argent fictif) pour continuer.`, confirmLabel: 'Ajouter des fonds' });
            if (!go || !(await topUp())) return;
          }
          if (!accept.input.checked) {
            error.textContent = 'Acceptez le contrat de distribution pour continuer.';
            return;
          }
          if (!(await verify('Payer l\'inscription au programme développeur'))) return;
          try {
            store.registerDeveloper({ name: name.input.value, email: email.input.value, website: website.input.value, accepted: true });
          } catch (e) {
            error.textContent = e.message;
            return;
          }
          ctx.ui.toast('Bienvenue dans le programme développeur');
          await nav.pop({ animated: false });
          dashboardPage();
        },
      }),
    );
    const p = page({ title: 'Développeurs', large: false, back: back(), content });
    nav.push(p);
  }

  // ───────────── Tableau de bord ─────────────

  /** Objet « paquet » pour dessiner l'icône d'un brouillon. */
  const preview = (app, draft = app.draft) => ({ id: app.id, name: draft.name, icon: draft.icon, color: draft.color });

  function dashboardPage() {
    const content = h('div.devc');
    const render = () => {
      const profile = store.developer();
      if (!profile) return;
      const s = store.summary();
      const apps = store.apps();
      fill(
        content,
        h('div.devc-profile', h('strong', profile.name), h('span', `Développeur depuis le ${new Date(profile.joinedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`)),
        h(
          'div.devc-stats',
          h('div', h('small', 'Revenus nets'), h('strong', formatMoney(s.revenue))),
          h('div', h('small', 'Ventes'), h('strong', String(s.sales))),
          h('div', h('small', 'Installations'), h('strong', String(s.installs))),
          h('div', h('small', 'Note moyenne'), h('strong', s.ratings ? `${s.average.toFixed(1).replace('.', ',')} ★` : '—')),
        ),
        button('Nouvelle app', { block: true, icon: 'plus', onClick: createApp }),
        apps.length
          ? listGroup({
              header: 'Mes apps',
              items: apps.map((app) =>
                listItem({
                  leading: appIcon(preview(app), { size: 40 }),
                  title: app.draft.name,
                  subtitle: [STATUS[app.status], app.live ? `v${app.live.version}` : null, app.pending ? 'modifications non publiées' : null].filter(Boolean).join(' · '),
                  detail: app.live ? formatPrice(app.live.price) : null,
                  chevron: true,
                  onClick: () => editorPage(app.id),
                }),
              ),
              footer: `Vos revenus (prix moins ${Math.round(COMMISSION * 100)} % de commission) sont versés sur votre solde de test.`,
            })
          : emptyState({ icon: 'code', title: 'Aucune app', message: 'Créez votre première app : un modèle prêt à essayer vous attend.' }),
        listGroup({
          header: 'Ressources',
          items: [listItem({ icon: 'book', iconColor: '#ff9f0a', title: 'Le SDK orion', subtitle: 'Stockage, dialogues, vibration, notifications, position', chevron: true, onClick: sdkPage })],
        }),
      );
    };
    const p = page({ title: 'Console', back: back('Store'), content });
    p.refresh = render;
    p.onShow = render;
    render();
    nav.push(p);
  }

  async function createApp() {
    const name = await ctx.ui.prompt({ title: 'Nouvelle app', message: 'Son nom sur le Store (modifiable ensuite).', placeholder: 'Nom de l\'app' });
    if (!name?.trim()) return;
    try {
      const app = store.createApp({ name });
      editorPage(app.id);
    } catch (error) {
      ctx.ui.alert({ title: 'Création impossible', message: error.message });
    }
  }

  function sdkPage() {
    const api = [
      ['orion.storage.get(clé) · set(clé, valeur) · remove(clé) · keys() · clear()', 'Données de l\'app (1 Mo), conservées sur l\'appareil.'],
      ['orion.ui.toast(texte) · alert({ title, message }) · confirm(…) · prompt(…)', 'Messages et boîtes de dialogue d\'Orion.'],
      ['orion.device.vibrate(ms | [motif]) · orion.device.info()', 'Vibration ; batterie, connexion et thème.'],
      ['orion.notify({ title, body })', 'Notification (une toutes les 5 secondes au plus).'],
      ['orion.location.current()', 'Position, si l\'app déclare l\'autorisation Localisation et que l\'utilisateur l\'accepte.'],
      ['orion.mail.status() · accounts() · folders(compte) · messages(compte, dossier, { before, limit, query, filter })', 'Vrais e-mails (Orion installé) : comptes ajoutés dans les Réglages, si l\'app déclare l\'autorisation E-mails et que l\'utilisateur l\'accepte.'],
      ['orion.mail.message(compte, dossier, uid) · setFlags(…, { add, remove }) · move(…, vers) · remove(…) · send(compte, { to, cc, subject, text, inReplyTo })', 'Lire, marquer (seen, flagged, answered), classer, supprimer, envoyer (10 envois par 10 minutes au plus).'],
      ['orion.on(\'pause\' | \'resume\' | \'theme\', fn) · orion.onBack(fn) · orion.close()', 'Cycle de vie, bouton Retour (renvoyer true si traité), fermeture.'],
    ];
    const content = h(
      'div.devc',
      h('p.devc-intro', 'Votre app est un fichier HTML (avec ses balises <style> et <script>) qui s\'exécute dans un environnement isolé : pas d\'accès à Internet, ni à la page d\'Orion, ni au stockage du navigateur. Toutes les fonctions du SDK renvoient des promesses.'),
      listGroup({ items: api.map(([code, text]) => h('div.list-item.devc-api', h('div.li-body', h('code', code), h('div.li-sub', text)))) }),
    );
    nav.push(page({ title: 'SDK orion', large: false, back: back('Console'), content }));
  }

  // ───────────── Édition d'une app ─────────────

  function editorPage(id) {
    const content = h('div.devc');
    let form = null;

    /** Valeurs saisies (le brouillon est enregistré à chaque action et en quittant la page). */
    function collect() {
      if (!form) return {};
      return {
        name: form.name.input.value.trim(),
        subtitle: form.subtitle.input.value.trim(),
        description: form.description.input.value.trim(),
        version: form.version.input.value.trim(),
        notes: form.notes.input.value.trim(),
        code: form.code.value,
      };
    }

    function save(patch = {}) {
      if (!store.app(id)) return null;
      return store.updateDraft(id, { ...collect(), ...patch });
    }

    const render = () => {
      const app = store.app(id);
      if (!app) {
        content.replaceChildren(emptyState({ icon: 'trash', title: 'App supprimée' }));
        return;
      }
      const d = app.draft;
      const stats = store.stats(id);
      const rating = store.rating(id);
      form = {
        name: field({ label: 'Nom', value: d.name }),
        subtitle: field({ label: 'Sous-titre', value: d.subtitle, placeholder: 'Une phrase qui résume l\'app' }),
        description: field({ label: 'Description', value: d.description, multiline: true, placeholder: 'Au moins 20 caractères' }),
        version: field({ label: 'Version', value: d.version, inputmode: 'decimal' }),
        notes: field({ label: 'Notes de version', value: d.notes, multiline: true, placeholder: app.live ? 'Nouveautés de cette version' : 'Facultatives pour la première version' }),
        code: h('textarea.devc-code', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Code de l\'app' }, d.code),
      };
      form.description.input.rows = 4;
      form.code.addEventListener('keydown', (e) => {
        // Tabulation dans l'éditeur de code.
        if (e.key !== 'Tab') return;
        e.preventDefault();
        form.code.setRangeText('  ', form.code.selectionStart, form.code.selectionEnd, 'end');
      });
      const pick = async (title, options, current, key) => {
        const value = await ctx.ui.actionSheet({ title, actions: options.map((o) => ({ label: o.label + (o.value === current ? ' ✓' : ''), value: o.value })) });
        if (value != null) {
          save({ [key]: value });
          render();
        }
      };
      fill(
        content,
        h(
          'div.devc-app-head',
          appIcon(preview(app), { size: 72 }),
          h('div', h('strong', d.name), h('span', [STATUS[app.status], app.live ? `v${app.live.version} en ligne` : null].filter(Boolean).join(' · ')), app.live ? h('small', `${stats.sales} vente${stats.sales > 1 ? 's' : ''} · ${formatMoney(stats.revenue)} · ${stats.installs} installation${stats.installs > 1 ? 's' : ''} · ${rating.count ? `${rating.average.toFixed(1).replace('.', ',')} ★ (${rating.count})` : 'pas de note'}`) : null),
        ),
        app.pending ? h('p.devc-pending', icon('info', { size: 15 }), 'Modifications non publiées : publiez une mise à jour pour les envoyer aux utilisateurs.') : null,
        listGroup({ header: 'Fiche du Store', items: [h('div.list-item.devc-form', form.name, form.subtitle, form.description)] }),
        listGroup({
          items: [
            listItem({ title: 'Catégorie', detail: d.category, chevron: true, onClick: () => pick('Catégorie', CATEGORIES.map((c) => ({ label: c, value: c })), d.category, 'category') }),
            listItem({ title: 'Prix', detail: formatPrice(d.price), chevron: true, onClick: () => pick('Prix', PRICES.map((p) => ({ label: formatPrice(p), value: p })), d.price, 'price') }),
            ...PERMISSION_TOGGLES.map(({ perm, title, subtitle }) =>
              listItem({
                title,
                subtitle,
                trailing: toggle(d.permissions.includes(perm), (on) => {
                  // Relu au moment du clic : l'autre interrupteur a pu changer la liste.
                  const current = store.app(id).draft.permissions.filter((p) => p !== perm);
                  save({ permissions: on ? [...current, perm] : current });
                }, { label: title }),
              }),
            ),
          ],
          footer: d.price ? `Vous touchez ${formatMoney(Math.round(d.price * (1 - COMMISSION)))} par vente.` : null,
        }),
        listGroup({
          header: 'Icône',
          items: [
            h(
              'div.list-item.devc-glyphs',
              GLYPHS.map((g) => h(`button.devc-glyph${g === d.icon ? '.active' : ''}`, { type: 'button', 'aria-label': g, onclick: () => { save({ icon: g }); render(); } }, icon(g, { size: 22 }))),
            ),
            h(
              'div.list-item.devc-palettes',
              PALETTES.map((c) => h(`button.devc-swatch${c.join() === d.color.join() ? '.active' : ''}`, { type: 'button', 'aria-label': `Couleur ${c[0]}`, style: { background: `linear-gradient(160deg, ${c[0]}, ${c[1]})` }, onclick: () => { save({ color: c }); render(); } })),
            ),
          ],
        }),
        listGroup({ header: 'Version', items: [h('div.list-item.devc-form', form.version, form.notes)] }),
        listGroup({
          header: 'Code (HTML, CSS et JavaScript)',
          items: [h('div.list-item.devc-editor', form.code)],
          footer: 'Le contenu de la page de votre app. Le SDK orion est déjà chargé.',
        }),
        h(
          'div.devc-actions',
          button('Essayer', { variant: 'tinted', icon: 'play', onClick: () => testRun() }),
          button('Modèles', { variant: 'gray', icon: 'notes', onClick: pickTemplate }),
        ),
        button(app.live ? 'Examiner et publier la mise à jour' : 'Examiner et publier', { block: true, icon: 'upload', onClick: reviewAndPublish }),
        app.live
          ? button(app.listed ? 'Retirer de la vente' : 'Remettre en vente', { variant: 'gray', block: true, onClick: async () => {
              if (app.listed && !(await ctx.ui.confirm({ title: `Retirer ${d.name} de la vente ?`, message: 'Elle disparaît du Store ; ceux qui l\'ont déjà installée la gardent.', confirmLabel: 'Retirer' }))) return;
              store.setListed(id, !app.listed);
              render();
            } })
          : null,
        app.live && app.listed ? button('Voir la fiche sur le Store', { variant: 'gray', block: true, onClick: () => openListing(id) }) : null,
        button('Supprimer l\'app', { variant: 'gray', destructive: true, block: true, onClick: async () => {
          if (!(await ctx.ui.confirm({ title: `Supprimer ${d.name} ?`, message: 'L\'app et ses statistiques sont effacées.', confirmLabel: 'Supprimer', destructive: true }))) return;
          try {
            store.deleteApp(id);
            form = null;
            nav.pop();
          } catch (error) {
            ctx.ui.alert({ title: 'Suppression impossible', message: error.message });
          }
        } }),
      );
    };

    async function pickTemplate() {
      const index = await ctx.ui.actionSheet({ title: 'Partir d\'un modèle', actions: TEMPLATES.map((t, i) => ({ label: t.label, value: i })) });
      const template = TEMPLATES[index];
      if (!template) return;
      if (!(await ctx.ui.confirm({ title: 'Remplacer le code ?', message: `Le code actuel est remplacé par « ${template.label} ».`, confirmLabel: 'Remplacer', destructive: true }))) return;
      let code;
      try {
        code = await template.code();
      } catch (error) {
        ctx.ui.alert({ title: 'Modèle indisponible', message: `Le modèle n'a pas pu être chargé (${error.message}).` });
        return;
      }
      const draft = save()?.draft;
      if (!draft) return;
      const patch = { code };
      for (const [key, value] of Object.entries(template.listing ?? {})) if (draft[key] === UNSET[key]) patch[key] = value;
      if (template.permissions) patch.permissions = [...new Set([...draft.permissions, ...template.permissions])];
      save(patch);
      render();
      if (template.listing) ctx.ui.toast('Exemple chargé : essayez-le, puis publiez-le');
    }

    async function reviewAndPublish() {
      save();
      const app = store.app(id);
      const result = store.review(id);
      const list = h(
        'ul.devc-review',
        result.checks.map((c) => h(`li${c.ok ? '.ok' : '.ko'}`, icon(c.ok ? 'check-circle' : 'close', { size: 16 }), h('div', h('b', c.label), h('span', c.detail)))),
      );
      if (!result.ok) {
        await ctx.ui.alert({ title: 'Examen refusé', message: 'Corrigez les points en rouge puis réessayez.', content: list });
        render();
        return;
      }
      const go = await ctx.ui.alert({
        title: 'Examen réussi',
        message: `${app.draft.name} ${app.draft.version} · ${formatPrice(app.draft.price)}`,
        content: list,
        buttons: [{ label: 'Annuler', value: false, role: 'cancel' }, { label: app.live ? 'Publier la mise à jour' : 'Publier', value: true }],
      });
      if (!go) return;
      try {
        store.publish(id);
        ctx.ui.toast(app.live ? 'Mise à jour publiée' : 'Publiée sur le Store');
      } catch (error) {
        ctx.ui.alert({ title: 'Publication impossible', message: error.message });
      }
      render();
    }

    /** Essai du brouillon dans une page plein écran (données en mémoire, effacées à la fermeture). */
    function testRun() {
      const app = save();
      if (!app) return;
      const body = h('div.devc-test-body');
      const bar = appBar({ title: `Essai · ${app.draft.name}`, large: false, back: back('App') });
      const p = h('div.page.devc-test', bar, body);
      const run = runApp(body, { app: { id: app.id, name: app.draft.name, version: app.draft.version }, code: app.draft.code, host: hostFromContext(ctx, { test: true }) });
      p.onPop = () => run.dispose();
      nav.push(p);
    }

    const p = page({ title: '', large: false, back: back('Console'), content });
    // Enregistré en quittant la page (retour) ou en changeant d'onglet. Pas de p.refresh :
    // redessiner la page effacerait ce qui est en cours de saisie.
    p.onPop = () => form && save();
    render();
    nav.push(p);
  }

  return { open };
}
