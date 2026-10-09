from pathlib import Path
import re

path = Path('index.html')
text = path.read_text(encoding='utf-8')

# Convert the existing Blog icon placeholders in the current header/footer
# into real links without replacing or restructuring the existing MVP.
pattern = re.compile(r'<span class="social-icon social-placeholder" aria-label="Blog" title="Blog">(.*?)</span>', re.S)
replacement = r'<a class="social-icon blog-link" href="/blog/" aria-label="Blog" title="Blog">\1</a>'
text, count = pattern.subn(replacement, text)

# Convert the existing YouTube icon placeholders in the current header/footer
# into real links to the Kartik Clarity YouTube channel.
youtube_pattern = re.compile(r'<span class="social-icon social-placeholder" aria-label="YouTube" title="YouTube">(.*?)</span>', re.S)
youtube_replacement = r'<a class="social-icon youtube-link" href="https://youtube.com/@kartikclarityofficial" target="_blank" rel="noopener noreferrer" aria-label="YouTube" title="YouTube">\1</a>'
text, youtube_count = youtube_pattern.subn(youtube_replacement, text)
# Normalize only the exact legacy channel URL; do not alter the already-correct official URL.
text = text.replace('href="https://youtube.com/@kartikclarity"', 'href="https://youtube.com/@kartikclarityofficial"')

# Convert any existing Reddit icon placeholders into the supplied Reddit profile.
reddit_pattern = re.compile(r'<span class="social-icon social-placeholder" aria-label="Reddit" title="Reddit">(.*?)</span>', re.S)
reddit_replacement = r'<a class="social-icon reddit-link" href="https://www.reddit.com/user/Hungry-Lie-2220/" target="_blank" rel="noopener noreferrer" aria-label="Reddit" title="Reddit">\1</a>'
text, reddit_count = reddit_pattern.subn(reddit_replacement, text)

# Add a mobile header Blog link if it is not already present.
if 'class="mobile-blog-link"' not in text:
    marker = '<button class="signin-link mobile" onclick="closeMobileNav();openSignin()">Sign in</button>'
    mobile_link = '<a class="mobile-blog-link" href="/blog/" onclick="closeMobileNav()">Blog</a>\n    '
    if marker in text:
        text = text.replace(marker, mobile_link + marker, 1)
        text = text.replace('.signin-link.mobile{text-align:left;', '.mobile-blog-link{color:#dfe6f5;font-size:15.5px;font-weight:500;padding:13px 4px;border-bottom:1px solid rgba(255,255,255,0.06);}\n  .signin-link.mobile{text-align:left;', 1)

# The MVP already contains the social-icon containers, but Reddit may not have
# a dedicated placeholder in the source HTML. Inject a tiny, self-contained
# client-side fallback that guarantees a real Reddit icon/link in every social
# group (header and footer) without touching the existing layout.
reddit_bootstrap = r'''<script id="kartik-reddit-social-bootstrap">
(function(){
  var url='https://www.reddit.com/user/Hungry-Lie-2220/';
  var groups=document.querySelectorAll('.social-links');
  groups.forEach(function(group){
    if(group.querySelector('a.reddit-link')) return;
    var a=document.createElement('a');
    a.className='social-icon reddit-link';
    a.href=url;
    a.target='_blank';
    a.rel='noopener noreferrer';
    a.setAttribute('aria-label','Reddit');
    a.setAttribute('title','Reddit');
    a.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.5 9.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5S13 11.83 13 11s.67-1.5 1.5-1.5ZM9.5 9.5C8.67 9.5 8 10.17 8 11s.67 1.5 1.5 1.5S11 11.83 11 11s-.67-1.5-1.5-1.5ZM12 18c2.21 0 4-1.34 4-3H8c0 1.66 1.79 3 4 3Zm0-14a8 8 0 0 0-7.92 7H3.5a1.5 1.5 0 0 0 0 3h.67A8 8 0 0 0 12 20a8 8 0 0 0 7.83-6H20.5a1.5 1.5 0 0 0 0-3h-.58A8 8 0 0 0 12 4Zm0 14.5A6.5 6.5 0 1 1 18.5 12 6.51 6.51 0 0 1 12 18.5Z"/></svg>';
    group.appendChild(a);
  });
})();
</script>'''

if 'id="kartik-reddit-social-bootstrap"' not in text:
    if '</body>' in text:
        text = text.replace('</body>', reddit_bootstrap + '\n</body>', 1)
    else:
        text += '\n' + reddit_bootstrap + '\n'

# Verify the intended integrations while accepting both root-relative and relative blog links.
# The script must be safe to rerun when the links are already integrated.
if not any(link in text for link in ('href="/blog/', 'href="blog/', "href='/blog/", "href='blog/")):
    raise SystemExit('Blog integration failed; no working blog link found.')
if 'https://youtube.com/@kartikclarityofficial' not in text:
    raise SystemExit('YouTube integration failed; official channel link not found.')
if 'kartik-reddit-social-bootstrap' not in text or 'https://www.reddit.com/user/Hungry-Lie-2220/' not in text:
    raise SystemExit('Reddit integration failed; refusing to finish.')

path.write_text(text, encoding='utf-8')
print(f'Navigation integration complete: Blog={count}, YouTube={youtube_count}, Reddit={reddit_count}; Reddit bootstrap installed.')
