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
youtube_replacement = r'<a class="social-icon youtube-link" href="https://youtube.com/@kartikclarity" target="_blank" rel="noopener noreferrer" aria-label="YouTube" title="YouTube">\1</a>'
text, youtube_count = youtube_pattern.subn(youtube_replacement, text)

# Convert the existing Reddit icon placeholders in the current header/footer
# into real links to the supplied Kartik Clarity Reddit profile.
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

# Fail closed: never silently leave the requested navigation integration incomplete.
if count == 0 and 'href="/blog/"' not in text:
    raise SystemExit('Blog integration marker was not found; refusing to modify index.html.')
if youtube_count == 0 and 'href="https://youtube.com/@kartikclarity"' not in text:
    raise SystemExit('YouTube integration marker was not found; refusing to modify index.html.')
if reddit_count == 0 and 'href="https://www.reddit.com/user/Hungry-Lie-2220/"' not in text:
    raise SystemExit('Reddit integration marker was not found; refusing to modify index.html.')

path.write_text(text, encoding='utf-8')
print(f'Navigation integration complete: Blog={count}, YouTube={youtube_count}, Reddit={reddit_count} placeholder(s).')
