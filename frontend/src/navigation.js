const pages = new Set(["wallet", "assets", "funding", "transfers", "activity", "metadata"]);

export function mountNavigation({ document, window }) {
  const panels = [...document.querySelectorAll("[data-page]")];
  const links = [...document.querySelectorAll("[data-page-link]")];
  function navigate(page, updateHash = true) {
    if (!pages.has(page)) page = "wallet";
    for (const panel of panels) panel.hidden = panel.dataset.page !== page;
    for (const link of links) {
      if (link.dataset.pageLink === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (updateHash && window.location.hash !== `#${page}`) window.location.hash = page;
  }
  for (const link of links) link.addEventListener("click", (event) => {
    event.preventDefault(); navigate(link.dataset.pageLink);
  });
  window.addEventListener("hashchange", () => navigate(window.location.hash.slice(1), false));
  navigate(window.location.hash?.slice(1), false);
  return { navigate };
}
