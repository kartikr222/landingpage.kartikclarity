from pathlib import Path
import re

path = Path('index.html')
text = path.read_text(encoding='utf-8')

yt_url = 'https://youtube.com/@kartikclarity'
reddit_url = 'https://www.reddit.com/user/Hungry-Lie-2220/'

for label, url, cls in [
    ('YouTube', yt_url, 'youtube-link'),
    ('Reddit', reddit_url, 'reddit-link'),
]:
    pattern = re.compile(rf'<span class="social-icon social-placeholder" aria-label="{label}" title="{label}">(.*?)</span>', re.S)
    replacement = rf'<a class="social-icon {cls}" href="{url}" aria-label="{label}" title="{label}" target="_blank" rel="noopener noreferrer">\1</a>'
    text = pattern.sub(replacement, text)

path.write_text(text, encoding='utf-8')
print('YouTube and Reddit social links integrated.')
