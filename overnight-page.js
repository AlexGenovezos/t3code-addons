(() => {
  window.__t3Overnight?.dispose();
  let lastInputAt = Date.now();
  const input = () => { lastInputAt = Date.now(); };
  const events = ["keydown", "pointerdown", "wheel", "input"];
  for (const name of events) document.addEventListener(name, input, true);
  window.__t3Overnight = {
    inputIdleMs: () => Date.now() - lastInputAt,
    hasDraft: () => [...document.querySelectorAll('textarea,[contenteditable="true"]')].some((node) => (node.value ?? node.textContent ?? "").trim().length > 0),
    dispose() { for (const name of events) document.removeEventListener(name, input, true); },
  };
})();
