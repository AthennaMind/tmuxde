// Project rules for oxlint. Loaded through jsPlugins in .oxlintrc.json.

// Hosts of public CDNs, subdomains included. A host must start the string or
// follow `//` or a non path character, so a path segment such as `/esm.sh`
// passes. A regex literal keeps this file free of the string literals the
// rule flags.
const CDN_HOST =
  /(?:^|\/\/|[^\w./-])(?:[\w-]+\.)*(?:unpkg\.com|jsdelivr\.net|jsdelivr\.com|cdnjs\.cloudflare\.com|cdn\.skypack\.dev|esm\.sh|esm\.run|jspm\.io|jspm\.dev|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com|ajax\.googleapis\.com)(?![\w-])/i;

const noCdnUrls = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow external CDN URLs in string literals and templates.",
    },
    messages: {
      cdn: "External CDN URL. Bundle the asset locally. Runtime CDN fetches leak the user address, break offline use and add supply chain risk.",
    },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === "string" && CDN_HOST.test(text)) {
        context.report({ node, messageId: "cdn" });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export default {
  meta: { name: "tmuxde" },
  rules: { "no-cdn-urls": noCdnUrls },
};
