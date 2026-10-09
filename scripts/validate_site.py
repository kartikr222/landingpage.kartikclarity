#!/usr/bin/env python3
"""Dependency-free regression checks for Kartik Clarity's static site."""
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://kartikclarity.vercel.app"
PAGES = {
    "index.html": BASE + "/",
    "about.html": BASE + "/about.html",
    "contact.html": BASE + "/contact.html",
    "privacy-policy.html": BASE + "/privacy-policy.html",
    "terms-of-service.html": BASE + "/terms-of-service.html",
    "blog/index.html": BASE + "/blog/",
    "blog/revenue-intelligence-guide.html": BASE + "/blog/revenue-intelligence-guide.html",
    "blog/revenue-leak-detection.html": BASE + "/blog/revenue-leak-detection.html",
    "blog/data-driven-sales-culture.html": BASE + "/blog/data-driven-sales-culture.html",
}
EVENTS = ("contact_email_click", "checkout_outbound_click", "contact_page_click",
          "product_section_click", "outbound_link_click")
errors = []
checks = 0

class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.canonicals, self.ids = {}, [], set()
        self.h1, self.mains, self.skips, self.mailtos = 0, [], [], []
        self.title, self.in_title, self.lang, self.links = [], False, None, []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "html": self.lang = a.get("lang")
        if tag == "title": self.in_title = True
        if tag == "h1": self.h1 += 1
        if tag == "main": self.mains.append(a.get("id", ""))
        if "id" in a: self.ids.add(a["id"])
        if tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key: self.meta[key] = a.get("content", "")
        if tag == "link" and "canonical" in (a.get("rel") or "").lower().split():
            self.canonicals.append(a.get("href", ""))
        if tag == "a":
            href, classes = a.get("href", ""), (a.get("class") or "").split()
            self.links.append((classes, href))
            if "skip-link" in classes and href.startswith("#"): self.skips.append(href[1:])
            if href.lower().startswith("mailto:"): self.mailtos.append(href.lower())
    def handle_endtag(self, tag):
        if tag == "title": self.in_title = False
    def handle_data(self, data):
        if self.in_title: self.title.append(data)

def check(ok, message):
    global checks
    checks += 1
    if not ok: errors.append(message)

def parse(path):
    p = Page()
    p.feed((ROOT / path).read_text(encoding="utf-8"))
    return p

titles, canonicals = set(), set()
for path, expected in PAGES.items():
    file = ROOT / path
    check(file.is_file(), f"{path}: file missing")
    if not file.is_file(): continue
    html = file.read_text(encoding="utf-8")
    p = parse(path)
    title, canonical = "".join(p.title).strip(), p.canonicals[0] if len(p.canonicals) == 1 else ""
    check(bool(title), f"{path}: title missing")
    check(bool(p.meta.get("description", "").strip()), f"{path}: meta description missing")
    check(len(p.canonicals) == 1 and canonical == expected, f"{path}: canonical missing, duplicated or incorrect")
    check(title not in titles, f"{path}: duplicate title")
    check(canonical not in canonicals, f"{path}: duplicate canonical")
    titles.add(title); canonicals.add(canonical)
    check(p.lang == "en", f"{path}: html lang missing/incorrect")
    check(p.h1 == 1, f"{path}: expected exactly one H1")
    check(html.count("googletagmanager.com/gtag/js") == 1, f"{path}: expected one GA4 loader")
    check(len(re.findall(r"gtag\(\s*['\"]config['\"]", html)) == 1, f"{path}: expected one GA4 config")
    for key in ("og:title", "og:description", "og:url", "og:image", "og:image:alt",
                "twitter:card", "twitter:title", "twitter:description", "twitter:image"):
        check(bool(p.meta.get(key, "").strip()), f"{path}: {key} missing")
    check(p.meta.get("og:url") == canonical, f"{path}: og:url differs from canonical")
    check(p.meta.get("og:image") == BASE + "/cover-banner.png", f"{path}: Open Graph image mismatch")
    check(p.meta.get("twitter:image") == BASE + "/cover-banner.png", f"{path}: Twitter image mismatch")
    check(p.meta.get("twitter:card") == "summary_large_image", f"{path}: Twitter card type mismatch")

home = parse("index.html")
check("main-content" in home.mains and "main-content" in home.ids, "Homepage main landmark/skip target missing")
check("main-content" in home.skips, "Homepage skip link target incorrect")
check(sum(1 for c, h in home.links if "blog-link" in c and h.rstrip("/") == "/blog") >= 2,
      "Homepage header/footer Blog links missing")
check(sum(1 for c, h in home.links if "youtube-link" in c and "youtube.com/@kartikclarityofficial" in h) >= 2,
      "Homepage official YouTube links missing")
home_html = (ROOT / "index.html").read_text(encoding="utf-8")
check("kartik-reddit-social-bootstrap" in home_html, "Homepage Reddit social integration missing")
for event in EVENTS: check(event in home_html, f"Homepage GA4 event missing: {event}")
check(not re.search(r"gtag\(\s*['\"]event['\"]\s*,\s*['\"]purchase['\"]", home_html, re.I),
      "Checkout click must not be tracked as a purchase")

contact = parse("contact.html")
check(any(x.startswith("mailto:info.kartikclarity@gmail.com") for x in contact.mailtos),
      "Contact page functional email link missing")
legacy = parse("blog/article.html")
legacy_html = (ROOT / "blog/article.html").read_text(encoding="utf-8")
check(legacy.meta.get("robots", "").lower() == "noindex,follow", "Legacy JS article template must be noindex,follow")
check(not legacy.canonicals, "Legacy JS article template has misleading static canonical")
check("if(canonical)canonical.setAttribute" in legacy_html, "Legacy article canonical update is not guarded")

try:
    tree = ET.parse(ROOT / "sitemap.xml")
    urls = {n.text.strip() for n in tree.iter() if n.tag.endswith("loc") and n.text}
    check(urls == set(PAGES.values()), "Main sitemap does not exactly match the indexable page set")
except Exception as exc:
    check(False, f"Main sitemap XML invalid: {exc}")
check("Sitemap: " + BASE + "/sitemap.xml" in (ROOT / "robots.txt").read_text(encoding="utf-8"),
      "robots.txt sitemap declaration missing")
check((ROOT / "cover-banner.png").is_file(), "Social preview image asset missing")
workflow = (ROOT / ".github/workflows/integrate-blog.yml").read_text(encoding="utf-8")
check("concurrency:" in workflow, "Blog integration workflow lacks concurrency protection")
check("python scripts/validate_site.py" in workflow, "Blog integration workflow does not run validation")

if errors:
    print(f"FAIL: {len(errors)} of {checks} checks failed")
    for e in errors: print(" - " + e)
    sys.exit(1)
print(f"PASS: {checks} regression checks across {len(PAGES)} indexable pages")
