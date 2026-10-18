(() => {
  const href = (name) => `${chrome.runtime.getURL('assets/icons.svg')}#${name}`;
  function create(name, className = 'ui-icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class',className);
    svg.setAttribute('viewBox','0 0 24 24');
    svg.setAttribute('aria-hidden','true');
    svg.setAttribute('focusable','false');
    const use = document.createElementNS('http://www.w3.org/2000/svg','use');
    use.setAttribute('href',href(name));
    svg.append(use);
    return svg;
  }
  document.querySelectorAll('[data-icon]').forEach(node => node.append(create(node.dataset.icon)));
  window.SteelBallIcons = {create};
})();
