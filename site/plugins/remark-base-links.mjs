// Astro/Starlight don't rewrite root-relative links written in markdown prose to account for
// the configured `base` (only Starlight's own generated nav does that). This walks the markdown
// AST and prefixes any same-site, root-relative link (e.g. `/getting-started/`) with `base`, so
// hand-authored content can keep using clean root-relative links regardless of where the site is
// deployed.
export function remarkBaseLinks(base) {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;

  function visit(node) {
    if (
      node.type === 'link' &&
      typeof node.url === 'string' &&
      node.url.startsWith('/') &&
      !node.url.startsWith('//')
    ) {
      node.url = prefix + node.url;
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  }

  return () => (tree) => {
    visit(tree);
  };
}
