// The converter list, and the "From [app] to [app]" switcher at the top of every tool page.

export const APPS = {
  csp: { name: 'Clip Studio Paint', short: 'CSP' },
  procreate: { name: 'Procreate', short: 'Procreate' },
  krita: { name: 'Krita', short: 'Krita' },
};

export const ROUTES = [
  { from: 'csp', to: 'krita' },
  { from: 'csp', to: 'procreate' },
  { from: 'procreate', to: 'krita' },
  { from: 'procreate', to: 'csp' },
  { from: 'krita', to: 'procreate' },
  { from: 'krita', to: 'csp' },
];

const href = (r) => `../${r.from}-to-${r.to}/`;

/** Fill <nav id="nav"> on a tool page; `from`/`to` name the current page's route. */
export function renderNav(from, to, el = document.getElementById('nav')) {
  const link = (r, label, cls, current) => {
    const a = document.createElement('a');
    a.href = href(r);
    a.className = `sw-app c-${cls}`;
    a.textContent = label;
    if (current) a.setAttribute('aria-current', 'page');
    return a;
  };
  const group = (label, links) => {
    const g = document.createElement('span');
    g.className = 'sw';
    const l = document.createElement('span');
    l.className = 'sw-lbl';
    l.textContent = label;
    g.append(l, ...links);
    return g;
  };
  const home = document.createElement('a');
  home.className = 'home';
  home.href = '../../';
  home.textContent = 'Brush Converters';
  // "From" keeps the current target where possible; "to" lists the targets of the current source.
  const fromLinks = Object.keys(APPS).map((app) => {
    const r = ROUTES.find((x) => x.from === app && x.to === to) || ROUTES.find((x) => x.from === app);
    return link(r, APPS[app].short, app, app === from);
  });
  const toLinks = ROUTES.filter((r) => r.from === from).map((r) => link(r, APPS[r.to].short, r.to, r.to === to));
  el.replaceChildren(home, group('From', fromLinks), group('to', toLinks));
}
