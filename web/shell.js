// Shared portfolio identity on every arena page; no external scripts or fonts.
const header = document.querySelector("[data-site-header]");
if (header) {
  const brand = document.createElement("a");
  brand.href = "https://svanda.tech";
  brand.className = "identity";
  brand.setAttribute("aria-label", "Martin Švanda — portfolio");
  const mark = document.createElement("span");
  mark.className = "monogram";
  mark.setAttribute("aria-hidden", "true");
  mark.append("mš");
  const dot = document.createElement("span");
  dot.textContent = ".";
  mark.append(dot);
  brand.append(mark, "Martin Švanda");
  const nav = document.createElement("nav");
  nav.className = "site-navigation";
  nav.setAttribute("aria-label", "Hlavní navigace");
  for (const [label, url] of [
    ["Projekty", "https://svanda.tech/projekty"],
    ["Engineering", "https://svanda.tech/engineering"],
    ["Zápisky", "https://svanda.tech/blog"],
    ["LLM Arena", "./"],
    ["Kontakt ↗", "https://svanda.tech/contact"],
  ]) {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = label;
    if (label === "LLM Arena") a.className = "current";
    nav.append(a);
  }
  header.append(brand, nav);
}
// The portfolio already supplies a site header around the arena iframe.
if (window.self !== window.top)
  document.documentElement.classList.add("embedded");
